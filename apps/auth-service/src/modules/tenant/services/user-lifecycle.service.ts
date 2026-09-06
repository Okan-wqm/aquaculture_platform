import { hashPassword } from '@aquaculture/backend-common/auth';
import * as crypto from 'crypto';

import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { Role } from '@aquaculture/backend-common/decorators';
import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { UserInvitedEvent, createBaseEvent } from '@platform/event-contracts';
import { Repository, DataSource, EntityManager } from 'typeorm';

import { AuditLogSeverity } from '../../../audit/audit-log.entity';
import { TOKEN_CONSTANTS } from '../../../constants/auth.constants';
import { AuditLogService } from '../../../audit/audit-log.service';
import { BestEffortEventPublisher } from '../../../outbox/best-effort-event-publisher';
import {
  ActionToken,
  ActionTokenPurpose,
  ActionTokenStatus,
} from '../../authentication/entities/action-token.entity';
import { Invitation, InvitationStatus } from '../../authentication/entities/invitation.entity';
import { RefreshToken } from '../../authentication/entities/refresh-token.entity';
import { UserModuleAssignment } from '../../authentication/entities/user-module-assignment.entity';
import { User, AccessType } from '../../authentication/entities/user.entity';
import {
  DurableUserTokenInvalidationService,
  type UserTokenInvalidationIntent,
} from '../../authentication/services/durable-user-token-invalidation.service';
import {
  MobileUserSettings,
  DEFAULT_MOBILE_FEATURES,
} from '../entities/mobile-user-settings.entity';
import { Tenant } from '../entities/tenant.entity';

import { CapabilityAuthorityService, ValidatedOverrideSet } from './capability-authority';
import { TenantRoleService, TenantRoleWithDetails } from './tenant-role.service';
import {
  createCredentialInvalidationIntent,
  lockUserForCredentialMutation,
  revokeActiveRefreshTokens,
  type UserCredentialInvalidationOperation,
} from './user-credential-revocation';

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

const INVITATION_TTL_MS = TOKEN_CONSTANTS.DEFAULT_INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

/**
 * The correlation key shared by the User, Invitation and ActionToken rows of
 * one invitation, plus the expiry all three carry. Only the hash exists: the
 * link the invitee receives names the ActionToken row id
 * (InternalAuthController.getActionTokenUrl), and acceptInvitation joins the
 * resolved ActionToken to its Invitation through this hash.
 */
