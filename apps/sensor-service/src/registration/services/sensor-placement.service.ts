import { runInTenantTransaction, SENSOR_SOURCE_SCHEMA } from '@aquaculture/backend-common/database';
import {
  CircuitBreakerService,
  DEFAULT_BREAKER_OPTIONS,
} from '@aquaculture/backend-common/resilience';
import {
  SENSOR_PLACEMENT_ERROR,
  type SensorPlacementErrorCode,
} from '@aquaculture/shared-contracts';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { NatsRequestReply } from '@platform/event-bus';
import {
  createBaseEvent,
  type DevicePlacementLevel,
  FARM_DEVICE_PLACEMENT_QUERY_SUBJECTS,
  isResolveDevicePlacementResponse,
  type ResolveDevicePlacementRequest,
  type SensorConfigurationUpdatedEvent,
} from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, type EntityManager } from 'typeorm';

import { SensorProtocol } from '../../database/entities/sensor-protocol.entity';
import { Sensor } from '../../database/entities/sensor.entity';
import { recordEntityUpdate } from '../../infrastructure/audit/audit.subscriber';

/** A registration or a move waits this long for farm before failing closed. */
const FARM_PLACEMENT_TIMEOUT_MS = 3_000;

/** Where a caller says a sensor stands: a site, then optionally a department, a system and a unit. */
export interface PlacementRequest {
  readonly siteId: string;
  readonly departmentId: string | null;
  readonly systemId: string | null;
  readonly unitId: string | null;
}

/**
 * The placement columns a sensor row is inserted with: farm's answer, never
 * the caller's claim, and the instant it was placed (null with no place).
 */
export interface SensorPlacement {
  readonly siteId: string | null;
  readonly departmentId: string | null;
  readonly systemId: string | null;
  readonly tankId: string | null;
  readonly equipmentId: string | null;
  readonly placedAt: Date | null;
}

/** A sensor registered without a place. */
export const UNPLACED: SensorPlacement = {
  siteId: null,
  departmentId: null,
  systemId: null,
  tankId: null,
  equipmentId: null,
  placedAt: null,
};

const REFUSAL: Record<DevicePlacementLevel, { message: string; code: SensorPlacementErrorCode }> = {
  SITE: {
    message: 'The site does not exist or is not active',
    code: SENSOR_PLACEMENT_ERROR.REFUSED_SITE,
  },
  DEPARTMENT: {
    message: 'The department is not active or is not at this site',
    code: SENSOR_PLACEMENT_ERROR.REFUSED_DEPARTMENT,
  },
  SYSTEM: {
    message: 'The system is not active or is not at this site and department',
    code: SENSOR_PLACEMENT_ERROR.REFUSED_SYSTEM,
  },
  UNIT: {
    message: 'The tank or equipment is not active or is not in this department and system',
    code: SENSOR_PLACEMENT_ERROR.REFUSED_UNIT,
  },
};

/**
 * The place a registration or move input names: null when it names none.
 * Refused when it names a level below the site without the site, or a system
 * or a unit without its department (farm places both under a department).
 */
export function placementRequestOf(named: {
  siteId?: string | null;
  departmentId?: string | null;
  systemId?: string | null;
  unitId?: string | null;
}): PlacementRequest | null {
  const departmentId = named.departmentId ?? null;
  const systemId = named.systemId ?? null;
  const unitId = named.unitId ?? null;
  const siteId = named.siteId ?? null;
  if (siteId === null) {
    if (departmentId !== null || systemId !== null || unitId !== null) {
      throw new BadRequestException({
        message: 'A placement names its site',
        code: SENSOR_PLACEMENT_ERROR.INCOMPLETE,
      });
    }
    return null;
  }
  if (departmentId === null && (systemId !== null || unitId !== null)) {
    throw new BadRequestException({
      message: 'A system or a tank is named with its department',
      code: SENSOR_PLACEMENT_ERROR.INCOMPLETE,
    });
  }
  return { siteId, departmentId, systemId, unitId };
}

/**
 * Owner of a sensor's placement (SENSOR-MEDIUM-161/206). Its site,
 * department, system and unit are written only after farm, the owner of the
 * topology, accepts the path (`request.farm.resolveDevicePlacement`), and the
 * unit is stored as a tank or as equipment by farm's answer. Registration
 * resolves through here; a move is `relocate`, the only UPDATE of those
 * columns — the entity marks them `update: false`, so no ORM save can write
 * them, and a copy loaded before a move cannot put the sensor back.
 */
