/**
 * Update Department Input DTO
 */
import { InputType, Field, ID, PartialType, OmitType } from '@nestjs/graphql';
import { IsUUID, IsOptional, IsBoolean, IsEnum, IsString, MinLength, MaxLength } from 'class-validator';
import { CreateDepartmentInput } from './create-department.input';
import { DepartmentStatus, DepartmentType } from '../entities/department.entity';

@InputType()
export class UpdateDepartmentInput extends PartialType(
  OmitType(CreateDepartmentInput, ['siteId'] as const)
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

  @Field(() => DepartmentType, { nullable: true })
  @IsOptional()
  @IsEnum(DepartmentType)
  type?: DepartmentType;

  @Field(() => DepartmentStatus, { nullable: true })
  @IsOptional()
  @IsEnum(DepartmentStatus)
  status?: DepartmentStatus;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
