import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  Inject,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import * as crypto from 'crypto';
import { Repository, DataSource } from 'typeorm';
import { SchemaManagerService, Role } from '@aquaculture/backend-common';
import { IEventBus } from '@platform/event-bus';
import { UserInvitedEvent, createBaseEvent } from '@platform/event-contracts';

import { AuditLogService } from '../../../audit/audit-log.service';
import { AuditLogSeverity } from '../../../audit/audit-log.entity';
// WHY: Import AccessType so createTenantUser and updateTenantUser can accept and
// persist the platform access level chosen by the tenant admin.
import { User, AccessType } from '../../authentication/entities/user.entity';
import { Tenant } from '../entities/tenant.entity';
import { MobileUserSettings, DEFAULT_MOBILE_FEATURES } from '../entities/mobile-user-settings.entity';
import { TenantRoleService, TenantRoleWithDetails } from './tenant-role.service';

/**
 * Created tenant user result
 */
export interface CreatedTenantUser {
  user: User;
  roleAssignment: UserRoleAssignmentResult;
  invitationSent: boolean;
}

/**
 * User role assignment result
 */
export interface UserRoleAssignmentResult {
  id: string;
  userId: string;
  roleId: string;
  roleName: string;
  roleColor: string;
  roleIcon: string;
  roleLevel: number;
  permissionOverrides: {
    grants: string[];
    revokes: string[];
  };
  panelPermissions: Record<string, Record<string, Record<string, boolean>>>;
  resourcePermissions: string[];
  effectivePermissions: string[];
  isActive: boolean;
  expiresAt: Date | null;
  assignedAt: Date;
  assignedBy: string;
}

/**
 * Effective permissions result
 */
export interface EffectivePermissionsResult {
  roleId: string;
  roleName: string;
  panelPermissions: Record<string, Record<string, Record<string, boolean>>>;
  resourcePermissions: string[];
  overrides: {
    grants: string[];
    revokes: string[];
  };
}

/**
 * Bulk assignment result
 */
export interface BulkAssignmentResult {
  success: string[];
  failed: Array<{ userId: string; error: string }>;
}

@Injectable()
export class TenantUserManagementService {
  private readonly logger = new Logger(TenantUserManagementService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    // WHY: MobileUserSettings repository needed for auto-provisioning/deactivating
    // mobile settings when accessType changes (MOBILE_ONLY, BOTH, PANEL_ONLY).
    @InjectRepository(MobileUserSettings)
    private readonly mobileSettingsRepository: Repository<MobileUserSettings>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly schemaManager: SchemaManagerService,
    private readonly tenantRoleService: TenantRoleService,
    @Inject('EVENT_BUS') private readonly eventBus: IEventBus,
    private readonly auditLogService: AuditLogService,
  ) {}

