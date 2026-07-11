/**
 * CreateWaterQualityMeasurement Input DTO
 *
 * SINGLE-INGRESS (Tier-1): `dynamicParameters` is the SOLE parameter channel
 * into a WaterQualityMeasurement. The legacy `WaterParametersInput` class and
 * its fixed `parameters` field were removed so there is exactly ONE code path
 * carrying measurement values, and that path ALWAYS routes through
 * WaterQualityValidationService.validate() before persist. There is no longer
 * a structural way to submit parameter values that bypass tenant-config
 * validation.
 *
 * `dynamicParameters` and `equipmentId` are REQUIRED: every measurement is
 * recorded against a specific piece of equipment whose mapped parameter
 * configs define what may be submitted, and strict-mode validation rejects
 * empty-with-keys / no-config submissions at the service layer.
 */
import { MobileCommandEnvelopeInput } from '@aquaculture/backend-common/mobile-command';
import { InputType, Field, ID } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import { IsDate, IsEnum, IsNotEmpty, IsObject, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import GraphQLJSON from 'graphql-type-json';

import { MeasurementSource } from '../entities/water-quality-measurement.entity';
import { ValidateDynamicParameters } from '../validators/dynamic-parameters.validator';

@InputType()
export class CreateWaterQualityInput extends MobileCommandEnvelopeInput {
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
  measuredAt!: Date;

  @Field(() => MeasurementSource, { description: 'Ölçüm kaynağı' })
  @IsEnum(MeasurementSource)
  source!: MeasurementSource;

  @Field(() => ID, { nullable: true, description: 'Ölçümü yapan kullanıcı' })
  @IsOptional()
  @IsUUID()
  measuredBy?: string;

  /**
   * Equipment whose mapped parameter configs define what may be submitted.
   * REQUIRED — the single-ingress contract validates `dynamicParameters`
   * against this equipment's parameter-equipment mappings on every create.
   */
  @Field(() => ID, { description: 'Equipment ID' })
  @IsUUID()
  equipmentId!: string;

  /**
   * SOLE parameter channel. REQUIRED. Every key is a tenant-configured
   * parameter code; values are validated against the tenant's
   * WaterQualityParameterConfig set (strict mode) before persist. The
   * legacy fixed-shape `parameters` field was removed to guarantee a
   * single validated ingress.
   */
  @Field(() => GraphQLJSON, { description: 'Dynamic parameters (tenant-configured JSONB)' })
  @IsObject()
  @IsNotEmpty()
  @ValidateDynamicParameters()
  dynamicParameters!: Record<string, number | string | boolean>;

  @Field(() => ID, { nullable: true, description: 'Idempotency key for offline retry safety' })
  @IsOptional()
  @IsUUID()
  idempotencyKey?: string;

  /**
   * Phase 7.4 — cross-service correlation. When this measurement was
   * derived from a specific `sensor_readings` row in sensor-service,
   * pass the reading's UUID. Null for manual / bulk-imported
   * measurements. See water-quality-measurement.entity.ts for the
   * architectural rationale (informational pointer, not a DB FK).
   */
  @Field(() => ID, { nullable: true, description: 'Source sensor_readings row that produced this measurement' })
  @IsOptional()
  @IsUUID()
  relatedSensorReadingId?: string;

  @Field({ nullable: true, description: 'Notlar' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @Field({ nullable: true, description: 'Hava durumu' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  weatherConditions?: string;
}
