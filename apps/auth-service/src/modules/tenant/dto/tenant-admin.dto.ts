import { InputType, Field, ObjectType, ID } from '@nestjs/graphql';
import { IsEmail, IsNotEmpty, IsString, IsUUID, IsInt, Min, Max, Matches, MaxLength, IsIn } from 'class-validator';

/**
 * Input for assigning a user to a module
 */
@InputType()
export class AssignUserToModuleInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  firstName!: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  lastName!: string;

  @Field()
  @IsEmail()
  email!: string;

  @Field()
  @IsUUID()
  moduleId!: string;

  @Field({ defaultValue: 'manager' })
  @IsIn(['manager', 'viewer', 'operator'], { message: 'Role must be one of: manager, viewer, operator' })
  role!: string;
}

/**
 * Input for assigning a user to a farm-service Site (SEC-HIGH-051).
 *
 * WHY: auth.user_site_assignments is the SSoT for object-level site membership
 * but had NO write-path — every MODULE_USER was minted with assignedSiteIds:[]
 * forever and denied on every site-scoped op. This is the TENANT_ADMIN-gated
 * management surface, mirroring AssignUserToModuleInput.
 *
 * `userId` is an existing tenant user (unlike module-assign which can also
 * create a user). `siteId` is a farm-service Site id (cross-service id, no FK).
 */
@InputType()
export class AssignUserToSiteInput {
  @Field(() => ID)
  @IsUUID('4')
  userId!: string;

  @Field(() => ID)
  @IsUUID('4')
  siteId!: string;
}

/**
 * Result of a site assignment / unassignment (mirrors AssignmentResult).
 */
@ObjectType()
export class SiteAssignmentResult {
  @Field()
  success!: boolean;

  @Field()
  message!: string;

  @Field(() => ID)
  userId!: string;

  @Field(() => ID)
  siteId!: string;
}

/**
 * User Module info for tenant admin
 */
@ObjectType()
export class UserModuleInfo {
  @Field(() => ID)
  id!: string;

  @Field()
  moduleId!: string;

  @Field()
  code!: string;

  @Field()
  name!: string;

  @Field(() => String, { nullable: true })
  description!: string | null;

  @Field(() => String, { nullable: true })
  icon!: string | null;

  @Field(() => String, { nullable: true })
  color!: string | null;

  @Field()
  isEnabled!: boolean;

  @Field(() => String, { nullable: true })
  defaultRoute!: string | null;
}

/**
 * Current user's tenant info
 */
@ObjectType()
export class MyTenantInfo {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field()
  slug!: string;

  @Field(() => String, { nullable: true })
  description!: string | null;

  @Field(() => String, { nullable: true })
  logoUrl!: string | null;

  @Field()
  status!: string;

  @Field()
  plan!: string;

  @Field()
  maxUsers!: number;

  @Field()
  currentUserCount!: number;
}

/**
 * Assignment result
 */
@ObjectType()
export class AssignmentResult {
  @Field()
  success!: boolean;

  @Field()
  message!: string;

  @Field(() => String, { nullable: true })
  userId!: string | null;

  @Field()
  isNewUser!: boolean;
}

/**
 * Table info for tenant database viewer
 */
@ObjectType()
export class TenantTableInfo {
  @Field()
  tableName!: string;

  @Field()
  rowCount!: number;

  @Field(() => String, { nullable: true })
  module!: string | null;
}

/**
 * Table data result
 */
@ObjectType()
export class TableDataResult {
  @Field()
  tableName!: string;

  @Field()
  totalRows!: number;

  @Field(() => [String])
  columns!: string[];

  @Field(() => String)
  rows!: string; // JSON string of row data

  @Field()
  offset!: number;

  @Field()
  limit!: number;
}

/**
 * SQL identifier pattern - prevents SQL injection
 * Must start with letter/underscore, contain only alphanumeric/underscore
 */
const SQL_IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const SQL_IDENTIFIER_MSG = 'Must be a valid SQL identifier (letters, numbers, underscores only, must start with letter/underscore)';

/**
 * Input for getting table data
 * SECURITY: Schema and table names are validated to prevent SQL injection
 */
@InputType()
export class GetTableDataInput {
  @Field()
  @IsString()
  @MaxLength(63, { message: 'Schema name must be at most 63 characters' })
  @Matches(SQL_IDENTIFIER_PATTERN, { message: `schemaName: ${SQL_IDENTIFIER_MSG}` })
  schemaName!: string;

  @Field()
  @IsString()
  @MaxLength(63, { message: 'Table name must be at most 63 characters' })
  @Matches(SQL_IDENTIFIER_PATTERN, { message: `tableName: ${SQL_IDENTIFIER_MSG}` })
  tableName!: string;

  @Field({ defaultValue: 100 })
  @IsInt()
  @Min(1)
  @Max(1000)
  limit!: number;

  @Field({ defaultValue: 0 })
  @IsInt()
  @Min(0)
  offset!: number;
}
