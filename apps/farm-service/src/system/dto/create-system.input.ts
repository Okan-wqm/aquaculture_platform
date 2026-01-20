/**
 * Create System Input DTO
 */
import { InputType, Field, Float, ID, Int } from '@nestjs/graphql';
import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsNumber,
  MaxLength,
  MinLength,
  IsEnum,
  IsUUID,
} from 'class-validator';
import { SystemType, SystemStatus } from '../entities/system.entity';

@InputType()
export class CreateSystemInput {
  @Field(() => ID)
  @IsUUID()
  siteId: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @Field(() => ID, { nullable: true, description: 'Parent system for nested hierarchy' })
  @IsOptional()
  @IsUUID()
  parentSystemId?: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  @MinLength(2)
  @MaxLength(20)
  code: string;

  @Field(() => SystemType)
  @IsEnum(SystemType)
  type: SystemType;

  @Field(() => SystemStatus, { nullable: true, defaultValue: SystemStatus.OPERATIONAL })
  @IsOptional()
  @IsEnum(SystemStatus)
  status?: SystemStatus;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @Field(() => Float, { nullable: true, description: 'Total water volume in m³' })
  @IsOptional()
  @IsNumber()
  totalVolumeM3?: number;

  @Field(() => Float, { nullable: true, description: 'Maximum biomass capacity in kg' })
  @IsOptional()
  @IsNumber()
  maxBiomassKg?: number;

  @Field(() => Int, { nullable: true, description: 'Number of tanks in this system' })
  @IsOptional()
  @IsNumber()
  tankCount?: number;
}
