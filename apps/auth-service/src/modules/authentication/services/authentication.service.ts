import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';

import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  Inject,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { BypassRlsService } from '@aquaculture/backend-common/database';
import { Role } from '@aquaculture/backend-common/decorators';
import { requestContextStorage, getRequestContext } from '@aquaculture/backend-common/logging';
import { TimingSafeService, ISessionManager, ITokenBlacklist, SESSION_MANAGER, TOKEN_BLACKLIST, SecurityEventService } from '@aquaculture/backend-common/security';
import { IEventBus } from '@platform/event-bus';
import { createBaseEvent } from '@platform/event-contracts';
import { DataSource, Repository } from 'typeorm';

import { AuditLogService } from '../../../audit/audit-log.service';
import { AuditLogSeverity } from '../../../audit/audit-log.entity';
import { SECURITY_CONSTANTS, TOKEN_CONSTANTS } from '../../../constants/auth.constants';
import { Tenant } from '../../tenant/entities/tenant.entity';
import { AuthPayload, MePayload } from '../dto/auth-response.dto';
import { LoginInput } from '../dto/login.dto';
import { RegisterInput } from '../dto/register.dto';
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

@Injectable()
export class AuthenticationService {
  private readonly logger = new Logger(AuthenticationService.name);
  private readonly maxFailedAttempts: number;
  private readonly lockoutDurationMinutes: number;
  private readonly hashRefreshTokens: boolean;
  private readonly minLoginDurationMs: number;

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepository: Repository<RefreshToken>,
    @InjectRepository(Invitation)
    private readonly invitationRepository: Repository<Invitation>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    private readonly dataSource: DataSource,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Inject('EVENT_BUS') private readonly eventBus: IEventBus,
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

