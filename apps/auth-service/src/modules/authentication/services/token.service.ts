import * as crypto from 'crypto';

import { getActiveSigningKid } from '@aquaculture/backend-common/auth';
import { Role } from '@aquaculture/backend-common/decorators';
import {
  ISessionManager,
  IUserTokenRevocation,
  SESSION_MANAGER,
  USER_TOKEN_REVOCATION,
} from '@aquaculture/backend-common/security';
import { Injectable, Logger, Optional, Inject, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { TenantPlan, PLAN_LEVEL } from '@platform/event-contracts';
import * as bcrypt from 'bcryptjs';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';

import { parseHashRefreshTokens } from '../../../config/hash-refresh-tokens';
import { parseAccessTokenLifetimeSeconds } from '../../../config/jwt-lifetime';
import { SECURITY_CONSTANTS } from '../../../constants/auth.constants';
import { MobileSettingsService } from '../../tenant/services/mobile-settings.service';
import { resolveEntitledCapabilities } from '../../tenant/services/permission-catalogue';
import {
  applyPermissionOverrides,
  parsePermissionOverrides,
} from '../../tenant/services/permission-overrides.util';
import { AuthPayload } from '../dto/auth-response.dto';
import { RefreshToken } from '../entities/refresh-token.entity';
import { UserModuleAssignment } from '../entities/user-module-assignment.entity';
import { UserSiteAssignment } from '../entities/user-site-assignment.entity';
import { User } from '../entities/user.entity';
import { readEffectiveUserSiteAssignments } from './user-site-assignment-reader';

/**
 * JWT access token payload.
 *
 * SECURITY (H-08): Contains only non-PII identifiers. Personal data (email,
 * firstName, lastName) has been removed from token generation to prevent PII
 * leakage via token interception, browser DevTools inspection, or JWT decoding
 * tools. JWT payloads are merely base64-encoded and visible to anyone with the token.
 *
 * Services that need user profile data (email, name) should fetch it from
 * auth-service via the /users/:id endpoint or NATS request, not from the JWT.
 *
 * MIGRATION NOTE: The 'email' field is retained as optional for backward
 * compatibility during the transition period. Existing tokens in the wild may
 * still contain email/firstName/lastName. Consumers should not rely on these
 * fields being present and should gracefully handle their absence.
 */
export interface JwtPayload {
  sub: string;
  /** @deprecated Will be removed in next major version. Use sub (user ID) instead. */
  email?: string;
  role: Role;
  roles: Role[];
  tenantId: string | null;
  /**
   * Numeric tier rank of the tenant's plan (MT-MEDIUM-001) — the canonical
   * `PLAN_LEVEL` ordinal (FREE/TRIAL=0, STARTER=1, PROFESSIONAL=2, ENTERPRISE=3).
   * Lets the gateway and downstream services gate features by tier from the
   * token alone, without a per-request tenant lookup. Absent for platform
   * accounts with no tenant (SUPER_ADMIN). A few-minutes lag on a plan change
   * (until the next token refresh) is acceptable for feature gating.
   */
  planLevel?: number;
  modules?: string[];
  resourcePermissions?: string[];
  /**
   * SEC-HIGH-051: farm-service Site ids the user is assigned to (object-level
   * site authorization). Like `modules`/`resourcePermissions`/`planLevel`, this
   * is an authz claim with the SAME staleness tolerance: a freshly assigned or
   * revoked site only takes effect on the next access-token refresh (<=15m),
   * which is acceptable for site gating. SUPER_ADMIN/TENANT_ADMIN omit it — they
   * bypass site checks via the canonical role hierarchy.
   */
  assignedSiteIds?: string[];
  /**
   * SEC-HIGH-052: enabled mobile feature keys
   * (`auth.mobile_user_settings.allowedFeatures`). Same staleness tolerance as
   * above: a disabled feature stays effective until the next token refresh.
   */
  mobileFeatures?: string[];
  /**
   * Token type discriminator -- prevents refresh tokens from being used as
   * access tokens, and vice versa. The gateway's AuthGuard rejects any token
   * where `type !== 'access'`, ensuring that short-lived MFA challenge tokens,
   * MFA setup (enrollment) tokens, and opaque refresh tokens cannot be
   * replayed as bearer credentials. `mfa_setup` (ADR-046) authorizes ONLY the
   * setupMfa + verifyMfaSetup enrollment pair — MfaService positively requires
   * it there, and enforceAccessTokenType rejects it on every bearer surface.
   */
  type: 'access' | 'refresh' | 'mfa_challenge' | 'mfa_setup';
  /** @deprecated Will be removed in next major version. Fetch from auth-service instead. */
  firstName?: string;
  /** @deprecated Will be removed in next major version. Fetch from auth-service instead. */
  lastName?: string;
  /** IP-2: Set to true after MFA step-up verification. TenantGuard checks
   *  this claim for cross-tenant access when MFA_REQUIRED_FOR_CROSS_TENANT=true. */
  mfaVerified?: boolean;
  jti?: string; // JWT ID for blacklisting
  iat?: number;
  exp?: number;
}

interface TenantModuleRow {
  code: string;
  name: string;
  defaultRoute: string;
}

interface AssignedSiteSnapshot {
  siteIds: string[];
  earliestExpiryEpochSeconds?: number;
}

interface GenerateTokensOptions {
  mfaVerified?: boolean;
  familyId?: string;
  rememberMe?: boolean;
  manager?: EntityManager;
  establishSession?: boolean;
}

interface LockedGenerateTokensOptions extends GenerateTokensOptions {
  manager: EntityManager;
}

/**
 * Parse a time-duration string (e.g. '15m', '1h', '7d') into seconds.
 */
export function parseExpiresIn(expiresIn: string): number {
  return parseAccessTokenLifetimeSeconds(expiresIn);
}

/**
 * TokenService — Single Responsibility: JWT + refresh-token issuance.
 *
 * Extracted from AuthenticationService to break the circular dependency:
 *   AuthenticationService <-> MfaService / WebAuthnService
 *
 * Both MfaService and WebAuthnService only needed AuthenticationService
 * for token generation. Now they depend on TokenService instead,
 * eliminating the cycle entirely.
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly refreshTokenExpiryDays: number;
  private readonly rememberMeRefreshTokenExpiryDays: number;
  private readonly hashRefreshTokens: boolean;
  private readonly maxSessionsPerUser: number;

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepository: Repository<RefreshToken>,
    @InjectRepository(UserModuleAssignment)
    private readonly userModuleAssignmentRepository: Repository<UserModuleAssignment>,
    @InjectRepository(UserSiteAssignment)
    private readonly userSiteAssignmentRepository: Repository<UserSiteAssignment>,
    private readonly dataSource: DataSource,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    // SEC-HIGH-052: the SINGLE mobile-feature read path. Injected (not
    // re-queried inline) so allowedFeatures has exactly one source of truth.
    private readonly mobileSettingsService: MobileSettingsService,
    @Inject(USER_TOKEN_REVOCATION)
    private readonly userTokenRevocation: IUserTokenRevocation,
    @Optional() @Inject(SESSION_MANAGER) private readonly sessionManager?: ISessionManager,
  ) {
    this.refreshTokenExpiryDays = this.configService.get<number>(
      'REFRESH_TOKEN_EXPIRY_DAYS',
      SECURITY_CONSTANTS.DEFAULT_REFRESH_TOKEN_EXPIRY_DAYS,
    );
    this.rememberMeRefreshTokenExpiryDays = this.configService.get<number>(
      'REMEMBER_ME_REFRESH_TOKEN_EXPIRY_DAYS',
      SECURITY_CONSTANTS.DEFAULT_REMEMBER_ME_REFRESH_TOKEN_EXPIRY_DAYS,
    );
    this.hashRefreshTokens = parseHashRefreshTokens(this.configService);
    this.maxSessionsPerUser = this.configService.get<number>(
      'MAX_SESSIONS_PER_USER',
      SECURITY_CONSTANTS.DEFAULT_MAX_SESSIONS_PER_USER,
    );
  }

  /**
   * Generate JWT access token + refresh token for an authenticated user.
   *
   * Enforces session limits, creates DB-persisted refresh token, and
   * returns a full AuthPayload ready for the client.
   */
  async generateTokens(
    user: User,
    ipAddress?: string,
    userAgent?: string,
    options?: GenerateTokensOptions,
  ): Promise<AuthPayload> {
    const mintUnderUserFence = async (manager: EntityManager): Promise<AuthPayload> => {
      // Canonical credential lock order: every RefreshToken INSERT takes the
      // stable User row first. Snapshot fields are part of the predicate so a
      // password/role/tenant/deactivation mutation that committed after the
      // caller authenticated makes this mint fail closed instead of issuing a
      // token from stale authorization state.
      const lockedPrincipal = await manager.withRepository(this.userRepository).findOne({
        select: { id: true },
        where: {
          id: user.id,
          role: user.role,
          tenantId: user.tenantId ?? IsNull(),
          isActive: true,
          ...(user.updatedAt ? { updatedAt: user.updatedAt } : {}),
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!lockedPrincipal) {
        throw new ForbiddenException('User credentials changed during token issuance');
      }
      return this.generateTokensUnderUserFence(user, ipAddress, userAgent, {
        ...options,
        manager,
      });
    };

    return options?.manager
      ? mintUnderUserFence(options.manager)
      : this.dataSource.transaction(mintUnderUserFence);
  }

  private async generateTokensUnderUserFence(
    user: User,
    ipAddress: string | undefined,
    userAgent: string | undefined,
    options: LockedGenerateTokensOptions,
  ): Promise<AuthPayload> {
    // SSoT: the effective tenant this token is scoped to — the user's own tenant.
    const effectiveTenantId = user.tenantId ?? null;

    // C1 (tenant-isolation invariant): every non-SUPER_ADMIN principal is
    // tenant-scoped. Minting a token for one WITHOUT a resolved tenant would let
    // downstream tenant routing (search_path / RLS / TenantGuard) fall back to an
    // unscoped context — a cross-tenant hazard. SUPER_ADMIN is the only tenantless
    // role by design. Fail closed rather than issue an unscoped tenant token.
    if (user.role !== Role.SUPER_ADMIN && !effectiveTenantId) {
      throw new ForbiddenException(
        'A non-SUPER_ADMIN account cannot be issued a token without a tenant',
      );
    }

    const issuedAtEpochSeconds = await this.resolveIssuableEpochSeconds(user.id);
    const establishSession = options?.establishSession ?? true;

    // Rotation already belongs to an established session. Only fresh login
    // paths enforce/create a session; otherwise every refresh would consume a
    // new slot and could evict the very session being rotated.
    if (this.sessionManager && establishSession) {
      await this.sessionManager.enforceSessionLimit(user.id, this.maxSessionsPerUser);
    }

    // PERF (PERF-HIGH-003): the refresh-token random bytes are independent of
    // every DB read, and bcrypt.hash is CPU-bound (~tens of ms). Generate the
    // random material now and START the hash promise BEFORE awaiting the reads
    // so the hash runs concurrently with the module/permission/plan round-trips
    // instead of serially after them. When HASH_REFRESH_TOKENS is off the raw
    // value is wrapped in an already-resolved promise so the await below is a
    // no-op — semantics are preserved either way.
    const refreshTokenId = this.hashRefreshTokens ? crypto.randomUUID() : undefined;
    const refreshTokenRandom = crypto.randomBytes(64).toString('hex');
    const transportedRefreshSecret = refreshTokenId
      ? `${refreshTokenId.replaceAll('-', '')}${refreshTokenRandom}`
      : refreshTokenRandom;
    const tokenToStorePromise: Promise<string> = this.hashRefreshTokens
      ? bcrypt.hash(transportedRefreshSecret, SECURITY_CONSTANTS.BCRYPT_SALT_ROUNDS)
      : Promise.resolve(transportedRefreshSecret);

    // Hot-path reads run concurrently: the user's module codes, tenant-level
    // resource permissions, the tenant's plan-tier ordinal (the MT-MEDIUM-001
    // JWT claim), the user's assigned site ids (SEC-HIGH-051) and enabled mobile
    // features (SEC-HIGH-052) are independent, so a single Promise.all keeps
    // token mint to one read latency instead of five serial round-trips.
    const [modules, resourcePermissions, tenantPolicy, assignedSites, mobileFeatures] =
      await Promise.all([
        this.getUserModules(user),
        this.getUserResourcePermissions(user),
        this.resolveTenantTokenPolicy(effectiveTenantId),
        this.getUserAssignedSites(user, issuedAtEpochSeconds, options.manager),
        this.getUserMobileFeatures(user),
      ]);
    const moduleCodes = modules.map((m) => m.code);
    const planLevel = tenantPolicy.planLevel;
    const assignedSiteIds = assignedSites.siteIds;

    // Generate JWT ID for token blacklisting
    const jti = crypto.randomUUID();

    /**
     * SECURITY (H-08): JWT payload contains only non-PII identifiers.
     * Email, firstName, and lastName are intentionally excluded to prevent
     * PII leakage through token interception or base64 decoding.
     *
     * Downstream services needing user profile data should query auth-service
     * via NATS request (auth.user.get) or the /users/:id REST endpoint.
     */
    const payload: JwtPayload = {
      sub: user.id,
      role: user.role,
      roles: [user.role],
      tenantId: effectiveTenantId,
      ...(planLevel !== undefined ? { planLevel } : {}),
      // OMIT the keys entirely when empty (spread, not `: undefined`) so the
      // payload object has no `modules`/`resourcePermissions` property at all —
      // `'modules' in payload` is false, matching the omit-when-empty contract.
      ...(moduleCodes.length > 0 ? { modules: moduleCodes } : {}),
      ...(resourcePermissions.length > 0 ? { resourcePermissions } : {}),
      // SEC-HIGH-051 / SEC-HIGH-052: emit only when non-empty. Use the spread
      // pattern (like planLevel) so the KEY is genuinely absent when empty —
      // managers/admins carry no superfluous claim and `'x' in payload` is false.
      ...(assignedSiteIds.length > 0 ? { assignedSiteIds } : {}),
      ...(mobileFeatures.length > 0 ? { mobileFeatures } : {}),
      type: 'access',
      jti,
      iat: issuedAtEpochSeconds,
      // IP-2: MFA step-up claim — set after successful TOTP verification.
      // TenantGuard checks this claim for cross-tenant access (MFA_REQUIRED_FOR_CROSS_TENANT=true).
      ...(options?.mfaVerified ? { mfaVerified: true } : {}),
    };

    // SECURITY (SEC-HIGH-003): include audience (anti cross-service replay)
    // AND the `kid` header so verifiers can deterministically select the
    // matching JWKS public key during a rotation overlap. The kid is derived
    // from the same SSoT (getActiveSigningKid) the JWKS controller publishes,
    // making header/JWKS drift impossible.
    const configuredExpiresInSeconds = parseAccessTokenLifetimeSeconds(
      this.configService.get<string>('JWT_EXPIRES_IN', SECURITY_CONSTANTS.DEFAULT_JWT_EXPIRES_IN),
    );
    const assignmentExpiresInSeconds =
      assignedSites.earliestExpiryEpochSeconds === undefined
        ? configuredExpiresInSeconds
        : assignedSites.earliestExpiryEpochSeconds - issuedAtEpochSeconds;
    const expiresInSeconds = Math.min(configuredExpiresInSeconds, assignmentExpiresInSeconds);

    const accessToken = await this.jwtService.signAsync(payload, {
      audience: this.configService.get<string>('JWT_AUDIENCE', 'aquaculture-platform'),
      keyid: getActiveSigningKid(this.configService),
      expiresIn: expiresInSeconds,
    });

    // SECURITY: Prefix refresh token with userId so the lookup can be scoped per-user.
    const refreshTokenValue = this.hashRefreshTokens
      ? `${user.id}:${transportedRefreshSecret}`
      : transportedRefreshSecret;

    // PERF (PERF-HIGH-003): collect the bcrypt result started before the reads.
    // By now the hash has run concurrently with the module/permission/plan
    // round-trips, so this await is usually already-settled work.
    const tokenToStore = await tokenToStorePromise;

    // SECURITY (SEC-MEDIUM-003): a fresh login starts a NEW token family; a
    // rotation (refresh) passes the rotated token's familyId so the lineage
    // is preserved. Reuse-detection later revokes by family, not by user.
    const familyId = options?.familyId ?? crypto.randomUUID();

    // SECURITY (ORPHAN-LOW-135): a remembered session persists longer. Extend the
    // ROW's expiresAt to the remember-me TTL when remembered, so the persistent
    // refresh cookie (set by the resolver with a matching maxAge) never outlives
    // the row it points at. Non-remembered sessions keep the default TTL.
    const rememberMe = options?.rememberMe ?? false;
    const expiryDays = rememberMe
      ? this.rememberMeRefreshTokenExpiryDays
      : this.refreshTokenExpiryDays;

    // ADR-046: effective refresh TTL = MIN(configured TTL incl. rememberMe,
    // tenant session-timeout policy) — the tenant policy WINS, including over
    // a rememberMe extension. The policy is resolved INSIDE this chokepoint
    // (resolveTenantTokenPolicy, from the user's own tenant) rather than
    // threaded by callers, so no mint path — login, both rotation paths,
    // verifyMfaLogin, verifyStepUp, acceptInvitation, resetPassword, WebAuthn —
    // can forget the clamp. Applied on every mint (issuance AND rotation), so
    // a tenant idle window slides forward with activity and a policy REDUCTION
    // takes effect at the next rotation. Access-token TTL is untouched.
    const configuredTtlMs = expiryDays * 24 * 60 * 60 * 1000;
    const effectiveTtlMs =
      tenantPolicy.sessionTimeoutMinutes === null
        ? configuredTtlMs
        : Math.min(configuredTtlMs, tenantPolicy.sessionTimeoutMinutes * 60 * 1000);

    // Create refresh token
    const refreshTokenRepository = options.manager.withRepository(this.refreshTokenRepository);
    const refreshToken = refreshTokenRepository.create({
      token: tokenToStore,
      ...(refreshTokenId ? { tokenId: refreshTokenId } : {}),
      userId: user.id,
      tenantId: user.tenantId,
      familyId,
      rememberMe,
      expiresAt: new Date(Date.now() + effectiveTtlMs),
      ipAddress,
      userAgent,
    });

    // PERF (PERF-HIGH-003): the refresh-token row insert and the session
    // creation are independent writes (the session limit was already enforced
    // up front), so issue both concurrently and await together rather than
    // serially. Order does not matter: neither depends on the other's result.
    const persistPromises: Array<Promise<unknown>> = [refreshTokenRepository.save(refreshToken)];
    if (this.sessionManager && establishSession) {
      persistPromises.push(
        this.sessionManager.createSession(user.id, {
          ipAddress,
          userAgent,
          tenantId: user.tenantId ?? undefined,
        }),
      );
    }
    await Promise.all(persistPromises);

    // Determine redirect URL based on role
    const redirectUrl = this.getRedirectUrl(user, modules);

    return {
      accessToken,
      refreshToken: refreshTokenValue,
      user,
      expiresIn: expiresInSeconds,
      tokenType: 'Bearer',
      redirectUrl,
      // INTERNAL: surfaced back to the resolver so it can branch the cookie
      // maxAge. Not a @Field on AuthPayload, so it never reaches the client.
      rememberMe,
    };
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  /**
   * Never mint an access token on an invalidated second. JWT iat precision is
   * one second, so a synthetic future iat would be unsafe clock fabrication.
   * Instead, wait for the real next second and re-read the distributed marker.
   */
  private async resolveIssuableEpochSeconds(userId: string): Promise<number> {
    const maximumAttempts = 3;
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      const now = Date.now();
      const issuedAtEpochSeconds = Math.floor(now / 1000);
      const issuedAt = new Date(issuedAtEpochSeconds * 1000);
      if (await this.userTokenRevocation.isTokenValid(userId, issuedAt)) {
        return issuedAtEpochSeconds;
      }
      if (attempt === maximumAttempts - 1) {
        break;
      }
      const millisecondsUntilNextSecond = 1000 - (Date.now() % 1000);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, millisecondsUntilNextSecond);
      });
    }
    throw new ForbiddenException('Access-token issuance is temporarily unavailable');
  }

  async getUserModules(
    user: User,
  ): Promise<Array<{ code: string; name: string; defaultRoute: string }>> {
    if (user.role === Role.SUPER_ADMIN) {
      // SUPER_ADMIN sees ALL active modules (platform-wide, not tenant-scoped).
      // Previous behavior returned [] which made the sidebar empty.
      const allModules = await this.dataSource.query<
        Array<{ code: string; name: string; defaultRoute: string }>
      >(
        `SELECT code, name, "defaultRoute"
         FROM auth.modules
         WHERE "isActive" = true
         ORDER BY "sortOrder" ASC, name ASC`,
      );
      return allModules;
    }

    let modules: Array<{ code: string; name: string; defaultRoute: string }>;

    if (user.role === Role.TENANT_ADMIN && user.tenantId) {
      const tenantModules = await this.dataSource.query<TenantModuleRow[]>(
        `SELECT m.code, m.name, m."defaultRoute"
         FROM auth.tenant_modules tm
         JOIN auth.modules m ON tm."moduleId" = m.id
         WHERE tm."tenantId" = $1 AND tm."isEnabled" = true
         ORDER BY m.name`,
        [user.tenantId],
      );

      modules = tenantModules.map((tm) => ({
        code: tm.code,
        name: tm.name,
        defaultRoute: tm.defaultRoute,
      }));
    } else {
      const assignments = await this.userModuleAssignmentRepository.find({
        where: { userId: user.id, isActive: true },
        relations: ['module'],
      });

      modules = assignments
        .filter((a) => a.isAccessible() && a.module)
        .map((a) => ({
          code: a.module.code,
          name: a.module.name,
          defaultRoute: a.module.defaultRoute,
        }));
    }

    return modules;
  }

  /**
   * SEC-HIGH-051: resolve the user's assigned farm-service Site ids for the
   * `assignedSiteIds` JWT claim.
   *
   * The caller already holds the canonical User row FOR UPDATE. Assignment
   * rows are read under the same transaction so the principal fence, site
   * claim and RefreshToken INSERT form one ordered authorization snapshot.
   */
  private async getUserAssignedSites(
    user: User,
    issuedAtEpochSeconds: number,
    activeManager: EntityManager,
  ): Promise<AssignedSiteSnapshot> {
    if (
      user.role === Role.SUPER_ADMIN ||
      user.role === Role.TENANT_ADMIN ||
      user.role === Role.MODULE_MANAGER
    ) {
      return { siteIds: [] };
    }
    if (!user.tenantId) {
      return { siteIds: [] };
    }
    const tenantId = user.tenantId;

    const assignmentRepository = activeManager.withRepository(this.userSiteAssignmentRepository);
    // JWT times have whole-second precision. An assignment that expires
    // before the next representable token second cannot safely be carried
    // as a claim, even when a few milliseconds remain on the wall clock.
    const claimBoundary = new Date((issuedAtEpochSeconds + 1) * 1000 - 1);
    const effectiveAssignments = await readEffectiveUserSiteAssignments(
      assignmentRepository,
      user.id,
      tenantId,
      claimBoundary,
      { lock: 'pessimistic_read' },
    );

    return {
      siteIds: effectiveAssignments.siteIds,
      ...(effectiveAssignments.earliestExpiresAt
        ? {
            earliestExpiryEpochSeconds: Math.floor(
              effectiveAssignments.earliestExpiresAt.getTime() / 1000,
            ),
          }
        : {}),
    };
  }

  /**
   * SEC-HIGH-052: project the user's enabled mobile feature keys for the
   * `mobileFeatures` JWT claim, via the SINGLE read path
   * (`MobileSettingsService.getByUserId`).
   *
   * SUPER_ADMIN have no tenant/settings and are not feature-gated — return [].
   * For tenant-scoped users, only the truthy `allowedFeatures` keys are emitted,
   * and ONLY when `isMobileEnabled` (a globally-disabled mobile user gets no
   * feature claims, so MobileFeatureGuard denies every gated mutation).
   */
  private async getUserMobileFeatures(user: User): Promise<string[]> {
    if (!user.tenantId) {
      return [];
    }

    const settings = await this.mobileSettingsService.getByUserId(user.id, user.tenantId);
    if (!settings.isMobileEnabled) {
      return [];
    }

    return Object.entries(settings.allowedFeatures)
      .filter(([, enabled]) => enabled === true)
      .map(([key]) => key);
  }

  /**
   * Resolve the per-mint tenant policy in a SINGLE `auth.tenants` read:
   *
   *   - `planLevel` — the tenant's plan-tier ordinal for the JWT `planLevel`
   *     claim (MT-MEDIUM-001). Undefined for platform accounts (SUPER_ADMIN,
   *     no tenant) so the claim is omitted; an unrecognised plan string falls
   *     back to 0 (FREE-equivalent) so a data anomaly can never silently
   *     unlock a paid tier.
   *   - `sessionTimeoutMinutes` — the ADR-046 idle-session policy that clamps
   *     the refresh-token TTL. Resolved HERE, inside the single mint
   *     chokepoint, rather than threaded by callers: that is what makes the
   *     clamp unforgettable on every path. null = no tenant policy (the
   *     configured platform TTL applies).
   *
   * This widens by one column the same cross-tenant `auth.tenants` read the
   * planLevel claim already performed on every mint (D14 — auth.tenants is
   * cross-tenant by design), so it inherits the caller's RLS context (the
   * login scoped frame / the rotation audited bypass) exactly as before and
   * adds no round-trip.
   */
  private async resolveTenantTokenPolicy(
    tenantId: string | null,
  ): Promise<{ planLevel?: number; sessionTimeoutMinutes: number | null }> {
    if (!tenantId) {
      return { sessionTimeoutMinutes: null };
    }
    const rows = await this.dataSource.query<
      Array<{ plan: string; session_timeout_minutes: number | null }>
    >(`SELECT plan, session_timeout_minutes FROM auth.tenants WHERE id = $1 LIMIT 1`, [tenantId]);
    const row = rows[0];
    if (!row) {
      return { sessionTimeoutMinutes: null };
    }
    const plan = row.plan as TenantPlan | undefined;
    return {
      ...(plan ? { planLevel: PLAN_LEVEL[plan] ?? 0 } : {}),
      sessionTimeoutMinutes: row.session_timeout_minutes ?? null,
    };
  }

  /**
   * Get user's tenant-level resource permissions from their role assignment.
   *
   * PERF-HIGH-001 (a) — FAIL LOUD: a query failure here must NOT be swallowed.
   * The previous `catch → return []` minted a token with ZERO resource
   * permissions whenever the read failed (e.g. relation missing, connection
   * blip), silently downgrading the user's authorization. That is a security
   * regression masquerading as resilience: a transient DB error must abort the
   * token mint, not issue a wrongly-scoped token. The DB error is now
   * log-and-rethrown (diagnostic breadcrumb preserved) so the caller
   * (generateTokens) rejects and the login fails cleanly instead of handing out
   * an under-privileged token.
   *
   * Authorization reads are deliberately authoritative on every mint. A
   * process-local cache would allow a removed grant to survive on one replica.
   */
  private async getUserResourcePermissions(user: User): Promise<string[]> {
    if (user.role === Role.SUPER_ADMIN || user.role === Role.TENANT_ADMIN) {
      return [];
    }

    if (!user.tenantId) {
      return [];
    }

    let permissions: string[];
    try {
      // CENTRALIZED auth-schema role tables: admin-api's
      // `1800500000000-TenantProvisioningTopology` migration (NOT auth-service's
      // own 1800500000000-AddRefreshTokenFamilyId, which shares the timestamp)
      // moved user_role_assignments / tenant_role_permissions / tenant_roles out of
      // per-tenant schemas into `auth` and DROPs the tenant copies (post-condition
      // RAISEs if any remain). This query targets auth.* with PARAMETER-BOUND
      // user_id + tenantId — no schema-name interpolation, so the prior SEC-M13
      // injection surface is structurally gone. TENANT ISOLATION is enforced by the
      // JOIN to auth.tenant_roles + WHERE tr."tenantId" = $2: only roles owned by
      // THIS user's tenant contribute, so a cross-tenant role_id can never leak
      // another tenant's resource permissions (stronger than the old per-schema
      // boundary, which the migration removed).
      const rows: Array<{
        resource_permissions: string[] | null;
        permission_overrides: unknown;
      }> = await this.dataSource.query(
        `
        SELECT trp.resource_permissions, ura.permission_overrides
        FROM "auth"."user_role_assignments" ura
        JOIN "auth"."tenant_roles" tr ON ura.role_id = tr.id
        JOIN "auth"."tenant_role_permissions" trp ON ura.role_id = trp.role_id
        WHERE ura.user_id = $1
          AND ura.is_active = true
          AND tr."tenantId" = $2
        `,
        [user.id, user.tenantId],
      );

      // auth.user_role_assignments has a UNIQUE index on user_id alone, so a user
      // holds AT MOST one active assignment → at most one row here. Accumulate the
      // role's base resource_permissions, then fold that assignment's per-user
      // overrides (grants/revokes) through the shared SSoT util so the JWT
      // `resourcePermissions` claim equals EXACTLY what the effective-permissions
      // read path (TenantUserManagementService) and the tenant-admin UI compute.
      // BEFORE: overrides were never selected here, so a per-user grant/revoke had
      // zero runtime effect — the guard enforced only the role's base set.
      // (SUPER_ADMIN / TENANT_ADMIN already short-circuited to [] above.)
      const roleBaseSet = new Set<string>();
      let overrides = { grants: [] as string[], revokes: [] as string[] };
      for (const row of rows) {
        if (Array.isArray(row.resource_permissions)) {
          for (const perm of row.resource_permissions) {
            roleBaseSet.add(perm);
          }
        }
        overrides = parsePermissionOverrides(row.permission_overrides);
      }

      const effective = applyPermissionOverrides(Array.from(roleBaseSet), overrides);

      // RBAC-HIGH-010: intersect with the tenant's LICENSED capability set so a
      // capability stored for a module the tenant no longer (or never) had —
      // a stale grant from a plan downgrade, or the MT-HIGH-057 backfill that
      // seeded messaging/AI caps onto every default role irrespective of
      // entitlement — is NEVER stamped into the JWT `resourcePermissions`
      // claim. This is the runtime chokepoint: even if such a grant survives in
      // tenant_role_permissions, the guard/subgraph never sees it, so the
      // capability has zero effect until the module is (re)licensed. The
      // write-time authority (CapabilityAuthorityService) blocks NEW
      // non-entitled grants; this closes the already-persisted ones.
      const entitled = await resolveEntitledCapabilities(
        (sql, params) => this.dataSource.query(sql, params as unknown[]),
        user.tenantId,
      );
      permissions = effective.filter((capability) => entitled.has(capability));
    } catch (error) {
      // PERF-HIGH-001 (a): log-and-rethrow — preserve the diagnostic breadcrumb
      // (which user/tenant) for operators, then FAIL LOUD so generateTokens
      // rejects. The previous behaviour swallowed this and returned [], minting
      // an under-privileged token; that silent authorization downgrade is the
      // exact regression this finding closes.
      this.logger.error(
        `Failed to load resource permissions for user ${user.id} in tenant ${user.tenantId}: ${(error as Error).message}`,
      );
      throw error;
    }

    return permissions;
  }

  private getRedirectUrl(
    user: User,
    modules: Array<{ code: string; name: string; defaultRoute: string }>,
  ): string {
    switch (user.role) {
      case Role.SUPER_ADMIN:
        return '/admin';
      case Role.TENANT_ADMIN:
        return '/tenant';
      case Role.MODULE_MANAGER:
      case Role.MODULE_USER:
        if (modules.length > 0 && modules[0]) {
          return modules[0].defaultRoute;
        }
        return '/no-access';
      default:
        return '/';
    }
  }
}
