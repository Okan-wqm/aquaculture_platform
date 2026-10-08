import {
  COHERENCE_WINDOW_MS,
  engineUnit,
  isRecirculating,
  PAIRING_TOLERANCE_MS,
  WATER_CHEMISTRY_INPUT_SETS,
  type WaterChemistryInputSet,
  type WaterChemistryInputSpec,
} from '../data/water-chemistry-input-sets';
import type { SystemType } from '../../system/entities/system.entity';

import type { ReadingCandidate, ResolvedReading } from './reading-resolution';

/**
 * Whether a water-chemistry calculation can run at a point now, and on what
 * (plan rev2 D3) — the decision, free of I/O; the facts are gathered by the
 * input-set query handler and the reading resolver.
 *
 * - REFUSED: the calculation does not apply here — a dosing recipe for a loop
 *   that does not recirculate, or whose volume is unknown or smaller than the
 *   water its own tanks hold (a recipe scaled to it would under-dose).
 * - INCOMPLETE: it applies, and an input has no usable value within its
 *   coherence window, or H2S and its pH are not one water sample (another
 *   point, or observed more than PAIRING_TOLERANCE_MS apart).
 * - READY: every input has a value, each within its window.
 */
export const WATER_CHEMISTRY_VERDICT = {
  READY: 'READY',
  INCOMPLETE: 'INCOMPLETE',
  REFUSED: 'REFUSED',
} as const;

export type WaterChemistryVerdict =
  (typeof WATER_CHEMISTRY_VERDICT)[keyof typeof WATER_CHEMISTRY_VERDICT];

/** Why a set is refused or incomplete. Append-only: the UI keys on them. */
export const WATER_CHEMISTRY_SET_PROBLEM = {
  /** The system's type is not one whose water recirculates (RAS, aquaponics, biofloc). */
  SYSTEM_NOT_RECIRCULATING: 'SYSTEM_NOT_RECIRCULATING',
  /** The system has no positive total water volume. */
  VOLUME_MISSING: 'VOLUME_MISSING',
  /** The system's total volume is smaller than the water its active tanks hold. */
  VOLUME_BELOW_TANK_WATER: 'VOLUME_BELOW_TANK_WATER',
  /** At least one input has a problem (see the inputs). */
  INPUTS_INCOMPLETE: 'INPUTS_INCOMPLETE',
} as const;

export type WaterChemistrySetProblem =
  (typeof WATER_CHEMISTRY_SET_PROBLEM)[keyof typeof WATER_CHEMISTRY_SET_PROBLEM];

/** Why one input cannot feed the calculation. Append-only: the UI keys on them. */
export const WATER_CHEMISTRY_INPUT_PROBLEM = {
  /** No active parameter records the input's quantity (a family undeclared, or none configured). */
  NO_PARAMETER: 'NO_PARAMETER',
  /** No source yielded a value within the input's window (see the reading's skipped candidates). */
  NO_VALUE: 'NO_VALUE',
  /** The input was read at another point than the input it must be read with (H2S and its pH). */
  NOT_AT_SAME_POINT: 'NOT_AT_SAME_POINT',
  /**
   * The input and the input it must be read with were observed further apart
   * than PAIRING_TOLERANCE_MS: not one water sample (the engine converts H2S
   * at the pH it is given).
   */
  NOT_SAME_SAMPLE: 'NOT_SAME_SAMPLE',
} as const;

export type WaterChemistryInputProblem =
  (typeof WATER_CHEMISTRY_INPUT_PROBLEM)[keyof typeof WATER_CHEMISTRY_INPUT_PROBLEM];

/** The loop a dosing set scales by. */
export interface LoopFacts {
  readonly type: SystemType;
  readonly volumeM3: number | null;
  /** The water the system's active tanks hold (each tank's water volume, else its volume). */
  readonly tankWaterM3: number;
}

/** The active parameter recording an input's quantity. */
export interface InputParameter {
  readonly id: string;
  readonly effectiveQuantity: string | null;
}

/** One input as resolved: its parameter (null when none records the quantity) and its reading. */
export interface InputFacts {
  readonly spec: WaterChemistryInputSpec;
  readonly parameter: InputParameter | null;
  readonly reading: ResolvedReading | null;
}

export interface InputStatus extends InputFacts {
  /** The unit the value is in: the engine's, the quantity's canonical unit. */
  readonly unit: string;
  readonly windowMs: number;
  readonly problems: readonly WaterChemistryInputProblem[];
}

