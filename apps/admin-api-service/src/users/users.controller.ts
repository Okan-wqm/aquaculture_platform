import { ThrottleSensitive } from '@aquaculture/backend-common/security';
import { INVITABLE_ROLE_CODES, Role, type InvitableRoleCode } from '@platform/identity';
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
import { Type } from 'class-transformer';
import {
  IsString,
  IsEmail,
  IsOptional,
  IsUUID,
  IsBoolean,
  IsEnum,
  IsIn,
  MinLength,
  MaxLength,
  IsArray,
  IsInt,
  Min,
  Max,
  Matches,
} from 'class-validator';

import { ResetPasswordByAdminDto } from './dto/reset-password.dto';
import { RoleTemplateService, Permission, RoleTemplate } from './services/role-template.service';
import {
  UserProvisioningService,
  InviteUserDto as ProvisioningInviteUserDto,
  UserLimitCheckResult,
} from './services/user-provisioning.service';
import { UsersService, UserFilter, PaginatedUsers } from './users.service';
import type { IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import { AdminResponseContract } from '../shared/admin-response-contract.decorator';
import {
  usersUserDtoPageContract,
  type UsersUserDtoDto,
  usersUserStatsContract,
  type UsersUserStatsDto,
  usersUserDtoArrayContract,
  usersUserDtoContract,
  usersUserActivityArrayContract,
  type UsersUserActivityDto,
  usersUserSessionArrayContract,
  type UsersUserSessionDto,
  usersResetUserPasswordResponseContract,
  type UsersResetUserPasswordResponseDto,
  usersForceLogoutResponseContract,
  type UsersForceLogoutResponseDto,
  voidResponseContract,
  type VoidResponseDto,
  usersUserLimitCheckResultContract,
  type UsersUserLimitCheckResultDto,
  usersInviteUserResponseContract,
  type UsersInviteUserResponseDto,
  usersRoleTemplateArrayContract,
  type UsersRoleTemplateDto,
  usersPermissionArrayContract,
  type UsersPermissionDto,
  usersGetPermissionsByCategoryResponseContract,
  type UsersGetPermissionsByCategoryResponseDto,
  usersGetRoleHierarchyResponseArrayContract,
  type UsersGetRoleHierarchyResponseDto,
  usersCanAssignRoleResponseContract,
  type UsersCanAssignRoleResponseDto,
  usersGetRolePermissionsResponseArrayContract,
  type UsersGetRolePermissionsResponseDto,
} from './contracts/admin-http-response.contract';

// Allowed sort fields whitelist for security
const ALLOWED_SORT_FIELDS = [
  'createdAt',
  'updatedAt',
  'email',
  'firstName',
  'lastName',
  'role',
] as const;
type SortField = (typeof ALLOWED_SORT_FIELDS)[number];

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

  @IsEnum(Role, { message: 'Invalid role' })
  role!: Role;

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
  @IsEnum(Role, { message: 'Invalid role' })
  role?: Role;

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

  @IsIn(INVITABLE_ROLE_CODES, { message: 'Invalid role for invitation' })
  role!: InvitableRoleCode;

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
  @IsEnum(Role)
  role?: Role;

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
  constructor(
    private readonly usersService: UsersService,
    private readonly userProvisioningService: UserProvisioningService,
    private readonly roleTemplateService: RoleTemplateService,
  ) {}

  /**
   * Get all users across all tenants (SUPER_ADMIN only)
   */
  @AdminResponseContract(usersUserDtoPageContract)
  @Get()
  async listUsers(
    @Query() query: ListUsersQueryDto,
  ): Promise<IStandardPaginatedResult<UsersUserDtoDto>> {
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
  @AdminResponseContract(usersUserStatsContract)
  @Get('stats')
  async getUserStats(): Promise<UsersUserStatsDto> {
    return this.usersService.getUserStats();
  }

  /**
   * Get users by tenant
   */
  @AdminResponseContract(usersUserDtoPageContract)
  @Get('lookup/tenant/:tenantId')
  async getUsersByTenant(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<IStandardPaginatedResult<UsersUserDtoDto>> {
    return this.usersService.listUsers(
      { tenantId, status: 'all' },
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
    );
  }

  /**
   * Get recently active users
   */
  @AdminResponseContract(usersUserDtoArrayContract)
  @Get('recent-activity')
  async getRecentlyActiveUsers(@Query('limit') limit?: string): Promise<UsersUserDtoDto[]> {
    return this.usersService.getRecentlyActiveUsers(limit ? parseInt(limit, 10) : 50);
  }

  /**
   * Get user by ID
   */
  @AdminResponseContract(usersUserDtoContract)
  @Get(':id')
  async getUserById(@Param('id', ParseUUIDPipe) id: string): Promise<UsersUserDtoDto> {
    return this.usersService.getUserById(id);
  }

  /**
   * Get user's activity log
   */
  @AdminResponseContract(usersUserActivityArrayContract)
  @Get(':id/activity')
  async getUserActivity(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit?: string,
  ): Promise<UsersUserActivityDto[]> {
    return this.usersService.getUserActivity(id, limit ? parseInt(limit, 10) : 50);
  }

  /**
   * Get user's sessions
   */
  @AdminResponseContract(usersUserSessionArrayContract)
  @Get(':id/sessions')
  async getUserSessions(@Param('id', ParseUUIDPipe) id: string): Promise<UsersUserSessionDto[]> {
    return this.usersService.getUserSessions(id);
  }

  /**
   * Create new user (SUPER_ADMIN can create users for any tenant)
   */
  @AdminResponseContract(usersUserDtoContract)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createUser(@Body() dto: CreateUserDto): Promise<UsersUserDtoDto> {
    return this.usersService.createUser(dto);
  }

  /**
   * Update user
   */
  @AdminResponseContract(usersUserDtoContract)
  @Put(':id')
  async updateUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ): Promise<UsersUserDtoDto> {
    return this.usersService.updateUser(id, dto);
  }

  /**
   * Activate user
   */
  @AdminResponseContract(usersUserDtoContract)
  @Patch(':id/activate')
  async activateUser(@Param('id', ParseUUIDPipe) id: string): Promise<UsersUserDtoDto> {
    return this.usersService.setUserStatus(id, true);
  }

  /**
   * Deactivate user
   */
  @AdminResponseContract(usersUserDtoContract)
  @Patch(':id/deactivate')
  async deactivateUser(@Param('id', ParseUUIDPipe) id: string): Promise<UsersUserDtoDto> {
    return this.usersService.setUserStatus(id, false);
  }

  /**
   * Reset user password
   */
  @AdminResponseContract(usersResetUserPasswordResponseContract)
  @ThrottleSensitive()
  @Patch(':id/reset-password')
  async resetUserPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResetPasswordByAdminDto,
  ): Promise<UsersResetUserPasswordResponseDto> {
    return this.usersService.resetPassword(id, dto.newPassword);
  }

  /**
   * Force logout user (invalidate all sessions)
   */
  @AdminResponseContract(usersForceLogoutResponseContract)
  @Patch(':id/force-logout')
  async forceLogout(@Param('id', ParseUUIDPipe) id: string): Promise<UsersForceLogoutResponseDto> {
    return this.usersService.forceLogout(id);
  }

  /**
   * Delete user (soft delete)
   */
  @AdminResponseContract(voidResponseContract)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteUser(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.usersService.deleteUser(id);
  }

  // ============================================
  // User Provisioning & Invitation Endpoints
  // ============================================

  /**
   * Check user limit for a tenant
   */
  @AdminResponseContract(usersUserLimitCheckResultContract)
  @Get('tenant/:tenantId/limit')
  async checkUserLimit(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
  ): Promise<UsersUserLimitCheckResultDto> {
    return this.userProvisioningService.checkUserLimit(tenantId);
  }

  /**
   * Invite a new user to a tenant
   * Validation is handled by class-validator decorators on InviteUserRequestDto
   */
  @AdminResponseContract(usersInviteUserResponseContract)
  @ThrottleSensitive()
  @Post('invite')
  @HttpCode(HttpStatus.CREATED)
  async inviteUser(
    @Body() dto: InviteUserRequestDto,
    @Req() req: { user: { id: string } },
  ): Promise<UsersInviteUserResponseDto> {
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
    };
  }

  // ============================================
  // Role Template Endpoints
  // ============================================

  /**
   * Get all role templates
   */
  @AdminResponseContract(usersRoleTemplateArrayContract)
  @Get('roles/templates')
  getRoleTemplates(): readonly UsersRoleTemplateDto[] {
    return this.roleTemplateService.getAllRoleTemplates();
  }

  /**
   * Get assignable roles for a user level
   */
  @AdminResponseContract(usersRoleTemplateArrayContract)
  @Get('roles/lookup/:roleCode/assignable')
  getAssignableRoles(@Param('roleCode') roleCode: string): readonly UsersRoleTemplateDto[] {
    return this.roleTemplateService.getAssignableRoles(roleCode);
  }

  /**
   * Get all permissions
   */
  @AdminResponseContract(usersPermissionArrayContract)
  @Get('roles/permissions')
  getPermissions(): readonly UsersPermissionDto[] {
    return this.roleTemplateService.getAllPermissions();
  }

  /**
   * Get permissions by category
   */
  @AdminResponseContract(usersGetPermissionsByCategoryResponseContract)
  @Get('roles/permissions/grouped')
  getPermissionsByCategory(): UsersGetPermissionsByCategoryResponseDto {
    return this.roleTemplateService.getPermissionsByCategory();
  }

  /**
   * Get role hierarchy
   */
  @AdminResponseContract(usersGetRoleHierarchyResponseArrayContract)
  @Get('roles/hierarchy')
  getRoleHierarchy(): readonly UsersGetRoleHierarchyResponseDto[] {
    return this.roleTemplateService.getRoleHierarchy();
  }

  /**
   * Check if a role can be assigned
   */
  @AdminResponseContract(usersCanAssignRoleResponseContract)
  @Get('roles/can-assign')
  canAssignRole(
    @Query('assignerRole') assignerRole: string,
    @Query('targetRole') targetRole: string,
  ): UsersCanAssignRoleResponseDto {
    return this.roleTemplateService.canAssignRole(assignerRole, targetRole);
  }

  /**
   * Get permissions for a specific role
   */
  @AdminResponseContract(usersGetRolePermissionsResponseArrayContract)
  @Get('roles/:roleCode/permissions')
  getRolePermissions(
    @Param('roleCode') roleCode: string,
  ): readonly UsersGetRolePermissionsResponseDto[] {
    return this.roleTemplateService.getRolePermissions(roleCode);
  }
}
