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
  UseGuards,
} from '@nestjs/common';
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
import { Type } from 'class-transformer';
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
import { PlatformAdminGuard } from '../guards/platform-admin.guard';

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

  @IsString()
  @MinLength(1)
  invitedBy!: string;
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

@Controller('users')
@UseGuards(PlatformAdminGuard)
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
   * Validation is handled by class-validator decorators on InviteUserRequestDto
   */
  @Post('invite')
  @HttpCode(HttpStatus.CREATED)
  async inviteUser(@Body() dto: InviteUserRequestDto) {
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
