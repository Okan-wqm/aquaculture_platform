/**
 * Where a device stands, from the unit picked in the registration wizard.
 *
 * Farm's equipment list presents tanks (tanks, ponds, cages) alongside water
 * equipment, with `isTank` set, and a tank's identity is its `tanks.id`. A
 * device placed in a tank therefore records it as `tankId`; only non-tank
 * water equipment (a biofilter, a sump, a degasser) is an `equipmentId`.
 * Recording a tank as equipment left every wizard-registered tank sensor
 * without a tank, so nothing could tell it stands in that tank.
 */
export interface PlacementUnit {
  id: string;
  isTank?: boolean | null;
}

export interface DevicePlacement {
  tankId: string | undefined;
  equipmentId: string | undefined;
}

export function devicePlacement(unit: PlacementUnit | undefined): DevicePlacement {
  if (unit === undefined) {
    return { tankId: undefined, equipmentId: undefined };
  }
  return unit.isTank === true
    ? { tankId: unit.id, equipmentId: undefined }
    : { tankId: undefined, equipmentId: unit.id };
}
