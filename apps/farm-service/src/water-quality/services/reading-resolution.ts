import {
  convertUnit,
  type ChannelBindingProblem,
  type QuantityId,
} from '@aquaculture/shared-contracts';
import type { SensorChannelDescription, SensorSampleQuality } from '@platform/event-contracts';

import { ChannelSourcePriority } from '../entities/water-quality-param-equipment.entity';

import type { MeasurementPoint } from './parameter-sources';

/**
 * The value of a parameter at a measurement point, now — the decision, free
 * of I/O (the facts are gathered by ParameterReadingResolver).
 *
 * The point's sources are tried in a fixed precedence, and the first that
 * yields a value answers:
 *
 *   1. its primary channel, 2. its backup channel, 3. the latest manual
 *      sample taken there (a person's: manual, lab or calibration);
 *   then, only for a quantity the registry marks loop-homogeneous (D2), the
 *   same three at the system the point belongs to, then at its site —
 *   labelled inherited. DO, pH, CO2, the nitrogen species and sulfide are
 *   never inherited.
 *
 * A channel is tried only if the bind would accept it today
 * (`bindingProblems`, placement re-derived now — D12, FARM-MEDIUM-378), has a
 * sample, and that sample is not BAD. Its value is carried from the channel's
 * unit into the asked unit through the registry. A manual value is in its
 * parameter's unit (a parameter's code and unit are fixed once values exist,
 * D7). An answer carries its age; a caller that needs a recent value passes
 * its window (`maxAgeMs`), and an older candidate is skipped like any other —
 * the window is the caller's, never a constant here.
 *
 * Every candidate that existed and was passed over is reported with why.
 */
export const READING_SOURCE_KIND = {
  CHANNEL_PRIMARY: 'CHANNEL_PRIMARY',
  CHANNEL_BACKUP: 'CHANNEL_BACKUP',
  MANUAL: 'MANUAL',
} as const;

export type ReadingSourceKind = (typeof READING_SOURCE_KIND)[keyof typeof READING_SOURCE_KIND];

/** Why a source that could bind was passed over for its value. Append-only: the UI keys on them. */
export const READING_PROBLEM = {
  /** The channel has no sample since its unit or quantity last changed (within the sensor lookback). */
  NO_SAMPLE: 'NO_SAMPLE',
  /** The newest sample's quality band is BAD. */
  SAMPLE_QUALITY_BAD: 'SAMPLE_QUALITY_BAD',
  /** The value is older than the window the caller asked for. */
  OLDER_THAN_WINDOW: 'OLDER_THAN_WINDOW',
  /** A manual entry under the parameter's code is not a number. */
  VALUE_NOT_NUMERIC: 'VALUE_NOT_NUMERIC',
  /** The value cannot be carried into the asked unit. */
  UNIT_NOT_CONVERTIBLE: 'UNIT_NOT_CONVERTIBLE',
} as const;

export type ReadingProblem = (typeof READING_PROBLEM)[keyof typeof READING_PROBLEM];

/** Why no value was found. */
export const READING_UNRESOLVED = {
  /** No channel is bound and no manual sample was taken at the point (or where it may inherit from). */
  NO_SOURCE: 'NO_SOURCE',
  /** Sources exist, and every one was passed over (see the skipped candidates). */
  NO_USABLE_SOURCE: 'NO_USABLE_SOURCE',
} as const;

export type ReadingUnresolved = (typeof READING_UNRESOLVED)[keyof typeof READING_UNRESOLVED];

/** What the decision reads about the parameter. */
export interface ParameterToRead {
  readonly quantity: QuantityId | null;
  readonly unit: string;
}

export interface ChannelCandidateFacts {
  readonly sourceId: string;
  readonly priority: ChannelSourcePriority;
  readonly description: SensorChannelDescription;
  /** The bind's rule applied now, placement included; empty when the bind would accept it. */
  readonly bindingProblems: readonly ChannelBindingProblem[];
}

export interface ManualCandidateFacts {
  readonly measurementId: string;
  readonly measuredAt: Date;
  /** The value stored under the parameter's code, as stored. */
  readonly value: unknown;
}

