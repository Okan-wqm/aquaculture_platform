import { IsEmail, IsString, IsOptional, IsBoolean } from 'class-validator';

/**
 * DTO for inviting a new user to the tenant.
 *
 * RBAC-HIGH-009: the former `permissions?: Partial<PanelPermissions>` field
 * (and the UpdateUserPermissionsDto / UserWithPermissionsDto response DTOs)
 * were removed. They fed the phantom `shared.user_permissions` store, which
 * no guard or token-mint path consumes — the invited user's real authority
 * comes from the role assigned by the provisioning flow (auth-service
 * tenant-RBAC), not a panel-permission matrix persisted here.
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

  @IsBoolean()
  @IsOptional()
  sendInvitationEmail?: boolean = true;
}
