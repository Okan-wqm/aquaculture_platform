/**
 * UpdateWaterQualityMeasurement Input DTO
 *
 * SINGLE-INGRESS (Tier-1): like the create path, `dynamicParameters` is the
 * SOLE parameter channel. The legacy `WaterParametersInput` / `parameters`
 * field was removed. Updated parameter values are merged onto the existing
 * measurement and re-validated against the measurement's equipment mappings
 * via WaterQualityValidationService.validate() before persist.
 */
import { InputType, Field, ID } from '@nestjs/graphql';
import { IsObject, IsOptional, IsString, IsUUID } from 'class-validator';
import GraphQLJSON from 'graphql-type-json';

import { ValidateDynamicParameters } from '../validators/dynamic-parameters.validator';

@InputType()
export class UpdateWaterQualityInput {
  @Field(() => ID, { description: 'Ölçüm ID' })
  @IsUUID()
  id!: string;

  /**
   * Dynamic parameter values to merge onto the existing measurement.
   * Optional on update (caller may only change notes / weather), but when
   * present it routes through the same strict validation as create against
   * the measurement's stored equipmentId.
   */
  @Field(() => GraphQLJSON, { nullable: true, description: 'Dynamic parameters (tenant-configured JSONB)' })
  @IsOptional()
  @IsObject()
  @ValidateDynamicParameters()
  dynamicParameters?: Record<string, number | string | boolean>;

  @Field({ nullable: true, description: 'Notlar' })
  @IsOptional()
  @IsString()
  notes?: string;

  @Field({ nullable: true, description: 'Hava durumu' })
  @IsOptional()
  @IsString()
  weatherConditions?: string;
}
