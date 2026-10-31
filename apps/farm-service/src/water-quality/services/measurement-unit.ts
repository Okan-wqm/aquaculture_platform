import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { type EntityManager, In } from 'typeorm';

import {
  findTankOrEquipmentWithManager,
  resolveSiteIdFromDepartment,
  resolveUnitSiteIds,
  type TankLookupResult,
} from '../../batch/utils/tank-lookup.util';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { Tank } from '../../tank/entities/tank.entity';

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

/**
 * Whether a looked-up unit is a tank (a legacy tanks row, or equipment flagged
 * `isTank`) or other water equipment — farm's one rule for a single unit, used
 * by a measurement's unit and by a sensor's placement
 * (site/responders/resolve-device-placement.responder.ts), so a placement and
 * a bind can never classify the same unit differently.
 */
export function unitKindOf(lookup: TankLookupResult): MeasurementUnitKind {
  return lookup.isFromTanksTable || lookup.equipment.isTank === true ? 'tank' : 'equipment';
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
  return {
    kind: unitKindOf(lookup),
    id: unitId,
    siteId: await resolveSiteIdFromDepartment(manager, lookup.equipment.departmentId, tenantId),
  };
}

/**
 * Bulk counterpart of {@link resolveMeasurementUnit} for a read over many
 * units (the dashboard's per-site oxygen read), so it is not N lookups: the
 * same rule in three queries — an active, undeleted equipment row first (a
 * tank when flagged `isTank`), else an active legacy tank, each read through
 * the tenant-scoped repository; the site from {@link resolveUnitSiteIds}, the
 * bulk unit-site lookup a single point's read authorizes by
 * (measurement-point-lookup.ts siteOfPoint), so one unit resolves to the same
 * site on either read. A unit with no active row is absent.
 */
export async function resolveMeasurementUnits(
  manager: EntityManager,
  unitIds: readonly string[],
  tenantId: string,
): Promise<Map<string, MeasurementUnit>> {
  const asked = [...new Set(unitIds)];
  if (asked.length === 0) {
    return new Map();
  }
  const kinds = new Map<string, MeasurementUnitKind>();
  const equipment = await tenantManagerRepo(manager, Equipment, tenantId).find({
    where: { id: In(asked), isActive: true, isDeleted: false },
    select: { id: true, isTank: true },
  });
  for (const row of equipment) {
    kinds.set(row.id, row.isTank === true ? 'tank' : 'equipment');
  }
  const legacy = asked.filter((id) => !kinds.has(id));
  if (legacy.length > 0) {
    const tanks = await tenantManagerRepo(manager, Tank, tenantId).find({
      where: { id: In(legacy), isActive: true },
      select: { id: true },
    });
    for (const tank of tanks) {
      kinds.set(tank.id, 'tank');
    }
  }
  const found = asked.filter((id) => kinds.has(id));
  const sites =
    found.length === 0
      ? new Map<string, string>()
      : await resolveUnitSiteIds(manager, found, tenantId);
  const units = new Map<string, MeasurementUnit>();
  for (const id of found) {
    const kind = kinds.get(id);
    if (kind !== undefined) {
      units.set(id, { kind, id, siteId: sites.get(id) ?? null });
    }
  }
  return units;
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
