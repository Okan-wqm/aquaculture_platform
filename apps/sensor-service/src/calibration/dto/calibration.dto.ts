import { InputType, Field, ID, Float, Int } from '@nestjs/graphql';
import {
  IsUUID,
  IsBoolean,
  IsNumber,
  IsInt,
  IsOptional,
  IsArray,
  IsString,
  Min,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * A single reference point captured during calibration: the raw reading the
 * sensor produced and the known reference value it should have produced.
 */
@InputType()
export class CalibrationReferencePointInput {
  @Field(() => Float)
  @IsNumber()
  raw!: number;

  @Field(() => Float)
  @IsNumber()
  reference!: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;
}

/**
 * Input for recording a calibration (SENSOR-HIGH-083).
 *
 * This is the ONLY write path for a channel's calibration coefficients: it
 * appends a `CalibrationEvent` and atomically stamps the channel's coefficients,
 * `lastCalibratedAt`, and `nextCalibrationDue`. `updateDataChannel` no longer
 * accepts coefficient changes, so a calibrated channel can never again report
 * "never calibrated".
 */
@InputType()
export class RecordCalibrationInput {
  @Field(() => ID)
  @IsUUID()
  channelId!: string;

  /** Whether the stored coefficients should be applied to incoming readings. */
  @Field({ defaultValue: true })
  @IsBoolean()
  calibrationEnabled!: boolean;

  @Field(() => Float)
  @IsNumber()
  calibrationMultiplier!: number;

  @Field(() => Float)
  @IsNumber()
  calibrationOffset!: number;

  /** Reference points used to derive the coefficients (kept for provenance). */
  @Field(() => [CalibrationReferencePointInput], { nullable: true })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CalibrationReferencePointInput)
  referenceValues?: CalibrationReferencePointInput[];

  /**
   * Per-channel calibration interval in days. Persisted on the channel and used
   * to compute `nextCalibrationDue`. When omitted, the channel's existing
   * interval is reused; when neither is set, no due date is computed (the
   * channel stays "calibrated" without ever falsely showing "overdue").
   */
  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  intervalDays?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
