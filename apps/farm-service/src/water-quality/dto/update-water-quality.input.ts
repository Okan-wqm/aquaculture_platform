/**
 * UpdateWaterQualityMeasurement Input DTO
 */
import { InputType, Field, ID, PartialType } from '@nestjs/graphql';
import { IsUUID, IsOptional, IsString } from 'class-validator';
import { WaterParametersInput } from './create-water-quality.input';

@InputType()
export class UpdateWaterQualityInput {
  @Field(() => ID, { description: 'Ölçüm ID' })
  @IsUUID()
  id: string;

  @Field(() => WaterParametersInput, { nullable: true, description: 'Su parametreleri' })
  @IsOptional()
  parameters?: WaterParametersInput;

  @Field({ nullable: true, description: 'Notlar' })
  @IsOptional()
  @IsString()
  notes?: string;

  @Field({ nullable: true, description: 'Hava durumu' })
  @IsOptional()
  @IsString()
  weatherConditions?: string;
}
