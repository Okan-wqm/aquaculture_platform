import {
  CreateUserDto,
  GrantPlatformCapabilityDto,
  InviteUserRequestDto,
  ListUsersQueryDto,
  RevokePlatformCapabilityDto,
  UpdateUserDto,
} from './dto/users.dto';
import { Destructive, RequiresCapability, TenantParam, TenantIdCarrier } from '@aquaculture/backend-common/decorators';
import { AuditedOperation } from '@aquaculture/backend-common/audit';
import { ThrottleSensitive } from '@aquaculture/backend-common/security';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  PLATFORM_CAPABILITIES,
  isPlatformCapability,
  type PlatformCapability,
  type PlatformCapabilityGrantSnapshot,
} from '@platform/event-contracts';
import { Type } from 'class-transformer';
import {
  IsString,
  IsEmail,
  IsOptional,
  IsUUID,
  IsBoolean,
  IsEnum,
  MinLength,
  MaxLength,
  IsArray,
  IsInt,
  Min,
  Max,
  Matches,
  IsIn,
  IsISO8601,
} from 'class-validator';

import { ResetPasswordByAdminDto } from './dto/reset-password.dto';
import {
  RoleTemplateService,
  Permission,
  RoleTemplate,
} from './services/role-template.service';
import {
  UserProvisioningService,
  InviteUserDto as ProvisioningInviteUserDto,
  UserLimitCheckResult,
} from './services/user-provisioning.service';
import { UsersService, UserFilter, PaginatedUsers } from './users.service';

// Allowed sort fields whitelist for security

