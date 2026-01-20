import { InputType, Field, ObjectType, ID } from '@nestjs/graphql';
import { IsEmail, IsNotEmpty, IsOptional, IsString, MinLength, IsUUID, IsInt, Min, Max } from 'class-validator';
import { Module } from '../../system-module/entities/module.entity';

/**
 * Input for assigning a user to a module
 */
@InputType()
export class AssignUserToModuleInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  firstName: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  lastName: string;

  @Field()
  @IsEmail()
  email: string;

  @Field()
  @MinLength(8)
  password: string;

  @Field()
  @IsUUID()
  moduleId: string;

  @Field({ defaultValue: 'manager' })
  @IsString()
  role: string;
}

/**
 * User Module info for tenant admin
 */
@ObjectType()
export class UserModuleInfo {
  @Field(() => ID)
  id: string;

  @Field()
  moduleId: string;

  @Field()
  name: string;

  @Field(() => String, { nullable: true })
  description: string | null;

  @Field(() => String, { nullable: true })
  icon: string | null;

  @Field(() => String, { nullable: true })
  color: string | null;

  @Field()
  isEnabled: boolean;

  @Field(() => String, { nullable: true })
  defaultRoute: string | null;
}

/**
 * Current user's tenant info
 */
@ObjectType()
export class MyTenantInfo {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;

  @Field()
  slug: string;

  @Field(() => String, { nullable: true })
  description: string | null;

  @Field(() => String, { nullable: true })
  logoUrl: string | null;

  @Field()
  status: string;

  @Field()
  plan: string;

  @Field()
  maxUsers: number;

  @Field()
  currentUserCount: number;
}

/**
 * Assignment result
 */
@ObjectType()
export class AssignmentResult {
  @Field()
  success: boolean;

  @Field()
  message: string;

  @Field(() => String, { nullable: true })
  userId: string | null;

  @Field()
  isNewUser: boolean;
}

/**
 * Table info for tenant database viewer
 */
@ObjectType()
export class TenantTableInfo {
  @Field()
  tableName: string;

  @Field()
  rowCount: number;

  @Field(() => String, { nullable: true })
  module: string | null;
}

/**
 * Table data result
 */
@ObjectType()
export class TableDataResult {
  @Field()
  tableName: string;

  @Field()
  totalRows: number;

  @Field(() => [String])
  columns: string[];

  @Field(() => String)
  rows: string; // JSON string of row data

  @Field()
  offset: number;

  @Field()
  limit: number;
}

/**
 * Input for getting table data
 */
@InputType()
export class GetTableDataInput {
  @Field()
  @IsString()
  schemaName: string;

  @Field()
  @IsString()
  tableName: string;

  @Field({ defaultValue: 100 })
  @IsInt()
  @Min(1)
  @Max(1000)
  limit: number;

  @Field({ defaultValue: 0 })
  @IsInt()
  @Min(0)
  offset: number;
}
