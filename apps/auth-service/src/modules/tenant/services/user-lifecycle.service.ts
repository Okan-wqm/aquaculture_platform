import * as crypto from 'crypto';

import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { Role } from '@aquaculture/backend-common/decorators';
import {
  USER_TOKEN_REVOCATION,
  IUserTokenRevocation,
} from '@aquaculture/backend-common/security';
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
import { UserInvitedEvent, createBaseEvent } from '@platform/event-contracts';
import { Repository, DataSource } from 'typeorm';

import { AuditLogSeverity } from '../../../audit/audit-log.entity';
import { AuditLogService } from '../../../audit/audit-log.service';
import { BestEffortEventPublisher } from '../../../outbox/best-effort-event-publisher';
import { ActionToken, ActionTokenPurpose, ActionTokenStatus } from '../../authentication/entities/action-token.entity';
import { Invitation, InvitationStatus } from '../../authentication/entities/invitation.entity';
import { RefreshToken } from '../../authentication/entities/refresh-token.entity';
import { UserModuleAssignment } from '../../authentication/entities/user-module-assignment.entity';
import { User, AccessType } from '../../authentication/entities/user.entity';
import { MobileUserSettings, DEFAULT_MOBILE_FEATURES } from '../entities/mobile-user-settings.entity';
import { Tenant } from '../entities/tenant.entity';

import { CapabilityAuthorityService, ValidatedOverrideSet } from './capability-authority';
import { TenantRoleService, TenantRoleWithDetails } from './tenant-role.service';

/**
 * Narrowing type guard: a raw role string is one of the four canonical roles.
 *
 * WHY: `input.role` arrives as a `varchar`-backed string from the invite/create
 * DTOs. Guarding with this predicate narrows it to `Role` for the rest of the
 * method (the throwing negative branch makes the value provably a `Role`), which
 * removes BOTH the `as Role` assertions and the unsafe `string === Role` enum
 * comparisons — the comparison is `Role === Role` once narrowed.
 */
