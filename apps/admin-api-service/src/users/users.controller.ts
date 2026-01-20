import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { UsersService, UserFilter, PaginatedUsers } from './users.service';
import {
  UserProvisioningService,
  InviteUserDto,
  UserLimitCheckResult,
} from './services/user-provisioning.service';
import {
  RoleTemplateService,
  Permission,
  RoleTemplate,
} from './services/role-template.service';

export interface CreateUserDto {
  email: string;
  firstName: string;
  lastName: string;
  password: string;
  role: string;
  tenantId?: string;
}

export interface UpdateUserDto {
  firstName?: string;
  lastName?: string;
  role?: string;
  tenantId?: string;
  isActive?: boolean;
}

export interface InviteUserRequestDto {
  tenantId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: string;
  moduleIds?: string[];
  primaryModuleId?: string;
  message?: string;
  invitedBy: string;
}

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
  async listUsers(
    @Query('tenantId') tenantId?: string,
    @Query('role') role?: string,
    @Query('status') status?: 'active' | 'inactive' | 'all',
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'ASC' | 'DESC',
  ): Promise<PaginatedUsers> {
    const filter: UserFilter = {
      tenantId,
      role,
      status: status || 'all',
      search,
    };

    return this.usersService.listUsers(
      filter,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
      sortBy || 'createdAt',
      sortOrder || 'DESC',
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
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
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
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createUser(@Body() dto: CreateUserDto) {
    return this.usersService.createUser(dto);
  }

  /**
   * Update user
   */
  @Put(':id')
  async updateUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.usersService.updateUser(id, dto);
  }

  /**
   * Activate user
   */
  @Patch(':id/activate')
  async activateUser(@Param('id', ParseUUIDPipe) id: string) {
    return this.usersService.setUserStatus(id, true);
  }

  /**
   * Deactivate user
   */
  @Patch(':id/deactivate')
  async deactivateUser(@Param('id', ParseUUIDPipe) id: string) {
    return this.usersService.setUserStatus(id, false);
  }

  /**
   * Reset user password
   */
  @Patch(':id/reset-password')
  async resetUserPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('newPassword') newPassword: string,
  ) {
    return this.usersService.resetPassword(id, newPassword);
  }

  /**
   * Force logout user (invalidate all sessions)
   */
  @Patch(':id/force-logout')
  async forceLogout(@Param('id', ParseUUIDPipe) id: string) {
    return this.usersService.forceLogout(id);
  }

  /**
   * Delete user (soft delete)
   */
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
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
  ): Promise<UserLimitCheckResult> {
    return this.userProvisioningService.checkUserLimit(tenantId);
  }

  /**
   * Invite a new user to a tenant
   */
  @Post('invite')
  @HttpCode(HttpStatus.CREATED)
  async inviteUser(@Body() dto: InviteUserRequestDto) {
    if (!dto.tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }

    if (!dto.email) {
      throw new BadRequestException('Email is required');
    }

    if (!dto.role) {
      throw new BadRequestException('Role is required');
    }

    const result = await this.userProvisioningService.inviteUser({
      tenantId: dto.tenantId,
      email: dto.email,
      firstName: dto.firstName,
      lastName: dto.lastName,
      role: dto.role,
      moduleIds: dto.moduleIds,
      primaryModuleId: dto.primaryModuleId,
      invitedBy: dto.invitedBy || 'system',
      message: dto.message,
    });

    if (!result.success) {
      throw new BadRequestException(result.error);
    }

    return {
      success: true,
      userId: result.userId,
      invitationId: result.invitationId,
      invitationToken: result.invitationToken,
      message: 'Invitation created successfully',
    };
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
