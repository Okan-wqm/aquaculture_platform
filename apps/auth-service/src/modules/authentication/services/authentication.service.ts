import * as crypto from 'crypto';

import {
  hashPassword,
  verifyPassword,
  enforceAccessTokenType,
  getJwtVerifyOptions,
} from '@aquaculture/backend-common/auth';
import { BypassRlsService, updateReturningRows } from '@aquaculture/backend-common/database';
import { Role } from '@aquaculture/backend-common/decorators';
import { requestContextStorage, getRequestContext } from '@aquaculture/backend-common/logging';
import {
  TimingSafeService,
  ISessionManager,
  ITokenBlacklist,
  IUserTokenRevocation,
  SESSION_MANAGER,
  TOKEN_BLACKLIST,
  USER_TOKEN_REVOCATION,
  SecurityEventService,
} from '@aquaculture/backend-common/security';
import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
  Inject,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { createBaseEvent, isLoginAllowed, tenantScopeOf } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import type { UserAccountLockedEvent, InvitationAcceptedEvent, PasswordResetCompletedEvent, PasswordResetRequestedEvent } from '@platform/event-contracts';
import * as bcrypt from 'bcryptjs';
import {
  DataSource,
  EntityManager,
  IsNull,
  Repository,
} from 'typeorm';

import { AuditLogSeverity } from '../../../audit/audit-log.entity';
import { AuditLogService } from '../../../audit/audit-log.service';
import { SECURITY_CONSTANTS, TOKEN_CONSTANTS } from '../../../constants/auth.constants';
import { parseHashRefreshTokens } from '../../../config/hash-refresh-tokens';
import { BestEffortEventPublisher } from '../../../outbox/best-effort-event-publisher';
import { Tenant } from '../../tenant/entities/tenant.entity';
import { AuthPayload, MePayload, CredentialActionResult } from '../dto/auth-response.dto';
import { LoginInput } from '../dto/login.dto';
import {
  ActionToken,
  ActionTokenPurpose,
  ActionTokenStatus,
} from '../entities/action-token.entity';
import { Invitation, InvitationStatus } from '../entities/invitation.entity';
import { RefreshToken } from '../entities/refresh-token.entity';
import { User } from '../entities/user.entity';
import { WebAuthnCredential } from '../entities/webauthn-credential.entity';

import { LockedAuthContext, snapshotCredentialProof, withLockedCredentialPrincipal, withLockedAuthenticatedSession } from './credential-state';
import { ActionTokenResolver, type ActionLinkLock } from './action-token-resolver.service';
import { MfaService } from './mfa.service';
import { DurableAccessTokenInvalidationService } from './durable-access-token-invalidation.service';
import {
  DurableUserTokenInvalidationService,
  type UserTokenInvalidationIntent,
} from './durable-user-token-invalidation.service';
import {
  type PostCommitSecurityEffect,
  settlePostCommitSecurityEffects,
} from './post-commit-security-effects';
import { TokenService } from './token.service';
import type { JwtPayload, OriginatingAccessSession } from './token.service';

// Re-export JwtPayload from its canonical location for backward compatibility
export type { JwtPayload } from './token.service';

/**
 * Generic authentication error message
 * SECURITY: Using generic message prevents user enumeration attacks
 */
const INVALID_CREDENTIALS_MSG = 'Invalid email or password';
const GENERIC_AUTH_ERROR_MSG = 'Authentication failed';
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LEGACY_REFRESH_SECRET_PATTERN = /^[0-9a-f]{128}$/;
const VERSIONED_REFRESH_SECRET_PATTERN = /^[0-9a-f]{160}$/;

interface ParsedHashedRefreshToken {
  userId: string;
  secret: string;
  tokenId?: string;
}

interface RefreshReuseContainment {
  intent: UserTokenInvalidationIntent;
  suspectToken: RefreshToken;
}

interface RefreshTransactionResult {
  payload?: AuthPayload;
  containment?: RefreshReuseContainment;
}

/**
 * Recover the canonical refresh-token SSoT (`${userId}:${random}`) from its
 * cookie transport. A refresh cookie minted before the identity-encoder fix
 * (refresh-token-cookie.ts) — or any hop that re-applies URL-encoding — can
 * deliver the ':' separator as '%3A'. `decodeURIComponent` is the correct
 * inverse of that transport; it is idempotent for an already-canonical token
 * (a UUID:hex value contains no '%') and falls back to the raw input on a
 * malformed escape rather than throwing.
 */
export function decodeRefreshTokenTransport(token: string): string {
  if (!token.includes('%')) return token;
  try {
    return decodeURIComponent(token);
  } catch {
    return token;
  }
}

/**
 * SEC-MEDIUM-113 (2026-08-23 scan №58): a benign two-tab refresh race (both
 * tabs fire refresh with the same pre-rotation cookie) previously landed in
 * reuse CONTAINMENT — all-session logout plus a false CRITICAL alert. A
 * short tolerance window lets the loser re-mint from the same family once;
 * the re-mint flips the reason to 'Token refreshed (grace)' so a second
 * presentation of the same row still contains. A stolen-token replay inside
 * the window gains exactly one mint — the inherent, bounded cost of grace.
 */
const REFRESH_ROTATION_GRACE_MS = 60_000;

@Injectable()
export class AuthenticationService {
  private readonly logger = new Logger(AuthenticationService.name);
  private readonly maxFailedAttempts: number;
  private readonly lockoutDurationMinutes: number;
  private readonly hashRefreshTokens: boolean;
  private readonly minLoginDurationMs: number;

