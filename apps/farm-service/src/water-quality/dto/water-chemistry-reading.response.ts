/**
 * What the water-chemistry UI reads about a value at a point (plan rev2 PR-4):
 * the value, where it came from, how old it is, and every source passed over
 * with why — and, for a calculation, each input and the set's verdict.
 *
 * The vocabularies are the domain's own tables (reading-resolution.ts,
 * water-chemistry-input-set.ts, water-chemistry-input-sets.ts), registered as
 * they are, so the UI keys its messages on one list.
 */
import { CHANNEL_BINDING_PROBLEM, type ChannelBindingProblem } from '@aquaculture/shared-contracts';
import { Field, Float, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import type { SensorSampleQuality } from '@platform/event-contracts';

import {
  COHERENCE_WINDOW,
  type CoherenceWindow,
  WATER_CHEMISTRY_INPUT_SET,
  type WaterChemistryInputSet,
} from '../data/water-chemistry-input-sets';
import { MeasurementPosition } from '../entities/water-quality-param-equipment.entity';
import { SystemType } from '../../system/entities/system.entity';
import {
  type MeasurementPoint,
  type MeasurementPointKind,
  representativeLocation,
  type SourceLocation,
} from '../services/parameter-sources';
import {
  READING_PROBLEM,
  READING_SOURCE_KIND,
  READING_UNRESOLVED,
  type ReadingCandidate,
  type ReadingProblem,
  type ReadingSourceKind,
  type ReadingUnresolved,
  type ResolvedReading,
  type SkippedCandidate,
} from '../services/reading-resolution';
import {
  type InputSetEvaluation,
  type InputStatus,
  WATER_CHEMISTRY_INPUT_PROBLEM,
  WATER_CHEMISTRY_SET_PROBLEM,
  WATER_CHEMISTRY_VERDICT,
  type WaterChemistryInputProblem,
  type WaterChemistrySetProblem,
  type WaterChemistryVerdict,
} from '../services/water-chemistry-input-set';

import { SampleQualityEnum } from './parameter-source-status.response';

const MeasurementPointKindEnum = {
  SITE: 'site',
  SYSTEM: 'system',
  TANK: 'tank',
  EQUIPMENT: 'equipment',
} as const satisfies Record<string, MeasurementPointKind>;

registerEnumType(MeasurementPointKindEnum, {
  name: 'MeasurementPointKind',
  description: 'A measurement point is a site, a system (loop), a tank or non-tank water equipment',
});
registerEnumType(READING_SOURCE_KIND, {
  name: 'ReadingSourceKind',
  description: 'A primary channel, a backup channel, or a manual sample',
});
registerEnumType(READING_PROBLEM, {
  name: 'ReadingProblem',
  description: 'Why a source the bind would accept was passed over for its value',
});
registerEnumType(READING_UNRESOLVED, {
  name: 'ReadingUnresolved',
  description: 'Why a parameter has no value at a point',
});
registerEnumType(WATER_CHEMISTRY_INPUT_SET, {
  name: 'WaterChemistryInputSet',
  description: 'DOSING at a system point, TOXICITY at a tank point',
});
registerEnumType(COHERENCE_WINDOW, {
  name: 'CoherenceWindow',
  description:
    'SHORT (4 h) pH, temperature, TAN, H2S; DAILY (24 h) alkalinity for dosing; LONG (48 h) salinity, calcium',
});
registerEnumType(WATER_CHEMISTRY_VERDICT, {
  name: 'WaterChemistryVerdict',
  description: 'READY, INCOMPLETE (an input is missing or stale) or REFUSED (does not apply here)',
});
registerEnumType(WATER_CHEMISTRY_SET_PROBLEM, {
  name: 'WaterChemistrySetProblem',
  description: 'Why a water-chemistry calculation is refused or incomplete at a point',
});
registerEnumType(WATER_CHEMISTRY_INPUT_PROBLEM, {
  name: 'WaterChemistryInputProblem',
  description: 'Why one input cannot feed a water-chemistry calculation',
});

@ObjectType({ description: 'A measurement point' })
export class MeasurementPointRef {
  @Field(() => MeasurementPointKindEnum)
  kind!: MeasurementPointKind;

  @Field(() => ID)
  id!: string;
}

@ObjectType({ description: 'A source passed over, and why' })
export class SkippedReadingCandidate {
  @Field(() => READING_SOURCE_KIND)
  sourceKind!: ReadingSourceKind;

  @Field(() => MeasurementPointRef, { description: 'Where the source stands' })
  point!: MeasurementPointRef;

  @Field({ description: 'Whether the source is at a system or site the point inherits from' })
  inherited!: boolean;

  @Field(() => ID, { nullable: true, description: 'The channel source row; null for a sample' })
  sourceId!: string | null;

  @Field(() => ID, { nullable: true })
  sensorId!: string | null;

  @Field(() => String, { nullable: true })
  channelKey!: string | null;

  @Field(() => ID, { nullable: true, description: 'The manual sample; null for a channel' })
  measurementId!: string | null;

  @Field(() => Date, { nullable: true })
  observedAt!: Date | null;

  @Field(() => SampleQualityEnum, { nullable: true })
  quality!: SensorSampleQuality | null;

  @Field(() => [CHANNEL_BINDING_PROBLEM], {
    description: 'Why the bind would refuse the channel now (placement re-derived now)',
  })
  bindingProblems!: ChannelBindingProblem[];

  @Field(() => [READING_PROBLEM])
  readingProblems!: ReadingProblem[];
}

@ObjectType({ description: 'The value of a parameter at a point now, and where it came from' })
export class ParameterReading {
  @Field(() => ID)
  parameterConfigId!: string;

  @Field(() => String, {
    nullable: true,
    description: 'The measured quantity the parameter records',
  })
  quantity!: string | null;

  @Field(() => MeasurementPointRef, { description: 'The point asked about' })
  point!: MeasurementPointRef;

  @Field(() => MeasurementPosition)
  position!: MeasurementPosition;

  @Field(() => Float, { nullable: true })
  depthM!: number | null;

  @Field({ description: 'The instant the value was resolved at; ages are measured to it' })
  asOf!: Date;

  @Field(() => Float, { nullable: true })
  value!: number | null;

  @Field({ description: 'The unit of value' })
  unit!: string;

  @Field(() => READING_SOURCE_KIND, { nullable: true })
  sourceKind!: ReadingSourceKind | null;

  @Field(() => MeasurementPointRef, { nullable: true, description: 'Where the value was read' })
  resolvedAt!: MeasurementPointRef | null;

  @Field(() => MeasurementPointKindEnum, {
    nullable: true,
    description: 'SYSTEM or SITE when the value is inherited (loop-homogeneous quantities only)',
  })
  inheritedFrom!: MeasurementPointKind | null;

  @Field(() => ID, { nullable: true })
  sourceId!: string | null;

  @Field(() => ID, { nullable: true })
  sensorId!: string | null;

  @Field(() => String, { nullable: true })
  channelKey!: string | null;

  @Field(() => ID, { nullable: true })
  measurementId!: string | null;

  @Field(() => Date, { nullable: true })
  observedAt!: Date | null;

  @Field(() => Int, { nullable: true, description: 'Seconds from observedAt to asOf' })
  ageSeconds!: number | null;

  @Field(() => SampleQualityEnum, { nullable: true, description: 'Null for a manual sample' })
  quality!: SensorSampleQuality | null;

  @Field(() => [SkippedReadingCandidate])
  skipped!: SkippedReadingCandidate[];

  @Field(() => READING_UNRESOLVED, { nullable: true, description: 'Null when there is a value' })
  unresolved!: ReadingUnresolved | null;
}

@ObjectType({ description: 'One input of a water-chemistry calculation, resolved at the point' })
export class WaterChemistryInputStatus {
  @Field({ description: 'The WaterChemistryInputs field it feeds, e.g. tempC, h2sUgL' })
  engineInput!: string;

  @Field()
  quantity!: string;

  @Field({ description: 'The unit the value is in (the engine’s)' })
  unit!: string;

  @Field(() => COHERENCE_WINDOW)
  coherenceWindow!: CoherenceWindow;

  @Field(() => Int, { description: 'How old the value may be, in seconds' })
  windowSeconds!: number;

  @Field(() => ID, { nullable: true, description: 'The active parameter recording the quantity' })
  parameterConfigId!: string | null;

  @Field(() => ParameterReading, {
    nullable: true,
    description: 'Null when no parameter records it',
  })
  reading!: ParameterReading | null;

  @Field(() => [WATER_CHEMISTRY_INPUT_PROBLEM])
  problems!: WaterChemistryInputProblem[];
}

@ObjectType({
  description: 'The inputs of a water-chemistry calculation at a point, and its verdict',
})
export class WaterChemistryInputsResult {
  @Field(() => WATER_CHEMISTRY_INPUT_SET)
  set!: WaterChemistryInputSet;

  @Field(() => MeasurementPointRef)
  point!: MeasurementPointRef;

  @Field()
  asOf!: Date;

  @Field(() => WATER_CHEMISTRY_VERDICT)
  verdict!: WaterChemistryVerdict;

  @Field(() => [WATER_CHEMISTRY_SET_PROBLEM])
  problems!: WaterChemistrySetProblem[];

  @Field(() => SystemType, { nullable: true, description: 'The loop’s type (DOSING)' })
  systemType!: SystemType | null;

  @Field(() => Float, { nullable: true, description: 'System.totalVolumeM3 (DOSING)' })
  volumeM3!: number | null;

  @Field(() => Float, {
    nullable: true,
    description: 'Water the loop’s active tanks hold (DOSING)',
  })
  tankWaterM3!: number | null;

  @Field(() => [WaterChemistryInputStatus])
  inputs!: WaterChemistryInputStatus[];
}

function pointRef(point: MeasurementPoint): MeasurementPointRef {
  return { kind: point.kind, id: point.id };
}

function skippedOf(candidate: SkippedCandidate): SkippedReadingCandidate {
  return {
    ...candidateFields(candidate),
    point: pointRef(candidate.point),
    inherited: candidate.inherited,
    bindingProblems: [...candidate.bindingProblems],
    readingProblems: [...candidate.readingProblems],
  };
}

function candidateFields(
  candidate: ReadingCandidate,
): Pick<
  SkippedReadingCandidate,
  'sourceKind' | 'sourceId' | 'sensorId' | 'channelKey' | 'measurementId' | 'observedAt' | 'quality'
> {
  return {
    sourceKind: candidate.kind,
    sourceId: candidate.sourceId,
    sensorId: candidate.sensorId,
    channelKey: candidate.channelKey,
    measurementId: candidate.measurementId,
    observedAt: candidate.observedAt,
    quality: candidate.quality,
  };
}

/** The reading of a parameter at a location, as the API returns it. */
export function parameterReadingOf(
  parameter: { readonly id: string; readonly effectiveQuantity: string | null },
  location: SourceLocation,
  reading: ResolvedReading,
): ParameterReading {
  const chosen = reading.chosen;
  const none = {
    sourceKind: null,
    sourceId: null,
    sensorId: null,
    channelKey: null,
    measurementId: null,
    observedAt: null,
    quality: null,
  };
  return {
    parameterConfigId: parameter.id,
    quantity: parameter.effectiveQuantity,
    point: pointRef(location.point),
    position: location.position,
    depthM: location.depthM,
    asOf: reading.asOf,
    value: reading.value,
    unit: reading.unit,
    ...(chosen === null ? none : candidateFields(chosen)),
    resolvedAt: chosen === null ? null : pointRef(chosen.point),
    inheritedFrom: chosen !== null && chosen.inherited ? chosen.point.kind : null,
    ageSeconds: reading.ageMs === null ? null : Math.floor(reading.ageMs / 1000),
    skipped: reading.skipped.map(skippedOf),
    unresolved: reading.unresolved,
  };
}

/** An evaluated input set, as the API returns it. */
export function waterChemistryInputsOf(
  point: MeasurementPoint,
  asOf: Date,
  evaluation: InputSetEvaluation,
): WaterChemistryInputsResult {
  const location = representativeLocation(point);
  const inputOf = (input: InputStatus): WaterChemistryInputStatus => ({
    engineInput: input.spec.engineInput,
    quantity: input.spec.quantity,
    unit: input.unit,
    coherenceWindow: input.spec.window,
    windowSeconds: Math.floor(input.windowMs / 1000),
    parameterConfigId: input.parameter === null ? null : input.parameter.id,
    reading:
      input.parameter === null || input.reading === null
        ? null
        : parameterReadingOf(input.parameter, location, input.reading),
    problems: [...input.problems],
  });
  const { loop } = evaluation;
  return {
    set: evaluation.set,
    point: pointRef(point),
    asOf,
    verdict: evaluation.verdict,
    problems: [...evaluation.problems],
    systemType: loop === null ? null : loop.type,
    volumeM3: loop === null ? null : loop.volumeM3,
    tankWaterM3: loop === null ? null : loop.tankWaterM3,
    inputs: evaluation.inputs.map(inputOf),
  };
}
