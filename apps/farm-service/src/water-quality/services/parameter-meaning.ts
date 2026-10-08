import type { EntityManager } from 'typeorm';

import { WaterQualityMeasurement } from '../entities/water-quality-measurement.entity';

/**
 * Whether any measurement of the tenant recorded a value under this parameter
 * code (plan D7).
 *
 * A measurement stores its values keyed by code, in the unit the config named
 * when it was taken; no unit is stored beside the value. Re-coding or
 * re-uniting a config with recorded values would re-read every one of them
 * under the new meaning (a mg/L history shown as µg/L). Once values exist the
 * code and unit are fixed: a new meaning is a new config.
 */
export async function parameterHasMeasurements(
  manager: EntityManager,
  tenantId: string,
  code: string,
): Promise<boolean> {
  return manager
    .createQueryBuilder(WaterQualityMeasurement, 'measurement')
    .where('measurement.tenantId = :tenantId', { tenantId })
    .andWhere('jsonb_exists(measurement.parameters, :code)', { code })
    .getExists();
}
