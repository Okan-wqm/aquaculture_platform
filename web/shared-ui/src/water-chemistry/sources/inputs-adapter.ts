/**
 * A measurement point's measured values → the engine's `WaterChemistryInputs`
 * — the ONE composition both water-chemistry views run (the farm calculator
 * at a point and the sensor monitoring view), so a point gives one answer.
 *
 * What a point reads (the backend resolves each set within its windows):
 *
 * - a system: its DOSING set (pH, alkalinity, temperature, salinity, calcium,
 *   and the loop's volume);
 * - a tank: its TOXICITY set (pH, temperature, salinity, TAN, H2S), and from
 *   its loop's DOSING set only what is the loop's — alkalinity, calcium and
 *   the volume — shown as the loop's.
 *
 * Per field:
 *
 * - measured: the input has a value and NO problem. The backend keeps a value
 *   it flags (NOT_SAME_SAMPLE, NOT_AT_SAME_POINT …): such a field is BLOCKED,
 *   shown with its value and problem, never used;
 * - configured: the loop volume, only when > 0 and the DOSING set is not
 *   REFUSED;
 * - corrected / entered: the operator's own value for this session (a
 *   correction of a covered field, an entry for a field no set covers);
 * - missing: neither. Nothing is ever defaulted.
 *
 * The engine runs when every measured field is usable. The loop volume only
 * scales a dose: dosing is offered at a system whose DOSING set is READY,
 * and its absence never blocks the charts.
 */
import type {
  WaterChemistryInputProblem,
  WaterChemistryInputSet,
  WaterChemistrySetProblem,
} from '../../generated/graphql-types';
import type { WaterChemistryInputs } from '../types';

import type { InputSetResult, InputStatusResult, ReadingResult } from './operations';
import type { SourceProblemCode } from './problems';

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

/** Every field the composition accounts for: the measured inputs and the loop volume. */
export type ResolvableField = EngineInputField | 'volume';

export const RESOLVABLE_FIELDS: readonly ResolvableField[] = [...ENGINE_INPUT_FIELDS, 'volume'];

/** What a tank reads from its loop's DOSING set: the loop's carbonate store and its water. */
export const LOOP_FIELDS: readonly ResolvableField[] = ['alkalinityMg', 'caMgL', 'volume'];

/** Decimals a field is shown with. */
export const FIELD_DECIMALS: Readonly<Record<ResolvableField, number>> = {
  pH: 2,
  tempC: 1,
  salinity: 1,
  alkalinityMg: 0,
  caMgL: 0,
  tan: 2,
  h2sUgL: 1,
  volume: 1,
};

export type FieldState =
  | 'measured'
  | 'configured'
  | 'corrected'
  | 'entered'
  | 'blocked'
  | 'missing';

export interface FieldProvenance {
  readonly field: ResolvableField;
  readonly state: FieldState;
  /** The value the engine may use; null when blocked or missing. */
  readonly value: number | null;
  /** Covered by the point's own set, its loop's, or neither. */
  readonly from: 'point' | 'loop' | null;
  readonly set: WaterChemistryInputSet | null;
  /** The resolved input (null for the volume and an uncovered field). */
  readonly input: InputStatusResult | null;
  /** The reading behind it — shown even when blocked. */
  readonly reading: ReadingResult | null;
  /** Why the field cannot be used (empty when it can). */
  readonly problems: readonly SourceProblemCode[];
}

/** The sets a point reads: its own, and for a tank its loop's DOSING set. */
export interface PointSets {
  readonly own: InputSetResult;
  readonly loop: InputSetResult | null;
}

/** The operator's session values: corrections of covered fields, entries for uncovered ones. */
export type OperatorEntries = Partial<Record<ResolvableField, number>>;

export type DosingAvailability =
  | { readonly available: true }
  | {
      readonly available: false;
      /** NOT_A_LOOP: the point is a tank — a dose is computed for its system. */
      readonly reason: 'NOT_A_LOOP' | 'NOT_READY';
      readonly problems: readonly SourceProblemCode[];
    };

export interface ComposedInputs {
  readonly fields: Readonly<Record<ResolvableField, FieldProvenance>>;
  readonly dosing: DosingAvailability;
}

const VOLUME_PROBLEMS: readonly WaterChemistrySetProblem[] = [
  'SYSTEM_NOT_RECIRCULATING',
  'VOLUME_MISSING',
  'VOLUME_BELOW_TANK_WATER',
];

function isEngineInputField(value: string): value is EngineInputField {
  return (ENGINE_INPUT_FIELDS as readonly string[]).includes(value);
}

function inputOf(set: InputSetResult, field: EngineInputField): InputStatusResult | undefined {
  return set.inputs.find(
    (candidate) => isEngineInputField(candidate.engineInput) && candidate.engineInput === field,
  );
}

function uncovered(field: ResolvableField, entries: OperatorEntries): FieldProvenance {
  const entered = entries[field];
  return {
    field,
    state: entered === undefined ? 'missing' : 'entered',
    value: entered === undefined ? null : entered,
    from: null,
    set: null,
    input: null,
    reading: null,
    problems: [],
  };
}

