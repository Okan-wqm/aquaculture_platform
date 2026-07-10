/**
 * UpdateParamEquipment Input DTO
 *
 * Partial update for an existing parameter-equipment mapping.
 */
import { InputType, Field, ID } from '@nestjs/graphql';
import {
  IsUUID,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsString,
} from 'class-validator';
import { MonitoringFrequency } from '../entities/water-quality-param-equipment.entity';

@InputType()
export class UpdateParamEquipmentInput {
  @Field(() => ID, { description: 'Mapping ID to update' })
  @IsUUID()
  id!: string;

  @Field(() => MonitoringFrequency, { nullable: true, description: 'Monitoring frequency' })
  @IsOptional()
  @IsEnum(MonitoringFrequency)
  monitoringFrequency?: MonitoringFrequency;

  @Field(() => ID, { nullable: true, description: 'Linked sensor device UUID' })
  @IsOptional()
  @IsUUID()
  sensorId?: string;

  @Field({ nullable: true, description: 'Enable alerts for this mapping' })
  @IsOptional()
  @IsBoolean()
  alertEnabled?: boolean;

  @Field({ nullable: true, description: 'Activate or deactivate this mapping' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field({ nullable: true, description: 'Free-text notes' })
  @IsOptional()
  @IsString()
  notes?: string;
}
