import {
  isValidUUID,
  readTenantMutationInstantV1,
  type TenantMutationSession,
} from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { Equipment } from '../../equipment/entities/equipment.entity';
import { FeedingDayPlan, FeedingDayPlanStatus } from '../entities/feeding-day-plan.entity';
import { DayPlanRecalcService } from './day-plan-recalc.service';

export const SENSOR_TEMPERATURE_RECALC_POLICY_V1 = Object.freeze({
  schemaVersion: 'sensor-temperature-recalc-policy/v1',
  maxUnitsPerReading: 128,
} as const);

interface SensorTemperatureRecalcTargetRow {
  readonly unitId: string;
}

/**
 * Closed sensor-projection → feeding mutation bridge.
 *
 * The projection listener owns event idempotency; this authority owns the
 * bounded target compiler and deterministic lock order. Entity-backed
 * QueryBuilder predicates keep physical SQL coordinates under TypeORM
 * metadata instead of introducing another handwritten relation authority.
 */
@Injectable()
export class SensorTemperatureRecalcAuthority {
  constructor(private readonly dayPlanRecalc: DayPlanRecalcService) {}

  async recalcAffectedUnits(
    manager: EntityManager,
    mutationSession: TenantMutationSession,
    tenantId: string,
    sensorId: string,
    temperatureC: number,
  ): Promise<number> {
    if (!isValidUUID(tenantId) || !isValidUUID(sensorId) || !Number.isFinite(temperatureC)) {
      throw new TypeError('Sensor temperature recalculation received invalid coordinates');
    }

    const rows = await manager
      .createQueryBuilder(FeedingDayPlan, 'plan')
      .innerJoin(Equipment, 'unit', 'unit.id = plan.unitId AND unit.tenantId = plan.tenantId')
      .select('plan.unitId', 'unitId')
      .distinct(true)
      .where('plan.tenantId = :tenantId', { tenantId })
      .andWhere('plan.status IN (:...statuses)', {
        statuses: [FeedingDayPlanStatus.PLANNED, FeedingDayPlanStatus.IN_PROGRESS],
      })
      .andWhere('unit.temperatureSensorId = :sensorId', { sensorId })
      .orderBy('plan.unitId', 'ASC')
      .take(SENSOR_TEMPERATURE_RECALC_POLICY_V1.maxUnitsPerReading + 1)
      .getRawMany<SensorTemperatureRecalcTargetRow>();

    if (rows.length > SENSOR_TEMPERATURE_RECALC_POLICY_V1.maxUnitsPerReading) {
      throw new Error(
        `Sensor ${sensorId} exceeds the governed recalculation fan-out of ` +
          SENSOR_TEMPERATURE_RECALC_POLICY_V1.maxUnitsPerReading,
      );
    }

    const unitIds = rows.map(({ unitId }) => unitId);
    if (unitIds.some((unitId) => !isValidUUID(unitId))) {
      throw new TypeError('Sensor temperature target compiler returned an invalid unitId');
    }
    if (new Set(unitIds).size !== unitIds.length) {
      throw new Error('Sensor temperature target compiler returned duplicate units');
    }
    if (unitIds.some((unitId, index) => index > 0 && unitIds[index - 1]! >= unitId)) {
      throw new Error('Sensor temperature targets violate canonical unit order');
    }
    if (unitIds.length === 0) return 0;

    const mutationInstant = await readTenantMutationInstantV1(mutationSession, 'farm');
    for (const unitId of unitIds) {
      await this.dayPlanRecalc.recalcForUnit(
        manager,
        mutationSession,
        tenantId,
        unitId,
        'temperature',
        { mutationInstant, newTemperatureC: temperatureC },
      );
    }
    return unitIds.length;
  }
}