/** One place the value may come from: the point itself, or a system or site it inherits from. */
export interface ReadingLevel {
  readonly point: MeasurementPoint;
  readonly inherited: boolean;
  readonly channels: readonly ChannelCandidateFacts[];
  readonly manual: ManualCandidateFacts | null;
}

export interface ReadingAsk {
  readonly parameter: ParameterToRead;
  /** The unit the answer is in. */
  readonly unit: string;
  readonly asOf: Date;
  /** Skip a value older than this; null accepts any age. */
  readonly maxAgeMs: number | null;
}

export interface ReadingCandidate {
  readonly kind: ReadingSourceKind;
  readonly point: MeasurementPoint;
  readonly inherited: boolean;
  readonly sourceId: string | null;
  readonly sensorId: string | null;
  readonly channelKey: string | null;
  readonly measurementId: string | null;
  readonly observedAt: Date | null;
  readonly quality: SensorSampleQuality | null;
}

export interface SkippedCandidate extends ReadingCandidate {
  readonly bindingProblems: readonly ChannelBindingProblem[];
  readonly readingProblems: readonly ReadingProblem[];
}

export interface ResolvedReading {
  readonly value: number | null;
  readonly unit: string;
  readonly asOf: Date;
  /** The candidate that answered; null when none did. */
  readonly chosen: ReadingCandidate | null;
  readonly ageMs: number | null;
  readonly skipped: readonly SkippedCandidate[];
  readonly unresolved: ReadingUnresolved | null;
}

interface Evaluated {
  readonly candidate: ReadingCandidate;
  readonly value: number | null;
  readonly bindingProblems: readonly ChannelBindingProblem[];
  readonly readingProblems: readonly ReadingProblem[];
}

/**
 * The answer to an ask from its levels, tried in order: the point itself,
 * then — only when the quantity may be inherited, which the caller's chain
 * decides — the system and the site it belongs to.
 */
export function resolveReading(ask: ReadingAsk, levels: readonly ReadingLevel[]): ResolvedReading {
  const skipped: SkippedCandidate[] = [];
  for (const level of levels) {
    for (const evaluated of candidatesOf(level).map((facts) => evaluate(ask, level, facts))) {
      const { candidate, value, bindingProblems, readingProblems } = evaluated;
      if (value !== null && bindingProblems.length === 0 && readingProblems.length === 0) {
        return {
          value,
          unit: ask.unit,
          asOf: ask.asOf,
          chosen: candidate,
          ageMs: ageOf(ask, candidate.observedAt),
          skipped,
          unresolved: null,
        };
      }
      skipped.push({ ...candidate, bindingProblems, readingProblems });
    }
  }
  return {
    value: null,
    unit: ask.unit,
    asOf: ask.asOf,
    chosen: null,
    ageMs: null,
    skipped,
    unresolved:
      skipped.length === 0 ? READING_UNRESOLVED.NO_SOURCE : READING_UNRESOLVED.NO_USABLE_SOURCE,
  };
}

type CandidateFacts =
  | { readonly kind: 'channel'; readonly facts: ChannelCandidateFacts }
  | { readonly kind: 'manual'; readonly facts: ManualCandidateFacts };

/** A level's candidates in precedence: primary, backup, manual. */
function candidatesOf(level: ReadingLevel): CandidateFacts[] {
  const rank = (priority: ChannelSourcePriority): number =>
    priority === ChannelSourcePriority.PRIMARY ? 0 : 1;
  return [
    ...[...level.channels]
      .sort((a, b) => rank(a.priority) - rank(b.priority))
      .map((facts) => ({ kind: 'channel' as const, facts })),
    ...(level.manual === null ? [] : [{ kind: 'manual' as const, facts: level.manual }]),
  ];
}

function evaluate(ask: ReadingAsk, level: ReadingLevel, candidate: CandidateFacts): Evaluated {
  return candidate.kind === 'channel'
    ? evaluateChannel(ask, level, candidate.facts)
    : evaluateManual(ask, level, candidate.facts);
}