@ApiTags('Users')
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly userProvisioningService: UserProvisioningService,
    private readonly roleTemplateService: RoleTemplateService,
  ) {}

  /**
   * Get all users across all tenants (SUPER_ADMIN only)
   */
  @Get()
  async listUsers(@Query() query: ListUsersQueryDto): Promise<PaginatedUsers> {
    const filter: UserFilter = {
      tenantId: query.tenantId,
      role: query.role,
      status: query.status || 'all',
      search: query.search,
    };

    return this.usersService.listUsers(
      filter,
      query.page || 1,
      query.limit || 20,
      query.sortBy || 'createdAt',
      query.sortOrder || 'DESC',
    );
  }

  /**
   * Get user statistics
   */
  @Get('stats')
  async getUserStats() {
    return this.usersService.getUserStats();
  }

  /**
   * Get users by tenant
   */
  @Get('by-tenant/:tenantId')
  async getUsersByTenant(
    @TenantParam('param') tenantId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<PaginatedUsers> {
    return this.usersService.listUsers(
      { tenantId, status: 'all' },
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
    );
  }

  /**
   * Get recently active users
   */
  @Get('recent-activity')
  async getRecentlyActiveUsers(@Query('limit') limit?: string) {
    return this.usersService.getRecentlyActiveUsers(
      limit ? parseInt(limit, 10) : 50,
    );
  }

  /**
   * Get user by ID
   */
  @Get(':id')
  async getUserById(@Param('id', ParseUUIDPipe) id: string) {
    return this.usersService.getUserById(id);
  }

  /**
   * Get user's activity log
   */
  @Get(':id/activity')
  async getUserActivity(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit?: string,
  ) {
    return this.usersService.getUserActivity(
      id,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  /**
   * Get user's sessions
   */
  @Get(':id/sessions')
  async getUserSessions(@Param('id', ParseUUIDPipe) id: string) {
    return this.usersService.getUserSessions(id);
  }

  /**
   * Create new user (SUPER_ADMIN can create users for any tenant)
   */
  @AuditedOperation({ resource: 'User', action: 'CREATE' })
  @RequiresCapability('security-ops')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createUser(@Body() dto: CreateUserDto) {
    return this.usersService.createUser(dto);
  }

  /**
   * Update user
   */
  @AuditedOperation({ resource: 'User', action: 'UPDATE' })
  @RequiresCapability('security-ops')
  @Put(':id')
  async updateUser(
    @Param('id', ParseUUIDPipe) id: string,
    @TenantParam('body', { optional: true, allow: 'any' }) tenantId: string | undefined,
    @Body() dto: UpdateUserDto,
  ) {
    return this.usersService.updateUser(id, dto);
  }

  /**
   * Activate user
   */
  @AuditedOperation({ resource: 'User', action: 'ACTIVATE' })
  @RequiresCapability('security-ops')
  @Patch(':id/activate')
  async activateUser(@Param('id', ParseUUIDPipe) id: string) {
    return this.usersService.setUserStatus(id, true);
  }

  /**
   * Deactivate user
   */
  @AuditedOperation({ resource: 'User', action: 'DEACTIVATE' })
  @RequiresCapability('security-ops')
  @Patch(':id/deactivate')
  async deactivateUser(@Param('id', ParseUUIDPipe) id: string) {
    return this.usersService.setUserStatus(id, false);
  }

  /**
   * Reset user password
   */
  @AuditedOperation({ resource: 'UserPassword', action: 'RESET' })
  @RequiresCapability('security-ops')
  @Patch(':id/reset-password')
  async resetUserPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResetPasswordByAdminDto,
  ) {
    return this.usersService.resetPassword(id, dto.newPassword);
  }

  /**
   * Force logout user (invalidate all sessions)
   */
  @AuditedOperation({ resource: 'Users', action: 'FORCE_LOGOUT' })
  @RequiresCapability('security-ops')
  @Patch(':id/force-logout')
  async forceLogout(@Param('id', ParseUUIDPipe) id: string) {
    return this.usersService.forceLogout(id);
  }

  /**
   * Delete user (soft delete)
   */
  @AuditedOperation({ resource: 'User', action: 'DELETE' })
  @Destructive()
  @RequiresCapability('security-ops')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteUser(@Param('id', ParseUUIDPipe) id: string) {
    await this.usersService.deleteUser(id);
  }

  // ============================================
  // User Provisioning & Invitation Endpoints
  // ============================================

  /**
   * Check user limit for a tenant
   */
  @Get('tenant/:tenantId/limit')
  async checkUserLimit(
    @TenantParam('param') tenantId: string,
  ): Promise<UserLimitCheckResult> {
    return this.userProvisioningService.checkUserLimit(tenantId);
  }

  /**
   * Invite a new user to a tenant
   * Validation is handled by class-validator decorators on InviteUserRequestDto
   */
  @ThrottleSensitive()
  @AuditedOperation({ resource: 'User', action: 'INVITE' })
  @RequiresCapability('security-ops')
  @Post('invite')
  @HttpCode(HttpStatus.CREATED)
  async inviteUser(
    @TenantParam('body') tenantId: string,
    @Body() dto: InviteUserRequestDto,
    @Req() req: { user: { id: string } },
  ) {
    const result = await this.userProvisioningService.inviteUser({
      tenantId,
      email: dto.email,
      firstName: dto.firstName,
      lastName: dto.lastName,
      role: dto.role,
      moduleIds: dto.moduleIds,
      primaryModuleId: dto.primaryModuleId,
      invitedBy: req.user.id,
      message: dto.message,
    });

    if (!result.success) {
      throw new BadRequestException(result.error);
    }

    return {
      success: true,
      userId: result.userId,
      invitationId: result.invitationId,
      deliveryStatus: result.deliveryStatus ?? 'queued',
      message: 'Invitation created successfully. Notification delivery queued.',
    };
  }

  // ============================================
  // Platform Capability Endpoints (ADR-0016)
  // ============================================

  /**
   * Every capability grant of a SUPER_ADMIN, live and historical, plus the
   * live set the next token carries.
   */
  @Get(':id/capabilities')
  async listPlatformCapabilities(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ grants: PlatformCapabilityGrantSnapshot[]; active: PlatformCapability[] }> {
    return this.usersService.listPlatformCapabilities(id);
  }

  /**
   * Grant a capability. `security-ops` is the only capability that grants
   * capabilities; `break-glass` must come from another SUPER_ADMIN, with an
   * expiry within four hours (enforced by auth-service, the single writer).
   */
  @AuditedOperation({ resource: 'PlatformCapability', action: 'GRANT' })
  @RequiresCapability('security-ops')
  @Post(':id/capabilities')
  async grantPlatformCapability(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GrantPlatformCapabilityDto,
    @Req() req: { user: { id: string } },
  ): Promise<PlatformCapabilityGrantSnapshot> {
    return this.usersService.grantPlatformCapability({
      userId: id,
      capability: dto.capability,
      grantedBy: req.user.id,
      expiresAt: dto.expiresAt,
      reason: dto.reason,
    });
  }

  /** Revoke the live grant of one capability; the target's sessions are revoked with it. */
  @AuditedOperation({ resource: 'PlatformCapability', action: 'REVOKE' })
  @RequiresCapability('security-ops')
  @Destructive({ requiresBreakGlass: false, reason: 'revokes an operator capability and their sessions' })
  @Post(':id/capabilities/:capability/revoke')
  async revokePlatformCapability(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('capability') capability: string,
    @Body() dto: RevokePlatformCapabilityDto,
    @Req() req: { user: { id: string } },
  ): Promise<PlatformCapabilityGrantSnapshot> {
    if (!isPlatformCapability(capability)) {
      throw new BadRequestException(`'${capability}' is not a platform capability`);
    }
    return this.usersService.revokePlatformCapability({
      userId: id,
      capability,
      revokedBy: req.user.id,
      reason: dto.reason,
    });
  }

  // ============================================
  // Role Template Endpoints
  // ============================================

  /**
   * Get all role templates
   */
  @Get('roles/templates')
  getRoleTemplates(): RoleTemplate[] {
    return this.roleTemplateService.getAllRoleTemplates();
  }

  /**
   * Get assignable roles for a user level
   */
  @Get('roles/assignable/:roleCode')
  getAssignableRoles(@Param('roleCode') roleCode: string): RoleTemplate[] {
    return this.roleTemplateService.getAssignableRoles(roleCode);
  }

  /**
   * Get all permissions
   */
  @Get('roles/permissions')
  getPermissions(): Permission[] {
    return this.roleTemplateService.getAllPermissions();
  }

  /**
   * Get permissions by category
   */
  @Get('roles/permissions/grouped')
  getPermissionsByCategory(): Record<string, Permission[]> {
    return this.roleTemplateService.getPermissionsByCategory();
  }

  /**
   * Get role hierarchy
   */
  @Get('roles/hierarchy')
  getRoleHierarchy() {
    return this.roleTemplateService.getRoleHierarchy();
  }

  /**
   * Check if a role can be assigned
   */
  @Get('roles/can-assign')
  canAssignRole(
    @Query('assignerRole') assignerRole: string,
    @Query('targetRole') targetRole: string,
  ): { allowed: boolean; reason?: string } {
    return this.roleTemplateService.canAssignRole(assignerRole, targetRole);
  }

  /**
   * Get permissions for a specific role
   */
  @Get('roles/:roleCode/permissions')
  getRolePermissions(@Param('roleCode') roleCode: string): string[] {
    return this.roleTemplateService.getRolePermissions(roleCode);
  }
}