  /**
   * SECURITY (SEC-HIGH-002): a VALID peppered dummy hash, lazily computed
   * once, used to run the user-not-found login branch through the EXACT same
   * verifyPassword (applyPepper → bcrypt.compare) pipeline as a real user.
   * The previous code compared against a MALFORMED bcrypt string AND skipped
   * the pepper HMAC, leaving a measurable timing asymmetry that leaks user
   * existence. Computing it of random material means it never matches any
   * real password.
   */
  private dummyPasswordHash: string | null = null;
  private readonly lockedContexts = new WeakMap<User, LockedAuthContext>();

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepository: Repository<RefreshToken>,
    @InjectRepository(Invitation)
    private readonly invitationRepository: Repository<Invitation>,
    @InjectRepository(ActionToken)
    private readonly actionTokenRepository: Repository<ActionToken>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    // ADR-046: the MFA-enrollment gate treats a registered WebAuthn credential
    // as satisfying tenant MFA enforcement, so the gate must be able to count
    // the user's passkeys / security keys.
    @InjectRepository(WebAuthnCredential)
    private readonly webAuthnCredentialRepository: Repository<WebAuthnCredential>,
    private readonly dataSource: DataSource,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    // Login telemetry is best effort; credential actions and recovery delivery
    // events commit through the outbox with the corresponding mutation.
    private readonly bestEffort: BestEffortEventPublisher,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly actionTokenResolver: ActionTokenResolver,
    private readonly auditLogService: AuditLogService,
    private readonly tokenService: TokenService,
    private readonly durableAccessTokenInvalidation: DurableAccessTokenInvalidationService,
    private readonly durableUserTokenInvalidation: DurableUserTokenInvalidationService,
    private readonly mfaService: MfaService,
    /**
     * SECURITY (DEPLOY-CRITICAL-007): audit-logged RLS bypass primitive for
     * the SUPER_ADMIN login path. Platform-level users (tenantId=NULL)
     * cannot satisfy `tenant_isolation_policy` on auth.refresh_tokens —
     * see login() for the tenant-vs-platform branching and the full
     * architectural rationale.
     */
    private readonly bypassRls: BypassRlsService,
    @Inject(TOKEN_BLACKLIST) private readonly tokenBlacklist: ITokenBlacklist,
    @Inject(USER_TOKEN_REVOCATION)
    private readonly userTokenRevocation: IUserTokenRevocation,
    @Optional() private readonly timingSafe?: TimingSafeService,
    @Optional() @Inject(SESSION_MANAGER) private readonly sessionManager?: ISessionManager,
    // SEC-HIGH-009 cure: when refresh-token reuse is detected (a
    // previously-revoked token is presented again, indicating either
    // a captured-token replay or a buggy client retry on a now-stale
    // copy), the SecurityEventService publishes a
    // RefreshTokenReuseDetected event so the incident-detection
    // pipeline (Prom alert / pager) sees the signal in real time.
    // @Optional preserves local-dev paths where the security
    // infrastructure may not be wired.
    @Optional() private readonly securityEventService?: SecurityEventService,
  ) {
    this.maxFailedAttempts = this.configService.get<number>(
      'MAX_FAILED_ATTEMPTS',
      SECURITY_CONSTANTS.DEFAULT_MAX_FAILED_ATTEMPTS,
    );
    this.lockoutDurationMinutes = this.configService.get<number>(
      'LOCKOUT_DURATION_MINUTES',
      SECURITY_CONSTANTS.DEFAULT_LOCKOUT_DURATION_MINUTES,
    );
    this.hashRefreshTokens = parseHashRefreshTokens(this.configService);
    this.minLoginDurationMs = this.configService.get<number>(
      'MIN_LOGIN_DURATION_MS',
      SECURITY_CONSTANTS.MIN_LOGIN_DURATION_MS,
    );
  }


  /**
   * Canonical serialization fence for every per-user refresh-credential write.
   *
   * The user row is the one stable lock key shared by rotation, reuse
   * containment, logout, and logout-all. Taking this lock before any refresh
   * token row lock or set-based UPDATE prevents a replacement token INSERT from
   * committing just after a revocation statement's PostgreSQL snapshot. It also
   * gives every path one lock order (User -> RefreshToken), avoiding the
   * token-first/user-first deadlock cycle that otherwise appears under load.
   */
  private async lockCredentialPrincipal(manager: EntityManager, userId: string): Promise<User> {
    const context = await LockedAuthContext.lock(manager, userId);
    this.lockedContexts.set(context.user, context);
    return context.user;
  }

  private contextFor(user: User): LockedAuthContext {
    const context = this.lockedContexts.get(user);
    if (!context) throw new Error('Credential operation requires the locked principal context');
    return context;
  }

  private invalidationTenantForUser(user: User): string | null {
    if (user.tenantId) {
      return user.tenantId;
    }
    if (user.role === Role.SUPER_ADMIN) {
      return null;
    }
    throw new ForbiddenException('Tenant-scoped user has no tenant identity');
  }

  /**
   * RBAC-HIGH-007: refresh enforces the SAME fail-closed tenant allow-list as
   * login (isLoginAllowed — ACTIVE only, the tenant-status machine SSoT that
   * MT-HIGH-003 installed on the login path). Before this gate, suspending /
   * deactivating / cancelling a tenant only blocked NEW logins — every
   * logged-in user kept silently ROTATING fresh tokens for the refresh-token
   * lifetime (days). Both refresh paths call this after resolving the user;
   * the tenant row is read through the same pre-tenant repository as the
   * token/user rows (refresh runs before tenant context exists). SUPER_ADMIN
   * (tenantId null) is exempt, matching login. A missing tenant row falls
   * through exactly like the login gate — symmetry with login is the contract.
   */
  private async assertTenantOperationalForRefresh(
    manager: EntityManager,
    user: User,
  ): Promise<void> {
    if (!user.tenantId) return;
    const tenant = await manager.withRepository(this.tenantRepository).findOne({
      where: { id: user.tenantId },
    });
    if (tenant && !isLoginAllowed(tenant.status)) {
      this.logger.debug(`Refresh blocked: tenant ${user.tenantId} is ${tenant.status}`);
      throw new UnauthorizedException(GENERIC_AUTH_ERROR_MSG);
    }
  }

  /**
   * SECURITY (SEC-HIGH-002): lazily compute (once) a VALID peppered dummy
   * hash of random material. The user-not-found login branch verifies the
   * supplied password against it through the real verifyPassword pipeline so
   * the timing/instruction path is identical to a real user — and it can
   * never match because no user knows the random secret.
   */
  private async getDummyPasswordHash(): Promise<string> {
    if (this.dummyPasswordHash === null) {
      this.dummyPasswordHash = await hashPassword(crypto.randomBytes(32).toString('hex'));
    }
    return this.dummyPasswordHash;
  }

  /**
   * Log security events for audit trail
   * @private
   */
  private async logSecurityEvent(
    action: string,
    details: {
      userId?: string;
      email?: string;
      tenantId?: string | null;
      ipAddress?: string;
      userAgent?: string;
      success: boolean;
      reason?: string;
    },
    severity: AuditLogSeverity = AuditLogSeverity.INFO,
    manager?: EntityManager,
  ): Promise<void> {
    try {
      await this.auditLogService.log({
        tenantId: details.tenantId || undefined,
        performedBy: details.userId || 'anonymous',
        performedByEmail: details.email,
        action,
        entityType: 'User',
        entityId: details.userId,
        details: {
          success: details.success,
          reason: details.reason,
          timestamp: new Date().toISOString(),
        },
        severity,
        ipAddress: details.ipAddress,
        userAgent: details.userAgent,
      }, manager);
    } catch (error) {
      if (manager) throw error;
      // Rejected attempts outside a credential transaction retain best-effort diagnostics.
      this.logger.error(`Failed to log security event: ${action}`, error);
    }
  }

  // SECURITY (SEC-CRITICAL-001): register() was REMOVED — it persisted a
  // client-supplied tenantId with no existence/ACTIVE/maxUsers validation
  // and issued a full token pair to an unverified email. User creation is
  // owned by the invitation flow and the provisioning saga's first-admin
  // path (UserLifecycleService).

  /**
   * Confirm a user's CURRENT password without ANY login side effects.
   *
   * WHY separate from `login()`: this backs the credential-confirmation NATS
   * responder (request.auth.verifyPassword) that gates messaging's
   * irreversible GDPR `anonymizeMyData` erasure. It is a RE-confirmation, not
   * an authentication:
   *   - It does NOT touch `failedLoginAttempts` / `lockedUntil` — locking an
   *     account because its owner mistyped a GDPR confirmation would be
   *     hostile and would turn a data-subject right into a self-DoS.
   *   - It does NOT check `isActive` / `isLocked` / tenant status — a user
   *     with a valid session reaching the erasure flow may exercise their
   *     Article-17 right regardless of those operational states.
   *   - It runs the SAME peppered-bcrypt pipeline against a valid dummy hash
   *     for a missing/invitation-pending user (getDummyPasswordHash) and
   *     enforces `ensureMinDuration`, so a caller cannot distinguish
   *     "no such user" from "wrong password" by timing (no enumeration).
   *   - On a legacy-hash match it lazily re-hashes to the peppered format,
   *     identical to the login path, so a confirmed password migrates.
   *
   * Returns only a boolean; the responder never surfaces anything richer.
   */
  async confirmUserPassword(userId: string, password: string): Promise<boolean> {
    const startTime = Date.now();
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user || user.isPendingInvitation()) {
      // SEC (enumeration): identical instruction path to a real user — the
      // dummy hash goes through the same applyPepper → bcrypt.compare — and
      // it can never match because it is a hash of random material.
      await verifyPassword(password, await this.getDummyPasswordHash());
      await this.ensureMinDuration(startTime);
      return false;
    }

    const { matched, shouldMigrate } = await user.verifyPasswordAndSignalMigration(password);
    if (matched && shouldMigrate) {
      const proof = snapshotCredentialProof(user);
      const passwordHash = await hashPassword(password);
      await withLockedCredentialPrincipal(this.dataSource, proof, async (context) => {
        await context.manager.update(User, { id: user.id }, { password: passwordHash });
      });
    }
    await this.ensureMinDuration(startTime);
    return matched;
  }

  /**
   * Login user - supports all roles including SUPER_ADMIN
   *
   * SECURITY:
   * - Uses timing-safe operations to prevent timing attacks
   * - Generic error messages to prevent user enumeration
   * - Session management with concurrent session limits
   */
  async login(input: LoginInput, ipAddress?: string, userAgent?: string): Promise<AuthPayload> {
    const startTime = Date.now();
    // SECURITY: Do not log email addresses — PII under GDPR (SEC-AUTH-011)
    this.logger.debug('Login attempt received');

    try {
      // Find user by email only (tenantId can be null for SUPER_ADMIN)
      const user = await this.userRepository.findOne({
        where: { email: input.email.toLowerCase() },
      });

      // SECURITY (SEC-HIGH-002): user-not-found runs the SAME peppered verify
      // pipeline as a real user (applyPepper → bcrypt.compare) against a
      // valid dummy hash — identical instruction sequence, no timing/path
      // asymmetry that could leak account existence. The prior malformed
      // dummy hash + skipped pepper HMAC was the enumeration vector.
      if (!user) {
        await verifyPassword(input.password, await this.getDummyPasswordHash());
        await this.ensureMinDuration(startTime);
        this.logger.debug(`Login failed: user not found`);
        // SECURITY AUDIT: Log failed login attempt
        await this.logSecurityEvent(
          'LOGIN_FAILED',
          {
            email: input.email,
            ipAddress,
            userAgent,
            success: false,
            reason: 'User not found',
          },
          AuditLogSeverity.WARNING,
        );
        throw new UnauthorizedException(INVALID_CREDENTIALS_MSG);
      }

      // Check if user is pending invitation (no password set)
      // SECURITY: Use generic message
      if (user.isPendingInvitation()) {
        await this.ensureMinDuration(startTime);
        // SECURITY: Log user ID instead of email to prevent PII exposure (H-14)
        this.logger.debug(`Login failed: pending invitation for userId=${user.id}`);
        throw new UnauthorizedException(GENERIC_AUTH_ERROR_MSG);
      }

      // Check if account is locked
      // SECURITY: Don't reveal lockout duration to prevent timing attacks
      if (user.isLocked()) {
        await this.ensureMinDuration(startTime);
        // SECURITY: Log user ID instead of email to prevent PII exposure (H-14)
        this.logger.debug(`Login failed: account locked for userId=${user.id}`);
        // SECURITY AUDIT: Log locked account access attempt
        await this.logSecurityEvent(
          'LOGIN_BLOCKED_ACCOUNT_LOCKED',
          {
            userId: user.id,
            email: user.email,
            tenantId: user.tenantId,
            ipAddress,
            userAgent,
            success: false,
            reason: 'Account locked due to failed attempts',
          },
          AuditLogSeverity.WARNING,
        );
        throw new UnauthorizedException(GENERIC_AUTH_ERROR_MSG);
      }

      // Check if account is active
      if (!user.isActive) {
        await this.ensureMinDuration(startTime);
        // SECURITY: Log user ID instead of email to prevent PII exposure (H-14)
        this.logger.debug(`Login failed: account inactive for userId=${user.id}`);
        throw new UnauthorizedException(GENERIC_AUTH_ERROR_MSG);
      }

      // SECURITY (MT-HIGH-003): only an ACTIVE tenant may authenticate.
      // The previous check enumerated REJECTED statuses (SUSPENDED, CANCELLED),
      // so DEACTIVATED, ARCHIVED, PENDING and PROVISIONING* tenants slipped
      // through and could still log in. isLoginAllowed is the fail-closed
      // allow-list (ACTIVE only) owned by the tenant-status machine — a new
      // non-operational status is blocked by default, not by remembering to
      // add it here. SUPER_ADMIN users (tenantId null) are exempt.
      // The row is hoisted out of this block because it also drives the
      // ADR-046 enforcement point below: the MFA-enrollment login gate.
      let tenant: Tenant | null = null;
      if (user.tenantId) {
        tenant = await this.tenantRepository.findOne({ where: { id: user.tenantId } });
        if (tenant && !isLoginAllowed(tenant.status)) {
          await this.ensureMinDuration(startTime);
          this.logger.debug(`Login failed: tenant ${user.tenantId} is ${tenant.status}`);
          await this.logSecurityEvent(
            'LOGIN_BLOCKED_TENANT_INACTIVE',
            {
              userId: user.id,
              email: user.email,
              tenantId: user.tenantId,
              ipAddress,
              userAgent,
              success: false,
              reason: `Tenant account status is ${tenant.status}`,
            },
            AuditLogSeverity.WARNING,
          );
          throw new UnauthorizedException('Tenant account is not active');
        }
      }

      // Validate password
      // SECURITY (HIGH-006): verifyPasswordAndSignalMigration returns a
      // lazy-migration flag so legacy (unpeppered) hashes transparently
      // upgrade to the HMAC-peppered format on successful login. We only
      // re-hash AFTER all the other login-time checks (MFA, session cap)
      // have cleared — see the block further down that persists the rehash.
      const verifyResult = await user.verifyPasswordAndSignalMigration(input.password);
      const isPasswordValid = verifyResult.matched;
      const shouldMigratePasswordHash = verifyResult.shouldMigrate;

      if (!isPasswordValid) {
        // M-04: Use returned attempt count for accurate audit logging
        const updatedAttempts = await this.handleFailedLogin(user);
        await this.ensureMinDuration(startTime);
        // SECURITY AUDIT: Log failed password attempt
        await this.logSecurityEvent(
          'LOGIN_FAILED_INVALID_PASSWORD',
          {
            userId: user.id,
            email: user.email,
            tenantId: user.tenantId,
            ipAddress,
            userAgent,
            success: false,
            reason: `Invalid password (attempt ${updatedAttempts})`,
          },
          AuditLogSeverity.WARNING,
        );
        throw new UnauthorizedException(INVALID_CREDENTIALS_MSG);
      }

      const proof = snapshotCredentialProof(user);
      const migratedPassword = shouldMigratePasswordHash ? await hashPassword(input.password) : undefined;
      const completeLogin = (): Promise<AuthPayload> => withLockedCredentialPrincipal(
        this.dataSource, proof, async (context) => {
          context.assertSessionAdmission();
          const manager = context.manager;
          await manager.update(User, { id: user.id }, {
            failedLoginAttempts: 0, lockedUntil: null, lastLoginIp: ipAddress ?? null,
            ...(migratedPassword ? { password: migratedPassword } : {}),
          });
          const principal = await context.reloadUser();
          if (principal.mfaEnabled) {
            if (!this.mfaService.isMfaAvailable()) {
              throw new UnauthorizedException(GENERIC_AUTH_ERROR_MSG);
            }
            const challenge = this.mfaService.generateMfaChallenge(principal, input.rememberMe ?? false);
            await this.logSecurityEvent('LOGIN_MFA_REQUIRED', {
              userId: principal.id, tenantId: principal.tenantId, ipAddress, userAgent, success: true,
            }, AuditLogSeverity.INFO, manager);
            return { accessToken: '', refreshToken: '', user: principal, expiresIn: 0,
              tokenType: 'Bearer', redirectUrl: '', mfaRequired: true, mfaToken: challenge.mfaToken };
          }
          const enrollment = await this.resolveMfaEnrollmentGate(principal, context.tenant,
            { ipAddress, userAgent }, manager);
          if (enrollment) return enrollment;
          await manager.update(User, { id: principal.id }, { lastLoginAt: new Date() });
          const payload = await this.tokenService.generateTokensInContext(context, ipAddress, userAgent,
            { rememberMe: input.rememberMe ?? false });
          await this.logSecurityEvent('LOGIN_SUCCESS', {
            userId: principal.id, tenantId: principal.tenantId, ipAddress, userAgent, success: true,
          }, AuditLogSeverity.INFO, manager);
          return payload;
        });
      const result = user.tenantId
        ? await requestContextStorage.run({ ...getRequestContext(), tenantId: user.tenantId, userId: user.id }, completeLogin)
        : await this.bypassRls.withBypass('auth-service:super-admin-login-tokens', completeLogin);
      if (result.accessToken) {
        await this.bestEffort.publish(createBaseEvent('UserLoggedIn', tenantScopeOf(user.tenantId), {
          aggregateId: user.id, aggregateType: 'User', userId: user.id,
        }));
      }
      await this.ensureMinDuration(startTime);
      return result;
    } catch (error) {
      await this.ensureMinDuration(startTime);
      throw error;
    }
  }

  /**
   * Ensure minimum duration to prevent timing attacks
   */
  private async ensureMinDuration(startTime: number): Promise<void> {
    if (this.timingSafe) {
      await this.timingSafe.ensureMinDuration(startTime, this.minLoginDurationMs);
    } else {
      // Fallback implementation
      const elapsed = Date.now() - startTime;
      const remaining = this.minLoginDurationMs - elapsed;
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining));
      }
    }
  }

  /**
   * Accept invitation and set password
   *
   * SECURITY: All reads and the canBeAccepted() check are inside the transaction
   * with SELECT FOR UPDATE to prevent TOCTOU race conditions (two concurrent
   * requests both passing validation independently).
   */
  async acceptInvitation(
    token: string,
    password: string,
    firstName?: string,
    lastName?: string,
    ipAddress?: string,
  ): Promise<CredentialActionResult> {
    const passwordHash = await hashPassword(password);
    await this.bypassRls.withBypass('auth-service:invitation-acceptance', () =>
      this.dataSource.transaction(async (manager) => {
        const discoveredLink = await this.loadInvitationForSegment(manager, token, 'none');
        if (!discoveredLink.invitation) throw new BadRequestException('Invalid or expired invitation');
        const discovered = await manager.findOne(User, {
          where: { invitationToken: discoveredLink.invitation.token },
        });
        if (!discovered) throw new BadRequestException('Invalid or expired invitation');
        const context = await LockedAuthContext.lock(manager, discovered.id);
        // Lock the action and invitation only after Tenant → User. The second
        // resolution observes concurrent reset/resend/acceptance before mutation.
        const { actionToken, invitation } = await this.loadInvitationForSegment(manager, token, 'pessimistic_write');
        const user = context.user;
        if (!invitation || !invitation.canBeAccepted() || invitation.tenantId !== user.tenantId ||
            user.invitationToken !== invitation.token ||
            (actionToken && (!actionToken.isActive() || actionToken.userId !== user.id ||
              (actionToken.tenantId ?? null) !== (user.tenantId ?? null)))) {
          throw new BadRequestException('Invalid or expired invitation');
        }
        await manager.update(User, { id: user.id }, {
          password: passwordHash, invitationToken: null, invitationExpiresAt: null,
          isEmailVerified: true, ...(firstName ? { firstName } : {}), ...(lastName ? { lastName } : {}),
        });
        await manager.update(Invitation, { id: invitation.id }, {
          status: InvitationStatus.ACCEPTED, acceptedAt: new Date(), userId: user.id,
          acceptedFromIp: ipAddress ?? null,
        });
        if (actionToken) {
          await manager.update(ActionToken, { id: actionToken.id }, {
            status: ActionTokenStatus.CONSUMED, consumedAt: new Date(),
          });
        }
        const intent: UserTokenInvalidationIntent = {
          userId: user.id, tenantId: this.invalidationTenantForUser(user), invalidatedAt: new Date(),
          reason: 'password_reset', idempotencyKey: `invitation-accepted:${invitation.id}`,
        };
        await manager.update(RefreshToken, { userId: user.id }, {
          isRevoked: true, revokedAt: intent.invalidatedAt, revokedReason: 'Invitation accepted',
        });
        await this.durableUserTokenInvalidation.enqueue(manager, intent);
        await this.logSecurityEvent('INVITATION_ACCEPTED', {
          userId: user.id, tenantId: user.tenantId, ipAddress, success: true,
        }, AuditLogSeverity.INFO, manager);
        await this.outboxPublisher.enqueue<InvitationAcceptedEvent>({
          ...createBaseEvent<InvitationAcceptedEvent>('InvitationAccepted', tenantScopeOf(user.tenantId)),
          userId: user.id, invitationId: invitation.id,
        }, manager, { aggregateId: user.id, idempotencyKey: `invitation-accepted-event:${invitation.id}`,
          ...(user.tenantId ? {} : { routingScope: 'system' as const }) });
      }));
    return { success: true, loginRequired: true };
  }

  /**
   * Validate invitation token
   */
  async validateInvitation(token: string): Promise<{
    valid: boolean;
    email?: string;
    role?: Role;
    firstName?: string;
    lastName?: string;
    expired?: boolean;
  }> {
    return this.bypassRls.withBypass('auth-service:invitation-validation', () =>
      this.dataSource.transaction(async (manager) => {
        const { actionToken, invitation } = await this.loadInvitationForSegment(manager, token, 'none');
        if (actionToken && !actionToken.isActive()) {
          return { valid: false, expired: actionToken.expiresAt <= new Date() };
        }
        if (!invitation) return { valid: false };
        if (!invitation.canBeAccepted()) return { valid: false, expired: invitation.isExpired() };
        return { valid: true, email: invitation.email, role: invitation.role,
          firstName: invitation.firstName ?? undefined, lastName: invitation.lastName ?? undefined };
      }));
  }

  /** The canonical link resolver and invitation gate shared by preview and redemption. */
  private async loadInvitationForSegment(
    manager: EntityManager,
    segment: string,
    lock: ActionLinkLock,
  ): Promise<{ actionToken: ActionToken | null; invitation: Invitation | null }> {
    const resolution = await this.actionTokenResolver.resolve(segment, ActionTokenPurpose.INVITATION, manager, lock);
    if (resolution.kind === 'unresolvable') return { actionToken: null, invitation: null };
    const actionToken = resolution.kind === 'action-token' ? resolution.actionToken : null;
    if (actionToken && !actionToken.isActive()) return { actionToken, invitation: null };
    const tokenHash = resolution.kind === 'action-token' ? resolution.actionToken.tokenHash : resolution.tokenHash;
    const invitation = await manager.findOne(Invitation, { where: { token: tokenHash },
      ...(lock === 'pessimistic_write' ? { lock: { mode: 'pessimistic_write' as const } } : {}) });
    return { actionToken, invitation };
  }

  /**
   * Refresh access token using a valid refresh token.
   *
   * SECURITY:
   * - Supports hashed refresh tokens
   * - Uses atomic update to prevent race conditions
   * - Implements refresh token rotation
   */
  async refreshToken(token: string): Promise<AuthPayload> {
    // Recover the canonical SSoT token (`${userId}:${random}`) from its cookie
    // transport. New cookies are set with an identity encoder
    // (refresh-token-cookie.ts), but a cookie minted before that fix — or any
    // intermediate hop that re-applies URL-encoding — can deliver the ':' as
    // '%3A'. Decoding here is idempotent for an already-canonical token (no '%'
    // in a UUID:hex value) and is the correct inverse of cookie transport, so a
    // valid session is never rejected over an encoding mismatch.
    token = decodeRefreshTokenTransport(token);

    // ROOT CAUSE (logout on every refresh): the refresh token is a PRE-TENANT,
    // cross-tenant credential — the tenant is unknown until the token row is
    // found, so neither the lookup nor the rotation that follows can satisfy the
    // tenant-isolation RLS predicate on auth.refresh_tokens
    // (`"tenantId" = current_setting('app.current_tenant')::uuid`), because the
    // unauthenticated refresh request sets no app.current_tenant GUC. Under the
    // RLS-enforced auth_service DB role this makes the lookup return ZERO rows
    // for a perfectly valid token → "Authentication failed" → silent-refresh
    // logs the user out on every refresh. Run the rotation under an AUDIT-LOGGED
    // RLS bypass (the same primitive the SUPER_ADMIN platform-session path uses):
    // the bcrypt match on the caller-supplied token is the authorization, and
    // possession of the exact token is what proves identity here.
    // If tokens are hashed, we need to find by comparing hashes.
    if (this.hashRefreshTokens) {
      return this.bypassRls.withBypass('auth-service:refresh-token-rotation', () =>
        this.refreshTokenWithHash(token),
      );
    }

    // SECURITY: Use transaction with pessimistic locking to prevent double-spending
    // NOTE: FOR UPDATE cannot be used with LEFT JOIN in PostgreSQL, so we split
    // the token lock and user fetch into separate queries.
    return this.bypassRls.withBypass('auth-service:refresh-token-rotation', () =>
      this.dataSource.transaction(async (manager) => {
        // RefreshToken rotation runs before tenant context is
        // re-established — the bearer's tenant is derived from the token
        // row's userId after the row is resolved. Cross-tenant scan is
        // intrinsic to the refresh-token protocol.
        const tokenRepo = manager.withRepository(this.refreshTokenRepository);

        // The legacy plaintext transport has no user id. Resolve only the
        // serialization key first, without taking a token lock or trusting the
        // row as authorization state. The authoritative token read is repeated
        // under FOR UPDATE after the canonical User lock is held.
        const discoveredToken = await tokenRepo.findOne({
          select: { userId: true },
          where: { token },
        });
        if (!discoveredToken) {
          throw new UnauthorizedException(GENERIC_AUTH_ERROR_MSG);
        }
        const user = await this.lockCredentialPrincipal(manager, discoveredToken.userId);

        // SELECT FOR UPDATE after User FOR UPDATE: one global lock order for
        // rotation and every per-user credential revocation path.
        const refreshToken = await tokenRepo
          .createQueryBuilder('rt')
          .setLock('pessimistic_write')
          .where('rt.token = :token', { token })
          .andWhere('rt.isRevoked = :isRevoked', { isRevoked: false })
          .andWhere('rt.expiresAt > :now', { now: new Date() })
          .getOne();

        if (!refreshToken) {
          throw new UnauthorizedException(GENERIC_AUTH_ERROR_MSG);
        }
        if (refreshToken.userId !== user.id || !user.isActive) {
          throw new UnauthorizedException(GENERIC_AUTH_ERROR_MSG);
        }

        // RBAC-HIGH-007: a non-operational tenant must not rotate tokens.
        await this.assertTenantOperationalForRefresh(manager, user);

        // Revoke the token within the same transaction
        refreshToken.familyId = refreshToken.familyId ?? refreshToken.id;
        refreshToken.isRevoked = true;
        refreshToken.revokedAt = new Date();
        refreshToken.revokedReason = 'Token refreshed';
        await tokenRepo.save(refreshToken);

        // Preserve the rememberMe choice across rotation so a remembered session
        // stays persistent (the resolver re-issues a persistent vs session cookie).
        return this.tokenService.generateTokensInContext(
          this.contextFor(user),
          refreshToken.ipAddress ?? undefined,
          refreshToken.userAgent ?? undefined,
          {
            familyId: refreshToken.familyId,
            rememberMe: refreshToken.rememberMe,
            establishSession: false,
          },
        );
      }),
    );
  }

  private parseHashedRefreshToken(plainToken: string): ParsedHashedRefreshToken | null {
    const segments = plainToken.split(':');
    if (segments.length !== 2) {
      return null;
    }
    const [userId, secret] = segments;
    if (!userId || !secret || !UUID_V4_PATTERN.test(userId)) {
      return null;
    }
    if (LEGACY_REFRESH_SECRET_PATTERN.test(secret)) {
      return { userId, secret };
    }
    if (!VERSIONED_REFRESH_SECRET_PATTERN.test(secret)) {
      return null;
    }
    const tokenIdHex = secret.slice(0, 32);
    const tokenId = [
      tokenIdHex.slice(0, 8),
      tokenIdHex.slice(8, 12),
      tokenIdHex.slice(12, 16),
      tokenIdHex.slice(16, 20),
      tokenIdHex.slice(20),
    ].join('-');
    if (!UUID_V4_PATTERN.test(tokenId)) {
      return null;
    }
    return { userId, secret, tokenId };
  }

  private async refreshTokenWithHash(plainToken: string): Promise<AuthPayload> {
    const parsed = this.parseHashedRefreshToken(plainToken);
    if (!parsed) {
      throw new UnauthorizedException(GENERIC_AUTH_ERROR_MSG);
    }

    const result = await this.dataSource.transaction(async (manager) => {
      const user = await this.lockCredentialPrincipal(manager, parsed.userId);
      return parsed.tokenId
        ? this.rotateVersionedRefreshToken(manager, user, parsed)
        : this.rotateLegacyRefreshToken(manager, user, parsed);
    });

    if (result.payload) {
      return result.payload;
    }
    if (result.containment) {
      await this.applyReuseContainment(result.containment);
    }
    throw new UnauthorizedException(GENERIC_AUTH_ERROR_MSG);
  }

  private async rotateVersionedRefreshToken(
    manager: EntityManager,
    user: User,
    parsed: ParsedHashedRefreshToken & { tokenId?: string },
  ): Promise<RefreshTransactionResult> {
    if (!parsed.tokenId) {
      return {};
    }
    const tokenRepo = manager.withRepository(this.refreshTokenRepository);
    const token = await tokenRepo
      .createQueryBuilder('rt')
      .setLock('pessimistic_write')
      .where('rt.userId = :userId', { userId: parsed.userId })
      .andWhere('rt.tokenId = :tokenId', { tokenId: parsed.tokenId })
      .getOne();
    if (!token || !(await bcrypt.compare(parsed.secret, token.token))) {
      return {};
    }
    return this.rotateMatchedRefreshToken(manager, user, token);
  }

  private async rotateLegacyRefreshToken(
    manager: EntityManager,
    user: User,
    parsed: ParsedHashedRefreshToken,
  ): Promise<RefreshTransactionResult> {
    const tokenRepo = manager.withRepository(this.refreshTokenRepository);
    const now = new Date();
    const activeTokens = await tokenRepo
      .createQueryBuilder('rt')
      .setLock('pessimistic_write')
      .where('rt.userId = :userId', { userId: parsed.userId })
      .andWhere('rt.isRevoked = :isRevoked', { isRevoked: false })
      .andWhere('rt.expiresAt > :now', { now })
      .orderBy('rt.createdAt', 'DESC')
      .take(TOKEN_CONSTANTS.MAX_ACTIVE_REFRESH_TOKEN_CHECK)
      .getMany();
    const activeMatch = await this.findRefreshTokenHashMatch(activeTokens, parsed.secret);
    if (activeMatch) {
      return this.rotateMatchedRefreshToken(manager, user, activeMatch);
    }

    const revokedTokens = await tokenRepo
      .createQueryBuilder('rt')
      .setLock('pessimistic_write')
      .where('rt.userId = :userId', { userId: parsed.userId })
      .andWhere('rt.isRevoked = :isRevoked', { isRevoked: true })
      .orderBy('rt.revokedAt', 'DESC')
      .take(TOKEN_CONSTANTS.MAX_REVOKED_REFRESH_TOKEN_REUSE_CHECK)
      .getMany();
    const revokedMatch = await this.findRefreshTokenHashMatch(revokedTokens, parsed.secret);
    if (!revokedMatch) {
      return {};
    }
    return this.rotateMatchedRefreshToken(manager, user, revokedMatch);
  }

  private async findRefreshTokenHashMatch(
    tokens: RefreshToken[],
    secret: string,
  ): Promise<RefreshToken | null> {
    for (const token of tokens) {
      if (await bcrypt.compare(secret, token.token)) {
        return token;
      }
    }
    return null;
  }

  private async rotateMatchedRefreshToken(
    manager: EntityManager,
    user: User,
    token: RefreshToken,
  ): Promise<RefreshTransactionResult> {
    if (token.userId !== user.id) {
      return {};
    }
    if (token.isRevoked) {
      // Historical NULL-family lineages cannot be reconstructed; terminal rows never contain newer sessions.
      if (!token.familyId || !['Token refreshed', 'Token refreshed (grace)'].includes(token.revokedReason ?? '')) return {};
      if (token.expiresAt.getTime() <= Date.now()) {
        return {};
      }
      // SEC-MEDIUM-113 (№58): one grace re-mint for a JUST-rotated token
      // (reason 'Token refreshed', within the window). The re-mint flips the
      // reason to the grace marker, so a second presentation of the SAME row
      // falls through to containment below.
      const revokedAtMs = token.revokedAt?.getTime();
      const rotatedWithinGrace =
        token.revokedReason === 'Token refreshed' &&
        revokedAtMs !== undefined &&
        Date.now() - revokedAtMs <= REFRESH_ROTATION_GRACE_MS;
      if (rotatedWithinGrace) {
        const claimed = await manager.withRepository(this.refreshTokenRepository).update(
          { id: token.id, revokedReason: 'Token refreshed' },
          { revokedReason: 'Token refreshed (grace)' },
        );
        if (claimed.affected === 1) {
          this.logger.warn(
            JSON.stringify({
              event: 'refresh_token_grace_replay',
              tokenId: token.id,
              familyId: token.familyId ?? undefined,
            }),
          );
          if (!user.isActive) {
            throw new UnauthorizedException(GENERIC_AUTH_ERROR_MSG);
          }
          await this.assertTenantOperationalForRefresh(manager, user);
          const payload = await this.tokenService.generateTokensInContext(
            this.contextFor(user),
            token.ipAddress ?? undefined,
            token.userAgent ?? undefined,
            {
              familyId: token.familyId ?? undefined,
              rememberMe: token.rememberMe,
              establishSession: false,
            },
          );
          return { payload };
        }
      }
      const containment = await this.containRefreshTokenReuse(manager, token);
      return containment ? { containment } : {};
    }
    if (token.expiresAt.getTime() <= Date.now()) {
      return {};
    }

    if (!user.isActive) {
      throw new UnauthorizedException(GENERIC_AUTH_ERROR_MSG);
    }
    await this.assertTenantOperationalForRefresh(manager, user);

    token.familyId = token.familyId ?? token.id;
    token.isRevoked = true;
    token.revokedAt = new Date();
    token.revokedReason = 'Token refreshed';
    await manager.withRepository(this.refreshTokenRepository).save(token);
    const payload = await this.tokenService.generateTokensInContext(
      this.contextFor(user),
      token.ipAddress ?? undefined,
      token.userAgent ?? undefined,
      {
        familyId: token.familyId ?? undefined,
        rememberMe: token.rememberMe,
        establishSession: false,
      },
    );
    return { payload };
  }

  private async containRefreshTokenReuse(
    manager: EntityManager,
    suspectToken: RefreshToken,
  ): Promise<RefreshReuseContainment | null> {
    const tokenRepo = manager.withRepository(this.refreshTokenRepository);
    const invalidatedAt = new Date();
    const claim = await tokenRepo.update(
      { id: suspectToken.id, reuseContainedAt: IsNull() },
      { reuseContainedAt: invalidatedAt },
    );
    if (claim.affected !== 1) {
      return null;
    }

    await tokenRepo.update(
      suspectToken.familyId
        ? { userId: suspectToken.userId, familyId: suspectToken.familyId }
        : { userId: suspectToken.userId },
      {
        isRevoked: true,
        revokedAt: invalidatedAt,
        revokedReason: 'Refresh-token reuse detected',
      },
    );
    const intent: UserTokenInvalidationIntent = {
      userId: suspectToken.userId,
      tenantId: suspectToken.tenantId ?? null,
      invalidatedAt,
      reason: 'refresh_token_reuse',
      idempotencyKey: `refresh-token-reuse:${suspectToken.id}`,
    };
    await this.durableUserTokenInvalidation.enqueue(manager, intent);
    return { intent, suspectToken };
  }

  private async applyReuseContainment(containment: RefreshReuseContainment): Promise<void> {
    const { intent, suspectToken } = containment;
    await Promise.allSettled([
      this.durableUserTokenInvalidation.applyImmediately(intent),
      this.sessionManager?.revokeAllSessions(intent.userId) ?? Promise.resolve(),
      this.securityEventService?.publishSuspiciousActivity({
        ip: suspectToken.ipAddress ?? undefined,
        userId: intent.userId,
        userAgent: suspectToken.userAgent ?? undefined,
        description: 'refresh-token-reuse-detected',
        familyId: suspectToken.familyId ?? undefined,
        suspectTokenId: suspectToken.id,
        suspectTokenRevokedAt: suspectToken.revokedAt?.toISOString(),
        suspectTokenRevokedReason: suspectToken.revokedReason ?? undefined,
      }) ?? Promise.resolve(),
    ]);
    this.logger.warn(
      JSON.stringify({
        event: 'refresh_token_reuse_contained',
        familyScoped: suspectToken.familyId !== null && suspectToken.familyId !== undefined,
      }),
    );
  }

  /**
   * Logout user
   *
   * - Revokes all refresh tokens
   * - Blacklists current access token (if JTI provided)
   * - Revokes all sessions
   */
  async logout(origin: OriginatingAccessSession): Promise<boolean> {
    const { sub: userId, jti } = origin;
    const accessTokenExpiry = new Date(origin.exp * 1000);
    const intent = await withLockedAuthenticatedSession(this.dataSource, origin, async ({ manager, user }) => {
      await manager.withRepository(this.refreshTokenRepository).update(
        { userId },
        { isRevoked: true, revokedAt: new Date(), revokedReason: 'User logged out' },
      );
      if (accessTokenExpiry.getTime() <= Date.now()) {
        return null;
      }
      const accessIntent = {
        targetJti: jti,
        tenantId: this.invalidationTenantForUser(user),
        expiresAt: accessTokenExpiry,
        reason: 'user_logout' as const,
        idempotencyKey: `user-logout:${jti}`,
      };
      await this.durableAccessTokenInvalidation.enqueue(manager, accessIntent);
      return accessIntent;
    });

    const effects: PostCommitSecurityEffect[] = [];
    if (intent) {
      effects.push({
        type: 'access_token_invalidation',
        apply: () => this.durableAccessTokenInvalidation.applyImmediately(intent),
      });
    }
    const sessionManager = this.sessionManager;
    if (sessionManager) {
      effects.push({
        type: 'session_revocation',
        apply: () => sessionManager.revokeAllSessions(userId),
      });
    }
    await settlePostCommitSecurityEffects({
      logger: this.logger,
      operation: 'user_logout',
      effects,
    });

    this.logger.log(JSON.stringify({ event: 'user_logged_out' }));
    return true;
  }

  /**
   * Logout from all devices
   */
  async logoutAllDevices(userId: string): Promise<number> {
    const transactionResult = await this.dataSource.transaction(async (manager) => {
      const user = await this.lockCredentialPrincipal(manager, userId);
      const invalidatedAt = new Date();
      const activeCount = await manager.withRepository(this.refreshTokenRepository).count({ where: { userId, isRevoked: false } });
      await manager.withRepository(this.refreshTokenRepository).update(
        { userId },
        {
          isRevoked: true,
          revokedAt: invalidatedAt,
          revokedReason: 'Logged out from all devices',
        },
      );
      const userIntent: UserTokenInvalidationIntent = {
        userId,
        tenantId: this.invalidationTenantForUser(user),
        invalidatedAt,
        reason: 'logout_all_devices',
        idempotencyKey: `logout-all-devices:${userId}:${Math.floor(
          invalidatedAt.getTime() / 1000,
        )}`,
      };
      await this.durableUserTokenInvalidation.enqueue(manager, userIntent);
      return { affected: activeCount, intent: userIntent };
    });

    const effects: PostCommitSecurityEffect[] = [
      {
        type: 'user_token_invalidation',
        apply: () => this.durableUserTokenInvalidation.applyImmediately(transactionResult.intent),
      },
    ];
    const sessionManager = this.sessionManager;
    if (sessionManager) {
      effects.push({
        type: 'session_revocation',
        apply: () => sessionManager.revokeAllSessions(userId),
      });
    }
    await settlePostCommitSecurityEffects({
      logger: this.logger,
      operation: 'logout_all_devices',
      effects,
    });

    this.logger.log(JSON.stringify({ event: 'user_logged_out_all_devices' }));
    return transactionResult.affected;
  }

  /**
   * Validate access token
   *
   * SECURITY:
   * - Verifies JWT signature
   * - Checks token blacklist
   * - Validates token hasn't expired
   */
  async validateToken(token: string): Promise<{ valid: boolean; payload?: JwtPayload }> {
    try {
      // SECURITY: verify with the SAME options the guard uses (RS256 pinned,
      // issuer + audience enforced) — not a bare verifyAsync that would skip
      // algorithm/issuer/audience checks.
      const payload = await this.jwtService.verifyAsync<JwtPayload>(
        token,
        getJwtVerifyOptions(this.configService),
      );

      // SECURITY (SEC-MEDIUM-004): this is a bearer-token introspection
      // surface. Without a type check it returns valid:true (plus role +
      // tenantId) for a REFRESH or MFA-challenge token — an oracle that
      // treats a non-access token as a usable access token. Reject anything
      // whose type !== 'access', matching the JwtAuthGuard contract.
      const isProduction =
        this.configService.get<string>('NODE_ENV', 'development') === 'production';
      enforceAccessTokenType(payload, this.logger, isProduction);

      // Independent, mandatory revocation gates: a token without any identity
      // component is not introspectable and must fail closed before Redis.
      const issuedAt = payload.iat;
      if (
        typeof payload.jti !== 'string' ||
        payload.jti.trim().length === 0 ||
        typeof payload.sub !== 'string' ||
        payload.sub.trim().length === 0 ||
        typeof issuedAt !== 'number' ||
        !Number.isSafeInteger(issuedAt) ||
        issuedAt <= 0
      ) {
        return { valid: false };
      }

      const tokenIssuedAt = new Date(issuedAt * 1000);
      const [isBlacklisted, isUserTokenValid] = await Promise.all([
        this.tokenBlacklist.isBlacklisted(payload.jti),
        this.userTokenRevocation.isTokenValid(payload.sub, tokenIssuedAt),
      ]);
      if (isBlacklisted) {
        this.logger.debug(JSON.stringify({ event: 'token_validation_revoked_jti' }));
        return { valid: false };
      }
      if (!isUserTokenValid) {
        this.logger.debug(JSON.stringify({ event: 'token_validation_revoked_user' }));
        return { valid: false };
      }

      return { valid: true, payload };
    } catch (error) {
      this.logger.debug(
        JSON.stringify({
          event: 'token_validation_failed',
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
      return { valid: false };
    }
  }

  /**
   * Get current user with their accessible modules
   */
  async me(userId: string, effectiveTenantId?: string | null): Promise<MePayload> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      // SECURITY: Generic message to prevent information leakage
      throw new UnauthorizedException(GENERIC_AUTH_ERROR_MSG);
    }

    // The JWT tenant claim is the authoritative effective tenant for the session;
    // `me` reports it (not only the DB record) so the frontend always scopes its
    // queries to the token's tenant. For a regular user the token tenant equals
    // the DB tenant (no-op); a platform SUPER_ADMIN has a null token tenant.
    if (effectiveTenantId) {
      user.tenantId = effectiveTenantId;
    }

    // Get user's accessible modules
    const modules = await this.tokenService.getUserModules(user);

    // Determine redirect path based on role
    let redirectPath: string;
    switch (user.role) {
      case Role.SUPER_ADMIN:
        redirectPath = '/admin/dashboard';
        break;
      case Role.TENANT_ADMIN:
        redirectPath = '/tenant/dashboard';
        break;
      case Role.MODULE_MANAGER:
      case Role.MODULE_USER:
        // Redirect to first/primary module
        if (modules.length > 0 && modules[0]) {
          redirectPath = modules[0].defaultRoute;
        } else {
          redirectPath = '/no-access';
        }
        break;
      default:
        redirectPath = '/';
    }

    return {
      user,
      modules,
      redirectPath,
    };
  }

  async getUserById(userId: string): Promise<User | null> {
    return this.userRepository.findOne({
      where: { id: userId },
    });
  }

  /**
   * Handle failed login with atomic database increment to prevent race conditions.
   * Uses a single atomic SQL statement with RETURNING to avoid multiple round-trips (MED-01).
   * Returns the updated failedLoginAttempts count for accurate audit logging (M-04).
   */
  private async handleFailedLogin(user: User): Promise<number> {
    const lockoutUntil = new Date(Date.now() + this.lockoutDurationMinutes * 60 * 1000);

    // Single atomic query: increment + conditional lockout + return updated values (MED-01)
    //
    // ORPHAN-HIGH-318 — WHY updateReturningRows instead of a hand-written
    // type annotation: the postgres driver returns `[rows, affectedCount]`
    // for UPDATE statements, NOT the rows array. The previous
    // `Array<{...}>` annotation asserted the wrong shape, so `result[0]`
    // was the rows ARRAY: every audit event recorded "attempt 0" and the
    // CRITICAL ACCOUNT_LOCKED emission below never fired in production
    // (0 >= maxFailedAttempts is always false). The helper runtime-asserts
    // the tuple shape before any field access.
    const raw: unknown = await this.dataSource.query(
      // SEC-LOW-001(c) — WHY $3::timestamptz (not ::timestamp): users.lockedUntil
      // is a TIMESTAMP WITH TIME ZONE column and $3 is bound to a JS Date (an
      // absolute instant). Casting to ::timestamp (without tz) drops the offset
      // and reinterprets the lockout deadline under the DB session TimeZone,
      // drifting the lockout window on any non-UTC session. ::timestamptz
      // round-trips the instant losslessly.
      `UPDATE auth.users
       SET "failedLoginAttempts" = "failedLoginAttempts" + 1,
           "lockedUntil" = CASE
             WHEN "failedLoginAttempts" + 1 >= $2 THEN $3::timestamptz
             ELSE "lockedUntil"
           END
       WHERE id = $1
       RETURNING "failedLoginAttempts", "lockedUntil"`,
      [user.id, this.maxFailedAttempts, lockoutUntil],
    );
    // lockedUntil arrives as Date (pg parses timestamptz) — typed as
    // Date | string | null defensively is WRONG per repo rules; the pg
    // driver contract is Date | null for timestamptz. `!= null` (not
    // `!== null`) also rejects undefined, which would indicate a
    // RETURNING-clause drift rather than an unlocked account.
    const result = updateReturningRows<{
      failedLoginAttempts: number;
      lockedUntil: Date | null;
    }>(raw);

    const updatedAttempts = result[0]?.failedLoginAttempts ?? 0;
    const isNowLocked = result[0]?.lockedUntil != null && updatedAttempts >= this.maxFailedAttempts;

    if (isNowLocked) {
      // SECURITY: Log user ID instead of email to prevent PII exposure (H-14)
      this.logger.warn(`Account locked for userId=${user.id} until ${lockoutUntil.toISOString()}`);
      // SECURITY AUDIT: Log account lockout (critical security event)
      await this.logSecurityEvent(
        'ACCOUNT_LOCKED',
        {
          userId: user.id,
          email: user.email,
          tenantId: user.tenantId,
          success: false,
          reason: `Account locked after ${this.maxFailedAttempts} failed attempts. Locked until ${lockoutUntil.toISOString()}`,
        },
        AuditLogSeverity.CRITICAL,
      );

      // ORPHAN-MEDIUM-320: owner-facing lockout channel. The wire response
      // stays the generic anti-enumeration message, so this event is the
      // only signal the LEGITIMATE owner ever gets — notification-service
      // consumes it and emails "account locked, unlocks at T; wasn't you?
      // reset your password". Audit-log-backed (the CRITICAL row above is
      // the durable SoT) → best-effort path. Platform-level users
      // (tenantId NULL) route to events.system; the notification consumer
      // only mails tenant-scoped users — operator visibility for platform
      // accounts comes from the CRITICAL audit event.
      const lockEvent: UserAccountLockedEvent = {
        ...createBaseEvent<UserAccountLockedEvent>('UserAccountLocked', tenantScopeOf(user.tenantId), {
          aggregateId: user.id,
          aggregateType: 'User',
          userId: user.id,
        }),
        userId: user.id,
        failedAttempts: updatedAttempts,
        lockedUntil: lockoutUntil.toISOString(),
      };
      await this.bestEffort.publish(lockEvent);
    }

    return updatedAttempts;
  }

  /**
   * Initiate password reset flow.
   *
   * SECURITY:
   * - Always completes in minimum duration to prevent timing-based user enumeration
   * - Stores SHA-256 hash of token (not plaintext) in the database
   * - Token expires after 1 hour
   * - If user not found, performs dummy hash to match timing and returns silently
   * - Commits PasswordResetRequestedEvent with the credential through the durable outbox
   */
  async initiatePasswordReset(email: string, ipAddress?: string): Promise<void> {
    const startTime = Date.now();
    this.logger.debug('Password reset requested');

    try {
      const user = await this.userRepository.findOne({
        where: { email: email.toLowerCase() },
      });

      if (!user) {
        // SECURITY: Perform dummy hash to match timing of real token generation
        crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex');
        await this.ensureMinDuration(startTime);
        return;
      }

      // Check if account is active
      if (!user.isActive) {
        await this.ensureMinDuration(startTime);
        return;
      }

      // Generate cryptographically secure reset token (256 bits of entropy)
      const resetToken = crypto.randomBytes(32).toString('hex');

      // SECURITY: Store SHA-256 hash of token, not the plaintext
      const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

      // The reset credential and its only delivery signal commit together.
      // Platform scope is derived from the locked principal, never caller input.
      await this.bypassRls.withBypass('auth-service:password-reset-request', () =>
        withLockedCredentialPrincipal(this.dataSource, user.id, async (context) => {
          const { manager, user: principal } = context;
          if (!principal.isActive) throw new BadRequestException('Account is unavailable');
          await manager.update(User, { id: principal.id }, {
            passwordResetToken: resetTokenHash, passwordResetExpires: expiresAt,
          });
          await manager.update(ActionToken, {
            userId: principal.id, purpose: ActionTokenPurpose.PASSWORD_RESET, status: ActionTokenStatus.ACTIVE,
          }, { status: ActionTokenStatus.REVOKED, revokedAt: new Date() });
          const actionToken = await manager.save(ActionToken, manager.create(ActionToken, {
            purpose: ActionTokenPurpose.PASSWORD_RESET, tenantId: principal.tenantId ?? null,
            userId: principal.id, tokenHash: resetTokenHash, status: ActionTokenStatus.ACTIVE, expiresAt,
            auditMetadata: { source: 'password-reset-request', ipAddress },
          }));
          const scope = tenantScopeOf(principal.tenantId);
          const event: PasswordResetRequestedEvent = {
            ...createBaseEvent<PasswordResetRequestedEvent>('PasswordResetRequested', scope, {
              aggregateId: principal.id, aggregateType: 'User', userId: principal.id, version: 2,
            }),
            userId: principal.id, actionTokenId: actionToken.id, cryptoShredKeyId: principal.id,
          };
          await this.outboxPublisher.enqueue(event, manager, {
            aggregateId: principal.id, idempotencyKey: `password-reset-requested:${actionToken.id}`,
            ...(scope.kind === 'platform' ? { routingScope: 'system' as const } : {}),
          });
          await this.logSecurityEvent('PASSWORD_RESET_REQUESTED', {
            userId: principal.id, tenantId: principal.tenantId, ipAddress, success: true,
          }, AuditLogSeverity.INFO, manager);
        }));

      await this.ensureMinDuration(startTime);
    } catch (error) {
      await this.ensureMinDuration(startTime);
      // SECURITY: Swallow errors to prevent information leakage
      // Log internally but don't propagate to caller
      this.logger.error('Error during password reset initiation', (error as Error).stack);
    }
  }

  /**
   * Reset password using a valid reset token.
   *
   * SECURITY:
   * - Token is hashed with SHA-256 before database lookup
   * - Validates token expiry (1 hour window)
   * - Token is single-use (cleared after successful reset)
   * - All refresh tokens are revoked (forces re-authentication on all devices)
   * - Returns success/loginRequired; session admission is a subsequent login
   * - Password validation: min 8, uppercase, lowercase, digit, special char
   */
  async resetPassword(
    token: string,
    newPassword: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<CredentialActionResult> {
    const passwordHash = await hashPassword(newPassword);
    await this.bypassRls.withBypass('auth-service:password-reset', () =>
      this.dataSource.transaction(async (manager) => {
        const reference = await this.actionTokenResolver.resolve(token, ActionTokenPurpose.PASSWORD_RESET, manager, 'none');
        if (reference.kind === 'unresolvable' || (reference.kind === 'action-token' && !reference.actionToken.isActive())) {
          throw new BadRequestException('Invalid or expired password reset token');
        }
        const tokenHash = reference.kind === 'action-token' ? reference.actionToken.tokenHash : reference.tokenHash;
        const discovered = await manager.findOne(User, { where: { passwordResetToken: tokenHash } });
        if (!discovered) throw new BadRequestException('Invalid or expired password reset token');
        const context = await LockedAuthContext.lock(manager, discovered.id);
        const resolved = await this.actionTokenResolver.resolve(token, ActionTokenPurpose.PASSWORD_RESET, manager, 'pessimistic_write');
        if (resolved.kind === 'unresolvable') throw new BadRequestException('Invalid or expired password reset token');
        const actionToken = resolved.kind === 'action-token' ? resolved.actionToken : null;
        const resolvedHash = resolved.kind === 'action-token' ? resolved.actionToken.tokenHash : resolved.tokenHash;
        const user = context.user;
        if (!user.isActive || !user.passwordResetToken || !user.passwordResetExpires ||
            user.passwordResetExpires.getTime() <= Date.now() || user.passwordResetToken !== resolvedHash ||
            (actionToken && (!actionToken.isActive() || actionToken.userId !== user.id ||
              (actionToken.tenantId ?? null) !== (user.tenantId ?? null)))) {
          throw new BadRequestException('Invalid or expired password reset token');
        }
        await manager.update(User, { id: user.id }, {
          password: passwordHash, passwordResetToken: null, passwordResetExpires: null,
          failedLoginAttempts: 0, lockedUntil: null,
        });
        if (actionToken) {
          await manager.update(ActionToken, { id: actionToken.id }, {
            status: ActionTokenStatus.CONSUMED, consumedAt: new Date(),
          });
        }
        await manager.delete(WebAuthnCredential, { userId: user.id });
        const invalidation: UserTokenInvalidationIntent = {
          userId: user.id, tenantId: this.invalidationTenantForUser(user), invalidatedAt: new Date(),
          reason: 'password_reset',
          idempotencyKey: `password-reset:${actionToken?.id ?? user.passwordResetToken}`,
        };
        await manager.update(RefreshToken, { userId: user.id }, {
          isRevoked: true, revokedAt: invalidation.invalidatedAt, revokedReason: 'Password reset',
        });
        await this.durableUserTokenInvalidation.enqueue(manager, invalidation);
        await this.logSecurityEvent('PASSWORD_RESET_SUCCESS', {
          userId: user.id, tenantId: user.tenantId, ipAddress, userAgent, success: true,
        }, AuditLogSeverity.INFO, manager);
        await this.outboxPublisher.enqueue<PasswordResetCompletedEvent>({
          ...createBaseEvent<PasswordResetCompletedEvent>('PasswordResetCompleted', tenantScopeOf(user.tenantId)),
          userId: user.id,
        }, manager, { aggregateId: user.id, idempotencyKey: `password-reset-event:${actionToken?.id ?? user.passwordResetToken}`,
          ...(user.tenantId ? {} : { routingScope: 'system' as const }) });
      }));
    return { success: true, loginRequired: true };
  }

  // ==========================================================================
  // ADR-046 — tenant MFA enforcement (ADMIN-HIGH-014)
  // ==========================================================================

  /**
   * Load the user's tenant row for the MFA-enrollment gate on the
   * password-backed token-minting paths (login).
   * `auth.tenants` is cross-tenant by design (D14) and readable without a
   * tenant context — the same direct read login performs for its tenant-status
   * gate. Platform users (tenantId NULL) have no tenant.
   */


  /**
   * ADR-046: a user SATISFIES tenant MFA enforcement when they have TOTP MFA
   * enrolled (`mfaEnabled`) OR at least one registered WebAuthn credential.
   * WebAuthn is a first-class second factor, so a passkey / security-key user
   * must NOT be forced onto TOTP as well — and, symmetrically, a WebAuthn-only
   * user does not bypass the gate. The credential read only runs for non-TOTP
   * users (short-circuit) and only the gate calls it, so a tenant that does not
   * enforce MFA never pays for it.
   */
  private async userSatisfiesMfaEnforcement(user: User, manager: EntityManager): Promise<boolean> {
    if (user.mfaEnabled) {
      return true;
    }
    const credentialCount = await manager.withRepository(this.webAuthnCredentialRepository).count({
      where: { userId: user.id },
    });
    return credentialCount > 0;
  }

  /**
   * ADR-046 MFA-ENFORCEMENT GATE (ADMIN-HIGH-014) — the single shared
   * assertion every password-backed token-minting caller funnels through
   * (login). Returns:
   *
   *   - `null` → the caller MAY mint a full session: the tenant does not
   *     enforce MFA, or the user already satisfies enforcement (TOTP OR a
   *     WebAuthn credential).
   *   - an `AuthPayload` carrying `mfaSetupRequired` + a 10-minute `mfa_setup`
   *     token (no access/refresh) → the tenant enforces MFA, the user has
   *     NEITHER factor, and MFA is available: a completable enrollment path,
   *     not a lockout.
   *
   * THROWS (fail-closed) when the tenant enforces MFA, the user is unenrolled
   * AND the MFA service is unavailable: enrollment is impossible, so a full
   * session must NEVER be issued, and a CRITICAL security-audit event records
   * it. Enforcement therefore never depends on a boot-time env heuristic.
   *
   * WHY the assertion lives here and NOT inside the generateTokens clamp
   * chokepoint: producing the graceful `mfaSetupRequired` outcome requires
   * minting an `mfa_setup` token via MfaService, and TokenService cannot
   * depend on MfaService without reintroducing the exact
   * TokenService ↔ MfaService cycle TokenService was extracted to break. So
   * enforcement is one shared, greppable helper rather than an in-chokepoint
   * throw. The session-TTL clamp — which needs no MfaService — DOES live in
   * the chokepoint.
   */
  private async resolveMfaEnrollmentGate(
    user: User,
    tenant: Tenant | null,
    audit: { ipAddress?: string; userAgent?: string },
    manager: EntityManager,
  ): Promise<AuthPayload | null> {
    if (!tenant || tenant.enforceMfa !== true) {
      return null;
    }
    if (await this.userSatisfiesMfaEnforcement(user, manager)) {
      return null;
    }

    if (!this.mfaService?.isMfaAvailable()) {
      // Fail closed: no MFA key → the user CANNOT enroll, so a full session
      // must not be issued. Deny + CRITICAL audit — mirrors the
      // enrolled-but-unavailable branch in login().
      await this.logSecurityEvent(
        'LOGIN_BLOCKED_MFA_UNAVAILABLE',
        {
          userId: user.id,
          email: user.email,
          tenantId: user.tenantId,
          ipAddress: audit.ipAddress,
          userAgent: audit.userAgent,
          success: false,
          reason:
            'Tenant enforces MFA, user has no factor enrolled, and the MFA service is unavailable',
        },
        AuditLogSeverity.CRITICAL,
      );
      throw new UnauthorizedException(GENERIC_AUTH_ERROR_MSG);
    }

    const mfaSetupToken = this.mfaService.generateMfaSetupToken(user);

    await this.logSecurityEvent('LOGIN_MFA_SETUP_REQUIRED', {
      userId: user.id,
      email: user.email,
      tenantId: user.tenantId,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
      success: true,
      reason: 'Password valid; tenant enforces MFA and the user has no factor enrolled',
    }, AuditLogSeverity.INFO, manager);

    return {
      accessToken: '',
      refreshToken: '',
      user,
      expiresIn: 0,
      tokenType: 'Bearer',
      redirectUrl: '',
      mfaSetupRequired: true,
      mfaSetupToken,
    };
  }
}
