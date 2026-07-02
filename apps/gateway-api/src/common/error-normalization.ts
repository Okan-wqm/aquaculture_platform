/**
 * Normalize unknown rejection values into Error instances.
 *
 * JavaScript promises may reject with arbitrary values, but gateway code
 * propagates errors through Nest filters and logs that expect Error shape.
 */
export function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }

  if (typeof value === 'string') {
    return new Error(value);
  }

  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
}