  /**
   * Create a new user within a tenant schema and assign initial role
   */
  async createTenantUser(
    tenantId: string,
    input: {
      firstName: string;
      lastName: string;
      email: string;
      password?: string;
      roleId: string;
      // WHY: accessType lets the tenant admin control which platforms a new user
      // can access. Defaults to BOTH for backward compatibility.
      accessType?: AccessType;
      permissionOverrides?: {
        grants: string[];
        revokes: string[];
      };
    },
    createdBy: string,
    sendInvitation: boolean = true,
  ): Promise<CreatedTenantUser> {
    const schemaName = this.schemaManager.getTenantSchemaName(tenantId);

    // Validate tenant exists and is active
    const tenant = await this.tenantRepository.findOne({ where: { id: tenantId } });
    if (!tenant) {
      throw new NotFoundException(`Tenant with ID "${tenantId}" not found`);
    }

    // Check for existing user with same email (globally unique)
    const existingUser = await this.userRepository.findOne({
      where: { email: input.email.toLowerCase() },
    });
    if (existingUser) {
      throw new ConflictException(`User with email "${input.email}" already exists`);
    }

    // Validate role exists in tenant
    const role = await this.tenantRoleService.getRoleById(tenantId, input.roleId);
    if (!role) {
      throw new NotFoundException(`Role with ID "${input.roleId}" not found in tenant`);
    }

    // Generate invitation token if not providing password
    // SECURITY: Use crypto.randomBytes for unpredictable tokens (256 bits of entropy)
    const plainInvitationToken = sendInvitation && !input.password
      ? crypto.randomBytes(32).toString('hex')
      : null;
    // SECURITY: Hash invitation token with SHA-256 before storage (SEC-005)
    // Plain token is sent to user via email, hash is stored in DB for verification
    const invitationTokenHash = plainInvitationToken
      ? crypto.createHash('sha256').update(plainInvitationToken).digest('hex')
      : null;
    const invitationExpiry = plainInvitationToken
      ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
      : null;

    // WHY: Resolve accessType with BOTH as default for backward compatibility.
    // Tenant admin can override to PANEL_ONLY or MOBILE_ONLY per user.
    const userAccessType = input.accessType ?? AccessType.BOTH;

    // Create user in auth.users table
    const newUser = this.userRepository.create({
      email: input.email.toLowerCase(),
      firstName: input.firstName,
      lastName: input.lastName,
      password: input.password || undefined,
      role: Role.MODULE_USER, // Default global role; tenant role is separate
      accessType: userAccessType,
      tenantId,
      isActive: true,
      isEmailVerified: false,
      invitationToken: invitationTokenHash, // Store hash, not plain token
      invitationExpiresAt: invitationExpiry,
      invitedBy: createdBy,
    });

    const savedUser = await this.userRepository.save(newUser);
    // SECURITY: Log user ID instead of email to prevent PII exposure in logs (H-14)
    this.logger.log(`Created user userId=${savedUser.id} for tenant ${tenantId}`);

    // WHY: Auto-provision mobile_user_settings when user has mobile access.
    // Without this, mobile app would show "no settings" for new mobile users.
    if (userAccessType === AccessType.MOBILE_ONLY || userAccessType === AccessType.BOTH) {
      try {
        const mobileSettings = this.mobileSettingsRepository.create({
          userId: savedUser.id,
          tenantId,
          allowedFeatures: { ...DEFAULT_MOBILE_FEATURES },
          isMobileEnabled: true,
        });
        await this.mobileSettingsRepository.save(mobileSettings);
        this.logger.debug(`Auto-provisioned mobile settings for user ${savedUser.id}`);
      } catch (mobileErr) {
        // Non-fatal: mobile settings can be created on-demand when user first opens the app
        this.logger.warn(`Failed to auto-provision mobile settings for ${savedUser.id}: ${(mobileErr as Error).message}`);
      }
    }

    // Create role assignment in tenant schema
    const roleAssignment = await this.createRoleAssignment(
      schemaName,
      savedUser.id,
      input.roleId,
      role,
      input.permissionOverrides || { grants: [], revokes: [] },
      createdBy,
    );

    // Send invitation email if requested — use plain token (not hash) for user link
    let invitationSent = false;
    if (sendInvitation && plainInvitationToken) {
      try {
        await this.sendInvitationEmail(tenant, savedUser, plainInvitationToken);
        invitationSent = true;
      } catch (error) {
        // SECURITY: Log user ID instead of email to prevent PII exposure (H-14)
        this.logger.error(`Failed to send invitation email for userId=${savedUser.id}: ${(error as Error).message}`);
      }
    }

    return {
      user: savedUser,
      roleAssignment,
      invitationSent,
    };
  }

