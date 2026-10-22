import { InputType, Field } from '@nestjs/graphql';
import { IsEnum, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import { HrModuleCode } from '../../common/enums';

/**
 * Every property carries a class-validator decorator: the global ValidationPipe is
 * whitelist + forbidNonWhitelisted, so a property with only `@Field` is refused the
 * moment ANY sibling is decorated. Lengths are the `departments_hr` column limits.
 */
@InputType('CreateHRDepartmentInput')
export class CreateDepartmentInput {
  @Field()
  @IsString()
  @IsNotEmpty({ message: 'Department name is required' })
  @MaxLength(150, { message: 'Department name must be at most 150 characters' })
  name!: string;

  @Field()
  @IsString()
  @IsNotEmpty({ message: 'Department code is required' })
  @MaxLength(20, { message: 'Department code must be at most 20 characters' })
  code!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID(undefined, { message: 'Site ID must be a valid UUID' })
  siteId?: string;

  @Field(() => HrModuleCode, {
    nullable: true,
    description: 'Owning module; omit for a company-wide department',
  })
  @IsOptional()
  @IsEnum(HrModuleCode)
  moduleCode?: HrModuleCode;

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
}
