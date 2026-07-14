import { InputType, Field, ObjectType, ID, Int, registerEnumType } from '@nestjs/graphql';
import { IsNotEmpty, IsString, IsOptional, IsUUID, IsInt, Min, Max, IsBoolean, IsEnum, IsArray, ArrayMaxSize, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import GraphQLJSON from 'graphql-type-json';

// WHY: Import AccessType enum so CreateTenantUserInput and UpdateTenantUserInput
// can expose platform-access control to the GraphQL schema. Tenant admins
// decide per-user whether they can use web panel, mobile PWA, or both.
import { AccessType } from '../../authentication/entities/user.entity';

/**
 * Permission Action
 */
@ObjectType()
export class PermissionAction {
  @Field()
  name!: string;

  @Field(() => [String])
  actions!: string[];
}

/**
 * Permission Resource
 */
@ObjectType()
export class PermissionResource {
  @Field()
  name!: string;

  @Field(() => [String])
  actions!: string[];
}

/**
 * Permission Category
 */
@ObjectType()
export class PermissionCategory {
  @Field()
  categoryKey!: string;

  @Field()
  name!: string;

  @Field(() => [PermissionResource])
  resources!: PermissionResource[];
}

/**
 * Role Permissions
 */
@ObjectType()
export class TenantRolePermissions {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  roleId!: string;

  @Field(() => GraphQLJSON)
  panelPermissions!: Record<string, Record<string, Record<string, boolean>>>;

  @Field(() => [String])
  resourcePermissions!: string[];
}

/**
 * Tenant Role
 */
@ObjectType()
export class TenantRole {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field(() => String, { nullable: true })
  description!: string | null;

  @Field()
  color!: string;

  @Field()
  icon!: string;

  @Field(() => Int)
  level!: number;

  @Field()
  isSystem!: boolean;

  @Field()
  isDefault!: boolean;

  @Field(() => Int)
  userCount!: number;

  @Field(() => TenantRolePermissions, { nullable: true })
  permissions!: TenantRolePermissions | null;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;
}

/**
 * Permission Overrides Input
 *
 * RBAC-MEDIUM-003: bound the array length and per-item length at the validation
 * boundary (defense-in-depth). CapabilityAuthorityService already rejects any
 * capability outside the finite catalogue — which structurally caps the number
 * of DISTINCT stored capabilities — but these bounds reject an oversized/abusive
 * payload BEFORE it reaches the authority check, so a client cannot inflate the
 * request (and downstream the JWT `resourcePermissions` claim + the gateway
 * assertion header) with thousands of junk strings.
 */
const MAX_OVERRIDE_CAPABILITIES = 256;
const MAX_CAPABILITY_STRING_LENGTH = 128;

@InputType()
export class PermissionOverridesInput {
  @Field(() => [String], { defaultValue: [] })
  @IsArray()
  @ArrayMaxSize(MAX_OVERRIDE_CAPABILITIES)
  @IsString({ each: true })
  @MaxLength(MAX_CAPABILITY_STRING_LENGTH, { each: true })
  grants!: string[];

  @Field(() => [String], { defaultValue: [] })
  @IsArray()
  @ArrayMaxSize(MAX_OVERRIDE_CAPABILITIES)
  @IsString({ each: true })
  @MaxLength(MAX_CAPABILITY_STRING_LENGTH, { each: true })
  revokes!: string[];
}

/**
 * Permission Overrides Output
 */
@ObjectType()
export class PermissionOverrides {
  @Field(() => [String])
  grants!: string[];

  @Field(() => [String])
  revokes!: string[];
}

/**
 * User Role Assignment
 */
@ObjectType()
export class UserRoleAssignment {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  userId!: string;

  @Field(() => ID)
  roleId!: string;

  @Field()
  roleName!: string;

  @Field()
  roleColor!: string;

  @Field()
  roleIcon!: string;

  @Field(() => Int)
  roleLevel!: number;

  @Field(() => PermissionOverrides)
  permissionOverrides!: PermissionOverrides;

  @Field(() => GraphQLJSON)
  panelPermissions!: Record<string, Record<string, Record<string, boolean>>>;

  @Field(() => [String])
  resourcePermissions!: string[];

  @Field(() => [String])
  effectivePermissions!: string[];

  @Field()
  isActive!: boolean;

  @Field(() => Date, { nullable: true })
  expiresAt!: Date | null;

  @Field()
  assignedAt!: Date;

  @Field(() => ID)
  assignedBy!: string;
}

/**
 * Effective Permissions
 */
@ObjectType()
export class EffectivePermissions {
  @Field(() => ID)
  roleId!: string;

  @Field()
  roleName!: string;

  @Field(() => GraphQLJSON)
  panelPermissions!: Record<string, Record<string, Record<string, boolean>>>;

  @Field(() => [String])
  resourcePermissions!: string[];

  @Field(() => PermissionOverrides)
  overrides!: PermissionOverrides;
}

/**
 * Create Tenant Role Input
 */
@InputType()
export class CreateTenantRoleInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  name!: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field({ defaultValue: '#6366F1' })
  @IsString()
  color!: string;

  @Field({ defaultValue: 'shield' })
  @IsString()
  icon!: string;

  @Field(() => Int, { defaultValue: 50 })
  @IsInt()
  @Min(1)
  @Max(100)
  level!: number;

  @Field({ defaultValue: false })
  @IsBoolean()
  isDefault!: boolean;

  @Field(() => GraphQLJSON)
  panelPermissions!: Record<string, Record<string, Record<string, boolean>>>;
}

