import { ThrottleSensitive } from '@aquaculture/backend-common/security';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
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
} from 'class-validator';

import { PlatformAdminOnly } from '../decorators/roles.decorator';

import { InviteUserDto, UpdateUserPermissionsDto, UserWithPermissionsDto } from './dto/invite-user.dto';
import { ResetPasswordByAdminDto } from './dto/reset-password.dto';
import { PanelPermissions, DEFAULT_USER_PERMISSIONS } from './entities/user-permissions.entity';
import {
  RoleTemplateService,
  Permission,
  RoleTemplate,
} from './services/role-template.service';
import { UserPermissionsService } from './services/user-permissions.service';
import {
  UserProvisioningService,
  InviteUserDto as ProvisioningInviteUserDto,
  UserLimitCheckResult,
} from './services/user-provisioning.service';
import { UsersService, UserFilter, PaginatedUsers } from './users.service';

// Allowed sort fields whitelist for security
const ALLOWED_SORT_FIELDS = ['createdAt', 'updatedAt', 'email', 'firstName', 'lastName', 'role'] as const;
type SortField = typeof ALLOWED_SORT_FIELDS[number];

export class CreateUserDto {
  @IsEmail({}, { message: 'Invalid email format' })
  @MaxLength(255)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName!: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(128)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/, {
    message: 'Password must contain uppercase, lowercase, number and special character',
  })
  password!: string;

  @IsString()
  @IsEnum(['SUPER_ADMIN', 'TENANT_ADMIN', 'MANAGER', 'OPERATOR', 'VIEWER'], {
    message: 'Invalid role',
  })
  role!: string;

  @IsOptional()
  @IsUUID('4', { message: 'Invalid tenant ID format' })
  tenantId?: string;
}

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName?: string;

  @IsOptional()
  @IsString()
  @IsEnum(['SUPER_ADMIN', 'TENANT_ADMIN', 'MANAGER', 'OPERATOR', 'VIEWER'], {
    message: 'Invalid role',
  })
  role?: string;

  @IsOptional()
  @IsUUID('4', { message: 'Invalid tenant ID format' })
  tenantId?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class InviteUserRequestDto {
  @IsUUID('4', { message: 'Invalid tenant ID format' })
  tenantId!: string;

  @IsEmail({}, { message: 'Invalid email format' })
  @MaxLength(255)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  @IsString()
  @IsEnum(['TENANT_ADMIN', 'MANAGER', 'OPERATOR', 'VIEWER'], {
    message: 'Invalid role for invitation',
  })
  role!: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  moduleIds?: string[];

  @IsOptional()
  @IsUUID('4')
  primaryModuleId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  message?: string;
}

// Query DTO for list users with validation
export class ListUsersQueryDto {
  @IsOptional()
  @IsUUID('4')
  tenantId?: string;

  @IsOptional()
  @IsString()
  @IsEnum(['SUPER_ADMIN', 'TENANT_ADMIN', 'MANAGER', 'OPERATOR', 'VIEWER'])
  role?: string;

  @IsOptional()
  @IsEnum(['active', 'inactive', 'all'])
  status?: 'active' | 'inactive' | 'all';

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(/^[a-zA-Z0-9@._\-\s]*$/, { message: 'Invalid search characters' })
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @IsEnum(ALLOWED_SORT_FIELDS, { message: 'Invalid sort field' })
  sortBy?: SortField;