export interface InputSetEvaluation {
  readonly set: WaterChemistryInputSet;
  readonly verdict: WaterChemistryVerdict;
  readonly problems: readonly WaterChemistrySetProblem[];
  readonly loop: LoopFacts | null;
  readonly inputs: readonly InputStatus[];
}

/** The window an input is read within: the caller passes it to the resolver as maxAgeMs. */
export function inputWindowMs(spec: WaterChemistryInputSpec): number {
  return COHERENCE_WINDOW_MS[spec.window];
}

export function evaluateInputSet(
  set: WaterChemistryInputSet,
  loop: LoopFacts | null,
  inputs: readonly InputFacts[],
): InputSetEvaluation {
  const spec = WATER_CHEMISTRY_INPUT_SETS[set];
  const statuses = inputs.map((input) => inputStatus(input, inputs));
  const problems: WaterChemistrySetProblem[] = spec.needsLoopVolume ? loopProblems(loop) : [];
  const refused = problems.length > 0;
  if (statuses.some((status) => status.problems.length > 0)) {
    problems.push(WATER_CHEMISTRY_SET_PROBLEM.INPUTS_INCOMPLETE);
  }
  return {
    set,
    verdict: refused
      ? WATER_CHEMISTRY_VERDICT.REFUSED
      : problems.length > 0
        ? WATER_CHEMISTRY_VERDICT.INCOMPLETE
        : WATER_CHEMISTRY_VERDICT.READY,
    problems,
    loop,
    inputs: statuses,
  };
}

function loopProblems(loop: LoopFacts | null): WaterChemistrySetProblem[] {
  if (loop === null) {
    // The handler proved the system point live before asking.
    throw new Error('A set scaled by a loop volume was evaluated without its loop');
  }
  const problems: WaterChemistrySetProblem[] = [];
  if (!isRecirculating(loop.type)) {
    problems.push(WATER_CHEMISTRY_SET_PROBLEM.SYSTEM_NOT_RECIRCULATING);
  }
  if (loop.volumeM3 === null || !(loop.volumeM3 > 0)) {
    problems.push(WATER_CHEMISTRY_SET_PROBLEM.VOLUME_MISSING);
  } else if (loop.volumeM3 < loop.tankWaterM3) {
    problems.push(WATER_CHEMISTRY_SET_PROBLEM.VOLUME_BELOW_TANK_WATER);
  }
  return problems;
}

/** Where an input's value came from, or null when it has none. */
function chosenOf(input: InputFacts): ReadingCandidate | null {
  return input.reading === null ? null : input.reading.chosen;
}

/** Why two paired readings are not one water sample: another point, or too far apart in time. */
function pairingProblems(
  here: ReadingCandidate,
  there: ReadingCandidate,
): WaterChemistryInputProblem[] {
  const problems: WaterChemistryInputProblem[] = [];
  if (here.point.kind !== there.point.kind || here.point.id !== there.point.id) {
    problems.push(WATER_CHEMISTRY_INPUT_PROBLEM.NOT_AT_SAME_POINT);
  }
  if (
    here.observedAt === null ||
    there.observedAt === null ||
    Math.abs(here.observedAt.getTime() - there.observedAt.getTime()) > PAIRING_TOLERANCE_MS
  ) {
    problems.push(WATER_CHEMISTRY_INPUT_PROBLEM.NOT_SAME_SAMPLE);
  }
  return problems;
}

function inputStatus(input: InputFacts, all: readonly InputFacts[]): InputStatus {
  const problems: WaterChemistryInputProblem[] = [];
  if (input.parameter === null) {
    problems.push(WATER_CHEMISTRY_INPUT_PROBLEM.NO_PARAMETER);
  } else if (input.reading === null || input.reading.value === null) {
    problems.push(WATER_CHEMISTRY_INPUT_PROBLEM.NO_VALUE);
  }
  const partner = all.find((other) => other.spec.engineInput === input.spec.pairedWith);
  const here = chosenOf(input);
  const there = partner === undefined ? null : chosenOf(partner);
  if (here !== null && there !== null) {
    problems.push(...pairingProblems(here, there));
  }
  return {
    ...input,
    unit: engineUnit(input.spec),
    windowMs: inputWindowMs(input.spec),
    problems,
  };
}
