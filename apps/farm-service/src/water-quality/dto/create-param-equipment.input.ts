/**
 * CreateParamEquipment Input DTO
 *
 * Maps a single water quality parameter to an equipment item.
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
export class CreateParamEquipmentInput {
  @Field(() => ID, { description: 'Water quality parameter config to link' })
  @IsUUID()
  parameterConfigId!: string;

  @Field(() => ID, { description: 'Equipment to link' })
  @IsUUID()
  equipmentId!: string;

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

  @Field({ nullable: true, description: 'Free-text notes' })
  @IsOptional()
  @IsString()
  notes?: string;
}
