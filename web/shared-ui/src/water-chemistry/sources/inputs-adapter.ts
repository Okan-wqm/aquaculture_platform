/**
 * Measured values at a point → the engine's `WaterChemistryInputs`.
 *
 * The backend resolves each input of a calculation at a point
 * (`waterChemistryInputs`: DOSING at a system, TOXICITY at a tank) within its
 * coherence window, and says where each value came from. This adapter lays
 * those values over an input record and keeps, per field, where the value in
 * the record came from:
 *
 * - a field a resolved set covers takes the set's value — or the operator's
 *   session override of it — and is MISSING when the set has no value for it.
 *   A missing value is never filled from the base record or a default: the
 *   result's `inputs` is null (the engine-not-ready guard) and `missing` names
 *   what is absent, so a chart is never drawn from a value nobody measured;
 * - a field no set covers keeps the base record's value when the caller says
 *   the base holds the operator's entries (`uncovered: 'base'` — the
 *   calculator, e.g. TAN at a system point where DOSING does not read it), and
 *   is missing when it does not (`uncovered: 'missing'` — the live monitoring
 *   view, whose base holds only targets and limits).
 *
 * When several sets are passed, the first one covering a field wins: callers
 * pass the point's own set first and the loop's set after it.
 *
 * Overrides are the caller's session state (never persisted): an operator who
 * corrects a value for one calculation does not change what was measured.
 */
import type { WaterChemistryInputs } from '../types';

import type { InputSetResult, InputStatusResult, ReadingResult } from './operations';

/** The measured fields of WaterChemistryInputs a resolved set can fill (the backend's EngineInput). */
export const ENGINE_INPUT_FIELDS = [
  'pH',
  'tempC',
  'salinity',
  'alkalinityMg',
  'caMgL',
  'tan',
  'h2sUgL',
] as const;

export type EngineInputField = (typeof ENGINE_INPUT_FIELDS)[number];

/** Every field the adapter accounts for: the measured inputs and the loop volume (DOSING). */
export type ResolvableField = EngineInputField | 'volume';

export const RESOLVABLE_FIELDS: readonly ResolvableField[] = [...ENGINE_INPUT_FIELDS, 'volume'];

export type FieldOrigin = 'resolved' | 'override' | 'manual' | 'missing';

export interface FieldProvenance {
  readonly field: ResolvableField;
  readonly origin: FieldOrigin;
  /** The value in the record (null when missing). */
  readonly value: number | null;
  /** The set that covers the field; null when none does (the base record's value stands). */
  readonly set: InputSetResult['set'] | null;
  /** The resolved input, when a set covers the field (volume has none: it is the set's loop). */
  readonly input: InputStatusResult | null;
  /** The reading behind a resolved value — source, age, quality, inheritance. */
  readonly reading: ReadingResult | null;
}

export interface AppliedInputs {
  /** The record the engine may run on, or null while any covered field is missing. */
  readonly inputs: WaterChemistryInputs | null;
  readonly provenance: Readonly<Record<ResolvableField, FieldProvenance>>;
  /** Covered fields with neither a resolved value nor an override, in field order. */
  readonly missing: readonly ResolvableField[];
}

export type InputOverrides = Partial<Record<ResolvableField, number>>;

export interface ApplyOptions {
  /** Session-only corrections of covered fields. */
  readonly overrides: InputOverrides;
  /** What a field no set covers is: the base record's value, or missing. */
  readonly uncovered: 'base' | 'missing';
}

function isEngineInputField(value: string): value is EngineInputField {
  return (ENGINE_INPUT_FIELDS as readonly string[]).includes(value);
}

function coveringInput(
  sets: readonly InputSetResult[],
  field: EngineInputField,
): { set: InputSetResult; input: InputStatusResult } | null {
  for (const set of sets) {
    const input = set.inputs.find(
      (candidate) => isEngineInputField(candidate.engineInput) && candidate.engineInput === field,
    );
    if (input !== undefined) return { set, input };
  }
  return null;
}

function measuredProvenance(
  field: EngineInputField,
  base: WaterChemistryInputs,
  sets: readonly InputSetResult[],
  options: ApplyOptions,
): FieldProvenance {
  const covering = coveringInput(sets, field);
  if (covering === null) {
    return options.uncovered === 'base'
      ? { field, origin: 'manual', value: base[field], set: null, input: null, reading: null }
      : { field, origin: 'missing', value: null, set: null, input: null, reading: null };
  }
  const { set, input } = covering;
  const reading = input.reading;
  const override = options.overrides[field];
  if (override !== undefined) {
    return { field, origin: 'override', value: override, set: set.set, input, reading };
  }
  if (reading !== null && reading.value !== null) {
    return { field, origin: 'resolved', value: reading.value, set: set.set, input, reading };
  }
  return { field, origin: 'missing', value: null, set: set.set, input, reading };
}

/** The loop volume: a DOSING set's (a dose scales by it), else the base record's. */
function volumeProvenance(
  base: WaterChemistryInputs,
  sets: readonly InputSetResult[],
  options: ApplyOptions,
): FieldProvenance {
  const dosing = sets.find((set) => set.set === 'DOSING');
  if (dosing === undefined) {
    const uncovered = { field: 'volume', set: null, input: null, reading: null } as const;
    return options.uncovered === 'base'
      ? { ...uncovered, origin: 'manual', value: base.volume }
      : { ...uncovered, origin: 'missing', value: null };
  }
  const override = options.overrides.volume;
  const common = { field: 'volume', set: dosing.set, input: null, reading: null } as const;
  if (override !== undefined) return { ...common, origin: 'override', value: override };
  if (dosing.volumeM3 !== null) return { ...common, origin: 'resolved', value: dosing.volumeM3 };
  return { ...common, origin: 'missing', value: null };
}

export function applyResolved(
  base: WaterChemistryInputs,
  sets: readonly InputSetResult[],
  options: ApplyOptions,
): AppliedInputs {
  const measured = (field: EngineInputField): FieldProvenance =>
    measuredProvenance(field, base, sets, options);
  const provenance: Readonly<Record<ResolvableField, FieldProvenance>> = {
    pH: measured('pH'),
    tempC: measured('tempC'),
    salinity: measured('salinity'),
    alkalinityMg: measured('alkalinityMg'),
    caMgL: measured('caMgL'),
    tan: measured('tan'),
    h2sUgL: measured('h2sUgL'),
    volume: volumeProvenance(base, sets, options),
  };
  const fields = RESOLVABLE_FIELDS.map((field) => provenance[field]);
  const missing = fields.filter((entry) => entry.value === null).map((entry) => entry.field);
  if (missing.length > 0) {
    return { inputs: null, provenance, missing };
  }
  const inputs: WaterChemistryInputs = { ...base };
  for (const entry of fields) {
    if (entry.value !== null) inputs[entry.field] = entry.value;
  }
  return { inputs, provenance, missing };
}