  @IsOptional()
  @IsEnum(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC';
}

@ApiTags('Users')
@Controller('users')
export class UsersController {
  private readonly logger = new Logger(UsersController.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly userProvisioningService: UserProvisioningService,
    private readonly roleTemplateService: RoleTemplateService,
    private readonly userPermissionsService: UserPermissionsService,
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
    @Body() dto: ResetPasswordByAdminDto,
  ) {
    return this.usersService.resetPassword(id, dto.newPassword);
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
   * Validation is handled by class-validator decorators on InviteUserRequestDto
   */
  @ThrottleSensitive()
  @Post('invite')
  @HttpCode(HttpStatus.CREATED)
  async inviteUser(
    @Body() dto: InviteUserRequestDto,
    @Req() req: { user: { id: string } },
  ) {
    const result = await this.userProvisioningService.inviteUser({
      tenantId: dto.tenantId,
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

  // ============================================
  // User Permission Management Endpoints
  // (platform-admin only — SUPER_ADMIN; see PlatformAdminOnly / RBAC-LOW-001)
  // ============================================

  /**
   * Invite a new user with specific permissions (platform-admin / SUPER_ADMIN).
   */
  @ThrottleSensitive()
  @Post('tenant/invite')
  @PlatformAdminOnly()
  @HttpCode(HttpStatus.CREATED)
  async inviteUserWithPermissions(
    @Body() dto: InviteUserDto,
    @Req() req: { user: { id: string; tenantId?: string } },
  ): Promise<{ success: boolean; userId?: string; deliveryStatus: 'queued' | 'not_requested'; message: string }> {
    const tenantId = req.user.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant context required for this operation');
    }

    // Check user limit for tenant
    const limitCheck = await this.userProvisioningService.checkUserLimit(tenantId);
    if (!limitCheck.canCreate) {
      throw new BadRequestException(
        `User limit reached. Current: ${limitCheck.currentCount}/${limitCheck.limit}`,
      );
    }

    // Create the user via provisioning service
    const provisioningDto: ProvisioningInviteUserDto = {
      tenantId,
      email: dto.email,
      firstName: dto.firstName,
      lastName: dto.lastName,
      role: 'MODULE_USER', // Default role for invited users
      invitedBy: req.user.id,
      sendInvitation: dto.sendInvitationEmail !== false,
    };

    const result = await this.userProvisioningService.inviteUser(provisioningDto);

    if (!result.success || !result.userId) {
      throw new BadRequestException(result.error || 'Failed to invite user');
    }

    // Set initial permissions if provided
    if (dto.permissions) {
      try {
        // First create default permissions
        await this.userPermissionsService.createDefaultPermissions(
          result.userId,
          tenantId,
          req.user.id,
          false,
        );

        // Then update with provided permissions
        await this.userPermissionsService.updatePermissions(
          result.userId,
          tenantId,
          dto.permissions,
          req.user.id,
        );
      } catch (error) {
        // Log error but don't fail the invitation
        this.logger.error('Failed to set initial permissions', error instanceof Error ? error.stack : error);
      }
    } else {
      // Create default permissions
      await this.userPermissionsService.createDefaultPermissions(
        result.userId,
        tenantId,
        req.user.id,
        false,
      );
    }

    const deliveryStatus =
      dto.sendInvitationEmail === false ? 'not_requested' : result.deliveryStatus ?? 'queued';

    return {
      success: true,
      userId: result.userId,
      deliveryStatus,
      message: deliveryStatus === 'queued'
        ? 'User invited successfully. Notification delivery queued.'
        : 'User invited successfully. Notification delivery was not requested.',
    };
  }

  /**
   * Get permission categories for frontend checkbox display
   * Returns structured permission categories with labels
   */
  @Get('permission-categories')
  @PlatformAdminOnly()
  getPermissionCategories(): { category: string; permissions: string[]; label: string }[] {
    return this.userPermissionsService.getPermissionCategories();
  }

  /**
   * Get user permissions by user ID (TENANT_ADMIN)
   */
  @Get(':id/permissions')
  @PlatformAdminOnly()
  async getUserPermissions(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: { tenantId?: string } },
  ): Promise<{ userId: string; permissions: PanelPermissions }> {
    const tenantId = req.user.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant context required for this operation');
    }

    const permissions = await this.userPermissionsService.getUserPermissions(id, tenantId);

    if (!permissions) {
      // Return default permissions if not found
      return {
        userId: id,
        permissions: DEFAULT_USER_PERMISSIONS,
      };
    }

    return {
      userId: id,
      permissions: permissions.permissions,
    };
  }

  /**
   * Update user permissions (TENANT_ADMIN)
   * Allows tenant admin to toggle individual permission checkboxes
   */
  @Put(':id/permissions')
  @PlatformAdminOnly()
  async updateUserPermissions(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserPermissionsDto,
    @Req() req: { user: { id: string; tenantId?: string } },
  ): Promise<{ success: boolean; userId: string; permissions: PanelPermissions }> {
    const tenantId = req.user.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant context required for this operation');
    }

    // Verify the user exists and belongs to the tenant
    const user = await this.usersService.getUserById(id);
    if (user.tenantId !== tenantId) {
      throw new BadRequestException('Cannot modify permissions for users outside your tenant');
    }

    // Check if permissions exist, create if not
    const permissions = await this.userPermissionsService.getUserPermissions(id, tenantId);

    if (!permissions) {
      // Create default permissions first
      await this.userPermissionsService.createDefaultPermissions(
        id,
        tenantId,
        req.user.id,
        false,
      );
    }

    // Update permissions
    const updated = await this.userPermissionsService.updatePermissions(
      id,
      tenantId,
      dto.permissions,
      req.user.id,
    );

    return {
      success: true,
      userId: id,
      permissions: updated.permissions,
    };
  }

  /**
   * Get all users with their permissions for a tenant (TENANT_ADMIN)
   */
  @Get('tenant/users-with-permissions')
  @PlatformAdminOnly()
  async getTenantUsersWithPermissions(
    @Req() req: { user: { tenantId?: string } },
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<{ data: UserWithPermissionsDto[]; total: number }> {
    const tenantId = req.user.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant context required for this operation');
    }

    // Get users from tenant
    const usersResult = await this.usersService.listUsers(
      { tenantId, status: 'all' },
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 50,
    );

    // Get permissions for all users
    const allPermissions = await this.userPermissionsService.getTenantUsersPermissions(tenantId);
    const permissionsMap = new Map(
      allPermissions.map(p => [p.userId, p.permissions]),
    );

    // Merge user data with permissions
    const usersWithPermissions: UserWithPermissionsDto[] = usersResult.data.map(user => ({
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      isActive: user.isActive,
      permissions: permissionsMap.get(user.id) || DEFAULT_USER_PERMISSIONS,
      invitedAt: user.createdAt,
      lastLoginAt: user.lastLoginAt || undefined,
    }));

    return {
      data: usersWithPermissions,
      total: usersResult.total,
    };
  }
}
