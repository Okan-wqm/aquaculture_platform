import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTenantSchemaName, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { Role } from '@aquaculture/backend-common/decorators';
// User stays raw because User.tenantId is nullable (platform-admin
// users). UserModuleAssignment.tenantId is required, so it uses the
// scoped wrapper.
import * as crypto from 'crypto';
import { In, Repository, DataSource } from 'typeorm';

import { AuditLogService } from '../../../audit/audit-log.service';
import { AuditLogSeverity } from '../../../audit/audit-log.entity';
import { RefreshToken } from '../../authentication/entities/refresh-token.entity';
import { UserModuleAssignment } from '../../authentication/entities/user-module-assignment.entity';
import { UserSiteAssignment } from '../../authentication/entities/user-site-assignment.entity';
import { User } from '../../authentication/entities/user.entity';
import { Module } from '../../system-module/entities/module.entity';
import {
  AssignUserToModuleInput,
  AssignUserToSiteInput,
  AssignmentResult,
  SiteAssignmentResult,
  UserModuleInfo,
  MyTenantInfo,
  TenantTableInfo,
  TableDataResult,
  GetTableDataInput,
} from '../dto/tenant-admin.dto';
import {
  TenantLocalizationPreferences,
  TenantSecurityPolicy,
  UpdateTenantLocalizationPreferencesInput,
  UpdateTenantSecurityPolicyInput,
} from '../dto/tenant-policy.dto';
import { TenantModule } from '../entities/tenant-module.entity';
import { Tenant, TenantStatus } from '../entities/tenant.entity';

/**
 * Database query result interfaces
 */
interface TableInfoRow {
  tableName: string;
  rowCount: string | null;
}

interface CountRow {
  count: string;
}

interface DataRow {
  [key: string]: unknown;
}

/**
 * TenantAdminService
 *
 * Service for tenant admin operations:
 * - View own tenant info
 * - View assigned modules
 * - Assign module managers/users
 * - View tenant database (read-only)
 */
