/**
 * CreateWaterQualityMeasurement Input DTO
 */
import { InputType, Field, ID, Float } from '@nestjs/graphql';
import { IsUUID, IsOptional, IsDate, IsEnum, IsNumber, Min, Max, IsString } from 'class-validator';
import { Type } from 'class-transformer';
import { MeasurementSource } from '../entities/water-quality-measurement.entity';

@InputType()
export class WaterParametersInput {
  @Field(() => Float, { nullable: true, description: 'Sıcaklık (°C)' })
  @IsOptional()
  @IsNumber()
  @Min(-5)
  @Max(40)
  temperature?: number;

  @Field(() => Float, { nullable: true, description: 'Çözünmüş Oksijen (mg/L)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(20)
  dissolvedOxygen?: number;

  @Field(() => Float, { nullable: true, description: 'pH değeri' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(14)
  pH?: number;

  @Field(() => Float, { nullable: true, description: 'Amonyak (mg/L)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  ammonia?: number;

  @Field(() => Float, { nullable: true, description: 'Nitrit (mg/L)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  nitrite?: number;

  @Field(() => Float, { nullable: true, description: 'Nitrat (mg/L)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  nitrate?: number;

  @Field(() => Float, { nullable: true, description: 'Tuzluluk (ppt)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  salinity?: number;

  @Field(() => Float, { nullable: true, description: 'Bulanıklık (NTU)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  turbidity?: number;

  @Field(() => Float, { nullable: true, description: 'Alkalinite (mg/L CaCO3)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  alkalinity?: number;

  @Field(() => Float, { nullable: true, description: 'Sertlik (mg/L CaCO3)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  hardness?: number;
}

@InputType()
export class CreateWaterQualityInput {
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

  @Field({ description: 'Ölçüm tarihi' })
  @IsDate()
  @Type(() => Date)
  measuredAt: Date;

  @Field(() => MeasurementSource, { description: 'Ölçüm kaynağı' })
  @IsEnum(MeasurementSource)
  source: MeasurementSource;

  @Field(() => ID, { nullable: true, description: 'Ölçümü yapan kullanıcı' })
  @IsOptional()
  @IsUUID()
  measuredBy?: string;

  @Field(() => WaterParametersInput, { description: 'Su parametreleri' })
  parameters: WaterParametersInput;

  @Field({ nullable: true, description: 'Notlar' })
  @IsOptional()
  @IsString()
  notes?: string;

  @Field({ nullable: true, description: 'Hava durumu' })
  @IsOptional()
  @IsString()
  weatherConditions?: string;
}
