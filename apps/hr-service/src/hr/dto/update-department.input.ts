import { InputType, Field, ID } from '@nestjs/graphql';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

import { OWNER_MODULE, type OwnerModuleCode } from '@aquaculture/shared-contracts';
import { HR_MODULE_CODE_ENUM } from '../../common/enums';

/**
 * Every property carries a class-validator decorator (see CreateDepartmentInput for why).
 * A null on a nullable field is a deliberate "clear it": `@IsOptional()` lets null through.
 */
@InputType('UpdateHRDepartmentInput')
export class UpdateDepartmentInput {
  @Field(() => ID)
  @IsUUID(undefined, { message: 'Department ID must be a valid UUID' })
  id!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Department name cannot be empty' })
  @MaxLength(150, { message: 'Department name must be at most 150 characters' })
  name?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Department code cannot be empty' })
  @MaxLength(20, { message: 'Department code must be at most 20 characters' })
  code?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID(undefined, { message: 'Site ID must be a valid UUID' })
  siteId?: string;

  @Field(() => HR_MODULE_CODE_ENUM, { nullable: true })
  @IsOptional()
  @IsEnum(OWNER_MODULE)
  moduleCode?: OwnerModuleCode;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID(undefined, { message: 'Parent department ID must be a valid UUID' })
  parentDepartmentId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID(undefined, { message: 'Manager ID must be a valid UUID' })
  managerId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50, { message: 'Budget code must be at most 50 characters' })
  budgetCode?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50, { message: 'Cost center must be at most 50 characters' })
  costCenter?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isDeleted?: boolean;
}
