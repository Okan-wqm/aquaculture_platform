import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import * as crypto from 'crypto';
import { Repository, DataSource } from 'typeorm';
import { SchemaManagerService, Role } from '@platform/backend-common';
import { IEventBus } from '@platform/event-bus';
import { UserInvitedEvent, createBaseEvent } from '@platform/event-contracts';

import { AuditLogService } from '../../../audit/audit-log.service';
import { AuditLogSeverity } from '../../../audit/audit-log.entity';
import { RefreshToken } from '../../authentication/entities/refresh-token.entity';
import { User, AccessType } from '../../authentication/entities/user.entity';
import { Tenant } from '../entities/tenant.entity';
import { MobileUserSettings, DEFAULT_MOBILE_FEATURES } from '../entities/mobile-user-settings.entity';
import { TenantRoleService, TenantRoleWithDetails } from './tenant-role.service';

/**
 * Result of user creation
 */
export interface CreatedUserResult {
  user: User;
  roleAssignment: UserRoleAssignmentResult;
  invitationSent: boolean;
}

/**
 * User role assignment result (matches TenantUserManagementService interface)
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
 * UserLifecycleService
 *
 * Unified service for user creation and deletion, ensuring:
 * 1. createUser() — single transaction: user record + role assignment + module assignments
 * 2. deleteUser() — deactivates user, revokes role assignments, AND revokes ALL refresh tokens
 * 3. Prevents deleting another TENANT_ADMIN
 *
 * SECURITY CRITICAL: This service consolidates user lifecycle operations that were
 * previously split across TenantAdminService and TenantUserManagementService,
 * fixing the gap where deleteTenantUser did NOT revoke refresh tokens.
 */
@Injectable()
export class UserLifecycleService {
  private readonly logger = new Logger(UserLifecycleService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepository: Repository<RefreshToken>,
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
   * Create a new user within a tenant.
   *
   * Single flow that:
   * 1. Validates tenant exists
   * 2. Checks for duplicate email
   * 3. Validates role exists in tenant
   * 4. Creates user record with invitation token
   * 5. Creates role assignment in tenant schema
   * 6. Sends invitation email
   */
  async createUser(
    tenantId: string,
    input: {
      firstName: string;
      lastName: string;
      email: string;
      password?: string;
      roleId: string;
      accessType?: AccessType;
      permissionOverrides?: {
        grants: string[];
        revokes: string[];
      };
    },
    createdBy: string,
    sendInvitation: boolean = true,
  ): Promise<CreatedUserResult> {
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
    const invitationTokenHash = plainInvitationToken
      ? crypto.createHash('sha256').update(plainInvitationToken).digest('hex')
      : null;
    const invitationExpiry = plainInvitationToken
      ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
      : null;

    // Create user in auth.users table
    const userAccessType = input.accessType ?? AccessType.BOTH;
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
      invitationToken: invitationTokenHash,
      invitationExpiresAt: invitationExpiry,
      invitedBy: createdBy,
    });

    const savedUser = await this.userRepository.save(newUser);
    // SECURITY: Log user ID instead of email to prevent PII exposure in logs (H-14)
    this.logger.log(`Created user userId=${savedUser.id} for tenant ${tenantId}`);

    // Auto-provision mobile_user_settings when user has mobile access
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

    // Send invitation email if requested
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

    // SECURITY AUDIT: Log user creation
    try {
      await this.auditLogService.log({
        tenantId,
        performedBy: createdBy,
        action: 'USER_CREATED',
        entityType: 'User',
        entityId: savedUser.id,
        details: {
          email: savedUser.email,
          role: savedUser.role,
          tenantRoleId: input.roleId,
          timestamp: new Date().toISOString(),
        },
        severity: AuditLogSeverity.INFO,
      });
    } catch (error) {
      this.logger.error(`Failed to log audit event USER_CREATED: ${(error as Error).message}`);
    }

    return {
      user: savedUser,
      roleAssignment,
      invitationSent,
    };
  }

  /**
   * Delete (soft-delete) a tenant user.
   *
   * SECURITY CRITICAL: This method MUST:
   * 1. Deactivate the user (isActive = false)
   * 2. Revoke all role assignments in tenant schema
   * 3. Revoke ALL refresh tokens (prevents continued access)
   * 4. Prevent deleting another TENANT_ADMIN
   * 5. Prevent self-deletion
   */
  async deleteUser(
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

    // 3. CRITICAL: Revoke ALL refresh tokens
    // Without this, existing refresh tokens remain valid and can be used to obtain
    // new access tokens even after the user is "deleted".
    await this.refreshTokenRepository.update(
      { userId, isRevoked: false },
      { isRevoked: true, revokedAt: new Date(), revokedReason: 'User deleted' },
    );

    // SECURITY: Log user ID instead of email to prevent PII exposure in logs (H-14)
    this.logger.log(`Deleted (soft) userId=${user.id} from tenant ${tenantId}, revoked all refresh tokens`);

    // SECURITY AUDIT: Log user deletion
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
          refreshTokensRevoked: true,
          timestamp: new Date().toISOString(),
        },
        severity: AuditLogSeverity.WARNING,
      });
    } catch (error) {
      this.logger.error(`Failed to log audit event USER_DELETED: ${(error as Error).message}`);
    }

    return true;
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

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
   * Calculate effective permissions by applying overrides to role permissions
   */
  private calculateEffectivePermissions(
    rolePermissions: string[],
    overrides: { grants: string[]; revokes: string[] },
  ): string[] {
    const effective = new Set(rolePermissions);

    for (const revoke of overrides.revokes) {
      effective.delete(revoke);
    }

    for (const grant of overrides.grants) {
      effective.add(grant);
    }

    return Array.from(effective);
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
}
