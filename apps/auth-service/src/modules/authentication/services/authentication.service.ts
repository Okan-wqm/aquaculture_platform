import * as crypto from 'crypto';

import { hashPassword, verifyPassword, enforceAccessTokenType, getJwtVerifyOptions } from '@aquaculture/backend-common/auth';
import { BypassRlsService, updateReturningRows } from '@aquaculture/backend-common/database';
import { Role } from '@aquaculture/backend-common/decorators';
import { requestContextStorage, getRequestContext } from '@aquaculture/backend-common/logging';
import { TimingSafeService, ISessionManager, ITokenBlacklist, SESSION_MANAGER, TOKEN_BLACKLIST, SecurityEventService } from '@aquaculture/backend-common/security';
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
import { createBaseEvent, isLoginAllowed } from '@platform/event-contracts';
import type { UserAccountLockedEvent } from '@platform/event-contracts';
import * as bcrypt from 'bcryptjs';
import { DataSource, EntityManager, EntityTarget, ObjectLiteral, Repository } from 'typeorm';

import { AuditLogSeverity } from '../../../audit/audit-log.entity';
import { AuditLogService } from '../../../audit/audit-log.service';
import { SECURITY_CONSTANTS, TOKEN_CONSTANTS } from '../../../constants/auth.constants';
import { BestEffortEventPublisher } from '../../../outbox/best-effort-event-publisher';
import { Tenant } from '../../tenant/entities/tenant.entity';
import { AuthPayload, MePayload } from '../dto/auth-response.dto';
import { LoginInput } from '../dto/login.dto';
import { ActionToken, ActionTokenPurpose, ActionTokenStatus } from '../entities/action-token.entity';
import { Invitation, InvitationStatus } from '../entities/invitation.entity';
import { RefreshToken } from '../entities/refresh-token.entity';
import { User } from '../entities/user.entity';

import { MfaService } from './mfa.service';
import { TokenService, parseExpiresIn } from './token.service';
import type { JwtPayload } from './token.service';

// Re-export JwtPayload from its canonical location for backward compatibility
export type { JwtPayload } from './token.service';

/**
 * Generic authentication error message
 * SECURITY: Using generic message prevents user enumeration attacks
 */