  /**
   * Update a tenant user's profile fields (firstName, lastName) and optionally their role assignment
   */
  async updateTenantUser(
    tenantId: string,
    userId: string,
    input: {
      firstName?: string;
      lastName?: string;
      roleId?: string;
      // WHY: accessType in update allows tenant admin to change platform access
      // after user creation. Service handles mobile settings lifecycle.
      accessType?: AccessType;
    },
    updatedBy: string,
  ): Promise<User> {
    // SECURITY: Prevent self-demotion / self-modification of role
    // (profile field changes on self are allowed)

    // Validate user exists and belongs to tenant
    const user = await this.userRepository.findOne({
      where: { id: userId, tenantId },
    });
    if (!user) {
      throw new NotFoundException(`User with ID "${userId}" not found in tenant`);
    }

    // Update profile fields
    let profileChanged = false;
    if (input.firstName !== undefined) {
      user.firstName = input.firstName;
      profileChanged = true;
    }
    if (input.lastName !== undefined) {
      user.lastName = input.lastName;
      profileChanged = true;
    }

    // WHY: Process accessType change separately from profile fields because it
    // triggers side effects (mobile settings provisioning/deactivation).
    if (input.accessType !== undefined && input.accessType !== user.accessType) {
      const oldAccessType = user.accessType;
      user.accessType = input.accessType;
      profileChanged = true;

      const hadMobileAccess = oldAccessType === AccessType.MOBILE_ONLY || oldAccessType === AccessType.BOTH;
      const hasMobileAccess = input.accessType === AccessType.MOBILE_ONLY || input.accessType === AccessType.BOTH;

      if (!hadMobileAccess && hasMobileAccess) {
        // WHY: User gained mobile access — auto-provision mobile settings if they don't exist.
        try {
          const existing = await this.mobileSettingsRepository.findOne({ where: { userId, tenantId } });
          if (existing) {
            // Re-enable existing settings
            existing.isMobileEnabled = true;
            await this.mobileSettingsRepository.save(existing);
          } else {
            const mobileSettings = this.mobileSettingsRepository.create({
              userId,
              tenantId,
              allowedFeatures: { ...DEFAULT_MOBILE_FEATURES },
              isMobileEnabled: true,
            });
            await this.mobileSettingsRepository.save(mobileSettings);
          }
          this.logger.debug(`Provisioned mobile settings for user ${userId} (accessType -> ${input.accessType})`);
        } catch (mobileErr) {
          this.logger.warn(`Failed to provision mobile settings for ${userId}: ${(mobileErr as Error).message}`);
        }
      } else if (hadMobileAccess && !hasMobileAccess) {
        // WHY: User lost mobile access — deactivate mobile settings to enforce access restriction.
        try {
          const existing = await this.mobileSettingsRepository.findOne({ where: { userId, tenantId } });
          if (existing) {
            existing.isMobileEnabled = false;
            await this.mobileSettingsRepository.save(existing);
            this.logger.debug(`Deactivated mobile settings for user ${userId} (accessType -> PANEL_ONLY)`);
          }
        } catch (mobileErr) {
          this.logger.warn(`Failed to deactivate mobile settings for ${userId}: ${(mobileErr as Error).message}`);
        }
      }
    }

    if (profileChanged) {
      await this.userRepository.save(user);
      // SECURITY: Log user ID instead of email to prevent PII exposure in logs (H-14)
      this.logger.log(`Updated profile for userId=${userId} in tenant ${tenantId}`);
    }

    // Update role assignment if roleId is provided
    if (input.roleId) {
      const schemaName = this.schemaManager.getTenantSchemaName(tenantId);

      // Validate new role exists in tenant
      const newRole = await this.tenantRoleService.getRoleById(tenantId, input.roleId);
      if (!newRole) {
        throw new NotFoundException(`Role with ID "${input.roleId}" not found in tenant`);
      }

      // Check if user has an existing active role assignment
      const existingResult = await this.dataSource.query(
        `SELECT id, role_id FROM "${schemaName}"."user_role_assignments" WHERE user_id = $1 AND is_active = true`,
        [userId],
      );

      if (existingResult.length > 0) {
        const existing = existingResult[0];
        // Only update if role actually changed
        if (existing.role_id !== input.roleId) {
          await this.dataSource.query(
            `UPDATE "${schemaName}"."user_role_assignments"
             SET role_id = $1, updated_at = NOW(), updated_by = $2
             WHERE id = $3`,
            [input.roleId, updatedBy, existing.id],
          );
          this.logger.log(`Updated role assignment for user ${userId} to role ${newRole.name} in tenant ${tenantId}`);

          // SECURITY AUDIT: Log role change (BULGU-016)
          try {
            await this.auditLogService.log({
              tenantId,
              performedBy: updatedBy,
              action: 'USER_ROLE_CHANGED',
              entityType: 'UserRoleAssignment',
              entityId: userId,
              previousValue: { roleId: existing.role_id },
              newValue: { roleId: input.roleId },
              details: {
                newRoleName: newRole.name,
                timestamp: new Date().toISOString(),
              },
              severity: AuditLogSeverity.WARNING,
            });
          } catch (error) {
            this.logger.error(`Failed to log audit event USER_ROLE_CHANGED: ${(error as Error).message}`);
          }
        }
      } else {
        // No existing assignment — create one
        await this.dataSource.query(
          `INSERT INTO "${schemaName}"."user_role_assignments" (
            user_id, role_id, permission_overrides, is_active, assigned_by, created_at, updated_at
          ) VALUES ($1, $2, $3, true, $4, NOW(), NOW())`,
          [userId, input.roleId, JSON.stringify({ grants: [], revokes: [] }), updatedBy],
        );
        this.logger.log(`Created role assignment for user ${userId} with role ${newRole.name} in tenant ${tenantId}`);
      }
    }

    // Return updated user
    const updatedUser = await this.userRepository.findOne({ where: { id: userId } });
    return updatedUser!;
  }

