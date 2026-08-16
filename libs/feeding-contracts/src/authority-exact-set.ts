function duplicateAuthorityCoordinates(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (!value || value !== value.trim()) {
      throw new TypeError('Authority set coordinates must be canonical non-empty strings');
    }
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

/**
 * Proves both set equality and multiplicity. Converting to a Set before the
 * duplicate check would hide a second live mutation authority.
 */
export function assertExactAuthoritySetV1(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  const actualDuplicates = duplicateAuthorityCoordinates(actual);
  const expectedDuplicates = duplicateAuthorityCoordinates(expected);
  if (expectedDuplicates.length > 0) {
    throw new Error(
      `${label} catalog contains duplicate coordinates: ${expectedDuplicates.join(',')}`,
    );
  }
  if (actualDuplicates.length > 0) {
    throw new Error(
      `${label} runtime contains duplicate coordinates: ${actualDuplicates.join(',')}`,
    );
  }
  const observed = [...actual].sort();
  const authority = [...expected].sort();
  if (
    observed.length !== authority.length ||
    observed.some((value, index) => value !== authority[index])
  ) {
    throw new Error(
      `${label} registry differs: runtime=[${observed.join(',')}], catalog=[${authority.join(',')}]`,
    );
  }
}
