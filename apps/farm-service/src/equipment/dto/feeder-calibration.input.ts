/**
 * Feeder setup input DTOs.
 *
 * The wire shape is a DISCRIMINATED PAIR — `discrete` XOR `continuous` — rather
 * than one flat row with optional fields for both physics. That is deliberate
 * and is the first of the two places the mixing is stopped: a continuous
 * calibration item has no `gramsPerDispensing` FIELD to fill, and a discrete one
 * has no `gramsPerMinute`, so a client cannot even express the row the database
 * would reject. The database CHECK + FK constraints are the second place, for
 * every writer that never passes through GraphQL.
 *
 * Note also what these inputs do NOT let a client say twice: the speed band and
 * the silo capacity appear exactly once, on the branch, not on each calibration
 * item. Two calibration rows for the same feeder cannot disagree about the
 * machine, because there is nowhere to write the disagreement.
 */
import { InputType, Field, Float, ID } from '@nestjs/graphql';
import {
  IsUUID,
  IsNumber,
  IsString,
  IsOptional,
  IsEnum,
  Min,
  Max,
  MaxLength,
  ArrayMaxSize,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

import { FeederDispenseControl } from '../entities/feeder-capability.entity';

/** Sanity ceilings — DoS protection, not physics. */
const MAX_SILO_CAPACITY_KG = 100000;
const MAX_DRIVE_SPEED_HZ = 400;
const MAX_GRAMS_PER_DISPENSING = 100000;
const MAX_GRAMS_PER_MINUTE = 100000;
const MAX_CALIBRATIONS_PER_FEEDER = 50;

@InputType()
export class DiscreteFeederCalibrationItemInput {
  /** `feeds.id` — the same identity a protocol band carries. */
  @Field(() => ID)
  @IsUUID('4')
  feedId!: string;

  /** Mass thrown by one actuation of this feeder, for this feed. */
  @Field(() => Float)
  @IsNumber()
  @Min(0.01)
  @Max(MAX_GRAMS_PER_DISPENSING)
  gramsPerDispensing!: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

@InputType()
export class ContinuousFeederCalibrationItemInput {
  @Field(() => ID)
  @IsUUID('4')
  feedId!: string;

  /** The operator's own unit: "this feed is 10 g/min, that one is 40". */
  @Field(() => Float)
  @IsNumber()
  @Min(0.001)
  @Max(MAX_GRAMS_PER_MINUTE)
  gramsPerMinute!: number;

  /**
   * The drive frequency the rate was measured at. Required, not optional: a
   * flow rate without its speed is not a calibration, it is a number.
   */
  @Field(() => Float)
  @IsNumber()
  @Min(0.01)
  @Max(MAX_DRIVE_SPEED_HZ)
  referenceSpeedHz!: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/** Shot-type feeder: a fixed mass per actuation. */
@InputType()
export class DiscreteFeederSetupInput {
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0.001)
  @Max(MAX_SILO_CAPACITY_KG)
  siloCapacityKg?: number;

  @Field(() => [DiscreteFeederCalibrationItemInput])
  @ArrayMaxSize(MAX_CALIBRATIONS_PER_FEEDER)
  @ValidateNested({ each: true })
  @Type(() => DiscreteFeederCalibrationItemInput)
  calibrations!: DiscreteFeederCalibrationItemInput[];
}

/** VFD-driven auger: a mass FLOW, stated once with the band it is valid on. */
@InputType()
export class ContinuousFeederSetupInput {
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0.001)
  @Max(MAX_SILO_CAPACITY_KG)
  siloCapacityKg?: number;

  /**
   * The speed range over which this drive and auger were commissioned and over
   * which flow is known to track frequency. Stated ONCE per feeder — dosing
   * outside it is refused rather than extrapolated.
   */
  @Field(() => Float)
  @IsNumber()
  @Min(0.01)
  @Max(MAX_DRIVE_SPEED_HZ)
  minSpeedHz!: number;

  @Field(() => Float)
  @IsNumber()
  @Min(0.01)
  @Max(MAX_DRIVE_SPEED_HZ)
  maxSpeedHz!: number;

  @Field(() => [ContinuousFeederCalibrationItemInput])
  @ArrayMaxSize(MAX_CALIBRATIONS_PER_FEEDER)
  @ValidateNested({ each: true })
  @Type(() => ContinuousFeederCalibrationItemInput)
  calibrations!: ContinuousFeederCalibrationItemInput[];
}

/** What tells this feeder the dose has been delivered. */
@InputType()
export class FeederDispenseControlInput {
  @Field(() => FeederDispenseControl)
  @IsEnum(FeederDispenseControl)
  mode!: FeederDispenseControl;

  /**
   * sensor-service `sensors.id` of the mass sensor under the silo. Required
   * when `mode` is WEIGHT_BASED and rejected otherwise — a farm without load
   * cells has no id to give, and a farm that gives one must have a sensor that
   * actually reports, which the dose planner verifies against real readings.
   */
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID('4')
  weightSensorId?: string;
}

@InputType()
export class SaveFeederCalibrationsInput {
  @Field(() => ID)
  @IsUUID('4')
  equipmentId!: string;

  @Field(() => FeederDispenseControlInput)
  @ValidateNested()
  @Type(() => FeederDispenseControlInput)
  dispense!: FeederDispenseControlInput;

  /**
   * Exactly one of `discrete` / `continuous` must be present. A feeder is one
   * kind of machine or the other; supplying both or neither is rejected by the
   * handler, and the calibration rows are FK-pinned to whichever kind was
   * declared so the two can never drift apart afterwards.
   */
  @Field(() => DiscreteFeederSetupInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => DiscreteFeederSetupInput)
  discrete?: DiscreteFeederSetupInput;

  @Field(() => ContinuousFeederSetupInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => ContinuousFeederSetupInput)
  continuous?: ContinuousFeederSetupInput;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