@Injectable()
export class SensorPlacementService {
  private readonly logger = new Logger(SensorPlacementService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly requestReply: NatsRequestReply,
    private readonly circuitBreaker: CircuitBreakerService,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  /**
   * The columns a sensor standing at the requested place stores; UNPLACED for
   * no place. Refused (400, with the level's code) when farm refuses a level;
   * 503 when farm cannot answer — a placement is never stored unchecked.
   */
  async resolve(tenantId: string, request: PlacementRequest | null): Promise<SensorPlacement> {
    if (request === null) {
      return UNPLACED;
    }
    const asked: ResolveDevicePlacementRequest = { tenantId, ...request };
    let response: unknown;
    try {
      response = await this.circuitBreaker.execute<unknown>({
        serviceName: 'sensor-farm-device-placement',
        tenantId,
        options: { ...DEFAULT_BREAKER_OPTIONS, failureMode: 'fail-closed' },
        fn: () =>
          this.requestReply.requestTyped<ResolveDevicePlacementRequest, unknown>(
            FARM_DEVICE_PLACEMENT_QUERY_SUBJECTS.RESOLVE,
            asked,
            { timeoutMs: FARM_PLACEMENT_TIMEOUT_MS },
          ),
      });
    } catch (error) {
      this.logFarmFailure('request_failed', error);
      throw unavailable();
    }
    if (!isResolveDevicePlacementResponse(response)) {
      this.logFarmFailure('malformed_response');
      throw unavailable();
    }
    if (!response.placeable) {
      throw new BadRequestException(REFUSAL[response.refusedAt]);
    }
    return {
      siteId: request.siteId,
      departmentId: request.departmentId,
      systemId: request.systemId,
      tankId: response.unitKind === 'TANK' ? request.unitId : null,
      equipmentId: response.unitKind === 'EQUIPMENT' ? request.unitId : null,
      placedAt: new Date(),
    };
  }

  /**
   * Move a sensor to a place farm accepts, and return it as it now stands.
   *
   * - A parent device moves with its child sensors: they share its connection
   *   and its channels carry their data. A child is never moved alone.
   * - Each sensor whose place changes is stamped `placed_at = now()`, so no
   *   reader pairs a sample taken before the move with the new place; its
   *   legacy farm and pond end with the move.
   * - Each moved sensor gets, in the same transaction, a sensor_audit_logs
   *   row with its old and new place and who moved it (the SQL UPDATE does
   *   not pass through the entity subscriber), and a configuration-updated
   *   event through the outbox, so cached copies of its place are dropped.
   *   An audit row that cannot be written rolls the move back.
   * - Re-saving the same place changes nothing.
   */
  async relocate(
    tenantId: string,
    sensorId: string,
    request: PlacementRequest,
    actorId: string | null,
  ): Promise<Sensor> {
    const placement = await this.resolve(tenantId, request);
    // Bound to the tenant explicitly, not through the request's pool session,
    // so the move reads and writes inside that tenant's RLS boundary only.
    return runInTenantTransaction(this.dataSource, SENSOR_SOURCE_SCHEMA, tenantId, async (qr) => {
      const manager = qr.manager;
      const sensor = await manager.findOne(Sensor, {
        where: { id: sensorId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!sensor) {
        throw new NotFoundException(`Sensor not found: ${sensorId}`);
      }
      if (sensor.parentId) {
        throw new BadRequestException({
          message: 'A child sensor stands where its parent device stands; move the parent device',
          code: SENSOR_PLACEMENT_ERROR.FOLLOWS_PARENT,
        });
      }
      const children = sensor.isParentDevice
        ? await manager.find(Sensor, {
            where: { parentId: sensor.id, tenantId },
            lock: { mode: 'pessimistic_write' },
          })
        : [];
      const moving = [sensor, ...children].filter((row) => !standsAt(row, placement));
      if (moving.length > 0) {
        await movePlacement(manager, tenantId, moving, placement);
        const protocolCode = await this.protocolCodeOf(manager, sensor);
        const next = placeAfterMove(placement);
        for (const row of moving) {
          const changedFields = await recordEntityUpdate(manager, {
            tenantId,
            entityType: Sensor.name,
            entityId: row.id,
            previous: placeOf(row),
            next,
            changedBy: actorId,
          });
          await this.outboxPublisher.enqueue(
            placementChanged(row, protocolCode, changedFields),
            manager,
          );
        }
      }
      this.logger.log(
        JSON.stringify({ event: 'sensor_relocated', tenantId, sensorId, moved: moving.length }),
      );
      return manager.findOneOrFail(Sensor, { where: { id: sensorId, tenantId } });
    });
  }

  private async protocolCodeOf(manager: EntityManager, sensor: Sensor): Promise<string> {
    if (!sensor.protocolId) return '';
    const protocol = await manager.findOne(SensorProtocol, {
      select: { id: true, code: true },
      where: { id: sensor.protocolId },
    });
    return protocol?.code ?? '';
  }

  private logFarmFailure(reason: string, error?: unknown): void {
    this.logger.warn(
      JSON.stringify({
        event: 'sensor_placement_farm_unavailable',
        reason,
        errorType: error instanceof Error ? error.name : undefined,
      }),
    );
  }
}

function unavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message: 'Placement cannot be checked right now',
    code: SENSOR_PLACEMENT_ERROR.UNAVAILABLE,
  });
}