@Injectable()
export class TenantAdminService {
  private readonly logger = new Logger(TenantAdminService.name);

  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @InjectRepository(TenantModule)
    private readonly tenantModuleRepository: Repository<TenantModule>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(UserModuleAssignment)
    private readonly userModuleAssignmentRepository: Repository<UserModuleAssignment>,
    // SEC-HIGH-051: the write-path for auth.user_site_assignments (object-level
    // site membership SSoT). Without a management surface every MODULE_USER was
    // assignedSiteIds:[] forever and denied on every site-scoped op.
    @InjectRepository(UserSiteAssignment)
    private readonly userSiteAssignmentRepository: Repository<UserSiteAssignment>,
    @InjectRepository(Module)
    private readonly moduleRepository: Repository<Module>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepository: Repository<RefreshToken>,
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
  ) {}

  /**
   * Get current user's tenant info with stats
   */
  async getMyTenant(userId: string): Promise<MyTenantInfo> {
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user || !user.tenantId) {
      throw new NotFoundException('User or tenant not found');
    }

    // PERF: Run tenant fetch and user count in parallel (MED-03)
    const [tenant, currentUserCount] = await Promise.all([
      this.tenantRepository.findOne({ where: { id: user.tenantId } }),
      this.userRepository.count({ where: { tenantId: user.tenantId, isActive: true } }),
    ]);

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      description: tenant.description ?? null,
      logoUrl: tenant.logoUrl ?? null,
      status: tenant.status,
      plan: tenant.plan,
      maxUsers: tenant.maxUsers,
      currentUserCount,
    };
  }

  /**
   * Get modules assigned to current user's tenant
   * For TENANT_ADMIN: Returns all modules assigned to tenant
   * For MODULE_MANAGER/USER: Returns only assigned modules
   */
  async getMyModules(userId: string): Promise<UserModuleInfo[]> {
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // TENANT_ADMIN gets all tenant modules
    if (user.role === Role.TENANT_ADMIN) {
      if (!user.tenantId) {
        return [];
      }

      const tenantModules = await this.tenantModuleRepository.find({
        where: { tenantId: user.tenantId, isEnabled: true },
        relations: ['module'],
        order: { module: { sortOrder: 'ASC' } },
      });

      return tenantModules.map((tm) => ({
        id: tm.id,
        moduleId: tm.moduleId,
        code: tm.module.code,
        name: tm.module.name,
        description: tm.module.description ?? null,
        icon: tm.module.icon ?? null,
        color: tm.module.color ?? null,
        isEnabled: tm.isEnabled,
        defaultRoute: tm.module.defaultRoute,
      }));
    }

    // MODULE_MANAGER and MODULE_USER get their assigned modules
    const assignments = await this.userModuleAssignmentRepository.find({
      where: { userId: user.id, isActive: true },
      relations: ['module'],
    });

    return assignments
      .filter((a) => a.isAccessible() && a.module)
      .map((a) => ({
        id: a.id,
        moduleId: a.moduleId,
        code: a.module.code,
        name: a.module.name,
        description: a.module.description ?? null,
        icon: a.module.icon ?? null,
        color: a.module.color ?? null,
        isEnabled: true,
        defaultRoute: a.module.defaultRoute,
      }));
  }

  /**
   * Get users assigned to a specific module in tenant
   */
  async getModuleUsers(
    tenantAdminId: string,
    moduleId: string,
  ): Promise<User[]> {
    const admin = await this.userRepository.findOne({
      where: { id: tenantAdminId },
    });

    if (!admin || !admin.tenantId) {
      throw new NotFoundException('Admin not found');
    }

    // Verify module belongs to tenant
    const tenantModule = await this.tenantModuleRepository.findOne({
      where: { tenantId: admin.tenantId, moduleId },
    });

    if (!tenantModule) {
      throw new ForbiddenException('Module not assigned to tenant');
    }

    // Get all users assigned to this module
    const assignments = await this.userModuleAssignmentRepository.find({
      where: { moduleId, tenantId: admin.tenantId, isActive: true },
      relations: ['user'],
    });

    return assignments.map((a) => a.user);
  }

  /**
   * Assign a user to a module (create or update)
   */
  async assignUserToModule(
    tenantAdminId: string,
    input: AssignUserToModuleInput,
  ): Promise<AssignmentResult> {
    const admin = await this.userRepository.findOne({
      where: { id: tenantAdminId },
    });

    if (!admin || !admin.tenantId) {
      throw new NotFoundException('Admin not found');
    }

    // Verify module belongs to tenant
    const tenantModule = await this.tenantModuleRepository.findOne({
      where: { tenantId: admin.tenantId, moduleId: input.moduleId },
      relations: ['module'],
    });

    if (!tenantModule) {
      throw new ForbiddenException('Module not assigned to tenant');
    }

    // Check tenant user limit
    const tenant = await this.tenantRepository.findOne({
      where: { id: admin.tenantId },
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    if (tenant.status !== TenantStatus.ACTIVE) {
      throw new ForbiddenException('Tenant is not active');
    }

    // Check if user already exists
    let user = await this.userRepository.findOne({
      where: { email: input.email.toLowerCase(), tenantId: admin.tenantId },
    });

    let isNewUser = false;

    // SECURITY: Wrap user creation + assignment in a transaction to prevent
    // orphaned users on assignment failure or partial state
    return this.dataSource.transaction(async (manager) => {
      // User.tenantId is nullable in the schema (platform-admin users
      // belong to no tenant). tenantManagerRepo requires a non-null
      // tenantId type constraint, so the User repo stays raw here.
      // The code below sets tenantId explicitly on each create().
      // eslint-disable-next-line no-restricted-syntax -- User.tenantId is nullable for platform admins
      const userRepo = manager.getRepository(User);
      const assignmentRepo = tenantManagerRepo(manager, UserModuleAssignment, admin.tenantId!);

      if (!user) {
        // Check user limit
        const currentUserCount = await userRepo.count({
          where: { tenantId: admin.tenantId!, isActive: true },
        });

        if (currentUserCount >= tenant.maxUsers) {
          throw new BadRequestException(
            `User limit reached (${tenant.maxUsers}). Please upgrade your plan.`,
          );
        }

        // Create new user via invitation flow (SEC-AUTH-004)
        // SECURITY: Do NOT accept admin-supplied passwords — require the user to set
        // their own password via the invitation link to prevent account impersonation.
        const role =
          input.role === 'manager' ? Role.MODULE_MANAGER : Role.MODULE_USER;

        // Generate invitation token for the new user
        const plainInvitationToken = crypto.randomBytes(32).toString('hex');
        // SECURITY: Hash invitation token with SHA-256 before storage (SEC-005)
        const invitationTokenHash = crypto.createHash('sha256').update(plainInvitationToken).digest('hex');
        const invitationExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

        user = userRepo.create({
          email: input.email.toLowerCase(),
          firstName: input.firstName,
          lastName: input.lastName,
          password: undefined, // No password — user must set via invitation flow
          tenantId: admin.tenantId!,
          role,
          isActive: true,
          isEmailVerified: false,
          invitationToken: invitationTokenHash, // Store hash, not plain token
          invitationExpiresAt: invitationExpiry,
          invitedBy: tenantAdminId,
        });

        user = await userRepo.save(user);
        isNewUser = true;

        this.logger.log(
          `Created new user ${user.email} for tenant ${tenant.name} (invitation pending)`,
        );
      }

      // Check existing assignment
      const existingAssignment = await assignmentRepo.findOne({
        where: { userId: user.id, moduleId: input.moduleId },
      });

      if (existingAssignment) {
        // Reactivate if inactive
        if (!existingAssignment.isActive) {
          existingAssignment.isActive = true;
          existingAssignment.isPrimaryManager = input.role === 'manager';
          await assignmentRepo.save(existingAssignment);

          return {
            success: true,
            message: 'User assignment reactivated',
            userId: user.id,
            isNewUser: false,
          };
        }

        return {
          success: true,
          message: 'User already assigned to module',
          userId: user.id,
          isNewUser: false,
        };
      }

      // Create assignment
      const assignment = assignmentRepo.create({
        userId: user.id,
        moduleId: input.moduleId,
        tenantId: admin.tenantId!,
        isPrimaryManager: input.role === 'manager',
        isActive: true,
        assignedBy: tenantAdminId,
      });

      await assignmentRepo.save(assignment);

      this.logger.log(
        `Assigned user ${user.email} to module ${tenantModule.module.name}`,
      );

      return {
        success: true,
        message: isNewUser
          ? 'New user created and assigned to module'
          : 'User assigned to module',
        userId: user.id,
        isNewUser,
      };
    });
  }

  /**
   * Remove user from module
   */
  async removeUserFromModule(
    tenantAdminId: string,
    userId: string,
    moduleId: string,
  ): Promise<boolean> {
    // SECURITY: Prevent self-removal from module (SEC-008)
    if (tenantAdminId === userId) {
      throw new BadRequestException('Cannot remove your own module access');
    }

    const admin = await this.userRepository.findOne({
      where: { id: tenantAdminId },
    });

    if (!admin || !admin.tenantId) {
      throw new NotFoundException('Admin not found');
    }

    const assignment = await this.userModuleAssignmentRepository.findOne({
      where: { userId, moduleId, tenantId: admin.tenantId },
    });

    if (!assignment) {
      throw new NotFoundException('Assignment not found');
    }

    assignment.isActive = false;
    await this.userModuleAssignmentRepository.save(assignment);

    this.logger.log(`Removed user ${userId} from module ${moduleId}`);
    return true;
  }

  // =========================================================
  // Site assignment management (SEC-HIGH-051)
  // =========================================================

  /**
   * Assign a tenant user to a farm-service Site (idempotent upsert).
   *
   * SEC-HIGH-051: this is the write-path the object-level site-authz SSoT was
   * missing. Mirrors {@link assignUserToModule}: TENANT_ADMIN-gated at the
   * resolver, scoped to the caller's tenant, records `assignedBy`, idempotent
   * (re-assigning an active row is a no-op success; a soft-deactivated row is
   * reactivated). The fail-closed deny posture is NOT softened — an assignment
   * here is what GRANTS a MODULE_USER access to a site on the next token mint.
   *
   * `siteId` is a farm-service Site id (cross-service). auth-service must not
   * import farm tables (layering violation) and a cross-schema FK is forbidden,
   * so there is no cheap in-service ownership check — an unknown siteId simply
   * never matches a real site and grants nothing (fail-closed by construction).
   * The target user IS validated to belong to the caller's tenant.
   */
  async assignUserToSite(
    tenantAdminId: string,
    input: AssignUserToSiteInput,
  ): Promise<SiteAssignmentResult> {
    const admin = await this.userRepository.findOne({
      where: { id: tenantAdminId },
    });

    if (!admin || !admin.tenantId) {
      throw new NotFoundException('Admin not found');
    }

    // The target user MUST exist in the caller's tenant — a cross-tenant userId
    // resolves to null here and is rejected (no cross-tenant assignment).
    const targetUser = await this.userRepository.findOne({
      where: { id: input.userId, tenantId: admin.tenantId },
    });

    if (!targetUser) {
      throw new NotFoundException('User not found');
    }

    // Idempotent upsert scoped to the admin's tenant. The UQ_user_site
    // (userId, siteId) constraint makes the existing-row lookup authoritative.
    const existing = await this.userSiteAssignmentRepository.findOne({
      where: { userId: input.userId, siteId: input.siteId },
    });

    if (existing) {
      if (!existing.isActive) {
        existing.isActive = true;
        existing.assignedBy = tenantAdminId;
        existing.expiresAt = null;
        await this.userSiteAssignmentRepository.save(existing);

        await this.auditSiteAssignment(admin, 'USER_SITE_ASSIGNED', input, 'reactivated');

        return {
          success: true,
          message: 'Site assignment reactivated',
          userId: input.userId,
          siteId: input.siteId,
        };
      }

      return {
        success: true,
        message: 'User already assigned to site',
        userId: input.userId,
        siteId: input.siteId,
      };
    }

    const assignment = this.userSiteAssignmentRepository.create({
      userId: input.userId,
      siteId: input.siteId,
      tenantId: admin.tenantId,
      isActive: true,
      assignedBy: tenantAdminId,
    });

    await this.userSiteAssignmentRepository.save(assignment);

    await this.auditSiteAssignment(admin, 'USER_SITE_ASSIGNED', input, 'created');

    this.logger.log(`Assigned user ${input.userId} to site ${input.siteId}`);

    return {
      success: true,
      message: 'User assigned to site',
      userId: input.userId,
      siteId: input.siteId,
    };
  }

  /**
   * Unassign (deactivate) a user's site assignment (SEC-HIGH-051).
   *
   * Mirrors {@link removeUserFromModule}: TENANT_ADMIN-gated, scoped to the
   * caller's tenant, soft-deactivates the row (preserving the audit trail). The
   * revoked site stops being minted into assignedSiteIds on the next token
   * refresh; the user is then fail-closed denied on that site.
   */
  async unassignUserFromSite(
    tenantAdminId: string,
    userId: string,
    siteId: string,
  ): Promise<SiteAssignmentResult> {
    const admin = await this.userRepository.findOne({
      where: { id: tenantAdminId },
    });

    if (!admin || !admin.tenantId) {
      throw new NotFoundException('Admin not found');
    }

    // Scope the lookup to the admin's tenant so a cross-tenant assignment row
    // cannot be deactivated from another tenant.
    const assignment = await this.userSiteAssignmentRepository.findOne({
      where: { userId, siteId, tenantId: admin.tenantId },
    });

    if (!assignment) {
      throw new NotFoundException('Site assignment not found');
    }

    assignment.isActive = false;
    await this.userSiteAssignmentRepository.save(assignment);

    await this.auditSiteAssignment(
      admin,
      'USER_SITE_UNASSIGNED',
      { userId, siteId },
      'deactivated',
    );

    this.logger.log(`Unassigned user ${userId} from site ${siteId}`);

    return {
      success: true,
      message: 'User unassigned from site',
      userId,
      siteId,
    };
  }

  /**
   * Audit a site assignment / unassignment. Best-effort (mirrors the
   * deactivate/activate audit calls above) — a failed audit must not roll back
   * the membership change, which has its own log line.
   */
  private async auditSiteAssignment(
    admin: User,
    action: 'USER_SITE_ASSIGNED' | 'USER_SITE_UNASSIGNED',
    target: { userId: string; siteId: string },
    outcome: 'created' | 'reactivated' | 'deactivated',
  ): Promise<void> {
    try {
      await this.auditLogService.log({
        tenantId: admin.tenantId!,
        performedBy: admin.id,
        performedByEmail: admin.email,
        action,
        entityType: 'UserSiteAssignment',
        entityId: target.userId,
        details: {
          siteId: target.siteId,
          outcome,
          timestamp: new Date().toISOString(),
        },
        severity: AuditLogSeverity.INFO,
      });
    } catch (error) {
      this.logger.error(`Failed to log audit event ${action}: ${(error as Error).message}`);
    }
  }

  /**
   * Get tenant's users list
   */
  async getTenantUsers(tenantAdminId: string): Promise<User[]> {
    const admin = await this.userRepository.findOne({
      where: { id: tenantAdminId },
    });

    if (!admin || !admin.tenantId) {
      throw new NotFoundException('Admin not found');
    }

    return this.userRepository.find({
      where: { tenantId: admin.tenantId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Deactivate a user in tenant
   */
  async deactivateUser(tenantAdminId: string, userId: string): Promise<User> {
    // SECURITY: Prevent self-deactivation (SEC-008)
    if (tenantAdminId === userId) {
      throw new BadRequestException('Cannot deactivate your own account');
    }

    const admin = await this.userRepository.findOne({
      where: { id: tenantAdminId },
    });

    if (!admin || !admin.tenantId) {
      throw new NotFoundException('Admin not found');
    }

    const user = await this.userRepository.findOne({
      where: { id: userId, tenantId: admin.tenantId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.role === Role.TENANT_ADMIN) {
      throw new ForbiddenException('Cannot deactivate tenant admin');
    }

    user.isActive = false;
    const saved = await this.userRepository.save(user);

    // SECURITY: Revoke all active refresh tokens for the deactivated user
    // Without this, existing refresh tokens remain valid and can be used to obtain new access tokens.
    await this.refreshTokenRepository.update(
      { userId, isRevoked: false },
      { isRevoked: true, revokedAt: new Date(), revokedReason: 'User deactivated' },
    );

    this.logger.log(`Deactivated user ${user.email} and revoked all refresh tokens`);

    // SECURITY AUDIT: Log user deactivation (BULGU-016)
    try {
      await this.auditLogService.log({
        tenantId: admin.tenantId,
        performedBy: tenantAdminId,
        performedByEmail: admin.email,
        action: 'USER_DEACTIVATED',
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
      this.logger.error(`Failed to log audit event USER_DEACTIVATED: ${(error as Error).message}`);
    }

    return saved;
  }

  /**
   * Activate a user in tenant
   */
  async activateUser(tenantAdminId: string, userId: string): Promise<User> {
    const admin = await this.userRepository.findOne({
      where: { id: tenantAdminId },
    });

    if (!admin || !admin.tenantId) {
      throw new NotFoundException('Admin not found');
    }

    const user = await this.userRepository.findOne({
      where: { id: userId, tenantId: admin.tenantId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    user.isActive = true;
    const saved = await this.userRepository.save(user);

    this.logger.log(`Activated user ${user.email}`);

    // SECURITY AUDIT: Log user activation (BULGU-016)
    try {
      await this.auditLogService.log({
        tenantId: admin.tenantId,
        performedBy: tenantAdminId,
        performedByEmail: admin.email,
        action: 'USER_ACTIVATED',
        entityType: 'User',
        entityId: userId,
        details: {
          targetEmail: user.email,
          targetRole: user.role,
          timestamp: new Date().toISOString(),
        },
        severity: AuditLogSeverity.INFO,
      });
    } catch (error) {
      this.logger.error(`Failed to log audit event USER_ACTIVATED: ${(error as Error).message}`);
    }

    return saved;
  }

  /**
   * ORPHAN-MEDIUM-320: clear a failed-login lockout for a user in this tenant.
   *
   * WHY a first-class action instead of waiting out the window: before this
   * existed the only remediation was raw SQL against auth.users — the
   * 2026-07-02 incident had an operator locked out for 30 minutes with a
   * CORRECT password and no self-service path.
   *
   * Targeting a TENANT_ADMIN is deliberately ALLOWED (unlike deactivateUser):
   * a lockout is an availability incident, not a privilege change — a locked
   * admin cannot authenticate to unlock themselves, so recovery REQUIRES a
   * peer admin (or SUPER_ADMIN). No tokens are minted and no permissions
   * change; the audit row records who unlocked whom.
   */
  async unlockUser(tenantAdminId: string, userId: string): Promise<User> {
    const admin = await this.userRepository.findOne({
      where: { id: tenantAdminId },
    });

    if (!admin || !admin.tenantId) {
      throw new NotFoundException('Admin not found');
    }

    const user = await this.userRepository.findOne({
      where: { id: userId, tenantId: admin.tenantId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const wasLockedUntil = user.lockedUntil ?? null;
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    const saved = await this.userRepository.save(user);

    this.logger.log(`Cleared login lockout for userId=${userId}`);

    // SECURITY AUDIT: who restored access to whom, and what the lock was.
    try {
      await this.auditLogService.log({
        tenantId: admin.tenantId,
        performedBy: tenantAdminId,
        performedByEmail: admin.email,
        action: 'USER_UNLOCKED',
        entityType: 'User',
        entityId: userId,
        details: {
          targetEmail: user.email,
          targetRole: user.role,
          previousLockedUntil: wasLockedUntil ? wasLockedUntil.toISOString() : null,
          timestamp: new Date().toISOString(),
        },
        severity: AuditLogSeverity.WARNING,
      });
    } catch (error) {
      this.logger.error(`Failed to log audit event USER_UNLOCKED: ${(error as Error).message}`);
    }

    return saved;
  }

  // =========================================================
  // Tenant auth-security policy + localization preferences (ADR-045)
  // =========================================================

  private async findTenantOrFail(tenantId: string): Promise<Tenant> {
    const tenant = await this.tenantRepository.findOne({ where: { id: tenantId } });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }
    return tenant;
  }

  /**
   * Read the EFFECTIVE tenant auth-security policy (ADR-045). The nullable
   * enforce_mfa column collapses to its enforced meaning here (NULL → false)
   * so consumers never re-implement the default.
   */
  async getSecurityPolicy(tenantId: string): Promise<TenantSecurityPolicy> {
    const tenant = await this.findTenantOrFail(tenantId);
    return {
      enforceMfa: tenant.enforceMfa === true,
      sessionTimeoutMinutes: tenant.sessionTimeoutMinutes ?? null,
    };
  }

  /**
   * Update the tenant auth-security policy (ADR-045).
   *
   * REVOCATION-ON-FLIP: when enforceMfa transitions false/NULL → true, the
   * refresh tokens of this tenant's users WITHOUT MFA enrolled are revoked
   * (same update primitive as logout-all/deactivate) and a security audit
   * event records the blast radius. Their next login walks the enrollment
   * gate (mfaSetupRequired + mfa_setup token) instead of receiving tokens.
   *
   * sessionTimeoutMinutes REDUCTIONS apply on the next rotation: existing
   * refresh-token rows keep their already-persisted expiresAt; every
   * subsequent issuance/rotation clamps to MIN(configured TTL, policy) —
   * sliding idle-timeout semantics (see TokenService.generateTokens).
   */
  async updateSecurityPolicy(
    tenantAdminId: string,
    tenantId: string,
    input: UpdateTenantSecurityPolicyInput,
  ): Promise<TenantSecurityPolicy> {
    const admin = await this.userRepository.findOne({ where: { id: tenantAdminId } });
    if (!admin) {
      throw new NotFoundException('Admin not found');
    }

    const tenant = await this.findTenantOrFail(tenantId);
    const wasEnforced = tenant.enforceMfa === true;

    if (input.enforceMfa !== undefined) {
      tenant.enforceMfa = input.enforceMfa;
    }
    if (input.sessionTimeoutMinutes !== undefined) {
      tenant.sessionTimeoutMinutes = input.sessionTimeoutMinutes;
    }
    await this.tenantRepository.save(tenant);

    const enforcementFlippedOn = !wasEnforced && tenant.enforceMfa === true;
    let revokedUserCount = 0;
    if (enforcementFlippedOn) {
      revokedUserCount = await this.revokeSessionsOfUsersWithoutMfa(tenantId);
      this.logger.warn(
        `Tenant ${tenantId} enabled MFA enforcement — revoked refresh tokens of ${revokedUserCount} user(s) without MFA`,
      );
    }

    // SECURITY AUDIT: policy changes are audit-logged like sibling
    // tenant-admin mutations (best-effort — the policy write is the SSoT and
    // has its own log line above on the security-relevant branch).
    try {
      await this.auditLogService.log({
        tenantId,
        performedBy: tenantAdminId,
        performedByEmail: admin.email,
        action: 'TENANT_SECURITY_POLICY_UPDATED',
        entityType: 'Tenant',
        entityId: tenantId,
        details: {
          enforceMfa: tenant.enforceMfa ?? null,
          sessionTimeoutMinutes: tenant.sessionTimeoutMinutes ?? null,
          enforcementFlippedOn,
          revokedUserCount,
          timestamp: new Date().toISOString(),
        },
        severity: enforcementFlippedOn ? AuditLogSeverity.WARNING : AuditLogSeverity.INFO,
      });
    } catch (error) {
      this.logger.error(
        `Failed to log audit event TENANT_SECURITY_POLICY_UPDATED: ${(error as Error).message}`,
      );
    }

    return {
      enforceMfa: tenant.enforceMfa === true,
      sessionTimeoutMinutes: tenant.sessionTimeoutMinutes ?? null,
    };
  }

  /**
   * ADR-045 revocation-on-flip helper: revoke every active refresh token of
   * this tenant's users who have NOT enrolled MFA. Uses the same bulk
   * `refreshTokenRepository.update({ isRevoked: false } → revoked)` primitive
   * as logout-all / deactivateUser. Users WITH MFA keep their sessions —
   * they already satisfy the policy.
   */
  private async revokeSessionsOfUsersWithoutMfa(tenantId: string): Promise<number> {
    const nonMfaUsers = await this.userRepository.find({
      where: { tenantId, mfaEnabled: false },
      select: ['id'],
    });
    if (nonMfaUsers.length === 0) {
      return 0;
    }
    await this.refreshTokenRepository.update(
      { userId: In(nonMfaUsers.map((user) => user.id)), isRevoked: false },
      {
        isRevoked: true,
        revokedAt: new Date(),
        revokedReason: 'Tenant MFA enforcement enabled',
      },
    );
    return nonMfaUsers.length;
  }

  /**
   * Read the tenant localization preferences (ADR-045 — a PREFERENCE
   * container, deliberately separate from the security policy).
   */
  async getLocalizationPreferences(tenantId: string): Promise<TenantLocalizationPreferences> {
    const tenant = await this.findTenantOrFail(tenantId);
    return {
      timezone: tenant.timezone ?? null,
      dateFormat: tenant.dateFormat ?? null,
    };
  }

  /**
   * Update the tenant localization preferences (ADR-045). Timezone is
   * IANA-sanity-validated and dateFormat enum-validated at the input DTO.
   */
  async updateLocalizationPreferences(
    tenantAdminId: string,
    tenantId: string,
    input: UpdateTenantLocalizationPreferencesInput,
  ): Promise<TenantLocalizationPreferences> {
    const admin = await this.userRepository.findOne({ where: { id: tenantAdminId } });
    if (!admin) {
      throw new NotFoundException('Admin not found');
    }

    const tenant = await this.findTenantOrFail(tenantId);

    if (input.timezone !== undefined) {
      tenant.timezone = input.timezone;
    }
    if (input.dateFormat !== undefined) {
      tenant.dateFormat = input.dateFormat;
    }
    await this.tenantRepository.save(tenant);

    try {
      await this.auditLogService.log({
        tenantId,
        performedBy: tenantAdminId,
        performedByEmail: admin.email,
        action: 'TENANT_LOCALIZATION_PREFERENCES_UPDATED',
        entityType: 'Tenant',
        entityId: tenantId,
        details: {
          timezone: tenant.timezone ?? null,
          dateFormat: tenant.dateFormat ?? null,
          timestamp: new Date().toISOString(),
        },
        severity: AuditLogSeverity.INFO,
      });
    } catch (error) {
      this.logger.error(
        `Failed to log audit event TENANT_LOCALIZATION_PREFERENCES_UPDATED: ${(error as Error).message}`,
      );
    }

    return {
      timezone: tenant.timezone ?? null,
      dateFormat: tenant.dateFormat ?? null,
    };
  }

  // =========================================================
  // Database Viewer Methods (Read-Only)
  // =========================================================

  /**
   * Get list of tables in tenant's schema
   * Only works if tenant has separate schema
   */
  async getTenantTables(tenantAdminId: string): Promise<TenantTableInfo[]> {
    const admin = await this.userRepository.findOne({
      where: { id: tenantAdminId },
    });

    if (!admin || !admin.tenantId) {
      throw new NotFoundException('Admin not found');
    }

    const tenant = await this.tenantRepository.findOne({
      where: { id: admin.tenantId },
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    // Get schema name from tenant ID (must match SchemaManagerService format)
    const schemaName = getTenantSchemaName(tenant.id);

    try {
      // Query PostgreSQL information_schema
      const tables: TableInfoRow[] = await this.dataSource.query(
        `
        SELECT
          table_name as "tableName",
          (SELECT reltuples::bigint
           FROM pg_class
           WHERE oid = (quote_ident($1) || '.' || quote_ident(table_name))::regclass) as "rowCount"
        FROM information_schema.tables
        WHERE table_schema = $1
          AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `,
        [schemaName],
      );

      // Map tables to modules (based on naming convention)
      return tables.map((t) => ({
        tableName: t.tableName,
        rowCount: Number(t.rowCount) || 0,
        module: this.inferModuleFromTableName(t.tableName),
      }));
    } catch (error) {
      this.logger.warn(
        `Could not query tenant schema ${schemaName}: ${error instanceof Error ? error.message : String(error)}`,
      );

      // Return main schema tables for the tenant (filtered by tenant_id)
      return this.getMainSchemaTables(admin.tenantId);
    }
  }

  /**
   * Get data from a specific table (paginated)
   * Uses row-level tenant isolation with WHERE tenant_id = ?
   */
  async getTableData(
    tenantAdminId: string,
    input: GetTableDataInput,
  ): Promise<TableDataResult> {
    const admin = await this.userRepository.findOne({
      where: { id: tenantAdminId },
    });

    if (!admin || !admin.tenantId) {
      throw new NotFoundException('Admin not found');
    }

    const tenantId = admin.tenantId;

    // Validate identifiers (prevent SQL injection)
    const validIdentifier = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    if (!validIdentifier.test(input.schemaName) || !validIdentifier.test(input.tableName)) {
      throw new BadRequestException('Invalid schema or table name');
    }

    // Get tenant's assigned modules
    const tenantModules = await this.tenantModuleRepository.find({
      where: { tenantId, isEnabled: true },
      relations: ['module'],
    });

    // Module schemas (farm, hr, sensor, etc.)
    const moduleSchemas = tenantModules
      .map(tm => tm.module?.code)
      .filter((code): code is string => !!code);

    // Get tenant's dedicated schema name
    const tenantSchemaName = getTenantSchemaName(tenantId);

    // Allowed schemas: tenant's own schema + tenant's module schemas
    // SECURITY: 'auth' schema excluded — contains passwords, MFA secrets, invitation tokens
    const allowedSchemas = [tenantSchemaName, ...moduleSchemas];

    // Validate schema access
    if (!allowedSchemas.includes(input.schemaName)) {
      throw new ForbiddenException(
        `Access denied: You do not have permission to view tables in schema '${input.schemaName}'`,
      );
    }

    const limit = Math.min(input.limit, 1000); // Max 1000 rows
    const offset = input.offset;
    const fullTableName = `"${input.schemaName}"."${input.tableName}"`;

    try {
      // Get columns
      const columnsResult: Array<{ column_name: string }> = await this.dataSource.query(
        `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position
      `,
        [input.schemaName, input.tableName],
      );

      if (columnsResult.length === 0) {
        throw new NotFoundException(`Table not found: ${input.schemaName}.${input.tableName}`);
      }

      const columns = columnsResult.map((c) => c.column_name);

      // Resolve the tenant-isolation column. TypeORM entities expose it either as
      // snake_case `tenant_id` OR camelCase quoted `"tenantId"` — both MUST be
      // honoured. Treating only `tenant_id` as the filter (the prior bug) meant
      // any shared-schema table whose column is `tenantId` was read UNFILTERED,
      // leaking every tenant's rows. The candidate names are hard-coded literals
      // (not user input), so interpolating the chosen one is injection-safe.
      const tenantColumn = columns.includes('tenant_id')
        ? 'tenant_id'
        : columns.includes('tenantId')
          ? 'tenantId'
          : null;

      // The tenant's DEDICATED schema (tenant_<uuid>) is itself the isolation
      // boundary — every row already belongs to this tenant, so no row filter is
      // required. Every OTHER (shared module) schema holds cross-tenant rows and
      // MUST be filtered by the tenant column; when such a table has no tenant
      // column we FAIL CLOSED rather than return another tenant's data.
      const isDedicatedTenantSchema = input.schemaName === tenantSchemaName;
      if (!isDedicatedTenantSchema && !tenantColumn) {
        throw new ForbiddenException(
          `Access denied: table '${input.schemaName}.${input.tableName}' has no tenant column and cannot be tenant-isolated`,
        );
      }
      const applyTenantFilter = !isDedicatedTenantSchema && tenantColumn !== null;
      const whereClause = applyTenantFilter ? `WHERE "${tenantColumn}" = $1` : '';

      // Get total count (tenant-filtered unless reading the dedicated schema)
      const countResult: CountRow[] = await this.dataSource.query(
        `SELECT COUNT(*) as count FROM ${fullTableName} ${whereClause}`,
        applyTenantFilter ? [tenantId] : [],
      );
      const totalRows = Number(countResult[0]?.count) || 0;

      // Get the data page (same isolation rule)
      const rows: DataRow[] = applyTenantFilter
        ? await this.dataSource.query(
            `SELECT * FROM ${fullTableName} ${whereClause} ORDER BY 1 LIMIT $2 OFFSET $3`,
            [tenantId, limit, offset],
          )
        : await this.dataSource.query(
            `SELECT * FROM ${fullTableName} ORDER BY 1 LIMIT $1 OFFSET $2`,
            [limit, offset],
          );

      return {
        tableName: `${input.schemaName}.${input.tableName}`,
        totalRows,
        columns,
        rows: JSON.stringify(rows),
        offset,
        limit,
      };
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof NotFoundException) {
        throw error;
      }
      this.logger.error(`Failed to get table data: ${error instanceof Error ? error.message : String(error)}`);
      // SECURITY: Generic error message — do not reflect user input (SEC-AUTH-018)
      throw new BadRequestException('Could not read the requested table');
    }
  }

  // getTenantSchemaName imported from @aquaculture/backend-common

  /**
   * Infer module from table name based on naming convention
   */
  private inferModuleFromTableName(tableName: string): string | null {
    const moduleMapping: Record<string, string> = {
      farms: 'farm',
      ponds: 'farm',
      tanks: 'farm',
      stocks: 'farm',
      harvests: 'farm',
      employees: 'hr',
      departments: 'hr',
      attendance: 'hr',
      leaves: 'hr',
      cultures: 'seapod',
      products: 'inventory',
      warehouses: 'inventory',
      customers: 'crm',
      contacts: 'crm',
      accounts: 'finance',
      invoices: 'finance',
      transactions: 'finance',
      projects: 'project',
      tasks: 'project',
    };

    for (const [prefix, module] of Object.entries(moduleMapping)) {
      if (tableName.toLowerCase().includes(prefix)) {
        return module;
      }
    }

    return null;
  }

  /**
   * Get tables from main schema (when tenant doesn't have separate schema)
   * PERF: Use Promise.allSettled for parallel count queries (HIGH-05)
   */
  private async getMainSchemaTables(
    tenantId: string,
  ): Promise<TenantTableInfo[]> {
    // List of known tables that have tenant_id
    const tenantTables = [
      'farms',
      'ponds',
      'stocks',
      'employees',
      'departments',
      'sensors',
      'sensor_readings',
    ];

    const results = await Promise.allSettled(
      tenantTables.map(async (tableName) => {
        const countResult: CountRow[] = await this.dataSource.query(
          `SELECT COUNT(*) as count FROM "${tableName}" WHERE "tenant_id" = $1`,
          [tenantId],
        );
        return {
          tableName,
          rowCount: Number(countResult[0]?.count) || 0,
          module: this.inferModuleFromTableName(tableName),
        };
      }),
    );

    return results
      .filter((r): r is PromiseFulfilledResult<TenantTableInfo> => r.status === 'fulfilled')
      .map((r) => r.value);
  }
}