function isCanonicalRole(value: string): value is Role {
  return (Object.values(Role) as string[]).includes(value);
}

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
    @InjectRepository(Invitation)
    private readonly invitationRepository: Repository<Invitation>,
    @InjectRepository(UserModuleAssignment)
    private readonly userModuleAssignmentRepository: Repository<UserModuleAssignment>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly tenantRoleService: TenantRoleService,
    // DATA-HIGH-001: UserInvited is a notification trigger whose durable record
    // is the invitation row — routed through the allowlisted best-effort path,
    // not the raw event bus. (Durable upgrade tracked as ORPHAN-HIGH-090, which
    // first needs createUser to become transactional.)
    private readonly bestEffort: BestEffortEventPublisher,
    private readonly auditLogService: AuditLogService,
    // SECURITY (RBAC-C1/C2): write-time grant-authority SSoT. createUser was a
    // grant path with NO authority check — a delegate with `users:invite` could
    // spawn a user carrying arbitrary override grants. All grants now route
    // through the shared validator.
    private readonly capabilityAuthority: CapabilityAuthorityService,
    // SECURITY (RBAC-HIGH-002): deleting a user must lock out their live access
    // token too, not just their refresh tokens.
    @Inject(USER_TOKEN_REVOCATION)
    private readonly userTokenRevocation: IUserTokenRevocation,
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
    sendInvitation = true,
  ): Promise<CreatedUserResult> {
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

    // SECURITY (RBAC-C1/C2): validate the initial override grants against the
    // catalogue + the creator's own authority BEFORE creating the user. A
    // non-admin creator (holding `users:invite`) cannot seed a new user with
    // capabilities they do not themselves hold.
    const validatedOverrides = this.capabilityAuthority.assertGrantableOverrides(
      input.permissionOverrides,
      await this.capabilityAuthority.resolveActorAuthority(tenantId, createdBy),
    );

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

    // Create role assignment in auth.user_role_assignments (tenant-guarded
    // via the role's tenantId — see createRoleAssignment).
    const roleAssignment = await this.createRoleAssignment(
      tenantId,
      savedUser.id,
      input.roleId,
      role,
      validatedOverrides,
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

    // SECURITY (foreign-actor email leak): pin the admin (actor) lookup to the
    // tenant so a cross-tenant `deletedBy` id cannot surface another tenant's
    // admin email into THIS tenant's audit row. A cross-tenant id resolves to
    // null → no `performedByEmail` rather than a foreign email.
    const admin = await this.userRepository.findOne({
      where: { id: deletedBy, tenantId },
    });

    // SECURITY (SEC-MEDIUM-002): the soft-delete, role revocation, refresh-token
    // revocation, and audit row commit ATOMICALLY. Previously the user was
    // deactivated, roles revoked (swallowed try/catch), and tokens revoked
    // first, then the audit ran in a swallowed try/catch (fail-OPEN) — a user
    // deletion could persist with no audit evidence (SOC 2 CC6.1), and a
    // swallowed role-revoke failure could leave a "deleted" user with live role
    // assignments. A throwing audit, role revoke, or token revoke now rolls back
    // the whole soft-delete (fail-CLOSED): no deletion persists without its role
    // revocation, token revocation, AND audit trail.
    await this.dataSource.transaction(async (manager) => {
      // 1. Deactivate the user
      user.isActive = false;
      await manager.save(user);

      // 2. Revoke role assignments — repointed to "auth"."user_role_assignments"
      // (ORPHAN-CRITICAL-100). The table has NO tenantId column, so tenant
      // ownership is laundered through a write-side FROM-join to
      // "auth"."tenant_roles" tr WHERE tr."tenantId" = $2: only assignments
      // whose role belongs to this tenant are revoked. `updated_by` is NOT a
      // column on this table (GROUND-TRUTH) — dropped; SET is_active=false +
      // updated_at=NOW() only. tenantId is a bound param, never interpolated.
      await manager.query(
        `UPDATE "auth"."user_role_assignments" ura
         SET is_active = false, updated_at = NOW()
         FROM "auth"."tenant_roles" tr
         WHERE ura.user_id = $1
           AND ura.is_active = true
           AND tr.id = ura.role_id
           AND tr."tenantId" = $2`,
        [userId, tenantId],
      );

      // 3. CRITICAL: Revoke ALL refresh tokens. Without this, existing refresh
      // tokens remain valid and can mint new access tokens after "deletion".
      // EntityManager.update (not a repository handle) keeps this inside the tx.
      await manager.update(
        RefreshToken,
        { userId, isRevoked: false },
        { isRevoked: true, revokedAt: new Date(), revokedReason: 'User deleted' },
      );

      // 4. SECURITY AUDIT: Log user deletion. Pass `manager` so the audit row
      // is written on THIS transaction's connection (fail-CLOSED): a throwing
      // audit rolls back the soft-delete + role revoke + token revoke. Without
      // the `manager` arg `log()` saves on a separate connection and a
      // rolled-back deletion could still leave an orphan audit row (fail-OPEN),
      // contradicting the SEC-MEDIUM-002 invariant above.
      await this.auditLogService.log(
        {
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
        },
        manager,
      );
    });

    // RBAC-HIGH-001 / RBAC-HIGH-002: the refresh tokens are revoked in-tx above,
    // but the user's LIVE access token stays valid until its TTL. Revoke it too
    // so a deleted user is locked out on their next request, fleet-wide.
    await this.userTokenRevocation.revokeUserTokens(userId);

    // SECURITY: Log user ID instead of email to prevent PII exposure in logs (H-14)
    this.logger.log(`Deleted (soft) userId=${user.id} from tenant ${tenantId}, revoked all refresh tokens`);

    return true;
  }

  // ==========================================================================
  // Admin (SUPER_ADMIN) user lifecycle — NATS-RPC targets
  // ==========================================================================

  /**
   * Admin-initiated user creation.
   *
   * Used by the SUPER_ADMIN flow on admin-api-service — a platform operator
   * creates a user record at an arbitrary role (including SUPER_ADMIN) for
   * any tenant (or for no tenant at all, in the case of platform-level
   * SUPER_ADMIN accounts).
   *
   * This method writes through the TypeORM User repository only. The
   * `password` column name is sourced from the `User` entity definition
   * once; any raw-SQL alternative risks column drift, which is exactly the
   * bug this method was created to eliminate (CRITICAL-001 in
   * `docs/reviews/code-reviewer/2026-04-21-raw-sql-audit.md`). The entity's
   * `@BeforeInsert` hook applies the platform's HMAC-peppered bcrypt, so the
   * caller MUST NOT pre-hash.
   *
   * Differs from `createUser()` in that:
   *  - No tenant-role (`user_role_assignments`) is created. Admin-created
   *    users are bound to the global `role` column only; any tenant-role
   *    assignment is a subsequent step by a tenant admin.
   *  - Tenant is optional (NULL for SUPER_ADMIN platform accounts).
   *  - No invitation token is issued; the admin already set the password.
   *
   * @throws ConflictException on duplicate email (case-insensitive)
   * @throws NotFoundException when a non-null `tenantId` does not resolve
   * @throws BadRequestException on unknown role
   */
  async adminCreateUser(input: {
    email: string;
    firstName: string;
    lastName: string;
    password: string;
    role: string;
    tenantId?: string | null;
  }): Promise<User> {
    const normalisedEmail = input.email.toLowerCase();

    // Duplicate-email guard — expression index `LOWER(email)` enforces this
    // at the DB level too, but catching it in-service gives a clean typed
    // error surface for the NATS handler.
    const existing = await this.userRepository.findOne({ where: { email: normalisedEmail } });
    if (existing) {
      throw new ConflictException(`User with email "${input.email}" already exists`);
    }

    // Role validation — only known role values are accepted. Rejecting
    // unknown strings prevents an admin from typoing a role into existence
    // (the column is `varchar`, so TypeORM would accept any string).
    if (!isCanonicalRole(input.role)) {
      throw new BadRequestException(`Unknown role "${input.role}"`);
    }
    const role: Role = input.role;

    // Tenant validation — when a tenantId is provided it MUST resolve to
    // an active tenant. SUPER_ADMIN accounts legitimately pass null.
    if (input.tenantId) {
      const tenant = await this.tenantRepository.findOne({ where: { id: input.tenantId } });
      if (!tenant) {
        throw new NotFoundException(`Tenant with ID "${input.tenantId}" not found`);
      }
    }

    // Write via TypeORM entity — @BeforeInsert hashes the password.
    const newUser = this.userRepository.create({
      email: normalisedEmail,
      firstName: input.firstName,
      lastName: input.lastName,
      password: input.password,
      role,
      tenantId: input.tenantId ?? null,
      isActive: true,
      isEmailVerified: false,
    });

    const saved = await this.userRepository.save(newUser);
    // SECURITY: Log user ID only; email is PII (H-14).
    this.logger.log(`Admin-created user userId=${saved.id} role=${saved.role}`);
    return saved;
  }

  /**
   * Admin-initiated password reset (out-of-band, not via reset-token flow).
   *
   * Writes the new password through the TypeORM User repository — the
   * entity's `@BeforeUpdate` hook applies HMAC-peppered bcrypt. Caller MUST
   * NOT pre-hash.
   *
   * SECURITY side-effects (mirrors the self-service reset flow):
   *  - Clears any outstanding password-reset token (single-use invariant).
   *  - Resets failed-login counters and lockout window.
   *  - Revokes ALL refresh tokens for the user — the admin reset forces
   *    full re-authentication on every device. Access tokens remain valid
   *    until they expire (≤ 15m by platform default).
   *
   * @throws NotFoundException when the userId does not resolve
   */
  async adminResetPassword(
    userId: string,
    newPassword: string,
  ): Promise<{ userId: string; refreshTokensRevoked: number }> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User with ID "${userId}" not found`);
    }

    user.password = newPassword;
    user.passwordResetToken = null;
    user.passwordResetExpires = null;
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    await this.userRepository.save(user);

    // Revoke ALL refresh tokens. `update()` returns UpdateResult; affected
    // is populated by Postgres driver. Default to 0 when driver omits it.
    const revokeResult = await this.refreshTokenRepository.update(
      { userId, isRevoked: false },
      { isRevoked: true, revokedAt: new Date(), revokedReason: 'Admin password reset' },
    );
    const refreshTokensRevoked = revokeResult.affected ?? 0;

    this.logger.log(
      `Admin password reset for userId=${user.id}, refreshTokensRevoked=${refreshTokensRevoked}`,
    );
    return { userId: user.id, refreshTokensRevoked };
  }

  /**
   * Admin-initiated user update (patch).
   *
   * Writes every mutable field via the TypeORM `User` entity. Fields not
   * present in the patch are left untouched; a `null` tenantId is an
   * explicit assignment (SUPER_ADMIN promotion) distinct from `undefined`.
   *
   * CRITICAL-002: replaces admin-api's dynamic raw-SQL UPDATE against
   * `auth.users`. Naming a column in admin-api code is now structurally
   * impossible — the entity is the single writer.
   *
   * @throws NotFoundException when the userId does not resolve
   * @throws NotFoundException when a non-null tenantId does not resolve
   * @throws BadRequestException on unknown role value
   */
  async adminUpdateUser(
    userId: string,
    patch: {
      firstName?: string;
      lastName?: string;
      role?: string;
      tenantId?: string | null;
      isActive?: boolean;
    },
  ): Promise<User> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User with ID "${userId}" not found`);
    }

    if (patch.role !== undefined &&
        !(Object.values(Role) as string[]).includes(patch.role)) {
      throw new BadRequestException(`Unknown role "${patch.role}"`);
    }

    // `null` tenantId is meaningful (promotion to SUPER_ADMIN with no
    // tenant). Only validate existence when a non-null value is provided.
    if (patch.tenantId !== undefined && patch.tenantId !== null) {
      const tenant = await this.tenantRepository.findOne({
        where: { id: patch.tenantId },
      });
      if (!tenant) {
        throw new NotFoundException(`Tenant with ID "${patch.tenantId}" not found`);
      }
    }

    if (patch.firstName !== undefined) user.firstName = patch.firstName;
    if (patch.lastName !== undefined) user.lastName = patch.lastName;
    if (patch.role !== undefined) user.role = patch.role as Role;
    if (patch.tenantId !== undefined) user.tenantId = patch.tenantId;
    if (patch.isActive !== undefined) user.isActive = patch.isActive;

    const saved = await this.userRepository.save(user);
    this.logger.log(`Admin updated userId=${saved.id}`);
    return saved;
  }

  /**
   * Admin-initiated user deactivation (platform-scoped soft-delete).
   *
   * Unlike the tenant-scoped `deleteUser(tenantId, userId, deletedBy)`
   * above, this path:
   *  - Does NOT require a tenantId (valid for SUPER_ADMIN platform users).
   *  - Does NOT enforce the "cannot delete another TENANT_ADMIN" guard
   *    (admin-panel RBAC controls who reaches this endpoint).
   *  - Does NOT revoke tenant-schema role assignments (admin-api's
   *    platform-deactivation flow does not tear those down).
   *  - DELETES refresh tokens rather than soft-revoking them — matches
   *    the pre-existing admin-api semantics and the "force logout on
   *    deactivate" UX expectation.
   *
   * @throws NotFoundException when the userId does not resolve
   */
  async adminDeactivateUser(
    userId: string,
  ): Promise<{ userId: string; refreshTokensRemoved: number }> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User with ID "${userId}" not found`);
    }

    user.isActive = false;
    await this.userRepository.save(user);

    const deleteResult = await this.refreshTokenRepository.delete({ userId });
    const refreshTokensRemoved = deleteResult.affected ?? 0;

    this.logger.log(
      `Admin deactivated userId=${user.id}, refreshTokensRemoved=${refreshTokensRemoved}`,
    );
    return { userId: user.id, refreshTokensRemoved };
  }

  /**
   * Admin-initiated force-logout. Hard-deletes all refresh tokens for a
   * user without touching the user record itself — the account remains
   * active and the user can re-authenticate immediately. Typical use:
   * suspected credential leak, operator wants to invalidate sessions
   * without locking the account.
   */
  async adminForceLogout(
    userId: string,
  ): Promise<{ userId: string; sessionsInvalidated: number }> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User with ID "${userId}" not found`);
    }

    const deleteResult = await this.refreshTokenRepository.delete({ userId });
    const sessionsInvalidated = deleteResult.affected ?? 0;

    this.logger.log(
      `Admin force-logout userId=${user.id}, sessionsInvalidated=${sessionsInvalidated}`,
    );
    return { userId: user.id, sessionsInvalidated };
  }

  /**
   * Tenant-admin-initiated user invitation (CRITICAL-005 NATS path).
   *
   * Replaces the admin-api raw-SQL inviteUser path that wrote three
   * cross-service INSERTs against `auth.*` tables with snake_case column
   * names that drift from the User / Invitation / UserModuleAssignment
   * entities. By centralising the write here:
   *   - Column names live exactly once (on the entities).
   *   - The transaction is owned by the schema-owning service.
   *   - User-limit, role-hierarchy, email-uniqueness checks are
   *     authoritative (admin-api can no longer race on the count).
   *
   * Side-effects (all in one transaction):
   *   - Creates the User row with role + invitationToken hash.
   *   - Creates the Invitation row with status=PENDING + token hash.
   *   - For non-TENANT_ADMIN roles with moduleIds, creates one
   *     UserModuleAssignment per module (the first being marked primary
   *     when the role is MODULE_MANAGER and primaryModuleId is provided).
   *   - Increments tenant.userCount atomically.
   *
   * Publishes UserInvited with an opaque actionTokenId after commit. The
   * raw token never leaves auth-service.
   */
  async adminInviteUser(input: {
    tenantId: string;
    email: string;
    firstName?: string;
    lastName?: string;
    role: string;
    moduleIds?: string[];
    primaryModuleId?: string;
    invitedBy: string;
    message?: string;
    sendInvitation?: boolean;
  }): Promise<{
    userId: string;
    invitationId: string;
    actionTokenId: string;
    deliveryStatus?: 'queued';
  }> {
    // 1. Tenant existence + user-limit check (uses authoritative user
    //    count from auth.users, not the denormalized `tenant.userCount`
    //    counter — the counter can drift; the row count cannot).
    const tenant = await this.tenantRepository.findOne({
      where: { id: input.tenantId },
    });
    if (!tenant) {
      throw new NotFoundException(`Tenant with ID "${input.tenantId}" not found`);
    }

    const currentUserCount = await this.userRepository.count({
      where: { tenantId: input.tenantId },
    });
    // -1 means unlimited (enterprise tier).
    if (tenant.maxUsers !== -1 && currentUserCount >= tenant.maxUsers) {
      throw new BadRequestException(
        `User limit reached (${tenant.maxUsers} users). Upgrade plan to add more users.`,
      );
    }

    // 2. Role validation — only the four canonical roles.
    if (!isCanonicalRole(input.role)) {
      throw new BadRequestException(`Unknown role "${input.role}"`);
    }
    const invitedRole: Role = input.role;
    if (invitedRole === Role.SUPER_ADMIN) {
      throw new BadRequestException(
        'SUPER_ADMIN cannot be invited — use AdminCreateUserCommand for platform accounts',
      );
    }

    // 3. Inviter + role-hierarchy validation.
    const inviter = await this.userRepository.findOne({
      where: { id: input.invitedBy },
    });
    if (!inviter) {
      throw new NotFoundException(`Inviter user "${input.invitedBy}" not found`);
    }
    this.assertRoleHierarchy(inviter, input.tenantId, invitedRole);

    // 4. Email uniqueness (case-insensitive — schema enforces this via
    //    the LOWER(email) expression index too, but failing fast in the
    //    service gives a clean typed exception path).
    const normalisedEmail = input.email.toLowerCase();
    const existing = await this.userRepository.findOne({
      where: { email: normalisedEmail },
    });
    if (existing) {
      throw new ConflictException(`User with email "${input.email}" already exists`);
    }

    // 5. Invitation token: SHA-256 hash stored in the DB (MED-004 pattern).
    //    The raw token never crosses the service boundary.
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    // 6. Atomic multi-row write via a transaction. Using a transactional
    //    EntityManager guarantees that a User without an Invitation row
    //    (or vice versa) cannot exist if any single insert fails.
    const result = await this.dataSource.transaction(async (manager) => {
      // WHY manager.create/save for User + Invitation (not tenantManagerRepo):
      // auth.users and auth.invitations are cross-tenant tables by design —
      // tenantId is NULLABLE there (SUPER_ADMIN rows carry NULL), so the
      // entities do not satisfy the TenantEntity { tenantId: string }
      // constraint and the scoped-repository generic collapses to `any`.
      // tenantId is bound explicitly in each DTO below, which is the same
      // guarantee the scoped repository would have injected.
      // UserModuleAssignment HAS a non-nullable tenantId, so it keeps the
      // scoped repository.
      const umaRepo = tenantManagerRepo(manager, UserModuleAssignment, input.tenantId);

      const newUser = manager.create(User, {
        email: normalisedEmail,
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        role: invitedRole,
        tenantId: input.tenantId,
        isActive: true,
        isEmailVerified: false,
        invitationToken: tokenHash,
        invitationExpiresAt: expiresAt,
        invitedBy: input.invitedBy,
      });
      const savedUser = await manager.save(User, newUser);

      const newInvitation = manager.create(Invitation, {
        token: tokenHash,
        email: normalisedEmail,
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        role: invitedRole,
        tenantId: input.tenantId,
        moduleIds:
          input.moduleIds && input.moduleIds.length > 0
            ? input.moduleIds
            : null,
        primaryModuleId: input.primaryModuleId ?? null,
        status: InvitationStatus.PENDING,
        expiresAt,
        message: input.message ?? null,
        invitedBy: input.invitedBy,
        sendCount: 1,
        lastSentAt: new Date(),
      });
      const savedInvitation = await manager.save(Invitation, newInvitation);
      const actionToken = manager.create(ActionToken, {
        purpose: ActionTokenPurpose.INVITATION,
        tenantId: input.tenantId,
        userId: savedUser.id,
        tokenHash,
        status: ActionTokenStatus.ACTIVE,
        expiresAt,
        auditMetadata: {
          source: 'tenant-admin-invite',
          invitedBy: input.invitedBy,
        },
      });
      const savedActionToken = await manager.save(ActionToken, actionToken);

      // Module assignments — only meaningful for module-scoped roles.
      // TENANT_ADMIN inherits access from TenantModule rows and gets no
      // UserModuleAssignment entries. The moduleIds presence check is inlined
      // into the `if` so TS narrows `input.moduleIds` to a defined string[]
      // (no non-null assertion needed on the .map).
      if (
        invitedRole !== Role.TENANT_ADMIN &&
        input.moduleIds &&
        input.moduleIds.length > 0
      ) {
        const assignments = input.moduleIds.map((moduleId) =>
          umaRepo.create({
            userId: savedUser.id,
            moduleId,
            tenantId: input.tenantId,
            isPrimaryManager:
              invitedRole === Role.MODULE_MANAGER &&
              moduleId === input.primaryModuleId,
            isActive: true,
            assignedBy: input.invitedBy,
          }),
        );
        await umaRepo.saveMany(assignments);
      }

      // Atomic counter increment via SQL expression, not a read-modify-write
      // (avoids a concurrent-invite race that would have to be solved by
      // either advisory locks or a unique constraint).
      await manager
        .createQueryBuilder()
        .update(Tenant)
        .set({ userCount: () => '"userCount" + 1' })
        .where('id = :tenantId', { tenantId: input.tenantId })
        .execute();

      return {
        userId: savedUser.id,
        invitationId: savedInvitation.id,
        actionTokenId: savedActionToken.id,
      };
    });

    this.logger.log(
      `Admin invited userId=${result.userId} into tenant=${input.tenantId} role=${input.role}`,
    );

    if (input.sendInvitation !== false) {
      const event: UserInvitedEvent = {
        ...createBaseEvent<UserInvitedEvent>('UserInvited', input.tenantId, {
          aggregateId: result.userId,
          aggregateType: 'User',
        }),
        userId: result.userId,
        role: input.role,
        invitedBy: input.invitedBy,
        credentialType: 'reset_token',
        actionTokenId: result.actionTokenId,
        cryptoShredKeyId: result.userId,
      };
      await this.bestEffort.publish(event);
      this.logger.log(`Published UserInvitedEvent for userId=${result.userId}`);
    }

    return {
      userId: result.userId,
      invitationId: result.invitationId,
      actionTokenId: result.actionTokenId,
      ...(input.sendInvitation !== false && { deliveryStatus: 'queued' as const }),
    };
  }

  /**
   * Snapshot of how many user slots a tenant has remaining.
   *
   * Returned shape mirrors the admin-api's REST contract so the client
   * can consume the result without translation. `limit === -1` means
   * unlimited (enterprise tier); `remaining` clamps to ≥ 0.
   */
  async adminCheckUserLimit(tenantId: string): Promise<{
    canCreate: boolean;
    currentCount: number;
    limit: number;
    remaining: number;
    message?: string;
  }> {
    const tenant = await this.tenantRepository.findOne({
      where: { id: tenantId },
    });
    if (!tenant) {
      throw new NotFoundException(`Tenant with ID "${tenantId}" not found`);
    }

    // Authoritative count from auth.users — avoids the denormalised
    // counter drift that has bitten this code path historically.
    const currentCount = await this.userRepository.count({
      where: { tenantId },
    });
    const limit = tenant.maxUsers ?? 0;

    if (limit === -1) {
      return {
        canCreate: true,
        currentCount,
        limit: -1,
        remaining: -1,
        message: 'Unlimited users allowed',
      };
    }

    const remaining = Math.max(0, limit - currentCount);
    const canCreate = remaining > 0;
    return {
      canCreate,
      currentCount,
      limit,
      remaining,
      message: canCreate
        ? `${remaining} user slots remaining`
        : `User limit reached (${limit} users). Upgrade plan to add more users.`,
    };
  }

  /**
   * Enforce the platform role hierarchy at invite time. SUPER_ADMIN can
   * invite into any tenant at any role. Tenant-scoped roles can only
   * invite into their own tenant, and only at a role ≤ their own.
   * MODULE_MANAGER can invite only MODULE_USER. Anything else throws.
   */
  private assertRoleHierarchy(
    inviter: User,
    targetTenantId: string,
    targetRole: Role,
  ): void {
    const ranks: Record<string, number> = {
      [Role.SUPER_ADMIN]: 4,
      [Role.TENANT_ADMIN]: 3,
      [Role.MODULE_MANAGER]: 2,
      [Role.MODULE_USER]: 1,
    };

    if (inviter.role === Role.SUPER_ADMIN) return;

    if (inviter.tenantId !== targetTenantId) {
      throw new ForbiddenException(
        'Cannot invite users to a different tenant',
      );
    }

    if (inviter.role === Role.TENANT_ADMIN) {
      if ((ranks[targetRole] ?? 0) <= (ranks[Role.TENANT_ADMIN] ?? 0)) return;
      throw new ForbiddenException(
        'Cannot create user with higher role than your own',
      );
    }

    if (inviter.role === Role.MODULE_MANAGER) {
      if (targetRole === Role.MODULE_USER) return;
      throw new ForbiddenException(
        'Module managers can only invite module users',
      );
    }

    throw new ForbiddenException('You do not have permission to invite users');
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  /**
   * Create (or re-point) a user's role assignment in "auth"."user_role_assignments".
   *
   * # Why repointed to auth.* with an INSERT...SELECT tenant guard (ORPHAN-CRITICAL-100)
   *
   * WHAT: the row is written to the shared "auth"."user_role_assignments" table,
   * NOT a per-tenant "tenant_<uuid>" clone. That table has NO tenantId column, so
   * tenant ownership is laundered through the ROLE: the INSERT sources its row from
   * `SELECT ... FROM "auth"."tenant_roles" tr WHERE tr.id = $2 AND tr."tenantId" = $6`.
   * A roleId that does not belong to this tenant yields 0 source rows → no write →
   * 0 rows RETURNING → NotFoundException. The write carries its own tenant guard,
   * independent of the caller's prior `getRoleById` read.
   *
   * WHY the ON CONFLICT (user_id) re-point: "auth"."user_role_assignments" has a
   * GLOBAL UNIQUE index on (user_id) ALONE (GROUND-TRUTH `idx_user_role_assignments_user_id`).
   * A plain INSERT would violate that constraint whenever the user already holds a
   * row (active OR inactive — e.g. a re-created user, or a soft-revoked prior
   * assignment). `ON CONFLICT (user_id) DO UPDATE` re-points the single existing
   * row to the tenant-owned role and reactivates it, satisfying the one-row-per-user
   * invariant. The new role is still tenant-verified by the INSERT source.
   *
   * Only GROUND-TRUTH columns are written: user_id, role_id, permission_overrides,
   * is_active, expires_at, assigned_by, assigned_at, created_at, updated_at. There is
   * NO updated_by / removed_by / removed_at on this table. tenantId is a bound param,
   * never interpolated.
   */
  private async createRoleAssignment(
    tenantId: string,
    userId: string,
    roleId: string,
    role: TenantRoleWithDetails,
    // SECURITY (RBAC-C1/C2): accepts only a validated (branded) override set, so
    // this INSERT cannot persist an unauthorized grant. Callers validate first.
    permissionOverrides: ValidatedOverrideSet,
    assignedBy: string,
    expiresAt?: Date,
  ): Promise<UserRoleAssignmentResult> {
    const [inserted] = await this.dataSource.query<Array<{ id: string }>>(
      `
      INSERT INTO "auth"."user_role_assignments" (
        user_id, role_id, permission_overrides, is_active, expires_at, assigned_by, assigned_at, created_at, updated_at
      )
      SELECT $1, tr.id, $3::jsonb, true, $4, $5, NOW(), NOW(), NOW()
      FROM "auth"."tenant_roles" tr
      WHERE tr.id = $2 AND tr."tenantId" = $6
      ON CONFLICT (user_id) DO UPDATE
        SET role_id = EXCLUDED.role_id,
            permission_overrides = EXCLUDED.permission_overrides,
            is_active = true,
            expires_at = EXCLUDED.expires_at,
            assigned_by = EXCLUDED.assigned_by,
            assigned_at = NOW(),
            updated_at = NOW()
      RETURNING id
      `,
      [
        userId,
        roleId,
        CapabilityAuthorityService.serializeOverrides(permissionOverrides),
        expiresAt || null,
        assignedBy,
        tenantId,
      ],
    );

    // 0 rows RETURNING means the INSERT...SELECT source was empty: the roleId is
    // not owned by this tenant (or does not exist). Fail loud with a tenant-scoped
    // NotFoundException rather than carrying an undefined id forward.
    if (!inserted) {
      throw new NotFoundException(
        `Role with ID "${roleId}" not found in tenant`,
      );
    }
    const assignmentId = inserted.id;

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
      // Strip the internal validation brand from the client-facing result.
      permissionOverrides: { grants: permissionOverrides.grants, revokes: permissionOverrides.revokes },
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
  /**
   * Send invitation email to new user.
   *
   * SECURITY (CRITICAL-001/002): Only opaque references are published on the event bus.
   * PII (email, firstName, lastName, tenantName) and secret URLs are NEVER placed on
   * the immutable event bus. The notification service resolves user/tenant details
   * and builds the action URL at delivery time via authenticated internal API calls.
   *
   * @param tenant - The tenant the user is being invited to
   * @param user - The invited user entity
   * @param invitationToken - Raw invitation token (stored hashed in DB, NOT on event bus)
   */
  private async sendInvitationEmail(
    tenant: Tenant,
    user: User,
    invitationToken: string,
  ): Promise<void> {
    // SECURITY: Hash the invitation token for the opaque actionTokenId reference.
    // The raw token is NEVER placed on the event bus.
    const actionTokenHash = crypto
      .createHash('sha256')
      .update(invitationToken)
      .digest('hex');

    const event: UserInvitedEvent = {
      ...createBaseEvent<UserInvitedEvent>('UserInvited', tenant.id, { aggregateId: user.id, aggregateType: 'User' }),
      userId: user.id,
      role: user.role,
      invitedBy: user.invitedBy || undefined,
      credentialType: 'reset_token',
      actionTokenId: actionTokenHash,
      cryptoShredKeyId: user.id,
    };

    await this.bestEffort.publish(event);
    // SECURITY: Log user ID instead of email to prevent PII exposure in logs (H-14)
    this.logger.log(`Published UserInvitedEvent for userId=${user.id}`);
  }
}
