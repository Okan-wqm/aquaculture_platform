import type { EntityManager } from 'typeorm';

import { WaterQualityParamEquipment } from '../entities/water-quality-param-equipment.entity';
import type { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';

/**
 * What to record at a unit: the one rule the entry forms and the validator
 * share, so a form never asks for less or more than the server requires.
 *
 * A unit's plan is its manual plan lines (water_quality_param_equipment).
 * - A planned unit shows its plan; the plan's required parameters are
 *   required. A configured parameter outside the plan is still accepted
 *   (ad-hoc lab and vet samples).
 * - A unit nobody mapped shows every active parameter and requires none —
 *   before, its form showed nothing and every value was refused.
 * - With no unit (a site-level sample), every active parameter is shown and the
 *   tenant's required ones are required.
 */
export interface MeasurementPlanEntry {
  config: WaterQualityParameterConfig;
  required: boolean;
}

export interface MeasurementPlan {
  /** Whether the unit has a plan of its own (else every active parameter is offered). */
  planned: boolean;
  entries: MeasurementPlanEntry[];
}

/**
 * @param configs the tenant's active parameter configs
 * @param mappedCodes the codes mapped to the unit, or null when no unit is given
 */
export function measurementPlan(
  configs: readonly WaterQualityParameterConfig[],
  mappedCodes: ReadonlySet<string> | null,
): MeasurementPlan {
  const ordered = [...configs].sort((a, b) => a.displayOrder - b.displayOrder);
  if (mappedCodes === null) {
    return {
      planned: false,
      entries: ordered.map((config) => ({ config, required: config.isRequired })),
    };
  }
  if (mappedCodes.size === 0) {
    return { planned: false, entries: ordered.map((config) => ({ config, required: false })) };
  }
  return {
    planned: true,
    entries: ordered
      .filter((config) => mappedCodes.has(config.code))
      .map((config) => ({ config, required: config.isRequired })),
  };
}

/**
 * The codes of the parameters in a unit's manual-entry plan: its live manual
 * sources (`channelKey` NULL, `isActive`) at any position or depth. A bound
 * sensor channel is not a plan line: counting it made an unplanned unit
 * `planned` with only the channel's parameter, and its forms dropped every
 * other parameter and refused manual samples as missing required ones. A
 * unit id names a tank point or an
 * equipment point (the classifier filed it), so both columns are matched. An
 * inner join: a mapping whose config row is gone (tenant schemas carry no FK)
 * names no parameter, and so does one whose config is soft-deleted
 * (`isActive` false — deleting a config leaves its mappings active) or
 * belongs to another tenant. Otherwise such a mapping made the unit `planned`
 * with no entries, and its form offered nothing.
 */
export async function mappedCodesForUnit(
  manager: EntityManager,
  tenantId: string,
  unitId: string,
): Promise<Set<string>> {
  const rows = await manager
    .createQueryBuilder(WaterQualityParamEquipment, 'mapping')
    .innerJoin('mapping.parameterConfig', 'config')
    .select('config.code', 'code')
    .where('mapping.tenantId = :tenantId', { tenantId })
    .andWhere('(mapping.tankId = :unitId OR mapping.equipmentId = :unitId)', { unitId })
    .andWhere('mapping.unboundAt IS NULL')
    .andWhere('mapping.channelKey IS NULL')
    .andWhere('mapping.isActive = true')
    .andWhere('config.isActive = true')
    .andWhere('config.tenantId = :tenantId', { tenantId })
    .getRawMany<{ code: string }>();
  return new Set(rows.map((row) => row.code));
}
