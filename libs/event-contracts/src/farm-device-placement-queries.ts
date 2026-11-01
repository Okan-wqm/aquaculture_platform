/**
 * Farm-owned device-placement contract: may a device stand at this place, and
 * is the unit there a tank or other water equipment.
 *
 * Farm is the only owner of its topology. A sensor names a path down it — a
 * site, optionally a department, and below the department optionally a
 * system and a unit (a tank, pond or cage, or other water equipment) — and
 * every level it names must be live and belong to the level above.
 * Sensor-service stores a placement only after farm accepts it, and stores
 * the unit as a tank or as equipment by farm's answer, never by what the
 * caller claimed (SENSOR-MEDIUM-161).
 *
 * The reply names only the first level that failed, never another tenant's
 * topology or a list of the tenant's units.
 */
export const FARM_DEVICE_PLACEMENT_QUERY_SUBJECTS = {
  RESOLVE: 'request.farm.resolveDevicePlacement',
} as const;

export interface ResolveDevicePlacementRequest {
  tenantId: string;
  siteId: string;
  departmentId: string | null;
  systemId: string | null;
  unitId: string | null;
}

/** The levels of a placement, in the order farm checks them. */
export const DEVICE_PLACEMENT_LEVELS = ['SITE', 'DEPARTMENT', 'SYSTEM', 'UNIT'] as const;
export type DevicePlacementLevel = (typeof DEVICE_PLACEMENT_LEVELS)[number];

/**
 * What a placed unit is, by farm's measurement rule (the one a channel bind
 * checks): TANK for a legacy tanks row or equipment flagged `isTank` (tanks,
 * ponds, cages), EQUIPMENT for other water equipment.
 */
export const DEVICE_PLACEMENT_UNIT_KINDS = ['TANK', 'EQUIPMENT'] as const;
export type DevicePlacementUnitKind = (typeof DEVICE_PLACEMENT_UNIT_KINDS)[number];

export type ResolveDevicePlacementResponse =
  | { placeable: true; unitKind: DevicePlacementUnitKind | null }
  | { placeable: false; refusedAt: DevicePlacementLevel };

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

const isOneOf = <T extends string>(options: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (options as readonly string[]).includes(value);

/** Runtime trust-boundary validation for the NATS request envelope. */
export function isResolveDevicePlacementRequest(
  value: unknown,
): value is ResolveDevicePlacementRequest {
  if (typeof value !== 'object' || value === null) return false;
  return (
    Object.keys(value).length === 5 &&
    'tenantId' in value &&
    typeof value.tenantId === 'string' &&
    'siteId' in value &&
    typeof value.siteId === 'string' &&
    'departmentId' in value &&
    isNullableString(value.departmentId) &&
    'systemId' in value &&
    isNullableString(value.systemId) &&
    'unitId' in value &&
    isNullableString(value.unitId)
  );
}

/** Runtime trust-boundary validation for the NATS reply. */
export function isResolveDevicePlacementResponse(
  value: unknown,
): value is ResolveDevicePlacementResponse {
  if (typeof value !== 'object' || value === null) return false;
  if (!('placeable' in value)) return false;
  if (value.placeable === true) {
    return (
      Object.keys(value).length === 2 &&
      'unitKind' in value &&
      (value.unitKind === null || isOneOf(DEVICE_PLACEMENT_UNIT_KINDS, value.unitKind))
    );
  }
  return (
    value.placeable === false &&
    Object.keys(value).length === 2 &&
    'refusedAt' in value &&
    isOneOf(DEVICE_PLACEMENT_LEVELS, value.refusedAt)
  );
}
