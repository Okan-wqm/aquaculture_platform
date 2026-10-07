/**
 * The sensor-reading time range — ONE place for every preset duration, the
 * shape of a relative-or-absolute range, and how it is checked, parsed and
 * written to a URL.
 *
 * WHY here: the same durations were hand-written in eight places across the
 * readings page, the widget dashboard, the heatmap, the SCADA trend widget,
 * the chart toolbar and the chart export, each with its own fallback for an
 * unknown value (one silently became 24 h, another 1 h). The cap a range may
 * span comes from the tier policy, the same number the backend enforces, so
 * the browser cannot offer a range the server refuses.
 *
 * Zero dependencies, `as const` tables (shared-contracts declares no enums).
 */

import { MAX_SERIES_RANGE_MS } from './tier-policy';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Every relative preset any surface may offer, shortest first. */
export const RELATIVE_TIME_RANGE_PRESETS = [
  { key: 'live', ms: 5 * MINUTE_MS },
  { key: '1h', ms: HOUR_MS },
  { key: '6h', ms: 6 * HOUR_MS },
  { key: '8h', ms: 8 * HOUR_MS },
  { key: '24h', ms: DAY_MS },
  { key: '3d', ms: 3 * DAY_MS },
  { key: '7d', ms: 7 * DAY_MS },
  { key: '30d', ms: 30 * DAY_MS },
  { key: '90d', ms: 90 * DAY_MS },
  { key: '365d', ms: 365 * DAY_MS },
] as const;

export type RelativePresetKey = (typeof RELATIVE_TIME_RANGE_PRESETS)[number]['key'];

/** The duration of a preset. */
export function presetDurationMs(key: RelativePresetKey): number {
  const preset = RELATIVE_TIME_RANGE_PRESETS.find((candidate) => candidate.key === key);
  if (preset === undefined) {
    throw new Error(`Unknown time-range preset: ${key}`);
  }
  return preset.ms;
}

/** A preset key from untrusted input (a URL, a stored widget config), or null. */
export function parsePresetKey(value: unknown): RelativePresetKey | null {
  const preset = RELATIVE_TIME_RANGE_PRESETS.find((candidate) => candidate.key === value);
  return preset === undefined ? null : preset.key;
}

/**
 * The SCADA chart vocabulary (FUXA-style `last1h` … `last1m`) as names for
 * presets of this table. The SCADA trend chart, its toolbar and its export
 * speak these tokens; their durations come from here.
 */
export const SCADA_RANGE_TOKENS = [
  { token: 'last1h', preset: '1h' },
  { token: 'last8h', preset: '8h' },
  { token: 'last1d', preset: '24h' },
  { token: 'last3d', preset: '3d' },
  { token: 'last1w', preset: '7d' },
  { token: 'last1m', preset: '30d' },
] as const satisfies readonly { token: string; preset: RelativePresetKey }[];

export type ScadaRangeToken = (typeof SCADA_RANGE_TOKENS)[number]['token'];

/** The preset a SCADA chart token names. */
export function scadaRangePreset(token: ScadaRangeToken): RelativePresetKey {
  const entry = SCADA_RANGE_TOKENS.find((candidate) => candidate.token === token);
  if (entry === undefined) {
    throw new Error(`Unknown SCADA time-range token: ${token}`);
  }
  return entry.preset;
}

/** The duration of a SCADA chart token. */
export function scadaRangeDurationMs(token: ScadaRangeToken): number {
  return presetDurationMs(scadaRangePreset(token));
}

/** A range a chart shows: the last N of a preset, or a fixed window. */
export type TimeRangeSpec =
  | { readonly kind: 'relative'; readonly preset: RelativePresetKey }
  | { readonly kind: 'absolute'; readonly startMs: number; readonly endMs: number };

export type TimeRangeError = 'empty' | 'too-long' | 'invalid';

export type ResolvedTimeRange =
  | { readonly ok: true; readonly startMs: number; readonly endMs: number }
  | { readonly ok: false; readonly error: TimeRangeError };

/** The longest range a chart may request — the backend's own cap. */
export const MAX_TIME_RANGE_MS = MAX_SERIES_RANGE_MS;

/** The concrete window of a spec at `nowMs`, or why it cannot be shown. */
export function resolveTimeRange(spec: TimeRangeSpec, nowMs: number): ResolvedTimeRange {
  if (spec.kind === 'relative') {
    return { ok: true, startMs: nowMs - presetDurationMs(spec.preset), endMs: nowMs };
  }
  if (!Number.isFinite(spec.startMs) || !Number.isFinite(spec.endMs)) {
    return { ok: false, error: 'invalid' };
  }
  if (spec.endMs <= spec.startMs) {
    return { ok: false, error: 'empty' };
  }
  if (spec.endMs - spec.startMs > MAX_TIME_RANGE_MS) {
    return { ok: false, error: 'too-long' };
  }
  return { ok: true, startMs: spec.startMs, endMs: spec.endMs };
}

/** The URL parameters a range is written to: `range` or `from` + `to`. */
export interface TimeRangeParams {
  readonly range?: string | null;
  readonly from?: string | null;
  readonly to?: string | null;
}

export type ParsedTimeRange =
  | { readonly ok: true; readonly spec: TimeRangeSpec }
  | { readonly ok: false; readonly error: TimeRangeError };

/**
 * Read a range from URL parameters. Absent parameters are not an error (the
 * caller applies its default); present but malformed ones are, so a broken
 * link says so instead of quietly showing something else.
 */
export function parseTimeRangeParams(params: TimeRangeParams): ParsedTimeRange | null {
  const { range, from, to } = params;
  if (from || to) {
    const startMs = from ? Date.parse(from) : Number.NaN;
    const endMs = to ? Date.parse(to) : Number.NaN;
    const spec: TimeRangeSpec = { kind: 'absolute', startMs, endMs };
    const resolved = resolveTimeRange(spec, endMs);
    return resolved.ok ? { ok: true, spec } : { ok: false, error: resolved.error };
  }
  if (range) {
    const preset = parsePresetKey(range);
    return preset === null
      ? { ok: false, error: 'invalid' }
      : { ok: true, spec: { kind: 'relative', preset } };
  }
  return null;
}

/** The URL parameters for a range (ISO-8601 UTC instants for absolute ones). */
export function timeRangeToParams(spec: TimeRangeSpec): Record<string, string> {
  return spec.kind === 'relative'
    ? { range: spec.preset }
    : {
        from: new Date(spec.startMs).toISOString(),
        to: new Date(spec.endMs).toISOString(),
      };
}