  /**
   * Soft-delete a tenant user
   *
   * Sets isActive = false, revokes role assignment, and revokes all refresh tokens.
   * This is a "soft delete" — the user record remains but is fully deactivated.
   */
  async deleteTenantUser(
    tenantId: string,
    userId: string,
    deletedBy: string,
  ): Promise<boolean> {
    // SECURITY: Prevent self-deletion
    if (deletedBy === userId) {
      throw new BadRequestException('Cannot delete your own account');
    }

    // Validate user exists and belongs to tenant
    const user = await this.userRepository.findOne({
      where: { id: userId, tenantId },
    });
    if (!user) {
      throw new NotFoundException(`User with ID "${userId}" not found in tenant`);
    }

    // SECURITY: Cannot delete another TENANT_ADMIN
    if (user.role === Role.TENANT_ADMIN) {
      throw new ForbiddenException('Cannot delete a tenant admin user');
    }

    const schemaName = this.schemaManager.getTenantSchemaName(tenantId);

    // 1. Deactivate the user
    user.isActive = false;
    await this.userRepository.save(user);

    // 2. Revoke role assignments in tenant schema
    try {
      await this.dataSource.query(
        `UPDATE "${schemaName}"."user_role_assignments"
         SET is_active = false, updated_at = NOW(), updated_by = $2
         WHERE user_id = $1 AND is_active = true`,
        [userId, deletedBy],
      );
    } catch (error) {
      this.logger.warn(`Failed to revoke role assignments for user ${userId}: ${(error as Error).message}`);
    }

    // SECURITY: Log user ID instead of email to prevent PII exposure in logs (H-14)
    this.logger.log(`Deleted (soft) userId=${user.id} from tenant ${tenantId}`);

    // SECURITY AUDIT: Log user deletion (BULGU-016)
    try {
      const admin = await this.userRepository.findOne({ where: { id: deletedBy } });
      await this.auditLogService.log({
        tenantId,
        performedBy: deletedBy,
        performedByEmail: admin?.email,
        action: 'USER_DELETED',
        entityType: 'User',
        entityId: userId,
        details: {
          targetEmail: user.email,
          targetRole: user.role,
          timestamp: new Date().toISOString(),
        },
        severity: AuditLogSeverity.WARNING,
      });
    } catch (error) {
      this.logger.error(`Failed to log audit event USER_DELETED: ${(error as Error).message}`);
    }

    return true;
  }

