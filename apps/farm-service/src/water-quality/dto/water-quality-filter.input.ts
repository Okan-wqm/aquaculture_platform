/**
 * WaterQuality Filter Input DTO
 */
import { InputType, Field, ID, Int } from '@nestjs/graphql';
import { IsUUID, IsOptional, IsDate, IsEnum, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { WaterQualityStatus, MeasurementSource } from '../entities/water-quality-measurement.entity';

@InputType()
export class WaterQualityFilterInput {
  @Field(() => ID, { nullable: true, description: 'Tank ID' })
  @IsOptional()
  @IsUUID()
  tankId?: string;

  @Field(() => ID, { nullable: true, description: 'Havuz ID' })
  @IsOptional()
  @IsUUID()
  pondId?: string;

  @Field(() => ID, { nullable: true, description: 'Site ID' })
  @IsOptional()
  @IsUUID()
  siteId?: string;

  @Field(() => ID, { nullable: true, description: 'Batch ID' })
  @IsOptional()
  @IsUUID()
  batchId?: string;

  @Field(() => WaterQualityStatus, { nullable: true, description: 'Durum filtresi' })
  @IsOptional()
  @IsEnum(WaterQualityStatus)
  status?: WaterQualityStatus;

  @Field(() => MeasurementSource, { nullable: true, description: 'Kaynak filtresi' })
  @IsOptional()
  @IsEnum(MeasurementSource)
  source?: MeasurementSource;

  @Field({ nullable: true, description: 'Başlangıç tarihi' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  fromDate?: Date;

  @Field({ nullable: true, description: 'Bitiş tarihi' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  toDate?: Date;

  @Field(() => Int, { nullable: true, defaultValue: 50, description: 'Limit' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @Field(() => Int, { nullable: true, defaultValue: 0, description: 'Offset' })
  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;
}
