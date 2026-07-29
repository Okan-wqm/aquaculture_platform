/**
 * The config-service effective-configuration row, and how its value is read.
 *
 * Two pages now read config-service: system settings (platform scope) and
 * tenant configuration (per-tenant scope). They ask the same resolver for the
 * same row shape and face the same coercion question, so the shape and the
 * coercers have ONE author here rather than a copy in each — the second copy is
 * where "'false' is truthy" gets fixed on one page and not the other.
 *
 * Value coercion exists because `value` arrives as GraphQLJSON. A seeded row
 * comes back typed (number / boolean / parsed json) because the store preserves
 * `value_type`; a key first created through `setConfiguration` comes back as a
 * plain string. The coercers accept both so a page renders identically either
 * way.
 */

export interface EffectiveConfigurationRow {
  key: string;
  value: unknown;
  /** 'redacted' marks a secret FIELD; value is null when no secret is stored yet. */
  secretMode: 'none' | 'redacted';
  /**
   * Which partition answered.
   *
   * `'system'` means nobody set this key and the seeded default answered;
   * `'tenant'` means an operator decided it. Keeping the distinction on the wire
   * is what lets a settings page say "default" instead of implying every field
   * was chosen — the retired admin-api read path could not, because it invented
   * both.
   */
  source: 'tenant' | 'system';
  version: number;
}

export function coerceString(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

export function coerceNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
  }
  return fallback;
}

/**
 * A JSON list value as a string array.
 *
 * The store round-trips a `json` row either as the parsed array (seeded) or as
 * the JSON text (first written through `setConfiguration`), so both are read.
 * Anything else — an object, a number, malformed text — yields the fallback
 * rather than a partially-parsed list, because half a list of allowed file
 * types is a security decision nobody made.
 */
export function coerceStringList(value: unknown, fallback: readonly string[]): readonly string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === 'string');
      }
    } catch {
      return fallback;
    }
  }
  return fallback;
}
