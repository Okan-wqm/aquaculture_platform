import { InputType, Field, Float, ID } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import {
  IsOptional,
  IsNumber,
  IsUUID,
  IsDate,
  ValidateNested,
  Min,
  Max,
} from 'class-validator';

/**
 * Sensor Readings Input
 */
@InputType()
export class SensorReadingsInput {
  @Field(() => Float, { nullable: true })
  @IsNumber()
  @IsOptional()
  @Min(-50)
  @Max(100)
  temperature?: number;

  @Field(() => Float, { nullable: true })
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(14)
  ph?: number;

  @Field(() => Float, { nullable: true })
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(30)
  dissolvedOxygen?: number;

  @Field(() => Float, { nullable: true })
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(50)
  salinity?: number;

  @Field(() => Float, { nullable: true })
  @IsNumber()
  @IsOptional()
  @Min(0)
  ammonia?: number;

  @Field(() => Float, { nullable: true })
  @IsNumber()
  @IsOptional()
  @Min(0)
  nitrite?: number;

  @Field(() => Float, { nullable: true })
  @IsNumber()
  @IsOptional()
  @Min(0)
  nitrate?: number;

  @Field(() => Float, { nullable: true })
  @IsNumber()
  @IsOptional()
  @Min(0)
  turbidity?: number;

  @Field(() => Float, { nullable: true })
  @IsNumber()
  @IsOptional()
  @Min(0)
  waterLevel?: number;
}

/**
 * Ingest Reading Input DTO
 */
@InputType()
export class IngestReadingInput {
  @Field(() => ID)
  @IsUUID()
  sensorId: string;

  @Field(() => SensorReadingsInput)
  @ValidateNested()
  @Type(() => SensorReadingsInput)
  readings: SensorReadingsInput;

  @Field(() => ID, { nullable: true })
  @IsUUID()
  @IsOptional()
  pondId?: string;

  @Field(() => ID, { nullable: true })
  @IsUUID()
  @IsOptional()
  farmId?: string;

  @Field({ nullable: true })
  @IsDate()
  @IsOptional()
  @Type(() => Date)
  timestamp?: Date;
}

/**
 * Batch Ingest Input DTO
 */
@InputType()
export class BatchIngestInput {
  @Field(() => [IngestReadingInput])
  @ValidateNested({ each: true })
  @Type(() => IngestReadingInput)
  readings: IngestReadingInput[];
}
