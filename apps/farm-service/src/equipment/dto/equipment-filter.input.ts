/**
 * Equipment Filter Input DTO
 */
import { InputType, Field, ID } from '@nestjs/graphql';
import { IsOptional, IsString, IsBoolean, IsEnum, IsUUID } from 'class-validator';
import { EquipmentStatus } from '../entities/equipment.entity';
import { EquipmentCategory } from '../entities/equipment-type.entity';

@InputType()
export class EquipmentFilterInput {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  siteId?: string;

  @Field(() => ID, { nullable: true, description: 'Filter by system' })
  @IsOptional()
  @IsUUID()
  systemId?: string;

  @Field(() => ID, { nullable: true, description: 'Filter by parent equipment' })
  @IsOptional()
  @IsUUID()
  parentEquipmentId?: string;

  @Field({ nullable: true, description: 'Only get root equipment (no parent)' })
  @IsOptional()
  @IsBoolean()
  rootOnly?: boolean;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  equipmentTypeId?: string;

  @Field(() => EquipmentStatus, { nullable: true })
  @IsOptional()
  @IsEnum(EquipmentStatus)
  status?: EquipmentStatus;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  hasWarranty?: boolean;

  @Field({ nullable: true, description: 'Filter equipment visible in Sensor Module' })
  @IsOptional()
  @IsBoolean()
  isVisibleInSensor?: boolean;

  @Field({ nullable: true, description: 'Filter only tank equipment' })
  @IsOptional()
  @IsBoolean()
  isTank?: boolean;

  @Field(() => [EquipmentCategory], { nullable: true, description: 'Filter by equipment type categories (tank, pond, cage, etc.)' })
  @IsOptional()
  categories?: EquipmentCategory[];

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  search?: string;
}

@InputType()
export class EquipmentTypeFilterInput {
  @Field(() => EquipmentCategory, { nullable: true })
  @IsOptional()
  @IsEnum(EquipmentCategory)
  category?: EquipmentCategory;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  search?: string;
}
