import { unitConversion } from '@aquaculture/shared-contracts';
import type { EntityManager } from 'typeorm';

import { declarableQuantitiesOfParameter, parameterQuantity } from '../data/parameter-quantities';
import { WaterQualityMeasurement } from '../entities/water-quality-measurement.entity';
import type { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';

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

/**
 * Whether changing a parameter's unit from `from` to `to` changes what its
 * values mean — the one predicate the config update, the template overwrite
 * and the bound-channel check share.
 *
 * Two spellings of one unit (`''` and `pH`, `mg/L CaCO₃` and `mg/L CaCO3`,
 * `°C` and `℃`) are not a change: the registry maps both to the same
 * conversion onto the parameter's quantity. A unit the registry cannot place
 * for the quantity (or a parameter that records no quantity yet, among the
 * quantities it may be declared as) is a change unless the strings are equal.
 */
export function unitMeaningChanged(
  config: Pick<WaterQualityParameterConfig, 'code' | 'declaredQuantity'>,
  from: string,
  to: string,
): boolean {
  if (from.trim() === to.trim()) {
    return false;
  }
  const quantity = parameterQuantity(config.code, config.declaredQuantity);
  const candidates = quantity !== null ? [quantity] : declarableQuantitiesOfParameter(config.code);
  return !candidates.some((candidate) => {
    const before = unitConversion(candidate, from);
    const after = unitConversion(candidate, to);
    return (
      before !== null &&
      after !== null &&
      before.factor === after.factor &&
      (before.offset ?? 0) === (after.offset ?? 0)
    );
  });
}
