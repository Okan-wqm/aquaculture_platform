/** Canonical wire vocabulary for boolean query-string values. */
export const BOOLEAN_QUERY_VALUES_V1 = ['true', 'false'] as const;
export type BooleanQueryValueV1 = (typeof BOOLEAN_QUERY_VALUES_V1)[number];

export function booleanQueryValueV1(
  value: BooleanQueryValueV1 | undefined,
  defaultValue: boolean,
): boolean {
  return value === undefined ? defaultValue : value === 'true';
}