const INVALID_CREDENTIALS_MSG = 'Invalid email or password';
const GENERIC_AUTH_ERROR_MSG = 'Authentication failed';

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
    private readonly dataSource: DataSource,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    // DATA-HIGH-001: every event auth-service login/invitation/password-reset
    // publishes is telemetry or audit-log-backed and can originate from a
    // platform-level SUPER_ADMIN (tenantId NULL), so they route through the
    // allowlisted best-effort path rather than the raw event bus.
    private readonly bestEffort: BestEffortEventPublisher,
    private readonly auditLogService: AuditLogService,
    private readonly tokenService: TokenService,
    private readonly mfaService: MfaService,
    /**
     * SECURITY (DEPLOY-CRITICAL-007): audit-logged RLS bypass primitive for
     * the SUPER_ADMIN login path. Platform-level users (tenantId=NULL)
     * cannot satisfy `tenant_isolation_policy` on auth.refresh_tokens —
     * see login() for the tenant-vs-platform branching and the full
     * architectural rationale.
     */
    private readonly bypassRls: BypassRlsService,
    @Optional() private readonly timingSafe?: TimingSafeService,
    @Optional() @Inject(SESSION_MANAGER) private readonly sessionManager?: ISessionManager,
    @Optional() @Inject(TOKEN_BLACKLIST) private readonly tokenBlacklist?: ITokenBlacklist,
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
    this.hashRefreshTokens = this.configService.get<boolean>('HASH_REFRESH_TOKENS', true);
    this.minLoginDurationMs = this.configService.get<number>(
      'MIN_LOGIN_DURATION_MS',
      SECURITY_CONSTANTS.MIN_LOGIN_DURATION_MS,
    );
  }

  private preTenantAuthRepository<T extends ObjectLiteral>(
    manager: EntityManager,
    entity: EntityTarget<T>,
  ): Repository<T> {
    const getRepository = manager.getRepository.bind(manager);
    return getRepository(entity);
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
      });
    } catch (error) {
      // Don't fail the main operation if audit logging fails
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
      user.password = await hashPassword(password);
      await this.userRepository.save(user);
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
        await this.logSecurityEvent('LOGIN_FAILED', {
          email: input.email,
          ipAddress,
          userAgent,
          success: false,
          reason: 'User not found',
        }, AuditLogSeverity.WARNING);
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
        await this.logSecurityEvent('LOGIN_BLOCKED_ACCOUNT_LOCKED', {
          userId: user.id,
          email: user.email,
          tenantId: user.tenantId,
          ipAddress,
          userAgent,
          success: false,
          reason: 'Account locked due to failed attempts',
        }, AuditLogSeverity.WARNING);
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
      // The row is hoisted (not scoped to this block) because it also drives
      // the ADR-042 enforcement points below: the MFA-enforcement login gate
      // and the session-timeout clamp threaded into token issuance.
      let tenant: Tenant | null = null;
      if (user.tenantId) {
        tenant = await this.tenantRepository.findOne({ where: { id: user.tenantId } });
        if (tenant && !isLoginAllowed(tenant.status)) {
          await this.ensureMinDuration(startTime);
          this.logger.debug(`Login failed: tenant ${user.tenantId} is ${tenant.status}`);
          await this.logSecurityEvent('LOGIN_BLOCKED_TENANT_INACTIVE', {
            userId: user.id,
            email: user.email,
            tenantId: user.tenantId,
            ipAddress,
            userAgent,
            success: false,
            reason: `Tenant account status is ${tenant.status}`,
          }, AuditLogSeverity.WARNING);
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
        await this.logSecurityEvent('LOGIN_FAILED_INVALID_PASSWORD', {
          userId: user.id,
          email: user.email,
          tenantId: user.tenantId,
          ipAddress,
          userAgent,
          success: false,
          reason: `Invalid password (attempt ${updatedAttempts})`,
        }, AuditLogSeverity.WARNING);
        throw new UnauthorizedException(INVALID_CREDENTIALS_MSG);
      }

      // Reset failed login attempts on successful password validation
      user.failedLoginAttempts = 0;
      user.lockedUntil = null;
      user.lastLoginIp = ipAddress ?? null;

      // ----------------------------------------------------------------
      // MFA Check: If user has MFA enabled, return MFA challenge
      // instead of full tokens. The user must complete MFA verification
      // via the verifyMfaLogin mutation to receive full auth tokens.
      // ----------------------------------------------------------------
      if (user.mfaEnabled && !this.mfaService?.isMfaAvailable()) {
        await this.ensureMinDuration(startTime);
        this.logger.error(`Login blocked: MFA enabled but unavailable for userId=${user.id}`);
        await this.logSecurityEvent('LOGIN_BLOCKED_MFA_UNAVAILABLE', {
          userId: user.id,
          tenantId: user.tenantId,
          ipAddress,
          userAgent,
          success: false,
          reason: 'MFA enabled but MFA_ENCRYPTION_KEY is unavailable',
        }, AuditLogSeverity.CRITICAL);
        throw new UnauthorizedException(GENERIC_AUTH_ERROR_MSG);
      }

      if (user.mfaEnabled && this.mfaService?.isMfaAvailable()) {
        // Save login attempt state but DON'T set lastLoginAt yet
        // (it will be set after MFA verification succeeds)
        await this.userRepository.save(user);

        // Carry the rememberMe choice into the signed mfaToken so it survives the
        // challenge → verify round-trip (the client does not re-send it).
        const mfaChallenge = this.mfaService.generateMfaChallenge(user, input.rememberMe ?? false);

        await this.logSecurityEvent('LOGIN_MFA_REQUIRED', {
          userId: user.id,
          email: user.email,
          tenantId: user.tenantId,
          ipAddress,
          userAgent,
          success: true,
          reason: 'Password valid, MFA verification required',
        });

        await this.ensureMinDuration(startTime);

        // Return a partial AuthPayload with MFA challenge info
        return {
          accessToken: '',
          refreshToken: '',
          user,
          expiresIn: 0,
          tokenType: 'Bearer',
          redirectUrl: '',
          mfaRequired: true,
          mfaToken: mfaChallenge.mfaToken,
        };
      }

      // ----------------------------------------------------------------
      // ADR-042 MFA-ENFORCEMENT GATE: the tenant requires MFA but this
      // user has none enrolled. Fail closed on token issuance — NO
      // access/refresh tokens — but hand back a completable enrollment
      // path instead of a lockout: a short-lived (10 min) 'mfa_setup'
      // token that authorizes ONLY setupMfa + verifyMfaSetup. After
      // verifyMfaSetup succeeds the user logs in again and walks the
      // normal MFA challenge flow.
      //
      // The gate runs only when the MFA service is available: in
      // production-like environments MFA availability is guaranteed at
      // boot (MfaService fails fast without MFA_ENCRYPTION_KEY), so the
      // no-key fallthrough below is reachable only in local/dev where
      // enforcement without an enrollment path would be a hard lockout.
      // ----------------------------------------------------------------
      if (
        !user.mfaEnabled &&
        tenant &&
        tenant.enforceMfa === true &&
        this.mfaService.isMfaAvailable()
      ) {
        // Persist the reset failed-attempt counters, but NOT lastLoginAt —
        // like the MFA challenge branch, this is not yet a completed login.
        await this.userRepository.save(user);

        const mfaSetupToken = this.mfaService.generateMfaSetupToken(user);

        await this.logSecurityEvent('LOGIN_MFA_SETUP_REQUIRED', {
          userId: user.id,
          email: user.email,
          tenantId: user.tenantId,
          ipAddress,
          userAgent,
          success: true,
          reason: 'Password valid; tenant enforces MFA and user has none enrolled',
        });

        await this.ensureMinDuration(startTime);

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

      // No MFA — proceed with full login.
      //
      // SECURITY (HIGH-006): lazy password-hash migration.
      // If the stored hash was a legacy (unpeppered) bcrypt AND a pepper is
      // now configured, re-hash the plaintext with the peppered format and
      // persist. The @BeforeUpdate hook is skipped here because the entity
      // already has a hashed password; instead we set the plaintext back
      // onto the field before save() so the BeforeUpdate hook catches it.
      if (shouldMigratePasswordHash) {
        user.password = input.password;
        this.logger.debug(`Migrating legacy password hash to peppered format: userId=${user.id}`);
      }
      user.lastLoginAt = new Date();
      await this.userRepository.save(user);

      // SECURITY: Log user ID instead of email to prevent PII exposure in logs (H-14)
      this.logger.log(`User logged in: userId=${user.id} (role: ${user.role})`);

      // PERF: Parallelize audit log + event publish — both are independent
      // fire-and-monitor operations (HIGH-08)
      await Promise.allSettled([
        this.logSecurityEvent('LOGIN_SUCCESS', {
          userId: user.id,
          email: user.email,
          tenantId: user.tenantId,
          ipAddress,
          userAgent,
          success: true,
        }),
        this.bestEffort.publish(
          createBaseEvent('UserLoggedIn', user.tenantId ?? 'system', { aggregateId: user.id, aggregateType: 'User', userId: user.id }),
        ),
      ]);

      await this.ensureMinDuration(startTime);

      // ────────────────────────────────────────────────────────────────────
      // SECURITY (DEPLOY-CRITICAL-007): Establish post-authentication RLS
      // context for token + session writes.
      // ────────────────────────────────────────────────────────────────────
      //
      // Login is a TWO-PHASE operation:
      //
      //   Phase 1 (PRE-AUTH) — identify the user by email. Cross-tenant by
      //     design; the tenant is DETERMINED by the user row. Uses auth.users
      //     which is intentionally NOT RLS-gated (identity primitive — see
      //     DEPLOY-CRITICAL-006 + DEFAULT_IDENTITY_TABLES in
      //     apply-tenant-rls.helper.ts).
      //
      //   Phase 2 (POST-DISCOVERY) — write refresh_tokens and session rows
      //     SCOPED to the just-identified user's tenant. These tables ARE
      //     RLS-gated (auth.refresh_tokens carries tenant_isolation_policy),
      //     so the pool connection MUST have `app.current_tenant` set to the
      //     user's tenantId before the INSERT, OR the write fails with
      //     "new row violates row-level security policy" (the 2026-04-21
      //     login incident manifestation).
      //
      // The TenantContextMiddleware only sets `tenantId` when an
      // x-tenant-id header is present OR a JWT is already minted — neither
      // is true on the login endpoint. Hence we must establish the context
      // HERE, once we know the user's tenant.
      //
      // # Two paths, both architectural (neither is a bypass-the-problem hack)
      //
      //   A) Tenant user (user.tenantId IS NOT NULL) — nest an
      //      AsyncLocalStorage frame with the discovered tenantId. The
      //      RlsConnectionBootstrap pool patch reads this on the next
      //      connection checkout and emits SET app.current_tenant = <uuid>;
      //      the INSERT into refresh_tokens succeeds under the normal policy
      //      predicate. NO bypass — the write is strictly tenant-scoped, as
      //      intended by the RLS design.
      //
      //   B) SUPER_ADMIN (user.tenantId IS NULL) — platform-level session.
      //      The row has tenantId=NULL and cannot satisfy
      //      `"tenantId" = <uuid>` regardless of context. Use the
      //      AUDIT-LOGGED BypassRlsService.withBypass() so the bypass is
      //      visible in deploy-audit log grep ("RLS BYPASS GRANTED
      //      [auth-service:super-admin-login-tokens]"). Same primitive used
      //      by admin-api-service for cross-tenant analytics. SUPER_ADMIN
      //      login frequency is low, so the WARN log volume is negligible.
      //
      // # Why not mutate the existing RequestContext frame?
      //
      // BypassRlsService's docblock explicitly warns against mutating the
      // existing frame: other async work in flight may still be reading it.
      // `requestContextStorage.run(next, fn)` creates a strictly scoped
      // nested frame that AsyncLocalStorage unwinds automatically on
      // callback return (success or throw). No manual cleanup, no leakage
      // between concurrent requests.
      if (user.tenantId) {
        const scopedContext = {
          ...getRequestContext(),
          tenantId: user.tenantId,
          userId: user.id,
        };
        // ADR-042: the tenant idle-session policy rides along explicitly —
        // TokenService clamps the refresh TTL to MIN(configured, policy).
        const sessionTimeoutMinutes = tenant ? tenant.sessionTimeoutMinutes ?? null : null;
        return await requestContextStorage.run(scopedContext, () =>
          this.tokenService.generateTokens(user, ipAddress, userAgent, {
            rememberMe: input.rememberMe ?? false,
            sessionTimeoutMinutes,
          }),
        );
      }
      // SUPER_ADMIN: audited bypass for platform-level session creation.
      // No tenant → no tenant session-timeout policy (ADR-042).
      return await this.bypassRls.withBypass(
        'auth-service:super-admin-login-tokens',
        () =>
          this.tokenService.generateTokens(user, ipAddress, userAgent, {
            rememberMe: input.rememberMe ?? false,
            sessionTimeoutMinutes: null,
          }),
      );
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
        await new Promise(resolve => setTimeout(resolve, remaining));
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
  ): Promise<AuthPayload> {
    // SECURITY: Hash token with SHA-256 for lookup against hashed tokens (SEC-005)
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // Execute all reads + validation + writes inside a single transaction
    const result = await this.dataSource.transaction(async (manager) => {
      const actionToken = await this.preTenantAuthRepository(manager, ActionToken)
        .createQueryBuilder('actionToken')
        .setLock('pessimistic_write')
        .where('actionToken.id = :token', { token })
        .andWhere('actionToken.purpose = :purpose', { purpose: ActionTokenPurpose.INVITATION })
        .getOne();

      if (actionToken && !actionToken.isActive()) {
        throw new BadRequestException('Invalid invitation token');
      }

      const lookupTokenHash = actionToken?.tokenHash ?? tokenHash;

      // SECURITY: Lock the invitation row to prevent concurrent acceptance
      // Try hashed token first, then fall back to plaintext for backward compatibility
      // Invitation redemption runs BEFORE tenant context is established
      // — the invitation token IS the pre-tenant credential, so the
      // lookup must scan across all tenants by construction. auth-
      // service is the one service where cross-tenant auth flows are
      // first-class; tenantManagerRepo cannot be used here.
      let invitation = await this.preTenantAuthRepository(manager, Invitation)
        .createQueryBuilder('invitation')
        .setLock('pessimistic_write')
        .where('invitation.token = :tokenHash', { tokenHash: lookupTokenHash })
        .getOne();

      if (!invitation && !actionToken) {
        // Backward compatibility: try plaintext token for pre-migration invitations
        invitation = await this.preTenantAuthRepository(manager, Invitation)
          .createQueryBuilder('invitation')
          .setLock('pessimistic_write')
          .where('invitation.token = :token', { token })
          .getOne();
      }

      if (!invitation) {
        throw new BadRequestException('Invalid invitation token');
      }

      if (!invitation.canBeAccepted()) {
        if (invitation.isExpired()) {
          throw new BadRequestException('Invitation has expired');
        }
        throw new BadRequestException('Invitation cannot be accepted');
      }

      // Find user by invitation token hash (within transaction).
      // Same cross-tenant-before-tenant-resolved rationale as above.
      let user = await this.preTenantAuthRepository(manager, User)
        .findOne({ where: { invitationToken: lookupTokenHash } });

      if (!user && !actionToken) {
        // Backward compatibility: try plaintext token for pre-migration users
        user = await this.preTenantAuthRepository(manager, User)
          .findOne({ where: { invitationToken: token } });
      }

      if (!user) {
        // SECURITY: Generic message to prevent token enumeration
        throw new BadRequestException('Invalid or expired invitation');
      }

      // Update user with password and clear invitation token
      user.password = password; // Will be hashed by BeforeUpdate hook
      user.invitationToken = null;
      user.invitationExpiresAt = null;
      user.isEmailVerified = true;

      if (firstName) user.firstName = firstName;
      if (lastName) user.lastName = lastName;

      await manager.save(User, user);

      // Update invitation status
      invitation.status = InvitationStatus.ACCEPTED;
      invitation.acceptedAt = new Date();
      invitation.userId = user.id;
      invitation.acceptedFromIp = ipAddress ?? null;
      await manager.save(Invitation, invitation);

      if (actionToken) {
        actionToken.status = ActionTokenStatus.CONSUMED;
        actionToken.consumedAt = new Date();
        await manager.save(ActionToken, actionToken);
      }

      return user;
    });

    // SECURITY: Log user ID instead of email to prevent PII exposure in logs (H-14)
    this.logger.log(`Invitation accepted: userId=${result.id} (role: ${result.role})`);

    // PERF: Parallelize audit log + event publish (BULGU-016)
    await Promise.allSettled([
      // SECURITY AUDIT: Log invitation acceptance (BULGU-016)
      this.logSecurityEvent('INVITATION_ACCEPTED', {
        userId: result.id,
        email: result.email,
        tenantId: result.tenantId,
        ipAddress,
        success: true,
      }),
      // Publish event (outside transaction - events can be retried)
      this.bestEffort.publish(
        createBaseEvent('InvitationAccepted', result.tenantId ?? 'system', { aggregateId: result.id, aggregateType: 'User', userId: result.id }),
      ),
    ]);

    return this.tokenService.generateTokens(result, ipAddress);
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
    // SECURITY: Hash token for lookup against hashed tokens (SEC-005)
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // Try hashed token first, then fall back to plaintext for backward compatibility
    let invitation = await this.invitationRepository.findOne({
      where: { token: tokenHash },
    });

    if (!invitation) {
      // Backward compatibility: try plaintext token for pre-migration invitations
      invitation = await this.invitationRepository.findOne({
        where: { token },
      });
    }

    if (!invitation) {
      return { valid: false };
    }

    if (invitation.isExpired()) {
      return { valid: false, expired: true };
    }

    if (!invitation.isPending()) {
      return { valid: false };
    }

    return {
      valid: true,
      email: invitation.email,
      role: invitation.role,
      firstName: invitation.firstName ?? undefined,
      lastName: invitation.lastName ?? undefined,
    };
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
      const tokenRepo = this.preTenantAuthRepository(manager, RefreshToken);

      // SELECT FOR UPDATE to lock the token row and prevent concurrent refresh
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

      // Fetch the associated user separately (no lock needed on user row).
      const user = await this.preTenantAuthRepository(manager, User)
        .findOne({ where: { id: refreshToken.userId } });

      if (!user || !user.isActive) {
        throw new UnauthorizedException(GENERIC_AUTH_ERROR_MSG);
      }

      // Revoke the token within the same transaction
      refreshToken.isRevoked = true;
      refreshToken.revokedAt = new Date();
      refreshToken.revokedReason = 'Token refreshed';
      await tokenRepo.save(refreshToken);

      // ADR-042: re-read the tenant policy at EVERY rotation (explicit
      // caller-side read — TokenService performs no hidden repo reads) so
      // the refresh-TTL clamp gives sliding idle-timeout semantics.
      const sessionTimeoutMinutes = await this.resolveTenantSessionTimeout(
        manager,
        user.tenantId,
      );

      // Preserve the rememberMe choice across rotation so a remembered session
      // stays persistent (the resolver re-issues a persistent vs session cookie).
      return this.tokenService.generateTokens(
        user,
        refreshToken.ipAddress ?? undefined,
        refreshToken.userAgent ?? undefined,
        { rememberMe: refreshToken.rememberMe, sessionTimeoutMinutes },
      );
    }));
  }

  /**
   * Refresh token with hashed tokens
   *
   * SECURITY:
   * - Extracts userId from the first 36 chars of the token (UUID prefix)
   *   to scope the query to a single user's tokens, avoiding cross-tenant lock contention
   * - Uses transaction with pessimistic locking on per-user tokens only
   * - Limits bcrypt comparisons to the user's active tokens (typically 1-5)
   */
  private async refreshTokenWithHash(plainToken: string): Promise<AuthPayload> {
    // Extract userId prefix from token (first 36 chars = UUID)
    // Token format: {userId}:{randomBytes} — see generateTokens()
    const separatorIndex = plainToken.indexOf(':');
    const userIdPrefix = separatorIndex > 0 ? plainToken.substring(0, separatorIndex) : null;
    const tokenPart = separatorIndex > 0 ? plainToken.substring(separatorIndex + 1) : plainToken;

    return this.dataSource.transaction(async (manager) => {
      // RefreshToken rotation runs before tenant context is
      // re-established — the bearer's tenant is derived from the token
      // row's userId after the row is resolved. Cross-tenant scan is
      // intrinsic to the refresh-token protocol.
      const tokenRepo = this.preTenantAuthRepository(manager, RefreshToken);

      // Build query scoped to user if userId prefix is available
      const queryBuilder = tokenRepo
        .createQueryBuilder('rt')
        .setLock('pessimistic_write')
        .where('rt.isRevoked = :isRevoked', { isRevoked: false })
        .andWhere('rt.expiresAt > :now', { now: new Date() });

      if (userIdPrefix) {
        // SECURITY: Scope lock to single user's tokens — prevents global lock contention
        queryBuilder.andWhere('rt.userId = :userId', { userId: userIdPrefix });
      }

      const validTokens = await queryBuilder
        .orderBy('rt.createdAt', 'DESC')
        .take(TOKEN_CONSTANTS.MAX_ACTIVE_REFRESH_TOKEN_CHECK)
        .getMany();

      // Find matching token by comparing hashes
      // SECURITY: bcrypt.compare prevents timing attacks on refresh token validation
      let matchedToken: RefreshToken | null = null;
      for (const storedToken of validTokens) {
        const isMatch = await bcrypt.compare(tokenPart, storedToken.token);
        if (isMatch) {
          matchedToken = storedToken;
          break;
        }
      }

      if (!matchedToken) {
        // SEC-HIGH-009 cure: refresh-token reuse detection.
        //
        // Before throwing the generic 401, check whether the presented
        // token matches a REVOKED token for the same user. A match means:
        //   (a) An attacker captured the original refresh token and is
        //       replaying it AFTER the legitimate user already rotated it
        //       (RFC 6819 § 5.2.2 captured-token attack), OR
        //   (b) A buggy client cached a stale token and is retrying.
        //
        // Both cases are operationally indistinguishable; the security
        // posture must assume (a) and invalidate every active token for
        // the user — the attacker may have captured BOTH the original
        // and the rotated copy. This is the OWASP-recommended response
        // ("revoke the entire refresh-token chain on reuse-detection").
        if (userIdPrefix) {
          const revokedMatch = await this.detectRefreshTokenReuse(
            manager,
            userIdPrefix,
            tokenPart,
          );
          if (revokedMatch) {
            await this.revokeTokenFamilyOnReuseDetection(
              manager,
              userIdPrefix,
              revokedMatch,
            );
          }
        }
        throw new UnauthorizedException(GENERIC_AUTH_ERROR_MSG);
      }

      // Double-check the token is still not revoked (within locked transaction)
      if (matchedToken.isRevoked) {
        throw new UnauthorizedException(GENERIC_AUTH_ERROR_MSG);
      }

      // Fetch the associated user separately.
      const user = await this.preTenantAuthRepository(manager, User)
        .findOne({ where: { id: matchedToken.userId } });

      if (!user || !user.isActive) {
        throw new UnauthorizedException(GENERIC_AUTH_ERROR_MSG);
      }

      // Revoke the token within the same transaction
      matchedToken.isRevoked = true;
      matchedToken.revokedAt = new Date();
      matchedToken.revokedReason = 'Token refreshed';
      await tokenRepo.save(matchedToken);

      // ADR-042: same explicit rotation-time policy read as the non-hashed
      // path — the clamp is what turns session_timeout_minutes into a
      // SLIDING idle timeout.
      const sessionTimeoutMinutes = await this.resolveTenantSessionTimeout(
        manager,
        user.tenantId,
      );

      // SECURITY (SEC-MEDIUM-003): the rotated token inherits the family of
      // the token it replaces, so reuse-detection can scope revocation to
      // this lineage instead of the whole user.
      return this.tokenService.generateTokens(
        user,
        matchedToken.ipAddress ?? undefined,
        matchedToken.userAgent ?? undefined,
        {
          familyId: matchedToken.familyId ?? undefined,
          rememberMe: matchedToken.rememberMe,
          sessionTimeoutMinutes,
        },
      );
    });
  }

  /**
   * ADR-042: resolve the tenant's idle-session policy (session_timeout_minutes)
   * for a token-issuance caller. Lives HERE — at the caller — by design: the
   * policy is threaded into TokenService.generateTokens as an explicit
   * parameter, so TokenService stays free of hidden repository reads and the
   * clamp is testable as pure input → output.
   *
   * Runs inside the rotation transaction's manager so the read shares the
   * rotation's RLS-bypass context (the tenant row is cross-tenant by design —
   * D14). Platform users (tenantId NULL) have no tenant policy.
   */
  private async resolveTenantSessionTimeout(
    manager: EntityManager,
    tenantId: string | null | undefined,
  ): Promise<number | null> {
    if (!tenantId) {
      return null;
    }
    const tenant = await this.preTenantAuthRepository(manager, Tenant).findOne({
      where: { id: tenantId },
    });
    if (!tenant) {
      return null;
    }
    return tenant.sessionTimeoutMinutes ?? null;
  }

  /**
   * SEC-HIGH-009 cure helper: scan REVOKED tokens for the user to
   * decide whether the presented token corresponds to a previously-
   * issued (now-revoked) refresh token. Returns the matching revoked
   * row on hit, null otherwise. Used only on the no-match branch of
   * the main refresh path; keep the bcrypt scan intentionally tiny so
   * stale browser cookies cannot turn silent refresh into a long request.
   */
  private async detectRefreshTokenReuse(
    manager: import('typeorm').EntityManager,
    userId: string,
    tokenPart: string,
  ): Promise<RefreshToken | null> {
    const tokenRepo = this.preTenantAuthRepository(manager, RefreshToken);
    const revokedTokens = await tokenRepo
      .createQueryBuilder('rt')
      .where('rt.isRevoked = :isRevoked', { isRevoked: true })
      .andWhere('rt.userId = :userId', { userId })
      .orderBy('rt.revokedAt', 'DESC')
      .take(TOKEN_CONSTANTS.MAX_REVOKED_REFRESH_TOKEN_REUSE_CHECK)
      .getMany();
    for (const storedToken of revokedTokens) {
      const isMatch = await bcrypt.compare(tokenPart, storedToken.token);
      if (isMatch) return storedToken;
    }
    return null;
  }

  /**
   * SEC-HIGH-009 + SEC-MEDIUM-003 cure: when reuse is detected, revoke the
   * suspect token's FAMILY (its rotation lineage) — not the whole user's
   * chain. A single stale-cookie replay therefore invalidates only the
   * compromised lineage, leaving the user's other devices logged in, while
   * the emitted SecurityEvent carries a true family-id for correlation.
   *
   * Blacklisting outstanding access tokens + session revocation remain
   * user-scoped on purpose: an access token in the wild carries no family
   * id, so the blacklist cannot be family-narrowed; revoking the user's
   * access tokens + sessions is the correct conservative response to a
   * confirmed captured-token replay.
   *
   * Defense layers fail open independently — if SecurityEventService is
   * down, the token revocations still land. If sessionManager /
   * tokenBlacklist are missing (local-dev), the refresh-token revoke still
   * happens.
   *
   * Legacy rows pre-dating the familyId column have familyId=NULL; for those
   * we fall back to the user-wide revoke (the old behaviour) so a
   * pre-migration token replay is still fully contained.
   */
  private async revokeTokenFamilyOnReuseDetection(
    manager: import('typeorm').EntityManager,
    userId: string,
    suspectToken: RefreshToken,
  ): Promise<void> {
    const tokenRepo = this.preTenantAuthRepository(manager, RefreshToken);
    const familyId = suspectToken.familyId ?? null;
    const revokeReason = familyId
      ? `Reuse detected: family ${familyId} revoked (token id=${suspectToken.id} replayed)`
      : `Reuse detected: revoked token id=${suspectToken.id} replayed (legacy no-family)`;
    await tokenRepo.update(
      familyId ? { userId, familyId, isRevoked: false } : { userId, isRevoked: false },
      { isRevoked: true, revokedAt: new Date(), revokedReason: revokeReason },
    );

    if (this.tokenBlacklist) {
      const expiresIn = this.configService.get<string>('JWT_EXPIRES_IN', '15m');
      const expiresInSeconds = parseExpiresIn(expiresIn);
      const expiryDate = new Date(Date.now() + expiresInSeconds * 1000);
      await this.tokenBlacklist.blacklistUserTokens(
        userId,
        expiryDate,
        'refresh_token_reuse_detected',
      );
    }
    if (this.sessionManager) {
      await this.sessionManager.revokeAllSessions(userId);
    }

    this.logger.warn(
      `Refresh-token reuse detected for user ${userId}; ` +
        `${familyId ? `family ${familyId}` : 'all (legacy no-family)'} tokens revoked. ` +
        `Suspect token id=${suspectToken.id} (revoked at ${suspectToken.revokedAt?.toISOString() ?? 'unknown'}, reason='${suspectToken.revokedReason ?? 'unknown'}'). ` +
        `Source IP=${suspectToken.ipAddress ?? 'unknown'}.`,
    );

    // SecurityEvent emission. Defensive try/catch — a downstream
    // event-bus outage MUST NOT block the 401 response (otherwise a
    // failed event publish becomes a token-rotation request DOS).
    try {
      await this.securityEventService?.publishSuspiciousActivity({
        ip: suspectToken.ipAddress ?? undefined,
        userId,
        userAgent: suspectToken.userAgent ?? undefined,
        description: 'refresh-token-reuse-detected',
        // SEC-MEDIUM-003: carry the true family-id for incident correlation.
        familyId: familyId ?? undefined,
        suspectTokenId: suspectToken.id,
        suspectTokenRevokedAt: suspectToken.revokedAt?.toISOString(),
        suspectTokenRevokedReason: suspectToken.revokedReason ?? undefined,
      });
    } catch (err) {
      this.logger.warn(
        `RefreshTokenReuseDetected SecurityEvent publish failed (non-fatal): ${
          err instanceof Error ? err.message : 'Unknown'
        }`,
      );
    }
  }

  /**
   * Logout user
   *
   * - Revokes all refresh tokens
   * - Blacklists current access token (if JTI provided)
   * - Revokes all sessions
   */
  async logout(userId: string, jti?: string, accessTokenExpiry?: Date): Promise<boolean> {
    // Revoke all refresh tokens for user
    await this.refreshTokenRepository.update(
      { userId, isRevoked: false },
      { isRevoked: true, revokedAt: new Date(), revokedReason: 'User logged out' },
    );

    // Blacklist current access token if JTI provided
    if (jti && accessTokenExpiry && this.tokenBlacklist) {
      await this.tokenBlacklist.add(jti, accessTokenExpiry, 'user_logout');
    }

    // Revoke all sessions
    if (this.sessionManager) {
      await this.sessionManager.revokeAllSessions(userId);
    }

    this.logger.log(`User logged out: ${userId}`);
    return true;
  }

  /**
   * Logout from all devices
   */
  async logoutAllDevices(userId: string): Promise<number> {
    // Revoke all refresh tokens
    const result = await this.refreshTokenRepository.update(
      { userId, isRevoked: false },
      { isRevoked: true, revokedAt: new Date(), revokedReason: 'Logged out from all devices' },
    );

    // Blacklist all user tokens
    if (this.tokenBlacklist) {
      const expiresIn = this.configService.get<string>('JWT_EXPIRES_IN', '15m');
      const expiresInSeconds = parseExpiresIn(expiresIn);
      const expiryDate = new Date(Date.now() + expiresInSeconds * 1000);
      await this.tokenBlacklist.blacklistUserTokens(userId, expiryDate, 'logout_all_devices');
    }

    // Revoke all sessions
    if (this.sessionManager) {
      await this.sessionManager.revokeAllSessions(userId);
    }

    this.logger.log(`User logged out from all devices: ${userId}`);
    return result.affected || 0;
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

      // Check if token is blacklisted (by JTI or user-level blacklist)
      if (this.tokenBlacklist && payload.jti) {
        const isBlacklisted = await this.tokenBlacklist.isBlacklisted(payload.jti);
        if (isBlacklisted) {
          this.logger.debug(`Token blacklisted: ${payload.jti}`);
          return { valid: false };
        }

        // Check user-level blacklist
        if (payload.iat) {
          const tokenIssuedAt = new Date(payload.iat * 1000);
          const isUserBlacklisted = await this.tokenBlacklist.isUserBlacklisted(
            payload.sub,
            tokenIssuedAt,
          );
          if (isUserBlacklisted) {
            this.logger.debug(`User tokens blacklisted: ${payload.sub}`);
            return { valid: false };
          }
        }
      }

      return { valid: true, payload };
    } catch (error) {
      this.logger.debug(`Token validation failed: ${(error as Error).message}`);
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
      await this.logSecurityEvent('ACCOUNT_LOCKED', {
        userId: user.id,
        email: user.email,
        tenantId: user.tenantId,
        success: false,
        reason: `Account locked after ${this.maxFailedAttempts} failed attempts. Locked until ${lockoutUntil.toISOString()}`,
      }, AuditLogSeverity.CRITICAL);

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
        ...createBaseEvent<UserAccountLockedEvent>('UserAccountLocked', user.tenantId ?? 'system', {
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
   * - Publishes PasswordResetRequestedEvent for notification service to send email
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

      // Set token and expiry (1 hour)
      user.passwordResetToken = resetTokenHash;
      user.passwordResetExpires = expiresAt;
      await this.userRepository.save(user);

      const actionToken = await this.actionTokenRepository.save(
        this.actionTokenRepository.create({
          purpose: ActionTokenPurpose.PASSWORD_RESET,
          tenantId: user.tenantId ?? null,
          userId: user.id,
          tokenHash: resetTokenHash,
          status: ActionTokenStatus.ACTIVE,
          expiresAt,
          auditMetadata: {
            source: 'password-reset-request',
            ipAddress,
          },
        }),
      );

      // SECURITY (CRITICAL-001/002): Publish event with opaque references ONLY.
      // PII (email, firstName) and secret URLs are NEVER placed on the immutable event bus.
      // The notification service resolves user details and builds the reset URL at delivery
      // time via authenticated internal API calls using userId and actionTokenId.
      //
      // actionTokenId is the opaque auth.action_tokens row id. The notification
      // service calls auth-service's internal API with this ID to get the action URL
      // without the raw token ever touching the event bus.
      await this.bestEffort.publish({
        ...createBaseEvent('PasswordResetRequested', user.tenantId ?? 'system', { aggregateId: user.id, aggregateType: 'User', userId: user.id, version: 2 }),
        actionTokenId: actionToken.id,
        cryptoShredKeyId: user.id,
      });

      // Audit log
      await this.logSecurityEvent('PASSWORD_RESET_REQUESTED', {
        userId: user.id,
        email: user.email,
        tenantId: user.tenantId,
        ipAddress,
        success: true,
      });

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
   * - Returns new auth tokens so user is immediately logged in
   * - Password validation: min 8, uppercase, lowercase, digit, special char
   */
  async resetPassword(
    token: string,
    newPassword: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthPayload> {
    // SECURITY: Hash the provided token with SHA-256 to compare against stored hash
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const actionToken = await this.actionTokenRepository.findOne({
      where: {
        id: token,
        purpose: ActionTokenPurpose.PASSWORD_RESET,
        status: ActionTokenStatus.ACTIVE,
      },
    });

    if (actionToken && !actionToken.isActive()) {
      throw new BadRequestException('Invalid or expired password reset token');
    }

    // Find user by hashed token and ensure it hasn't expired
    const userQuery = this.userRepository
      .createQueryBuilder('user')
      .where('user.passwordResetExpires > :now', { now: new Date() });

    if (actionToken) {
      userQuery
        .andWhere('user.id = :userId', { userId: actionToken.userId })
        .andWhere('user.passwordResetToken = :tokenHash', { tokenHash: actionToken.tokenHash });
    } else {
      userQuery.andWhere('user.passwordResetToken = :tokenHash', { tokenHash });
    }

    const user = await userQuery.getOne();

    if (!user) {
      throw new BadRequestException('Invalid or expired password reset token');
    }

    // Check if account is active
    if (!user.isActive) {
      throw new BadRequestException('Invalid or expired password reset token');
    }

    // Update password (BeforeUpdate hook will bcrypt-hash it)
    user.password = newPassword;

    // SECURITY: Clear reset token (single-use)
    user.passwordResetToken = null;
    user.passwordResetExpires = null;

    // Reset any account lockout from failed login attempts
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;

    await this.userRepository.save(user);

    if (actionToken) {
      actionToken.status = ActionTokenStatus.CONSUMED;
      actionToken.consumedAt = new Date();
      await this.actionTokenRepository.save(actionToken);
    }

    // SECURITY: Revoke ALL refresh tokens (force re-auth on all devices)
    await this.refreshTokenRepository.update(
      { userId: user.id, isRevoked: false },
      { isRevoked: true, revokedAt: new Date(), revokedReason: 'Password reset' },
    );

    // Blacklist all existing access tokens for this user
    if (this.tokenBlacklist) {
      const expiresIn = this.configService.get<string>('JWT_EXPIRES_IN', '15m');
      const expiresInSeconds = parseExpiresIn(expiresIn);
      const expiryDate = new Date(Date.now() + expiresInSeconds * 1000);
      await this.tokenBlacklist.blacklistUserTokens(user.id, expiryDate, 'password_reset');
    }

    // Revoke all sessions
    if (this.sessionManager) {
      await this.sessionManager.revokeAllSessions(user.id);
    }

    this.logger.log(`Password reset successful for user: ${user.id}`);

    // Audit log + event publish in parallel
    await Promise.allSettled([
      this.logSecurityEvent('PASSWORD_RESET_SUCCESS', {
        userId: user.id,
        email: user.email,
        tenantId: user.tenantId,
        ipAddress,
        userAgent,
        success: true,
      }),
      this.bestEffort.publish(
        createBaseEvent('PasswordResetCompleted', user.tenantId ?? 'system', { aggregateId: user.id, aggregateType: 'User', userId: user.id }),
      ),
    ]);

    // Generate new tokens so user is immediately logged in
    return this.tokenService.generateTokens(user, ipAddress, userAgent);
  }
}
