import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import type { SensorChannelDescription } from '@platform/event-contracts';
import { type EntityManager, In } from 'typeorm';

import { resolveUnitSiteIds } from '../../batch/utils/tank-lookup.util';
import { EquipmentSystem } from '../../equipment/entities/equipment-system.entity';
import { System } from '../../system/entities/system.entity';
import { Tank } from '../../tank/entities/tank.entity';

import type { MeasurementPoint } from './parameter-sources';

/**
 * Whether a channel's sensor stands at a measurement point.
 *
 * The sensor service says where a sensor stands (site, system, tank, non-tank
 * equipment); farm owns how its units are arranged. When the sensor names a
 * unit, farm's topology decides which system and site that unit is in —
 * not the system the sensor was registered with (plan D12: farm topology
 * outranks the sensor's systemId). A sensor that names no unit stands at its
 * system, else at its site.
 *
 * - tank T: the sensor's tank or equipment id is T (the wizard writes a tank
 *   as equipment_id);
 * - equipment E: the sensor's equipment id is E;
 * - system S: the sensor's unit is in S, else its system is S;
 * - site X: the sensor's unit is at X, else its system is at X, else its site
 *   is X.
 *
 * Inheritance (a tank reading its loop's temperature) is a reading-time rule
 * (PR-4), not placement: a loop sensor does not stand at a tank.
 */
export type SensorLocation = Pick<
  SensorChannelDescription,
  'siteId' | 'systemId' | 'tankId' | 'equipmentId'
>;

/** Farm's arrangement of the units and systems the asked sensors name. */
export interface FarmPlacement {
  readonly systemsOfUnit: ReadonlyMap<string, ReadonlySet<string>>;
  readonly siteOfUnit: ReadonlyMap<string, string>;
  readonly siteOfSystem: ReadonlyMap<string, string>;
}

/** The farm unit a sensor names: its tank, else its equipment. */
function sensorUnit(sensor: SensorLocation): string | null {
  return sensor.tankId ?? sensor.equipmentId;
}

export function placedAt(
  point: MeasurementPoint,
  sensor: SensorLocation,
  farm: FarmPlacement,
): boolean {
  const unit = sensorUnit(sensor);
  switch (point.kind) {
    case 'tank':
      return sensor.tankId === point.id || sensor.equipmentId === point.id;
    case 'equipment':
      return sensor.equipmentId === point.id;
    case 'system':
      return unit !== null
        ? (farm.systemsOfUnit.get(unit)?.has(point.id) ?? false)
        : sensor.systemId === point.id;
    case 'site':
      if (unit !== null) {
        return farm.siteOfUnit.get(unit) === point.id;
      }
      return sensor.systemId !== null
        ? farm.siteOfSystem.get(sensor.systemId) === point.id
        : sensor.siteId === point.id;
  }
}

/** Reads farm's arrangement of the units and systems these sensors name. */
export async function loadFarmPlacement(
  manager: EntityManager,
  tenantId: string,
  sensors: readonly SensorLocation[],
): Promise<FarmPlacement> {
  return loadFarmArrangement(manager, tenantId, {
    units: sensors.map(sensorUnit).filter((id): id is string => id !== null),
    systems: sensors
      .filter((sensor) => sensorUnit(sensor) === null)
      .map((sensor) => sensor.systemId)
      .filter((id): id is string => id !== null),
  });
}

/**
 * Reads how farm arranges these units (tanks or water equipment) and systems:
 * the systems each unit is in (a tank's own system, and every system an
 * equipment row is linked to), each unit's site through its department, and
 * each live system's site. The one read of farm topology that placement and
 * the reading resolver's inheritance chain share.
 */
export async function loadFarmArrangement(
  manager: EntityManager,
  tenantId: string,
  asked: { readonly units: readonly string[]; readonly systems: readonly string[] },
): Promise<FarmPlacement> {
  const units = [...new Set(asked.units)];
  const systems = [...new Set(asked.systems)];
  const systemsOfUnit = new Map<string, Set<string>>();
  const addSystem = (unitId: string, systemId: string): void => {
    const known = systemsOfUnit.get(unitId) ?? new Set<string>();
    known.add(systemId);
    systemsOfUnit.set(unitId, known);
  };
  if (units.length > 0) {
    const tanks = await tenantManagerRepo(manager, Tank, tenantId).find({
      where: { id: In(units) },
      select: { id: true, systemId: true },
    });
    for (const tank of tanks) {
      if (tank.systemId) addSystem(tank.id, tank.systemId);
    }
    const links = await tenantManagerRepo(manager, EquipmentSystem, tenantId).find({
      where: { equipmentId: In(units) },
      select: { equipmentId: true, systemId: true },
    });
    for (const link of links) {
      addSystem(link.equipmentId, link.systemId);
    }
  }
  const siteOfSystem = new Map<string, string>();
  if (systems.length > 0) {
    const rows = await tenantManagerRepo(manager, System, tenantId).find({
      where: { id: In(systems), isDeleted: false },
      select: { id: true, siteId: true },
    });
    for (const system of rows) {
      siteOfSystem.set(system.id, system.siteId);
    }
  }
  return {
    systemsOfUnit,
    siteOfUnit: await resolveUnitSiteIds(manager, units, tenantId),
    siteOfSystem,
  };
}
