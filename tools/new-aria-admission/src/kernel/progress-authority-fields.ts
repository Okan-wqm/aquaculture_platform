import { compareCodePoints } from './canonical-json';
import type { JsonValue } from './strict-json';

const sha64 = /^[a-f0-9]{64}$/u;

export function progressAuthorityDigest(value: JsonValue | undefined, field: string): string {
  if (typeof value !== 'string' || !sha64.test(value)) {
    throw new TypeError(`progress authority ${field} is invalid`);
  }
  return value;
}

export function sortedProgressAuthorityIdentifiers(
  value: JsonValue | undefined,
  pattern: RegExp,
  label: string,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== 'string')
  ) {
    throw new TypeError(`${label} must be a non-empty string array`);
  }
  const identifiers = value as string[];
  if (identifiers.some((item) => !pattern.test(item))) {
    throw new TypeError(`${label} contains a malformed identifier`);
  }
  const expected = [...identifiers].sort(compareCodePoints);
  if (
    new Set(identifiers).size !== identifiers.length ||
    identifiers.some((item, index) => item !== expected[index])
  ) {
    throw new TypeError(`${label} must be unique and code-point sorted`);
  }
  return identifiers;
}