  /**
   * Register a new user (self-registration - typically not used in enterprise)
   *
   * SECURITY:
   * - Can be disabled via REGISTRATION_ENABLED=false env var (checked in resolver)
   * - Generic error message to prevent email enumeration
   * - Rate limited at gateway level (RateLimitGuard applied as global APP_GUARD)
   */
  async register(input: RegisterInput): Promise<AuthPayload> {
    // Check if user already exists
    const existingUser = await this.userRepository.findOne({
      where: { email: input.email.toLowerCase() },
    });

    if (existingUser) {
      // SECURITY: Generic message to prevent email enumeration
      // In production, you might want to silently fail or send email instead
      // SECURITY: Do not log email address -- PII under GDPR (H-14)
      this.logger.debug('Registration attempt for existing email');
      throw new ConflictException('Registration failed. Please try again or contact support.');
    }

    // Create new user with MODULE_USER role
    const user = this.userRepository.create({
      email: input.email.toLowerCase(),
      password: input.password,
      firstName: input.firstName,
      lastName: input.lastName,
      tenantId: input.tenantId,
      role: Role.MODULE_USER,
      isEmailVerified: false,
    });

    const savedUser = await this.userRepository.save(user);
    // SECURITY: Log user ID instead of email to prevent PII exposure in logs (H-14)
    this.logger.log(`User registered: userId=${savedUser.id} in tenant ${savedUser.tenantId}`);

    // Publish event
    await this.eventBus.publish({
      ...createBaseEvent('UserRegistered', savedUser.tenantId ?? 'system', { aggregateId: savedUser.id, aggregateType: 'User', userId: savedUser.id }),
    });

    return this.tokenService.generateTokens(savedUser);
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

      // SECURITY: Perform dummy password check even if user not found
      // This prevents timing-based user enumeration
      if (!user) {
        // Simulate password check timing
        await bcrypt.compare(input.password, '$2a$12$dummy.hash.to.prevent.timing.attacks');
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

      // SECURITY: Check tenant status — block login for SUSPENDED/CANCELLED tenants (BULGU-008)
      // SUPER_ADMIN users (tenantId is null) are exempt from this check
      if (user.tenantId) {
        const tenant = await this.tenantRepository.findOne({ where: { id: user.tenantId } });
        if (tenant && (tenant.status === 'SUSPENDED' || tenant.status === 'CANCELLED')) {
          await this.ensureMinDuration(startTime);
          this.logger.debug(`Login failed: tenant ${user.tenantId} is ${tenant.status}`);
          await this.logSecurityEvent('LOGIN_BLOCKED_TENANT_SUSPENDED', {
            userId: user.id,
            email: user.email,
            tenantId: user.tenantId,
            ipAddress,
            userAgent,
            success: false,
            reason: `Tenant account is ${tenant.status.toLowerCase()}`,
          }, AuditLogSeverity.WARNING);
          throw new UnauthorizedException('Tenant account is suspended');
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
      if (user.mfaEnabled && this.mfaService?.isMfaAvailable()) {
        // Save login attempt state but DON'T set lastLoginAt yet
        // (it will be set after MFA verification succeeds)
        await this.userRepository.save(user);

        const mfaChallenge = this.mfaService.generateMfaChallenge(user);

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
        this.eventBus.publish({
          ...createBaseEvent('UserLoggedIn', user.tenantId ?? 'system', { aggregateId: user.id, aggregateType: 'User', userId: user.id }),
        }),
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
        return await requestContextStorage.run(scopedContext, () =>
          this.tokenService.generateTokens(user, ipAddress, userAgent),
        );
      }
      // SUPER_ADMIN: audited bypass for platform-level session creation.
      return await this.bypassRls.withBypass(
        'auth-service:super-admin-login-tokens',
        () => this.tokenService.generateTokens(user, ipAddress, userAgent),
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
      // SECURITY: Lock the invitation row to prevent concurrent acceptance
      // Try hashed token first, then fall back to plaintext for backward compatibility
      // Invitation redemption runs BEFORE tenant context is established
      // — the invitation token IS the pre-tenant credential, so the
      // lookup must scan across all tenants by construction. auth-
      // service is the one service where cross-tenant auth flows are
      // first-class; tenantManagerRepo cannot be used here.
      // eslint-disable-next-line no-restricted-syntax -- pre-tenant-context auth flow
      let invitation = await manager
        .getRepository(Invitation)
        .createQueryBuilder('invitation')
        .setLock('pessimistic_write')
        .where('invitation.token = :tokenHash', { tokenHash })
        .getOne();

      if (!invitation) {
        // Backward compatibility: try plaintext token for pre-migration invitations
        // eslint-disable-next-line no-restricted-syntax -- pre-tenant-context auth flow
        invitation = await manager
          .getRepository(Invitation)
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
      // eslint-disable-next-line no-restricted-syntax -- pre-tenant-context auth flow
      let user = await manager
        .getRepository(User)
        .findOne({ where: { invitationToken: tokenHash } });

      if (!user) {
        // Backward compatibility: try plaintext token for pre-migration users
        // eslint-disable-next-line no-restricted-syntax -- pre-tenant-context auth flow
        user = await manager
          .getRepository(User)
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
      this.eventBus.publish({
        ...createBaseEvent('InvitationAccepted', result.tenantId ?? 'system', { aggregateId: result.id, aggregateType: 'User', userId: result.id }),
      }),
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
    // If tokens are hashed, we need to find by comparing hashes
    if (this.hashRefreshTokens) {
      return this.refreshTokenWithHash(token);
    }

    // SECURITY: Use transaction with pessimistic locking to prevent double-spending
    // NOTE: FOR UPDATE cannot be used with LEFT JOIN in PostgreSQL, so we split
    // the token lock and user fetch into separate queries.
    return this.dataSource.transaction(async (manager) => {
      // RefreshToken rotation runs before tenant context is
      // re-established — the bearer's tenant is derived from the token
      // row's userId after the row is resolved. Cross-tenant scan is
      // intrinsic to the refresh-token protocol.
      // eslint-disable-next-line no-restricted-syntax -- pre-tenant-context auth flow
      const tokenRepo = manager.getRepository(RefreshToken);

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
      // eslint-disable-next-line no-restricted-syntax -- pre-tenant-context auth flow
      const user = await manager
        .getRepository(User)
        .findOne({ where: { id: refreshToken.userId } });

      if (!user || !user.isActive) {
        throw new UnauthorizedException(GENERIC_AUTH_ERROR_MSG);
      }

      // Revoke the token within the same transaction
      refreshToken.isRevoked = true;
      refreshToken.revokedAt = new Date();
      refreshToken.revokedReason = 'Token refreshed';
      await tokenRepo.save(refreshToken);

      return this.tokenService.generateTokens(
        user,
        refreshToken.ipAddress ?? undefined,
        refreshToken.userAgent ?? undefined,
      );
    });
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
      // eslint-disable-next-line no-restricted-syntax -- pre-tenant-context auth flow
      const tokenRepo = manager.getRepository(RefreshToken);

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
        .take(TOKEN_CONSTANTS.MAX_REFRESH_TOKEN_CHECK)
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
            await this.revokeAllUserTokensOnReuseDetection(
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
      // eslint-disable-next-line no-restricted-syntax -- pre-tenant-context auth flow
      const user = await manager
        .getRepository(User)
        .findOne({ where: { id: matchedToken.userId } });

      if (!user || !user.isActive) {
        throw new UnauthorizedException(GENERIC_AUTH_ERROR_MSG);
      }

      // Revoke the token within the same transaction
      matchedToken.isRevoked = true;
      matchedToken.revokedAt = new Date();
      matchedToken.revokedReason = 'Token refreshed';
      await tokenRepo.save(matchedToken);

      return this.tokenService.generateTokens(
        user,
        matchedToken.ipAddress ?? undefined,
        matchedToken.userAgent ?? undefined,
      );
    });
  }

  /**
   * SEC-HIGH-009 cure helper: scan REVOKED tokens for the user to
   * decide whether the presented token corresponds to a previously-
   * issued (now-revoked) refresh token. Returns the matching revoked
   * row on hit, null otherwise. Used only on the no-match branch of
   * the main refresh path; the cost is N bcrypt.compare calls where N
   * is bounded by MAX_REFRESH_TOKEN_CHECK (typically 5-10).
   */
  private async detectRefreshTokenReuse(
    manager: import('typeorm').EntityManager,
    userId: string,
    tokenPart: string,
  ): Promise<RefreshToken | null> {
    // eslint-disable-next-line no-restricted-syntax -- pre-tenant-context auth flow
    const tokenRepo = manager.getRepository(RefreshToken);
    const revokedTokens = await tokenRepo
      .createQueryBuilder('rt')
      .where('rt.isRevoked = :isRevoked', { isRevoked: true })
      .andWhere('rt.userId = :userId', { userId })
      .orderBy('rt.revokedAt', 'DESC')
      .take(TOKEN_CONSTANTS.MAX_REFRESH_TOKEN_CHECK)
      .getMany();
    for (const storedToken of revokedTokens) {
      const isMatch = await bcrypt.compare(tokenPart, storedToken.token);
      if (isMatch) return storedToken;
    }
    return null;
  }

  /**
   * SEC-HIGH-009 cure helper: when reuse is detected, revoke every
   * active refresh token for the user (best-effort family invalidation
   * — without an explicit familyId column we revoke the entire user's
   * chain), blacklist all outstanding access tokens, revoke all
   * sessions, and emit RefreshTokenReuseDetected SecurityEvent.
   *
   * Defense layers fail open independently — if SecurityEventService
   * is down, the token revocations still land. If sessionManager /
   * tokenBlacklist are missing (local-dev), the refresh-token revoke
   * still happens.
   */
  private async revokeAllUserTokensOnReuseDetection(
    manager: import('typeorm').EntityManager,
    userId: string,
    suspectToken: RefreshToken,
  ): Promise<void> {
    // eslint-disable-next-line no-restricted-syntax -- pre-tenant-context auth flow
    const tokenRepo = manager.getRepository(RefreshToken);
    const revokeReason = `Reuse detected: revoked token id=${suspectToken.id} replayed`;
    await tokenRepo.update(
      { userId, isRevoked: false },
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
      `Refresh-token reuse detected for user ${userId}; all tokens revoked. ` +
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
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token);

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
  async me(userId: string): Promise<MePayload> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      // SECURITY: Generic message to prevent information leakage
      throw new UnauthorizedException(GENERIC_AUTH_ERROR_MSG);
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
    const result: Array<{ failedLoginAttempts: number; lockedUntil: Date | null }> =
      await this.dataSource.query(
        `UPDATE auth.users
         SET "failedLoginAttempts" = "failedLoginAttempts" + 1,
             "lockedUntil" = CASE
               WHEN "failedLoginAttempts" + 1 >= $2 THEN $3::timestamp
               ELSE "lockedUntil"
             END
         WHERE id = $1
         RETURNING "failedLoginAttempts", "lockedUntil"`,
        [user.id, this.maxFailedAttempts, lockoutUntil],
      );

    const updatedAttempts = result[0]?.failedLoginAttempts ?? 0;
    const isNowLocked = result[0]?.lockedUntil !== null && updatedAttempts >= this.maxFailedAttempts;

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

      // Set token and expiry (1 hour)
      user.passwordResetToken = resetTokenHash;
      user.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
      await this.userRepository.save(user);

      // SECURITY (CRITICAL-001/002): Publish event with opaque references ONLY.
      // PII (email, firstName) and secret URLs are NEVER placed on the immutable event bus.
      // The notification service resolves user details and builds the reset URL at delivery
      // time via authenticated internal API calls using userId and actionTokenId.
      //
      // actionTokenId is the SHA-256 hash of the reset token (same value stored in DB).
      // The notification service calls auth-service's internal API with this ID to get
      // the pre-built action URL without the raw token ever touching the event bus.
      await this.eventBus.publish({
        ...createBaseEvent('PasswordResetRequested', user.tenantId ?? 'system', { aggregateId: user.id, aggregateType: 'User', userId: user.id, version: 2 }),
        actionTokenId: resetTokenHash,
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

    // Find user by hashed token and ensure it hasn't expired
    const user = await this.userRepository
      .createQueryBuilder('user')
      .where('user.passwordResetToken = :tokenHash', { tokenHash })
      .andWhere('user.passwordResetExpires > :now', { now: new Date() })
      .getOne();

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
      this.eventBus.publish({
        ...createBaseEvent('PasswordResetCompleted', user.tenantId ?? 'system', { aggregateId: user.id, aggregateType: 'User', userId: user.id }),
      }),
    ]);

    // Generate new tokens so user is immediately logged in
    return this.tokenService.generateTokens(user, ipAddress, userAgent);
  }
}