/**
 * Whether a sensor already stands at this place: the same site, department,
 * system and unit (whichever column an older row keeps a tank in), and no
 * legacy farm or pond left over from a place it no longer stands at.
 */
function standsAt(sensor: Sensor, placement: SensorPlacement): boolean {
  return (
    (sensor.siteId ?? null) === placement.siteId &&
    (sensor.departmentId ?? null) === placement.departmentId &&
    (sensor.systemId ?? null) === placement.systemId &&
    (sensor.tankId ?? sensor.equipmentId ?? null) === (placement.tankId ?? placement.equipmentId) &&
    (sensor.farmId ?? null) === null &&
    (sensor.pondId ?? null) === null
  );
}

/**
 * The one UPDATE of a sensor's place. The entity marks these columns
 * `update: false`, so this statement — in the caller's tenant transaction,
 * the rows already locked — is the only write after insert.
 */
async function movePlacement(
  manager: EntityManager,
  tenantId: string,
  sensors: readonly Sensor[],
  placement: SensorPlacement,
): Promise<void> {
  // placed_at comes from the application clock, the one samples are stamped
  // with on receipt, so "taken before the move" compares like with like.
  await manager.query(
    `UPDATE sensors
        SET site_id = $3, department_id = $4, system_id = $5, tank_id = $6, equipment_id = $7,
            farm_id = NULL, pond_id = NULL, placed_at = $8, updated_at = now()
      WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
    [
      tenantId,
      sensors.map((row) => row.id),
      placement.siteId,
      placement.departmentId,
      placement.systemId,
      placement.tankId,
      placement.equipmentId,
      placement.placedAt,
    ],
  );
}

/** A sensor's place as the audit row records it. */
function placeOf(sensor: Sensor): Record<string, unknown> {
  return {
    siteId: sensor.siteId ?? null,
    departmentId: sensor.departmentId ?? null,
    systemId: sensor.systemId ?? null,
    tankId: sensor.tankId ?? null,
    equipmentId: sensor.equipmentId ?? null,
    farmId: sensor.farmId ?? null,
    pondId: sensor.pondId ?? null,
    placedAt: sensor.placedAt?.toISOString() ?? null,
  };
}

/** The place every moved sensor stands at after the move. */
function placeAfterMove(placement: SensorPlacement): Record<string, unknown> {
  return {
    siteId: placement.siteId,
    departmentId: placement.departmentId,
    systemId: placement.systemId,
    tankId: placement.tankId,
    equipmentId: placement.equipmentId,
    farmId: null,
    pondId: null,
    placedAt: placement.placedAt?.toISOString() ?? null,
  };
}

function placementChanged(
  sensor: Sensor,
  protocolCode: string,
  changedFields: string[],
): SensorConfigurationUpdatedEvent {
  return {
    ...createBaseEvent<SensorConfigurationUpdatedEvent>(
      'SensorConfigurationUpdated',
      sensor.tenantId,
      { aggregateId: sensor.id, aggregateType: 'Sensor' },
    ),
    sensorId: sensor.id,
    protocolCode,
    changedFields,
  };
}