function measuredField(
  field: EngineInputField,
  sets: PointSets,
  entries: OperatorEntries,
): FieldProvenance {
  const own = inputOf(sets.own, field);
  const loopInput =
    own === undefined && sets.loop !== null && LOOP_FIELDS.includes(field)
      ? inputOf(sets.loop, field)
      : undefined;
  if (own === undefined && (loopInput === undefined || sets.loop === null)) {
    return uncovered(field, entries);
  }
  const input = own === undefined ? loopInput : own;
  const set = own === undefined ? sets.loop : sets.own;
  if (input === undefined || set === null) return uncovered(field, entries);

  const common = {
    field,
    from: own === undefined ? ('loop' as const) : ('point' as const),
    set: set.set,
    input,
    reading: input.reading,
  };
  const corrected = entries[field];
  if (corrected !== undefined) {
    return { ...common, state: 'corrected', value: corrected, problems: [] };
  }
  const value = input.reading === null ? null : input.reading.value;
  if (value !== null && input.problems.length === 0) {
    return { ...common, state: 'measured', value, problems: [] };
  }
  const problems: readonly WaterChemistryInputProblem[] =
    input.problems.length > 0 ? input.problems : ['NO_VALUE'];
  return { ...common, state: 'blocked', value: null, problems };
}

function dosingSetOf(sets: PointSets): { set: InputSetResult; from: 'point' | 'loop' } | null {
  if (sets.own.set === 'DOSING') return { set: sets.own, from: 'point' };
  if (sets.loop !== null && sets.loop.set === 'DOSING') return { set: sets.loop, from: 'loop' };
  return null;
}

function volumeField(sets: PointSets, entries: OperatorEntries): FieldProvenance {
  const dosing = dosingSetOf(sets);
  if (dosing === null) return uncovered('volume', entries);
  const common = {
    field: 'volume' as const,
    from: dosing.from,
    set: dosing.set.set,
    input: null,
    reading: null,
  };
  const corrected = entries.volume;
  if (corrected !== undefined) {
    return { ...common, state: 'corrected', value: corrected, problems: [] };
  }
  const volume = dosing.set.volumeM3;
  if (dosing.set.verdict !== 'REFUSED' && volume !== null && volume > 0) {
    return { ...common, state: 'configured', value: volume, problems: [] };
  }
  const problems = dosing.set.problems.filter((problem) => VOLUME_PROBLEMS.includes(problem));
  return {
    ...common,
    state: 'blocked',
    value: null,
    problems: problems.length > 0 ? problems : ['VOLUME_MISSING'],
  };
}

function dosingOf(sets: PointSets, volume: FieldProvenance): DosingAvailability {
  if (sets.own.set !== 'DOSING') {
    return { available: false, reason: 'NOT_A_LOOP', problems: [] };
  }
  if (sets.own.verdict !== 'READY' || volume.value === null) {
    return {
      available: false,
      reason: 'NOT_READY',
      problems: sets.own.problems.length > 0 ? sets.own.problems : volume.problems,
    };
  }
  return { available: true };
}

/** What a point's sets give each field, and whether a dose can be computed there. */
export function composePointInputs(sets: PointSets, entries: OperatorEntries): ComposedInputs {
  const measured = (field: EngineInputField): FieldProvenance =>
    measuredField(field, sets, entries);
  const volume = volumeField(sets, entries);
  return {
    fields: {
      pH: measured('pH'),
      tempC: measured('tempC'),
      salinity: measured('salinity'),
      alkalinityMg: measured('alkalinityMg'),
      caMgL: measured('caMgL'),
      tan: measured('tan'),
      h2sUgL: measured('h2sUgL'),
      volume,
    },
    dosing: dosingOf(sets, volume),
  };
}

export type EngineRecord =
  | {
      /** The record the engine runs on. */
      readonly inputs: WaterChemistryInputs;
      /** Whether a dose may be computed: false means pass no reagents (the volume is not read). */
      readonly dosing: boolean;
    }
  | {
      readonly inputs: null;
      /** The measured fields that keep the engine from running, in field order. */
      readonly blocking: readonly FieldProvenance[];
    };

/**
 * The engine record of a composed point over the calculator's settings
 * (targets, limits, fish): every measured field must be usable. Without a
 * usable volume the record carries NaN there — and `dosing: false`, so no
 * caller computes or shows a dose from it.
 */
export function engineRecordOf(
  composed: ComposedInputs,
  settings: WaterChemistryInputs,
): EngineRecord {
  const blocking = ENGINE_INPUT_FIELDS.map((field) => composed.fields[field]).filter(
    (entry) => entry.value === null,
  );
  if (blocking.length > 0) return { inputs: null, blocking };
  const value = (field: EngineInputField): number => {
    const entry = composed.fields[field].value;
    if (entry === null) throw new Error(`${field} is usable by construction`);
    return entry;
  };
  const volume = composed.fields.volume.value;
  return {
    inputs: {
      ...settings,
      pH: value('pH'),
      tempC: value('tempC'),
      salinity: value('salinity'),
      alkalinityMg: value('alkalinityMg'),
      caMgL: value('caMgL'),
      tan: value('tan'),
      h2sUgL: value('h2sUgL'),
      volume: volume === null ? Number.NaN : volume,
    },
    dosing: composed.dosing.available && volume !== null,
  };
}

/** The usable value of every field (null: blocked or missing) — what a read-only form shows. */
export function usableValues(
  composed: ComposedInputs,
): Readonly<Record<ResolvableField, number | null>> {
  const { fields } = composed;
  return {
    pH: fields.pH.value,
    tempC: fields.tempC.value,
    salinity: fields.salinity.value,
    alkalinityMg: fields.alkalinityMg.value,
    caMgL: fields.caMgL.value,
    tan: fields.tan.value,
    h2sUgL: fields.h2sUgL.value,
    volume: fields.volume.value,
  };
}
