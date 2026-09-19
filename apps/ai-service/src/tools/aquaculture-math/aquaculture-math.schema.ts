import type { AiPersonaTier } from '@aquaculture/shared-contracts';

/** Shared JSON-schema fragments and validation helpers for the pure-math tools. */

export const ALL_TIERS: readonly AiPersonaTier[] = ['operator', 'manager', 'expert', 'supervisor'];

export const TEMPERATURE_SCHEMA = {
  type: 'number',
  description: 'Water temperature (°C)',
  minimum: 0,
  maximum: 45,
} as const;

export const SALINITY_SCHEMA = {
  type: 'number',
  description: 'Salinity (ppt); 0 for fresh water (default)',
  minimum: 0,
  maximum: 45,
} as const;

/**
 * The tool-schema validator enforces `minimum`, not `exclusiveMinimum`; strict
 * positivity is asserted in each tool's `validate()` with `requireFinite`.
 */
export const POSITIVE_NUMBER_SCHEMA = {
  type: 'number',
  minimum: 0,
} as const;

export const PERCENT_SCHEMA = {
  type: 'number',
  minimum: 0,
  maximum: 100,
} as const;

/** Range check that also rejects NaN/Infinity (JSON numbers never carry them, but tool inputs are model-authored). */
export function requireFinite(field: string, value: unknown, min?: number, max?: number): string[] {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return [`${field} must be a finite number`];
  if (min !== undefined && value < min) return [`${field} must be ≥ ${min}`];
  if (max !== undefined && value > max) return [`${field} must be ≤ ${max}`];
  return [];
}

export function requireOptionalFinite(
  field: string,
  value: unknown,
  min?: number,
  max?: number,
): string[] {
  return value === undefined ? [] : requireFinite(field, value, min, max);
}

/** Decimal places the math tools present to the model (the engines never round). */
export const PRESENTATION_DECIMALS = 4;

/**
 * Presentation step (the engines return raw doubles): every finite number in
 * the result is rounded to `decimals` places so the model reads 1.3516, not
 * 1.3515504…; non-numbers pass through untouched.
 */
export function roundNumbersDeep<T>(value: T, decimals: number = PRESENTATION_DECIMALS): T {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return value;
    const factor = 10 ** decimals;
    return (Math.round(value * factor) / factor) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => roundNumbersDeep(item, decimals)) as T;
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = roundNumbersDeep(item, decimals);
    }
    return out as T;
  }
  return value;
}