interface InvitationSecret {
  readonly tokenHash: string;
  readonly expiresAt: Date;
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
    // not the raw event bus. (Durable upgrade tracked as ORPHAN-HIGH-090; the
    // rows it must commit with are now written in one transaction by
    // mintInvitation, so the outbox move no longer waits on createUser.)
    private readonly bestEffort: BestEffortEventPublisher,
    private readonly auditLogService: AuditLogService,
    // SECURITY (RBAC-C1/C2): write-time grant-authority SSoT. createUser was a
    // grant path with NO authority check — a delegate with `users:invite` could
    // spawn a user carrying arbitrary override grants. All grants now route
    // through the shared validator.
    private readonly capabilityAuthority: CapabilityAuthorityService,
    private readonly durableUserTokenInvalidation: DurableUserTokenInvalidationService,
  ) {}

  private async applyCredentialInvalidationImmediately(
    operation: UserCredentialInvalidationOperation,
    intent: UserTokenInvalidationIntent,
  ): Promise<void> {
    try {
      await this.durableUserTokenInvalidation.applyImmediately(intent);
    } catch (error) {
      // The transaction already committed the durable security-recovery event.
      // Redis unavailability must not turn a committed credential mutation into
      // an apparent rollback; the outbox consumer will replay the same max-only
      // invalidation epoch.
      this.logger.error(
        JSON.stringify({
          event: 'user_credential_immediate_invalidation_failed',
          operation,
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
    }
  }

  /**
   * Create a new user within a tenant.
   *
   * Single flow that:
   * 1. Validates tenant exists
   * 2. Checks for duplicate email
   * 3. Validates role exists in tenant
   * 4. Creates the user row and, unless a password was supplied, its Invitation
   *    and ActionToken rows in ONE transaction (mintInvitation)
   * 5. Creates role assignment in tenant schema
   * 6. Publishes UserInvited carrying the ActionToken row id the e-mailed link names
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

    // An invitation is minted only when the caller did not supply a password:
    // the e-mailed link IS the credential. The secret is fixed before the
    // transaction so the User row carries its hash from the first write.
    const invitationSecret = sendInvitation && !input.password ? this.newInvitationSecret() : null;

    const userAccessType = input.accessType ?? AccessType.BOTH;
    const normalisedEmail = input.email.toLowerCase();

    // SEC-HIGH-158: User, Invitation and ActionToken commit together. A user
    // whose e-mailed link has no ActionToken row behind it cannot exist — the
    // previous shape published a token HASH under `actionTokenId`, which the
    // link resolver could never turn into a row.
    const { savedUser, actionTokenId } = await this.dataSource.transaction(async (manager) => {
      const newUser = manager.create(User, {
        email: normalisedEmail,
        firstName: input.firstName,
        lastName: input.lastName,
        password: input.password || undefined,
        role: Role.MODULE_USER, // Default global role; tenant role is separate
        accessType: userAccessType,
        tenantId,
        isActive: true,
        isEmailVerified: false,
        invitationToken: invitationSecret ? invitationSecret.tokenHash : null,
        invitationExpiresAt: invitationSecret ? invitationSecret.expiresAt : null,
        invitedBy: createdBy,
      });
      const persistedUser = await manager.save(User, newUser);
      if (invitationSecret === null) {
        return { savedUser: persistedUser, actionTokenId: null };
      }

      const { actionToken } = await this.mintInvitation(manager, {
        user: persistedUser,
        tenantId,
        email: normalisedEmail,
        firstName: input.firstName,
        lastName: input.lastName,
        role: Role.MODULE_USER,
        moduleIds: null,
        primaryModuleId: null,
        message: null,
        invitedBy: createdBy,
        secret: invitationSecret,
        source: 'tenant-user-create',
      });
      return { savedUser: persistedUser, actionTokenId: actionToken.id };
    });
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
        this.logger.warn(
          `Failed to auto-provision mobile settings for ${savedUser.id}: ${(mobileErr as Error).message}`,
        );
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

    // The e-mailed link is built by the notification service from this row id.
    let invitationSent = false;
    if (actionTokenId !== null) {
      await this.publishUserInvited({
        tenantId,
        userId: savedUser.id,
        role: savedUser.role,
        invitedBy: createdBy,
        actionTokenId,
      });
      invitationSent = true;
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
  async deleteUser(tenantId: string, userId: string, deletedBy: string): Promise<boolean> {
    // SECURITY: Prevent self-deletion
    if (deletedBy === userId) {
      throw new BadRequestException('Cannot delete your own account');
    }

    // SECURITY (SEC-MEDIUM-002): the soft-delete, role revocation, refresh-token
    // revocation, and audit row commit ATOMICALLY. Previously the user was
    // deactivated, roles revoked (swallowed try/catch), and tokens revoked
    // first, then the audit ran in a swallowed try/catch (fail-OPEN) — a user
    // deletion could persist with no audit evidence (SOC 2 CC6.1), and a
    // swallowed role-revoke failure could leave a "deleted" user with live role
    // assignments. A throwing audit, role revoke, or token revoke now rolls back
    // the whole soft-delete (fail-CLOSED): no deletion persists without its role
    // revocation, token revocation, AND audit trail.
    const transactionResult = await this.dataSource.transaction(async (manager) => {
      // Canonical credential lock order: User FOR UPDATE first. Every token
      // mint/rotation path uses the same per-user fence before RefreshToken,
      // so no concurrent replacement token can escape the UPDATE below.
      const user = await lockUserForCredentialMutation(
        manager,
        this.userRepository,
        userId,
        tenantId,
      );
      if (!user) {
        throw new NotFoundException(`User with ID "${userId}" not found in tenant`);
      }
      if (user.role === Role.TENANT_ADMIN) {
        throw new ForbiddenException('Cannot delete a tenant admin user');
      }

      // SECURITY (foreign-actor email leak): pin the actor lookup to this
      // tenant. It deliberately remains a non-locking read; the target User is
      // the one credential principal whose write fence this transaction owns.
      const transactionUserRepository = manager.withRepository(this.userRepository);
      const admin = await transactionUserRepository.findOne({
        where: { id: deletedBy, tenantId },
      });

      // 1. Deactivate the user
      user.isActive = false;
      await transactionUserRepository.update({ id: user.id }, { isActive: false });

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
      const invalidatedAt = new Date();
      const refreshTokensRevoked = await revokeActiveRefreshTokens(
        manager,
        this.refreshTokenRepository,
        userId,
        invalidatedAt,
        'User deleted',
      );
      const intent = createCredentialInvalidationIntent(
        user,
        invalidatedAt,
        'user-delete',
        'logout_all_devices',
      );
      await this.durableUserTokenInvalidation.enqueue(manager, intent);

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
            refreshTokensRevoked,
            timestamp: new Date().toISOString(),
          },
          severity: AuditLogSeverity.WARNING,
        },
        manager,
      );
      return { user, intent };
    });

    await this.applyCredentialInvalidationImmediately('user-delete', transactionResult.intent);

    // SECURITY: Log user ID instead of email to prevent PII exposure in logs (H-14)
    this.logger.log(
      `Deleted (soft) userId=${transactionResult.user.id} from tenant ${tenantId}, revoked all credentials`,
    );

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
    const passwordHash = await hashPassword(newPassword);
    const transactionResult = await this.dataSource.transaction(async (manager) => {
      const user = await lockUserForCredentialMutation(manager, this.userRepository, userId);
      if (!user) {
        throw new NotFoundException(`User with ID "${userId}" not found`);
      }

      await manager.update(
        User,
        { id: userId },
        {
          password: passwordHash,
          passwordResetToken: null,
          passwordResetExpires: null,
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      );

      const invalidatedAt = new Date();
      const refreshTokensRevoked = await revokeActiveRefreshTokens(
        manager,
        this.refreshTokenRepository,
        userId,
        invalidatedAt,
        'Admin password reset',
      );
      const intent = createCredentialInvalidationIntent(
        user,
        invalidatedAt,
        'admin-password-reset',
        'password_reset',
      );
      await this.durableUserTokenInvalidation.enqueue(manager, intent);
      return { user, refreshTokensRevoked, intent };
    });

    await this.applyCredentialInvalidationImmediately(
      'admin-password-reset',
      transactionResult.intent,
    );

    this.logger.log(
      `Admin password reset for userId=${transactionResult.user.id}, refreshTokensRevoked=${transactionResult.refreshTokensRevoked}`,
    );
    return {
      userId: transactionResult.user.id,
      refreshTokensRevoked: transactionResult.refreshTokensRevoked,
    };
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
    // Role, tenant and deactivation fields are authorization state, not
    // ordinary profile data. Serialize them with token minting through the
    // canonical User fence, revoke refresh credentials and durably invalidate
    // already-issued access tokens in the same transaction.
    const mutatesAuthorization =
      patch.isActive !== undefined || patch.role !== undefined || patch.tenantId !== undefined;
    if (mutatesAuthorization) {
      const transactionResult = await this.dataSource.transaction(async (manager) => {
        const discovered = await manager.findOne(User, {
          where: { id: userId },
          select: { id: true, tenantId: true },
        });
        if (!discovered) throw new NotFoundException('User not found');
        const tenantIds = [
          ...new Set(
            [discovered.tenantId, patch.tenantId].filter(
              (id): id is string => typeof id === 'string',
            ),
          ),
        ].sort();
        for (const tenantId of tenantIds) {
          const tenant = await manager.findOne(Tenant, {
            where: { id: tenantId },
            lock: { mode: 'pessimistic_write' },
          });
          if (!tenant) throw new NotFoundException('Tenant not found');
        }
        const user = await lockUserForCredentialMutation(manager, this.userRepository, userId);
        if (!user) {
          throw new NotFoundException(`User with ID "${userId}" not found`);
        }

        if ((user.tenantId ?? null) !== (discovered.tenantId ?? null)) {
          throw new ConflictException('User tenant changed during update');
        }
        const requestedRole = patch.role;
        if (requestedRole !== undefined && !isCanonicalRole(requestedRole)) {
          throw new BadRequestException(`Unknown role "${requestedRole}"`);
        }

        if (patch.tenantId !== undefined && patch.tenantId !== null) {
          const tenant = await manager.withRepository(this.tenantRepository).findOne({
            where: { id: patch.tenantId },
          });
          if (!tenant) {
            throw new NotFoundException(`Tenant with ID "${patch.tenantId}" not found`);
          }
        }

        if (patch.firstName !== undefined) user.firstName = patch.firstName;
        if (patch.lastName !== undefined) user.lastName = patch.lastName;
        if (requestedRole !== undefined) user.role = requestedRole;
        if (patch.tenantId !== undefined) user.tenantId = patch.tenantId;
        if (patch.isActive !== undefined) user.isActive = patch.isActive;

        await manager.update(
          User,
          { id: userId },
          {
            ...(patch.firstName !== undefined ? { firstName: patch.firstName } : {}),
            ...(patch.lastName !== undefined ? { lastName: patch.lastName } : {}),
            ...(requestedRole !== undefined ? { role: requestedRole } : {}),
            ...(patch.tenantId !== undefined ? { tenantId: patch.tenantId } : {}),
            ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
          },
        );
        const saved = await manager.findOneByOrFail(User, { id: userId });
        if (patch.tenantId !== undefined) {
          for (const tenantId of tenantIds) {
            const userCount = await manager.count(User, { where: { tenantId } });
            await manager.update(Tenant, { id: tenantId }, { userCount });
          }
        }
        const invalidatedAt = new Date();
        await revokeActiveRefreshTokens(
          manager,
          this.refreshTokenRepository,
          userId,
          invalidatedAt,
          'User authorization updated by administrator',
        );
        const intent = createCredentialInvalidationIntent(
          saved,
          invalidatedAt,
          'admin-user-authorization-update',
          'logout_all_devices',
        );
        await this.durableUserTokenInvalidation.enqueue(manager, intent);
        return { saved, intent };
      });

      await this.applyCredentialInvalidationImmediately(
        'admin-user-authorization-update',
        transactionResult.intent,
      );
      this.logger.log(`Admin updated authorization for userId=${transactionResult.saved.id}`);
      return transactionResult.saved;
    }

    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User with ID "${userId}" not found`);
    }

    if (patch.firstName !== undefined) user.firstName = patch.firstName;
    if (patch.lastName !== undefined) user.lastName = patch.lastName;
    if (patch.isActive !== undefined) user.isActive = patch.isActive;

    await this.userRepository.update(
      { id: userId },
      {
        ...(patch.firstName !== undefined ? { firstName: patch.firstName } : {}),
        ...(patch.lastName !== undefined ? { lastName: patch.lastName } : {}),
      },
    );
    const saved = await this.userRepository.findOneByOrFail({ id: userId });
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
   *  - Soft-revokes refresh tokens, preserving forensic lineage and reuse
   *    detection while keeping the existing result-field contract.
   *
   * @throws NotFoundException when the userId does not resolve
   */
  async adminDeactivateUser(
    userId: string,
  ): Promise<{ userId: string; refreshTokensRemoved: number }> {
    const transactionResult = await this.dataSource.transaction(async (manager) => {
      const user = await lockUserForCredentialMutation(manager, this.userRepository, userId);
      if (!user) {
        throw new NotFoundException(`User with ID "${userId}" not found`);
      }

      user.isActive = false;
      await manager.update(User, { id: userId }, { isActive: false });
      const invalidatedAt = new Date();
      const refreshTokensRemoved = await revokeActiveRefreshTokens(
        manager,
        this.refreshTokenRepository,
        userId,
        invalidatedAt,
        'User deactivated by administrator',
      );
      const intent = createCredentialInvalidationIntent(
        user,
        invalidatedAt,
        'admin-user-deactivate',
        'logout_all_devices',
      );
      await this.durableUserTokenInvalidation.enqueue(manager, intent);
      return { user, refreshTokensRemoved, intent };
    });

    await this.applyCredentialInvalidationImmediately(
      'admin-user-deactivate',
      transactionResult.intent,
    );

    this.logger.log(
      `Admin deactivated userId=${transactionResult.user.id}, refreshTokensRemoved=${transactionResult.refreshTokensRemoved}`,
    );
    return {
      userId: transactionResult.user.id,
      refreshTokensRemoved: transactionResult.refreshTokensRemoved,
    };
  }

  /**
   * Admin-initiated force-logout. Revokes all active refresh tokens for a
   * user without touching the user record itself — the account remains
   * active and the user can re-authenticate immediately. Typical use:
   * suspected credential leak, operator wants to invalidate sessions
   * without locking the account.
   */
  async adminForceLogout(userId: string): Promise<{ userId: string; sessionsInvalidated: number }> {
    const transactionResult = await this.dataSource.transaction(async (manager) => {
      const user = await lockUserForCredentialMutation(manager, this.userRepository, userId);
      if (!user) {
        throw new NotFoundException(`User with ID "${userId}" not found`);
      }

      const invalidatedAt = new Date();
      const sessionsInvalidated = await revokeActiveRefreshTokens(
        manager,
        this.refreshTokenRepository,
        userId,
        invalidatedAt,
        'Administrator forced logout',
      );
      const intent = createCredentialInvalidationIntent(
        user,
        invalidatedAt,
        'admin-force-logout',
        'logout_all_devices',
      );
      await this.durableUserTokenInvalidation.enqueue(manager, intent);
      return { user, sessionsInvalidated, intent };
    });

    await this.applyCredentialInvalidationImmediately(
      'admin-force-logout',
      transactionResult.intent,
    );

    this.logger.log(
      `Admin force-logout userId=${transactionResult.user.id}, sessionsInvalidated=${transactionResult.sessionsInvalidated}`,
    );
    return {
      userId: transactionResult.user.id,
      sessionsInvalidated: transactionResult.sessionsInvalidated,
    };
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

    // 5. Invitation secret (MED-004 pattern): only its hash is stored, and
    //    the link names the ActionToken row id — see newInvitationSecret.
    const secret = this.newInvitationSecret();

    // 6. Atomic multi-row write via a transaction. Using a transactional
    //    EntityManager guarantees that a User without an Invitation row
    //    (or vice versa) cannot exist if any single insert fails.
    const result = await this.dataSource.transaction(async (manager) => {
      const lockedTenant = await manager.findOne(Tenant, {
        where: { id: input.tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!lockedTenant) throw new NotFoundException('Tenant not found');
      const lockedCount = await manager.count(User, { where: { tenantId: input.tenantId } });
      if (lockedTenant.maxUsers !== -1 && lockedCount >= lockedTenant.maxUsers) {
        throw new BadRequestException('Tenant user limit reached');
      }

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
        invitationToken: secret.tokenHash,
        invitationExpiresAt: secret.expiresAt,
        invitedBy: input.invitedBy,
      });
      const savedUser = await manager.save(User, newUser);

      const { invitation: savedInvitation, actionToken: savedActionToken } =
        await this.mintInvitation(manager, {
          user: savedUser,
          tenantId: input.tenantId,
          email: normalisedEmail,
          firstName: input.firstName ?? null,
          lastName: input.lastName ?? null,
          role: invitedRole,
          moduleIds: input.moduleIds && input.moduleIds.length > 0 ? input.moduleIds : null,
          primaryModuleId: input.primaryModuleId ?? null,
          message: input.message ?? null,
          invitedBy: input.invitedBy,
          secret,
          source: 'tenant-admin-invite',
        });

      // Module assignments — only meaningful for module-scoped roles.
      // TENANT_ADMIN inherits access from TenantModule rows and gets no
      // UserModuleAssignment entries. The moduleIds presence check is inlined
      // into the `if` so TS narrows `input.moduleIds` to a defined string[]
      // (no non-null assertion needed on the .map).
      if (invitedRole !== Role.TENANT_ADMIN && input.moduleIds && input.moduleIds.length > 0) {
        const assignments = input.moduleIds.map((moduleId) =>
          umaRepo.create({
            userId: savedUser.id,
            moduleId,
            tenantId: input.tenantId,
            isPrimaryManager:
              invitedRole === Role.MODULE_MANAGER && moduleId === input.primaryModuleId,
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
      await this.publishUserInvited({
        tenantId: input.tenantId,
        userId: result.userId,
        role: input.role,
        invitedBy: input.invitedBy,
        actionTokenId: result.actionTokenId,
      });
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
  private assertRoleHierarchy(inviter: User, targetTenantId: string, targetRole: Role): void {
    const ranks: Record<string, number> = {
      [Role.SUPER_ADMIN]: 4,
      [Role.TENANT_ADMIN]: 3,
      [Role.MODULE_MANAGER]: 2,
      [Role.MODULE_USER]: 1,
    };

    if (inviter.role === Role.SUPER_ADMIN) return;

    if (inviter.tenantId !== targetTenantId) {
      throw new ForbiddenException('Cannot invite users to a different tenant');
    }

    if (inviter.role === Role.TENANT_ADMIN) {
      if ((ranks[targetRole] ?? 0) <= (ranks[Role.TENANT_ADMIN] ?? 0)) return;
      throw new ForbiddenException('Cannot create user with higher role than your own');
    }

    if (inviter.role === Role.MODULE_MANAGER) {
      if (targetRole === Role.MODULE_USER) return;
      throw new ForbiddenException('Module managers can only invite module users');
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
      throw new NotFoundException(`Role with ID "${roleId}" not found in tenant`);
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
      permissionOverrides: {
        grants: permissionOverrides.grants,
        revokes: permissionOverrides.revokes,
      },
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
   * Fresh invitation secret. 256 random bits are hashed and the raw value is
   * discarded: nothing e-mails it. The hash is the correlation key between
   * User.invitationToken, Invitation.token and ActionToken.tokenHash, and the
   * e-mailed link names the ActionToken row id instead (SEC-HIGH-158).
   */
  private newInvitationSecret(): InvitationSecret {
    const rawToken = crypto.randomBytes(32).toString('hex');
    return {
      tokenHash: crypto.createHash('sha256').update(rawToken).digest('hex'),
      expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
    };
  }

  /**
   * Write the Invitation and ActionToken rows of one invitation on the caller's
   * transactional manager. The user row is the caller's (its shape differs per
   * entry point); this is the single place the pair behind an e-mailed link is
   * minted, so every UserInvited publisher hands the notification service a
   * row id that InternalAuthController.getActionTokenUrl can look up.
   *
   * WHY manager.create/save (not tenantManagerRepo): auth.invitations and
   * auth.action_tokens are cross-tenant tables whose tenantId is nullable
   * (platform-scoped rows carry NULL), so they do not satisfy the scoped
   * repository's TenantEntity constraint; tenantId is bound explicitly below.
   */
  private async mintInvitation(
    manager: EntityManager,
    params: {
      user: User;
      tenantId: string;
      email: string;
      firstName: string | null;
      lastName: string | null;
      role: Role;
      moduleIds: string[] | null;
      primaryModuleId: string | null;
      message: string | null;
      invitedBy: string;
      secret: InvitationSecret;
      source: 'tenant-admin-invite' | 'tenant-user-create';
    },
  ): Promise<{ invitation: Invitation; actionToken: ActionToken }> {
    const invitation = await manager.save(
      Invitation,
      manager.create(Invitation, {
        token: params.secret.tokenHash,
        email: params.email,
        firstName: params.firstName,
        lastName: params.lastName,
        role: params.role,
        tenantId: params.tenantId,
        moduleIds: params.moduleIds,
        primaryModuleId: params.primaryModuleId,
        status: InvitationStatus.PENDING,
        expiresAt: params.secret.expiresAt,
        message: params.message,
        invitedBy: params.invitedBy,
        sendCount: 1,
        lastSentAt: new Date(),
      }),
    );
    const actionToken = await manager.save(
      ActionToken,
      manager.create(ActionToken, {
        purpose: ActionTokenPurpose.INVITATION,
        tenantId: params.tenantId,
        userId: params.user.id,
        tokenHash: params.secret.tokenHash,
        status: ActionTokenStatus.ACTIVE,
        expiresAt: params.secret.expiresAt,
        auditMetadata: {
          source: params.source,
          invitedBy: params.invitedBy,
        },
      }),
    );
    return { invitation, actionToken };
  }

  /**
   * Publish the UserInvited notification trigger.
   *
   * SECURITY (CRITICAL-001/002): only opaque references travel on the event
   * bus. PII (email, names, tenant name) and secret URLs are NEVER placed on
   * the immutable event bus; the notification service resolves user/tenant
   * details and builds the action URL at delivery time via authenticated
   * internal API calls. `actionTokenId` is the ActionToken ROW ID minted by
   * mintInvitation — the only value that URL builder can resolve.
   */
  private async publishUserInvited(params: {
    tenantId: string;
    userId: string;
    role: string;
    invitedBy: string;
    actionTokenId: string;
  }): Promise<void> {
    const event: UserInvitedEvent = {
      ...createBaseEvent<UserInvitedEvent>('UserInvited', params.tenantId, {
        aggregateId: params.userId,
        aggregateType: 'User',
      }),
      userId: params.userId,
      role: params.role,
      invitedBy: params.invitedBy,
      credentialType: 'reset_token',
      actionTokenId: params.actionTokenId,
      cryptoShredKeyId: params.userId,
    };

    await this.bestEffort.publish(event);
    // SECURITY: Log user ID instead of email to prevent PII exposure in logs (H-14)
    this.logger.log(`Published UserInvitedEvent for userId=${params.userId}`);
  }
}
