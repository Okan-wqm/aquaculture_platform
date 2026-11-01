import { isValidUUID, runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { NatsRequestReply, type RequestReplyResponderHandle } from '@platform/event-bus';
import {
  FARM_DEVICE_PLACEMENT_QUERY_SUBJECTS,
  isResolveDevicePlacementRequest,
  type ResolveDevicePlacementRequest,
  type ResolveDevicePlacementResponse,
} from '@platform/event-contracts';
import { DataSource, type EntityManager } from 'typeorm';

import { findTankOrEquipmentWithManager } from '../../batch/utils/tank-lookup.util';
import { Department } from '../../department/entities/department.entity';
import { System } from '../../system/entities/system.entity';
import { loadFarmArrangement } from '../../water-quality/services/channel-placement';
import { unitKindOf } from '../../water-quality/services/measurement-unit';
import { Site } from '../entities/site.entity';

import { type DevicePlacementFacts, judgeDevicePlacement } from './device-placement-judgement';

/** A request that does not match the contract; the caller sees it as a failure. */
export class FarmDevicePlacementRequestInvalidError extends Error {
  constructor() {
    super('Device-placement request does not match its contract');
    this.name = 'FARM_DEVICE_PLACEMENT_REQUEST_INVALID';
  }
}

/** The farm read behind the answer failed; the caller must not store the placement. */
export class FarmDevicePlacementAuthorityUnavailableError extends Error {
  constructor() {
    super('Farm device-placement authority is temporarily unavailable');
    this.name = 'FARM_DEVICE_PLACEMENT_AUTHORITY_UNAVAILABLE';
  }
}

const LIVE = { isActive: true, isDeleted: false } as const;

/**
 * Core-NATS responder: may a device stand at this place in farm's topology,
 * and is the unit there a tank or other water equipment
 * (`request.farm.resolveDevicePlacement`, SENSOR-MEDIUM-161).
 *
 * Sensor-service asks before it stores a sensor's placement, on registration
 * and on a move. The facts are read in the tenant's boundary with the lookups
 * the rest of farm uses: a live unit (`findTankOrEquipmentWithManager`)
 * classified by the measurement rule (`unitKindOf`, the one a channel bind
 * checks), and its systems (`loadFarmArrangement`); the decision is
 * `judgeDevicePlacement`. Broker ACLs decide who may publish the
 * subject (services.yaml); caller identity is never read from headers.
 */
@Injectable()
export class ResolveDevicePlacementResponder implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ResolveDevicePlacementResponder.name);
  private responder: RequestReplyResponderHandle | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly requestReply: NatsRequestReply,
  ) {}

  async onModuleInit(): Promise<void> {
    this.responder = await this.requestReply.respond<
      ResolveDevicePlacementRequest,
      ResolveDevicePlacementResponse
    >(FARM_DEVICE_PLACEMENT_QUERY_SUBJECTS.RESOLVE, (request) => this.resolve(request), {
      queue: 'farm-service',
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.responder?.drain();
    this.responder = null;
  }

  async resolve(request: ResolveDevicePlacementRequest): Promise<ResolveDevicePlacementResponse> {
    if (!isResolveDevicePlacementRequest(request) || !isValidUUID(request.tenantId)) {
      throw new FarmDevicePlacementRequestInvalidError();
    }
    try {
      const facts = await runInTenantRead(
        this.dataSource,
        'farm',
        request.tenantId,
        (queryRunner) => loadDevicePlacementFacts(queryRunner.manager, request),
      );
      return judgeDevicePlacement(request, facts);
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'farm_device_placement_authority_unavailable',
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
      throw new FarmDevicePlacementAuthorityUnavailableError();
    }
  }
}

/** A level id that is not a uuid names nothing at that level. */
function named(id: string | null): string | null {
  return id !== null && isValidUUID(id) ? id : null;
}

/**
 * Reads, in the caller's tenant boundary, what farm knows about each level the
 * request names: only live rows count, and a level named by a non-uuid is
 * read as absent.
 */
export async function loadDevicePlacementFacts(
  manager: EntityManager,
  request: ResolveDevicePlacementRequest,
): Promise<DevicePlacementFacts> {
  const { tenantId } = request;
  const siteId = named(request.siteId);
  const departmentId = named(request.departmentId);
  const systemId = named(request.systemId);
  const unitId = named(request.unitId);

  const site =
    siteId === null
      ? null
      : await manager.findOne(Site, {
          select: { id: true },
          where: { id: siteId, tenantId, ...LIVE },
        });
  const department =
    departmentId === null
      ? null
      : await manager.findOne(Department, {
          select: { id: true, siteId: true },
          where: { id: departmentId, tenantId, ...LIVE },
        });
  const system =
    systemId === null
      ? null
      : await manager.findOne(System, {
          select: { id: true, siteId: true, departmentId: true },
          where: { id: systemId, tenantId, ...LIVE },
        });

  let unit: DevicePlacementFacts['unit'] = null;
  if (unitId !== null) {
    const found = await findTankOrEquipmentWithManager(manager, unitId, tenantId);
    if (found !== null) {
      const arrangement = await loadFarmArrangement(manager, tenantId, {
        units: [unitId],
        systems: [],
      });
      unit = {
        kind: unitKindOf(found) === 'tank' ? 'TANK' : 'EQUIPMENT',
        departmentId: found.equipment.departmentId ?? null,
        systemIds: arrangement.systemsOfUnit.get(unitId) ?? new Set<string>(),
      };
    }
  }

  return {
    siteLive: site !== null,
    department: department === null ? null : { siteId: department.siteId ?? null },
    system:
      system === null ? null : { siteId: system.siteId, departmentId: system.departmentId ?? null },
    unit,
  };
}
