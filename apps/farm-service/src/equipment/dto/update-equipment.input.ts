/**
 * Update Equipment Input DTO
 */
import { InputType, Field, ID, PartialType, OmitType } from '@nestjs/graphql';
import { IsUUID, IsOptional, IsBoolean, IsString, MinLength, MaxLength, IsEnum } from 'class-validator';
import { CreateEquipmentInput } from './create-equipment.input';
import { EquipmentStatus } from '../entities/equipment.entity';

@InputType()
export class UpdateEquipmentInput extends PartialType(
  OmitType(CreateEquipmentInput, ['departmentId', 'equipmentTypeId'] as const)
) {
  @Field(() => ID)
  @IsUUID()
  id: string;

  // Override inherited required fields to make them optional for partial updates
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  code?: string;

  @Field(() => [ID], { nullable: true, description: 'Systems this equipment serves (many-to-many)' })
  @IsOptional()
  @IsUUID('4', { each: true })
  systemIds?: string[];

  @Field(() => EquipmentStatus, { nullable: true })
  @IsOptional()
  @IsEnum(EquipmentStatus)
  status?: EquipmentStatus;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
