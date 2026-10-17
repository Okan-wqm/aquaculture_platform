import { type EntityManager, In } from 'typeorm';

import {
  findTankOrEquipmentWithManager,
  resolveSiteIdFromDepartment,
} from '../../batch/utils/tank-lookup.util';
import { Department } from '../../department/entities/department.entity';
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

/**
 * Bulk counterpart of {@link resolveMeasurementUnit} for a read over many
 * units (the dashboard's per-site oxygen read), so it is not N lookups: the
 * same rule in three queries — an active, undeleted equipment row first (a
 * tank when flagged `isTank`), else an active legacy tank; the site through
 * the found row's department. A unit with no active row is absent.
 */
export async function resolveMeasurementUnits(
  manager: EntityManager,
  unitIds: readonly string[],
  tenantId: string,
): Promise<Map<string, MeasurementUnit>> {
  const asked = [...new Set(unitIds)];
  const found = new Map<string, { kind: MeasurementUnitKind; departmentId: string | null }>();
  if (asked.length === 0) {
    return new Map();
  }
  const equipment = await manager.find(Equipment, {
    where: { id: In(asked), tenantId, isActive: true, isDeleted: false },
    select: { id: true, isTank: true, departmentId: true },
  });
  for (const row of equipment) {
    found.set(row.id, {
      kind: row.isTank === true ? 'tank' : 'equipment',
      departmentId: row.departmentId ?? null,
    });
  }
  const legacy = asked.filter((id) => !found.has(id));
  if (legacy.length > 0) {
    const tanks = await manager.find(Tank, {
      where: { id: In(legacy), tenantId, isActive: true },
      select: { id: true, departmentId: true },
    });
    for (const tank of tanks) {
      found.set(tank.id, { kind: 'tank', departmentId: tank.departmentId });
    }
  }
  const departmentIds = [
    ...new Set(
      [...found.values()]
        .map((unit) => unit.departmentId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const departments =
    departmentIds.length === 0
      ? []
      : await manager.find(Department, {
          where: { id: In(departmentIds), tenantId },
          select: { id: true, siteId: true },
        });
  const siteOfDepartment = new Map(
    departments.map((department) => [department.id, department.siteId ?? null]),
  );
  const units = new Map<string, MeasurementUnit>();
  for (const [id, { kind, departmentId }] of found) {
    const siteId = departmentId === null ? null : (siteOfDepartment.get(departmentId) ?? null);
    units.set(id, { kind, id, siteId });
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
