const SQL_DELIMITERS = new Set(["'", '"', ';', '\\', '`']);
const SQL_CONTROL_CODE_POINTS = new Set([0x00, 0x0a, 0x0d, 0x1a]);

/** Remove NUL code points without embedding control characters in a regex. */
export function stripNullCharacters(value: string): string {
  return Array.from(value)
    .filter((character) => character.codePointAt(0) !== 0x00)
    .join('');
}

/**
 * Reject delimiters/control characters that are invalid in caller-supplied
 * SQL identifiers. SQL values must still use bound parameters.
 */
export function containsSqlDelimiterOrControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      SQL_DELIMITERS.has(character) ||
      (codePoint !== undefined && SQL_CONTROL_CODE_POINTS.has(codePoint))
    );
  });
}
