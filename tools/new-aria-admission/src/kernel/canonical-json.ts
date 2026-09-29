import { JsonValue } from './strict-json';

export const compareCodePoints = (left: string, right: string): number => {
  const a = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const b = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
};

const assertScalarString = (value: string): void => {
  for (let offset = 0; offset < value.length; offset += 1) {
    const unit = value.charCodeAt(offset);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(offset + 1);
      if (next < 0xdc00 || next > 0xdfff) throw new TypeError('unpaired high surrogate');
      offset += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError('unpaired low surrogate');
    }
  }
};

const serialize = (value: JsonValue, seen: Set<object>): string => {
  if (value === null || typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new TypeError('canonical JSON numbers must be safe integers');
    }
    return String(value);
  }
  if (typeof value === 'string') {
    assertScalarString(value);
    return JSON.stringify(value);
  }
  if (seen.has(value)) throw new TypeError('canonical JSON cannot contain cycles');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => serialize(entry, seen)).join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== null && prototype !== Object.prototype) {
      throw new TypeError('canonical JSON objects must be plain records');
    }
    const keys = Object.keys(value).sort(compareCodePoints);
    return `{${keys
      .map((key) => {
        assertScalarString(key);
        return `${JSON.stringify(key)}:${serialize(value[key] as JsonValue, seen)}`;
      })
      .join(',')}}`;
  } finally {
    seen.delete(value);
  }
};

export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(serialize(value as JsonValue, new Set<object>()), 'utf8');
}
