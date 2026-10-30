/**
 * The stable codes (GraphQL `extensions.code`) of sensor-service's placement
 * refusals — `relocateSensor` and a registration that names a place — so the
 * device page says in the user's language which level farm refused, instead
 * of showing the server's English message (SENSOR-MEDIUM-206). Append-only.
 */
export const SENSOR_PLACEMENT_ERROR = {
  /** The site does not exist in the tenant or is not active. */
  REFUSED_SITE: 'PLACEMENT_REFUSED_SITE',
  /** The department is not active or is not at the site. */
  REFUSED_DEPARTMENT: 'PLACEMENT_REFUSED_DEPARTMENT',
  /** The system is not active or is not at the site and department. */
  REFUSED_SYSTEM: 'PLACEMENT_REFUSED_SYSTEM',
  /** The tank or equipment is not active or is not in the department and system. */
  REFUSED_UNIT: 'PLACEMENT_REFUSED_UNIT',
  /** A level below the site was named without the department above it. */
  INCOMPLETE: 'PLACEMENT_INCOMPLETE',
  /** A child sensor stands where its parent device stands; the parent is moved. */
  FOLLOWS_PARENT: 'PLACEMENT_FOLLOWS_PARENT',
  /** Farm could not be asked; nothing was stored. */
  UNAVAILABLE: 'PLACEMENT_UNAVAILABLE',
} as const;

export type SensorPlacementErrorCode =
  (typeof SENSOR_PLACEMENT_ERROR)[keyof typeof SENSOR_PLACEMENT_ERROR];

const CODES: ReadonlySet<string> = new Set(Object.values(SENSOR_PLACEMENT_ERROR));

/** Whether an error code is one of the placement refusals. */
export function isSensorPlacementErrorCode(code: unknown): code is SensorPlacementErrorCode {
  return typeof code === 'string' && CODES.has(code);
}