/**
 * Update Tenant Role Input
 */
@InputType()
export class UpdateTenantRoleInput {
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  name?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  color?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  icon?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  level?: number;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  panelPermissions?: Record<string, Record<string, Record<string, boolean>>>;
}

/**
 * Assign User Role Input
 */
@InputType()
export class AssignUserRoleInput {
  @Field(() => ID)
  @IsUUID()
  roleId!: string;

  @Field(() => PermissionOverridesInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => PermissionOverridesInput)
  permissionOverrides?: PermissionOverridesInput;

  @Field(() => Date, { nullable: true })
  @IsOptional()
  expiresAt?: Date;
}

/**
 * Update User Role Input
 */
@InputType()
export class UpdateUserRoleInput {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  roleId?: string;

  @Field(() => PermissionOverridesInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => PermissionOverridesInput)
  permissionOverrides?: PermissionOverridesInput;

  @Field(() => Date, { nullable: true })
  @IsOptional()
  expiresAt?: Date;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * Bulk Assign Role Input
 */
@InputType()
export class BulkAssignRoleInput {
  @Field(() => [ID])
  @IsArray()
  @IsUUID('4', { each: true })
  userIds!: string[];

  @Field(() => ID)
  @IsUUID()
  roleId!: string;
}

/**
 * Bulk Assign Result
 */
@ObjectType()
export class BulkAssignResult {
  @Field(() => [String])
  success!: string[];

  @Field(() => [BulkAssignError])
  failed!: BulkAssignError[];
}

@ObjectType()
export class BulkAssignError {
  @Field()
  userId!: string;

  @Field()
  error!: string;
}

/**
 * Create Tenant User with Role Input
 */
@InputType()
export class CreateTenantUserInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  firstName!: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  lastName!: string;

  @Field()
  @IsNotEmpty()
  email!: string;

  @Field(() => String, { nullable: true, description: 'Optional password. If not provided, an invitation email will be sent.' })
  @IsOptional()
  @IsString()
  password?: string;

  @Field(() => ID)
  @IsUUID()
  roleId!: string;

  @Field(() => PermissionOverridesInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => PermissionOverridesInput)
  permissionOverrides?: PermissionOverridesInput;

  @Field(() => Boolean, { defaultValue: true, description: 'Send invitation email to the user' })
  @IsOptional()
  @IsBoolean()
  sendInvitation?: boolean;

  /**
   * Controls which platforms this user can access.
   * Tenant admin decides per-user access level.
   * When MOBILE_ONLY or BOTH, mobile_user_settings are auto-provisioned.
   */
  @Field(() => AccessType, {
    nullable: true,
    defaultValue: AccessType.BOTH,
    description: 'Platform access type: PANEL_ONLY, MOBILE_ONLY, or BOTH',
  })
  @IsOptional()
  @IsEnum(AccessType)
  accessType?: AccessType;
}

/**
 * Created Tenant User Result
 */
@ObjectType()
export class CreatedTenantUserResult {
  @Field(() => ID)
  userId!: string;

  @Field()
  email!: string;

  @Field(() => String, { nullable: true })
  firstName!: string | null;

  @Field(() => String, { nullable: true })
  lastName!: string | null;

  @Field(() => UserRoleAssignment)
  roleAssignment!: UserRoleAssignment;

  @Field()
  invitationSent!: boolean;

  @Field()
  createdAt!: Date;
}

/**
 * Update Tenant User Input
 * Used by tenant admins to update user profile fields and/or role assignment
 */
@InputType()
export class UpdateTenantUserInput {
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  firstName?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  lastName?: string;

  @Field(() => ID, { nullable: true, description: 'Tenant role ID to assign. If changed, updates the user role assignment.' })
  @IsOptional()
  @IsUUID()
  roleId?: string;

  /**
   * WHY: Allows tenant admins to change a user's platform access after creation.
   * Changing to/from MOBILE triggers mobile_user_settings provisioning/deactivation.
   */
  @Field(() => AccessType, {
    nullable: true,
    description: 'Platform access type: PANEL_ONLY, MOBILE_ONLY, or BOTH',
  })
  @IsOptional()
  @IsEnum(AccessType)
  accessType?: AccessType;
}

/**
 * Revoke User Role Input
 */
@InputType()
export class RevokeUserRoleInput {
  @Field(() => ID)
  @IsUUID()
  userId!: string;

  @Field(() => Boolean, { defaultValue: false, description: 'If true, permanently deletes the role assignment. If false, sets is_active = false.' })
  @IsOptional()
  @IsBoolean()
  hardDelete?: boolean;
}
