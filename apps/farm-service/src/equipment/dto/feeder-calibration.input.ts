/**
 * Feeder Calibration Input DTOs
 */
import { InputType, Field, Float } from '@nestjs/graphql';
import {
  IsUUID,
  IsNumber,
  IsString,
  IsOptional,
  Min,
  Max,
  MaxLength,
  ArrayMaxSize,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

@InputType()
export class FeederCalibrationItemInput {
  @Field(() => Float)
  @IsNumber()
  @Min(0.01)
  @Max(100)
  feedSizeMm!: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  feedSizeLabel?: string;

  @Field(() => Float)
  @IsNumber()
  @Min(0.1)
  @Max(100000)
  gramsPerDispensing!: number;

  @Field(() => Float)
  @IsNumber()
  @Min(0)
  @Max(100000)
  siloCapacityKg!: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

@InputType()
export class SaveFeederCalibrationsInput {
  @Field()
  @IsUUID('4')
  equipmentId!: string;

  @Field(() => [FeederCalibrationItemInput])
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => FeederCalibrationItemInput)
  calibrations!: FeederCalibrationItemInput[];
}
