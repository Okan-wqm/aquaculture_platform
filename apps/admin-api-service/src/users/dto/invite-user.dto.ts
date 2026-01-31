import { IsEmail, IsString, IsOptional, IsObject, ValidateNested, IsBoolean } from 'class-validator';
import { Type } from 'class-transformer';
import { PanelPermissions } from '../entities/user-permissions.entity';

/**
 * DTO for inviting a new user to the tenant
 * TENANT_ADMIN uses this to create users with specific permissions
 */
export class InviteUserDto {
  @IsEmail({}, { message: 'Valid email address is required' })
  email!: string;

  @IsString()
  @IsOptional()
  firstName?: string;

  @IsString()
  @IsOptional()
  lastName?: string;

  @IsObject()
  @IsOptional()
  permissions?: Partial<PanelPermissions>;

  @IsBoolean()
  @IsOptional()
  sendInvitationEmail?: boolean = true;
}

/**
 * DTO for updating user permissions
 */
export class UpdateUserPermissionsDto {
  @IsObject()
  permissions!: Partial<PanelPermissions>;
}

/**
 * Response DTO for user with permissions
 */
export class UserWithPermissionsDto {
  id!: string;
  email!: string;
  firstName?: string;
  lastName?: string;
  isActive!: boolean;
  permissions!: PanelPermissions;
  invitedAt!: Date;
  lastLoginAt?: Date;
}
