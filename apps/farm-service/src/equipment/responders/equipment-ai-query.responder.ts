import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { QueryBus, type PaginatedQueryResult } from '@platform/cqrs';
import {
  FARM_AI_QUERY_SUBJECTS,
  isEquipmentListRequest,
  isFeederCalibrationsRequest,
  toEventIso,
  type TenantBoundReply,
  type EquipmentDto,
  type EquipmentListReply,
  type FeederCalibrationDto,
  type FeederCalibrationsReply,
  type EquipmentStatusCode,
} from '@platform/event-contracts';
import { isoOrNull, numberOrNull, toBoundedList } from '../../common/nats/ai-query-responder';
import { EquipmentStatus, type Equipment } from '../entities/equipment.entity';
import type { FeederCalibration } from '../entities/feeder-calibration.entity';
import { ListEquipmentQuery } from '../queries/list-equipment.query';
import { ListFeederCalibrationsQuery } from '../queries/list-feeder-calibrations.query';
import { FarmAiResponder } from '../../common/tenant-boundary/farm-ai-responder';

/** No serial number, purchase price, specifications or location detail crosses. */
export function projectEquipment(row: Equipment): EquipmentDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    equipmentTypeName: row.equipmentType?.name ?? null,
    status: row.status,
    manufacturer: row.manufacturer ?? null,
    model: row.model ?? null,
    installationDate: isoOrNull(row.installationDate),
    warrantyEndDate: isoOrNull(row.warrantyEndDate),
    nextMaintenanceDate: isoOrNull(row.maintenanceSchedule?.nextMaintenanceDate),
    operatingHours: numberOrNull(row.operatingHours),
    isTank: row.isTank,
    isActive: row.isActive,
  };
}

export function projectCalibration(row: FeederCalibration): FeederCalibrationDto {
  return {
    id: row.id,
    feedSizeMm: Number(row.feedSizeMm),
    feedSizeLabel: row.feedSizeLabel,
    gramsPerDispensing: Number(row.gramsPerDispensing),
    siloCapacityKg: Number(row.siloCapacityKg),
    updatedAt: toEventIso(row.updatedAt),
  };
}

/**
 * The contract's status vocabulary is the entity enum's value set (guarded at
 * the boundary by `isEquipmentStatusCode`); the lookup is by enum VALUE so a
 * vocabulary drift between the two becomes a thrown INTERNAL_ERROR, never a
 * silently dropped filter.
 */
function toEquipmentStatus(code: EquipmentStatusCode | undefined): EquipmentStatus | undefined {
  if (code === undefined) return undefined;
  const status = Object.values(EquipmentStatus).find((value) => value === code);
  if (status === undefined) {
    throw new Error(`Equipment status ${code} is in the AI contract but not in EquipmentStatus`);
  }
  return status;
}

/** Equipment read surface for the farm operations specialist (FARM-MEDIUM-328). */
@Controller()
export class EquipmentAiQueryResponder {
  constructor(
    private readonly responder: FarmAiResponder,
    private readonly queryBus: QueryBus,
  ) {}

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.EQUIPMENT_LIST)
  listEquipment(@Payload() payload: unknown): Promise<TenantBoundReply<EquipmentListReply>> {
    return this.responder.respond(
      {
        subject: FARM_AI_QUERY_SUBJECTS.EQUIPMENT_LIST,
        isRequest: isEquipmentListRequest,
        handle: async (req, scope) => {
          const status = toEquipmentStatus(req.status);
          const page = await this.queryBus.execute<
            ListEquipmentQuery,
            PaginatedQueryResult<Equipment>
          >(
            new ListEquipmentQuery(
              scope,
              {
                isActive: true,
                ...(req.equipmentTypeId ? { equipmentTypeId: req.equipmentTypeId } : {}),
                ...(status ? { status } : {}),
                ...(req.isTank !== undefined ? { isTank: req.isTank } : {}),
              },
              { page: 1, limit: req.limit, sortBy: 'code', sortOrder: 'ASC' },
            ),
          );
          return toBoundedList(page.data, req.limit, projectEquipment, page.pagination.total);
        },
      },
      payload,
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.EQUIPMENT_FEEDER_CALIBRATIONS)
  listFeederCalibrations(
    @Payload() payload: unknown,
  ): Promise<TenantBoundReply<FeederCalibrationsReply>> {
    return this.responder.respond(
      {
        subject: FARM_AI_QUERY_SUBJECTS.EQUIPMENT_FEEDER_CALIBRATIONS,
        isRequest: isFeederCalibrationsRequest,
        handle: async (req, scope) => {
          const rows = await this.queryBus.execute<
            ListFeederCalibrationsQuery,
            FeederCalibration[]
          >(new ListFeederCalibrationsQuery(scope, req.equipmentId));
          return toBoundedList(rows, req.limit, projectCalibration);
        },
      },
      payload,
    );
  }
}