function evaluateChannel(
  ask: ReadingAsk,
  level: ReadingLevel,
  facts: ChannelCandidateFacts,
): Evaluated {
  const { description } = facts;
  const observedAt = description.latestAt === null ? null : new Date(description.latestAt);
  const candidate: ReadingCandidate = {
    kind:
      facts.priority === ChannelSourcePriority.PRIMARY
        ? READING_SOURCE_KIND.CHANNEL_PRIMARY
        : READING_SOURCE_KIND.CHANNEL_BACKUP,
    point: level.point,
    inherited: level.inherited,
    sourceId: facts.sourceId,
    sensorId: description.sensorId,
    channelKey: description.channelKey,
    measurementId: null,
    observedAt,
    quality: description.latestQuality,
  };
  if (facts.bindingProblems.length > 0) {
    return { candidate, value: null, bindingProblems: facts.bindingProblems, readingProblems: [] };
  }
  if (description.latestValue === null || observedAt === null) {
    return {
      candidate,
      value: null,
      bindingProblems: [],
      readingProblems: [READING_PROBLEM.NO_SAMPLE],
    };
  }
  const problems: ReadingProblem[] = [];
  if (description.latestQuality === 'BAD') {
    problems.push(READING_PROBLEM.SAMPLE_QUALITY_BAD);
  }
  // No binding problem: the channel reports the parameter's quantity in a unit of it.
  const value =
    ask.parameter.quantity === null || description.unit === null
      ? null
      : convertUnit(ask.parameter.quantity, description.unit, ask.unit, description.latestValue);
  if (value === null) {
    problems.push(READING_PROBLEM.UNIT_NOT_CONVERTIBLE);
  }
  if (isOlderThanWindow(ask, observedAt)) {
    problems.push(READING_PROBLEM.OLDER_THAN_WINDOW);
  }
  return { candidate, value, bindingProblems: [], readingProblems: problems };
}

function evaluateManual(
  ask: ReadingAsk,
  level: ReadingLevel,
  facts: ManualCandidateFacts,
): Evaluated {
  const candidate: ReadingCandidate = {
    kind: READING_SOURCE_KIND.MANUAL,
    point: level.point,
    inherited: level.inherited,
    sourceId: null,
    sensorId: null,
    channelKey: null,
    measurementId: facts.measurementId,
    observedAt: facts.measuredAt,
    quality: null,
  };
  const raw = numericValue(facts.value);
  if (raw === null) {
    return {
      candidate,
      value: null,
      bindingProblems: [],
      readingProblems: [READING_PROBLEM.VALUE_NOT_NUMERIC],
    };
  }
  const problems: ReadingProblem[] = [];
  const value = manualValueIn(ask, raw);
  if (value === null) {
    problems.push(READING_PROBLEM.UNIT_NOT_CONVERTIBLE);
  }
  if (isOlderThanWindow(ask, facts.measuredAt)) {
    problems.push(READING_PROBLEM.OLDER_THAN_WINDOW);
  }
  return { candidate, value, bindingProblems: [], readingProblems: problems };
}

/** A manual value, recorded in the parameter's unit, in the asked unit. */
function manualValueIn(ask: ReadingAsk, value: number): number | null {
  const { quantity, unit } = ask.parameter;
  if (quantity === null) {
    // A parameter that records no quantity has one unit: its own.
    return unit.trim() === ask.unit.trim() ? value : null;
  }
  return convertUnit(quantity, unit, ask.unit, value);
}

/** A stored manual value as a number: a JSON number, or a numeric string the old forms wrote. */
function numericValue(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** How old a value observed at `observedAt` is at the ask's instant; a sample stamped ahead of it is 0. */
function ageOf(ask: ReadingAsk, observedAt: Date | null): number | null {
  return observedAt === null ? null : Math.max(0, ask.asOf.getTime() - observedAt.getTime());
}

function isOlderThanWindow(ask: ReadingAsk, observedAt: Date): boolean {
  const age = ageOf(ask, observedAt);
  return ask.maxAgeMs !== null && age !== null && age > ask.maxAgeMs;
}