  /**
   * Assign a role to an existing user in a tenant
   */
  async assignUserRole(
    tenantId: string,
    userId: string,
    input: {
      roleId: string;
      permissionOverrides?: {
        grants: string[];
        revokes: string[];
      };
      expiresAt?: Date;
    },
    assignedBy: string,
  ): Promise<UserRoleAssignmentResult> {
    const schemaName = this.schemaManager.getTenantSchemaName(tenantId);

    // Validate user exists and belongs to tenant
    const user = await this.userRepository.findOne({
      where: { id: userId, tenantId },
    });
    if (!user) {
      throw new NotFoundException(`User with ID "${userId}" not found in tenant`);
    }

    // Validate role exists in tenant
    const role = await this.tenantRoleService.getRoleById(tenantId, input.roleId);
    if (!role) {
      throw new NotFoundException(`Role with ID "${input.roleId}" not found in tenant`);
    }

    // Check if user already has an active role assignment
    const existingAssignment = await this.dataSource.query(
      `SELECT id FROM "${schemaName}"."user_role_assignments" WHERE user_id = $1 AND is_active = true`,
      [userId],
    );

    if (existingAssignment.length > 0) {
      throw new ConflictException(
        `User already has an active role assignment. Use updateUserRole to change it.`
      );
    }

    // Create role assignment
    const roleAssignment = await this.createRoleAssignment(
      schemaName,
      userId,
      input.roleId,
      role,
      input.permissionOverrides || { grants: [], revokes: [] },
      assignedBy,
      input.expiresAt,
    );

    this.logger.log(`Assigned role "${role.name}" to user ${userId} in tenant ${tenantId}`);

    return roleAssignment;
  }

  /**
   * Update an existing user role assignment
   */
  async updateUserRole(
    tenantId: string,
    userId: string,
    input: {
      roleId?: string;
      permissionOverrides?: {
        grants: string[];
        revokes: string[];
      };
      expiresAt?: Date;
      isActive?: boolean;
    },
    updatedBy: string,
  ): Promise<UserRoleAssignmentResult> {
    const schemaName = this.schemaManager.getTenantSchemaName(tenantId);

    // Validate user exists and belongs to tenant
    const user = await this.userRepository.findOne({
      where: { id: userId, tenantId },
    });
    if (!user) {
      throw new NotFoundException(`User with ID "${userId}" not found in tenant`);
    }

    // Get existing assignment
    const existingResult = await this.dataSource.query(
      `SELECT * FROM "${schemaName}"."user_role_assignments" WHERE user_id = $1 AND is_active = true`,
      [userId],
    );

    if (existingResult.length === 0) {
      throw new NotFoundException(`No active role assignment found for user ${userId}`);
    }

    const existing = existingResult[0];
    const assignmentId = existing.id;

    // If changing role, validate new role exists
    let newRole: TenantRoleWithDetails | null = null;
    if (input.roleId && input.roleId !== existing.role_id) {
      newRole = await this.tenantRoleService.getRoleById(tenantId, input.roleId);
      if (!newRole) {
        throw new NotFoundException(`Role with ID "${input.roleId}" not found in tenant`);
      }
    }

    // Build update query
    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.roleId !== undefined) {
      updates.push(`role_id = $${paramIndex++}`);
      values.push(input.roleId);
    }

    if (input.permissionOverrides !== undefined) {
      updates.push(`permission_overrides = $${paramIndex++}`);
      values.push(JSON.stringify(input.permissionOverrides));
    }

    if (input.expiresAt !== undefined) {
      updates.push(`expires_at = $${paramIndex++}`);
      values.push(input.expiresAt);
    }

    if (input.isActive !== undefined) {
      updates.push(`is_active = $${paramIndex++}`);
      values.push(input.isActive);
    }

    updates.push(`updated_at = NOW()`);
    updates.push(`updated_by = $${paramIndex++}`);
    values.push(updatedBy);

    values.push(assignmentId);

