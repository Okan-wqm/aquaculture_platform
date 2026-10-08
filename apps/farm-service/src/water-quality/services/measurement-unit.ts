import type { EntityManager } from 'typeorm';

import {
  findTankOrEquipmentWithManager,
  resolveSiteIdFromDepartment,
} from '../../batch/utils/tank-lookup.util';

/**
 * The unit a water-quality measurement was taken at, resolved from the one id
 * a client sends.
 *
 * Every client — RecordTab, BulkRecordTab, AquaMobil (including its offline
 * queue) — sends the picked unit as `equipmentId`, and farm's equipment list
 * presents tanks (tanks, ponds, cages; a legacy `equipment.isTank` row too)
 * beside non-tank water equipment. The measurement row has a column for each:
 * a tank is recorded as `tankId`, a biofilter or sump as `equipmentId`. The
 * writers used to copy the one id into both columns (or only into
 * `equipmentId`), so tank readers missed batch rows and a site check that read
 * only `tankId` denied equipment-only submissions. The classification is
 * farm's, made here once, so no client and no queued payload has to change.
 * Readers name a row's unit through measurement-unit-reader.ts.
 */
export type MeasurementUnitKind = 'tank' | 'equipment';

export interface MeasurementUnit {
  kind: MeasurementUnitKind;
  id: string;
  /** The unit's site through its department; null when it has none (fail-closed for site checks). */
  siteId: string | null;
}

export interface MeasurementUnitColumns {
  tankId: string | undefined;
  equipmentId: string | undefined;
}

/** The active unit with this id in the tenant, or null when there is none. */
export async function resolveMeasurementUnit(
  manager: EntityManager,
  unitId: string,
  tenantId: string,
): Promise<MeasurementUnit | null> {
  const lookup = await findTankOrEquipmentWithManager(manager, unitId, tenantId);
  if (lookup === null) {
    return null;
  }
  const isTank = lookup.isFromTanksTable || lookup.equipment.isTank === true;
  return {
    kind: isTank ? 'tank' : 'equipment',
    id: unitId,
    siteId: await resolveSiteIdFromDepartment(manager, lookup.equipment.departmentId, tenantId),
  };
}

/** The measurement columns a unit is recorded in: a tank's id or an equipment id, never both. */
export function measurementUnitColumns(unit: MeasurementUnit | null): MeasurementUnitColumns {
  if (unit === null) {
    return { tankId: undefined, equipmentId: undefined };
  }
  return unit.kind === 'tank'
    ? { tankId: unit.id, equipmentId: undefined }
    : { tankId: undefined, equipmentId: unit.id };
}
