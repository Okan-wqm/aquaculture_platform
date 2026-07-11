/**
 * BulkMapParamsEquipment Input DTO
 *
 * Maps multiple water quality parameters to a single equipment item
 * in one operation.
 */
import { InputType, Field, ID } from '@nestjs/graphql';
import {
  IsUUID,
  IsArray,
  IsOptional,
  IsEnum,
} from 'class-validator';
import { MonitoringFrequency } from '../entities/water-quality-param-equipment.entity';

@InputType()
export class BulkMapParamsEquipmentInput {
  @Field(() => ID, { description: 'Target equipment' })
  @IsUUID()
  equipmentId!: string;

  @Field(() => [ID], { description: 'Parameter config IDs to map' })
  @IsArray()
  @IsUUID('4', { each: true })
  parameterConfigIds!: string[];

  @Field(() => MonitoringFrequency, { nullable: true, description: 'Default monitoring frequency for all mappings' })
  @IsOptional()
  @IsEnum(MonitoringFrequency)
  monitoringFrequency?: MonitoringFrequency;
}