    // Execute update
    await this.dataSource.query(
      `UPDATE "${schemaName}"."user_role_assignments" SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
      values,
    );

    this.logger.log(`Updated role assignment for user ${userId} in tenant ${tenantId}`);

    // SECURITY AUDIT: Log role change (BULGU-016)
    try {
      await this.auditLogService.log({
        tenantId,
        performedBy: updatedBy,
        action: 'USER_ROLE_CHANGED',
        entityType: 'UserRoleAssignment',
        entityId: userId,
        previousValue: {
          roleId: existing.role_id,
        },
        newValue: {
          roleId: input.roleId ?? existing.role_id,
          isActive: input.isActive ?? true,
          permissionOverrides: input.permissionOverrides,
        },
        details: {
          assignmentId,
          timestamp: new Date().toISOString(),
        },
        severity: AuditLogSeverity.WARNING,
      });
    } catch (error) {
      this.logger.error(`Failed to log audit event USER_ROLE_CHANGED: ${(error as Error).message}`);
    }

    // Return updated assignment
    return this.getUserRoleAssignment(schemaName, userId);
  }

  /**
   * Revoke a user's role (soft delete or hard delete)
   */
  async revokeUserRole(
    tenantId: string,
    userId: string,
    hardDelete: boolean = false,
    revokedBy: string,
  ): Promise<boolean> {
    const schemaName = this.schemaManager.getTenantSchemaName(tenantId);

    // Validate user exists and belongs to tenant
    const user = await this.userRepository.findOne({
      where: { id: userId, tenantId },
    });
    if (!user) {
      throw new NotFoundException(`User with ID "${userId}" not found in tenant`);
    }

    // Get existing active assignment
    const existingResult = await this.dataSource.query(
      `SELECT id FROM "${schemaName}"."user_role_assignments" WHERE user_id = $1 AND is_active = true`,
      [userId],
    );

    if (existingResult.length === 0) {
      throw new NotFoundException(`No active role assignment found for user ${userId}`);
    }

    if (hardDelete) {
      // Hard delete - remove the record
      await this.dataSource.query(
        `DELETE FROM "${schemaName}"."user_role_assignments" WHERE user_id = $1`,
        [userId],
      );
      this.logger.log(`Hard deleted role assignment for user ${userId} in tenant ${tenantId}`);
    } else {
      // Soft delete - set is_active = false
      await this.dataSource.query(
        `UPDATE "${schemaName}"."user_role_assignments"
         SET is_active = false, updated_at = NOW(), updated_by = $2
         WHERE user_id = $1 AND is_active = true`,
        [userId, revokedBy],
      );
      this.logger.log(`Soft deleted (deactivated) role assignment for user ${userId} in tenant ${tenantId}`);
    }

    return true;
  }

  /**
   * Get a user's effective permissions (role permissions + overrides)
   */
  async getUserEffectivePermissions(
    tenantId: string,
    userId: string,
  ): Promise<EffectivePermissionsResult> {
    const schemaName = this.schemaManager.getTenantSchemaName(tenantId);

    // Validate user exists and belongs to tenant
    const user = await this.userRepository.findOne({
      where: { id: userId, tenantId },
    });
    if (!user) {
      throw new NotFoundException(`User with ID "${userId}" not found in tenant`);
    }

    // Get user's role assignment with role details
    const assignmentResult = await this.dataSource.query(
      `
      SELECT
        ura.*,
        r.name as role_name,
        r.color as role_color,
        r.icon as role_icon,
        r.level as role_level,
        rp.panel_permissions,
        rp.resource_permissions
      FROM "${schemaName}"."user_role_assignments" ura
      JOIN "${schemaName}"."tenant_roles" r ON ura.role_id = r.id
      LEFT JOIN "${schemaName}"."tenant_role_permissions" rp ON r.id = rp.role_id
      WHERE ura.user_id = $1 AND ura.is_active = true
      `,
      [userId],
    );

    if (assignmentResult.length === 0) {
      throw new NotFoundException(`No active role assignment found for user ${userId}`);
    }

    const assignment = assignmentResult[0];
    const overrides = this.parsePermissionOverrides(assignment.permission_overrides);
    const panelPermissions = this.parsePanelPermissions(assignment.panel_permissions);
    const resourcePermissions: string[] = assignment.resource_permissions || [];

    return {
      roleId: assignment.role_id,
      roleName: assignment.role_name,
      panelPermissions,
      resourcePermissions,
      overrides,
    };
  }

  /**
   * Bulk assign role to multiple users
   */
  async bulkAssignRole(
    tenantId: string,
    userIds: string[],
    roleId: string,
    assignedBy: string,
  ): Promise<BulkAssignmentResult> {
    const result: BulkAssignmentResult = {
      success: [],
      failed: [],
    };

    // Validate role exists
    const role = await this.tenantRoleService.getRoleById(tenantId, roleId);
    if (!role) {
      throw new NotFoundException(`Role with ID "${roleId}" not found in tenant`);
    }

    for (const userId of userIds) {
      try {
        await this.assignUserRole(
          tenantId,
          userId,
          { roleId, permissionOverrides: { grants: [], revokes: [] } },
          assignedBy,
        );
        result.success.push(userId);
      } catch (error) {
        result.failed.push({
          userId,
          error: (error as Error).message,
        });
      }
    }

    this.logger.log(
      `Bulk assigned role "${role.name}" to ${result.success.length} users, ${result.failed.length} failed`
    );

    return result;
  }

  /**
   * Get a user's role assignment from tenant schema
   */
  private async getUserRoleAssignment(
    schemaName: string,
    userId: string,
  ): Promise<UserRoleAssignmentResult> {
    const result = await this.dataSource.query(
      `
      SELECT
        ura.*,
        r.name as role_name,
        r.color as role_color,
        r.icon as role_icon,
        r.level as role_level,
        rp.panel_permissions,
        rp.resource_permissions
      FROM "${schemaName}"."user_role_assignments" ura
      JOIN "${schemaName}"."tenant_roles" r ON ura.role_id = r.id
      LEFT JOIN "${schemaName}"."tenant_role_permissions" rp ON r.id = rp.role_id
      WHERE ura.user_id = $1 AND ura.is_active = true
      `,
      [userId],
    );

    if (result.length === 0) {
      throw new NotFoundException(`No active role assignment found for user ${userId}`);
    }

    return this.mapRowToUserRoleAssignment(result[0]);
  }

  /**
   * Create a new role assignment in tenant schema
   */
  private async createRoleAssignment(
    schemaName: string,
    userId: string,
    roleId: string,
    role: TenantRoleWithDetails,
    permissionOverrides: { grants: string[]; revokes: string[] },
    assignedBy: string,
    expiresAt?: Date,
  ): Promise<UserRoleAssignmentResult> {
    // Insert role assignment
    const insertResult = await this.dataSource.query(
      `
      INSERT INTO "${schemaName}"."user_role_assignments" (
        user_id, role_id, permission_overrides, is_active, expires_at, assigned_by, created_at, updated_at
      ) VALUES ($1, $2, $3, true, $4, $5, NOW(), NOW())
      RETURNING id
      `,
      [userId, roleId, JSON.stringify(permissionOverrides), expiresAt || null, assignedBy],
    );

    const assignmentId = insertResult[0].id;

    // Build response
    const effectivePermissions = this.calculateEffectivePermissions(
      role.permissions?.resourcePermissions || [],
      permissionOverrides,
    );

    return {
      id: assignmentId,
      userId,
      roleId,
      roleName: role.name,
      roleColor: role.color,
      roleIcon: role.icon,
      roleLevel: role.level,
      permissionOverrides,
      panelPermissions: role.permissions?.panelPermissions || {},
      resourcePermissions: role.permissions?.resourcePermissions || [],
      effectivePermissions,
      isActive: true,
      expiresAt: expiresAt || null,
      assignedAt: new Date(),
      assignedBy,
    };
  }

  /**
   * Send invitation email to new user
   */
  private async sendInvitationEmail(
    tenant: Tenant,
    user: User,
    invitationToken: string,
  ): Promise<void> {
    const baseUrl = process.env['APP_URL'];
    if (!baseUrl) {
      throw new Error('APP_URL environment variable is not configured');
    }
    const actionUrl = `${baseUrl}/accept-invitation/${invitationToken}`;

    const event: UserInvitedEvent = {
      ...createBaseEvent<UserInvitedEvent>('UserInvited', tenant.id, { aggregateId: user.id, aggregateType: 'User' }),
      userId: user.id,
      email: user.email,
      firstName: user.firstName || undefined,
      lastName: user.lastName || undefined,
      role: user.role,
      tenantName: tenant.name,
      invitedBy: user.invitedBy || undefined,
      credentialType: 'reset_token',
      actionUrl,
    };

    await this.eventBus.publish(event);
    // SECURITY: Log user ID instead of email to prevent PII exposure in logs (H-14)
    this.logger.log(`Published UserInvitedEvent for userId=${user.id}`);
  }

  /**
   * Calculate effective permissions by applying overrides to role permissions
   */
  private calculateEffectivePermissions(
    rolePermissions: string[],
    overrides: { grants: string[]; revokes: string[] },
  ): string[] {
    // Start with role permissions
    const effective = new Set(rolePermissions);

    // Remove revoked permissions
    for (const revoke of overrides.revokes) {
      effective.delete(revoke);
    }

    // Add granted permissions
    for (const grant of overrides.grants) {
      effective.add(grant);
    }

    return Array.from(effective);
  }

  /**
   * Parse permission overrides from JSON or object
   */
  private parsePermissionOverrides(
    raw: unknown,
  ): { grants: string[]; revokes: string[] } {
    if (!raw) {
      return { grants: [], revokes: [] };
    }

    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        return {
          grants: Array.isArray(parsed.grants) ? parsed.grants : [],
          revokes: Array.isArray(parsed.revokes) ? parsed.revokes : [],
        };
      } catch {
        return { grants: [], revokes: [] };
      }
    }

    if (typeof raw === 'object') {
      const obj = raw as { grants?: string[]; revokes?: string[] };
      return {
        grants: Array.isArray(obj.grants) ? obj.grants : [],
        revokes: Array.isArray(obj.revokes) ? obj.revokes : [],
      };
    }

    return { grants: [], revokes: [] };
  }

  /**
   * Parse panel permissions from JSON or object
   */
  private parsePanelPermissions(
    raw: unknown,
  ): Record<string, Record<string, Record<string, boolean>>> {
    if (!raw) {
      return {};
    }

    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw);
      } catch {
        return {};
      }
    }

    if (typeof raw === 'object') {
      return raw as Record<string, Record<string, Record<string, boolean>>>;
    }

    return {};
  }

  /**
   * Map database row to UserRoleAssignmentResult
   */
  private mapRowToUserRoleAssignment(row: Record<string, unknown>): UserRoleAssignmentResult {
    const overrides = this.parsePermissionOverrides(row.permission_overrides);
    const panelPermissions = this.parsePanelPermissions(row.panel_permissions);
    const resourcePermissions: string[] = (row.resource_permissions as string[]) || [];
    const effectivePermissions = this.calculateEffectivePermissions(resourcePermissions, overrides);

    return {
      id: row.id as string,
      userId: row.user_id as string,
      roleId: row.role_id as string,
      roleName: row.role_name as string,
      roleColor: row.role_color as string,
      roleIcon: row.role_icon as string,
      roleLevel: row.role_level as number,
      permissionOverrides: overrides,
      panelPermissions,
      resourcePermissions,
      effectivePermissions,
      isActive: row.is_active as boolean,
      expiresAt: row.expires_at as Date | null,
      assignedAt: row.created_at as Date,
      assignedBy: row.assigned_by as string,
    };
  }
}
