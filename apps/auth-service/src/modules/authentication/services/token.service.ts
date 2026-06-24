import * as crypto from 'crypto';

import { getActiveSigningKid } from '@aquaculture/backend-common/auth';
import { Role } from '@aquaculture/backend-common/decorators';
import { ISessionManager, SESSION_MANAGER } from '@aquaculture/backend-common/security';
import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { TenantPlan, PLAN_LEVEL } from '@platform/event-contracts';
import * as bcrypt from 'bcryptjs';
import { DataSource, Repository } from 'typeorm';

import { MobileSettingsService } from '../../tenant/services/mobile-settings.service';
import { SECURITY_CONSTANTS } from '../../../constants/auth.constants';
import { AuthPayload } from '../dto/auth-response.dto';
import { RefreshToken } from '../entities/refresh-token.entity';
import { UserModuleAssignment } from '../entities/user-module-assignment.entity';
import { UserSiteAssignment } from '../entities/user-site-assignment.entity';
import { User } from '../entities/user.entity';

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
   * SUPER_ADMIN act-as: when a SUPER_ADMIN switches into a tenant
   * (switchTenant mutation), the token is re-minted with `tenantId` = the
   * target tenant AND this claim set to the same id, so downstream audit can
   * tell a genuine tenant-scoped login apart from a SUPER_ADMIN acting-as.
   * Absent on ordinary tokens.
   */
  actAsTenantId?: string;
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
   * where `type !== 'access'`, ensuring that short-lived MFA challenge tokens
   * and opaque refresh tokens cannot be replayed as bearer credentials.
   */
  type: 'access' | 'refresh' | 'mfa_challenge';
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

/**
 * Parse a time-duration string (e.g. '15m', '1h', '7d') into seconds.
 */
export function parseExpiresIn(expiresIn: string): number {
  const match = expiresIn.match(/^(\d+)([smhdw])$/);
  if (!match || !match[1] || !match[2]) return SECURITY_CONSTANTS.DEFAULT_JWT_EXPIRES_SECONDS;

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 's':
      return value;
    case 'm':
      return value * 60;
    case 'h':
      return value * 60 * 60;
    case 'd':
      return value * 24 * 60 * 60;
    case 'w':
      return value * 7 * 24 * 60 * 60;
    default:
      return SECURITY_CONSTANTS.DEFAULT_JWT_EXPIRES_SECONDS;
  }
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

  // PERF: In-memory cache for user module assignments (CRIT-03)
  // SECURITY (AUTH-M2): Bounded to MAX_MODULE_CACHE_SIZE using Map insertion-order LRU.
  // BEFORE: raw Map with no size bound — mass account creation / enumeration attacks
  // could grow this map to hundreds of thousands of entries, exhausting process memory.
  // AFTER: when the cache reaches capacity, the oldest (least-recently-inserted) entry
  // is evicted before the new one is added. Map preserves insertion order in JS/TS,
  // so keys().next().value is always the oldest entry — O(1) eviction.
  // Combined with 60-second TTL (lazy eviction on access), memory is always bounded.
  private static readonly MAX_MODULE_CACHE_SIZE = 5_000;
  private readonly moduleCache = new Map<string, {
    modules: Array<{ code: string; name: string; defaultRoute: string }>;
    cachedAt: number;
  }>();
  // WHY: In-memory cache — stale for up to TTL across pods. Use Redis pub/sub for instant invalidation when multi-pod.
  private readonly moduleCacheTtlMs = 60 * 1000; // 60 seconds

  // PERF (PERF-HIGH-001): In-memory LRU cache for resolved tenant-level resource
  // permissions, mirroring the module cache above.
  // WHY: getUserResourcePermissions runs on every token mint and performs a
  // two-table JOIN against the role-assignment tables. Resource permissions
  // change far less often than tokens are minted, so caching the resolved set
  // per user collapses the hot-path read to a single round-trip on a miss.
  // WHAT: Same Map insertion-order LRU + MAX_MODULE_CACHE_SIZE cap + 60s TTL as
  // the module cache, keyed by user.id, so memory is always bounded against
  // mass account creation / enumeration. A miss (or stale entry) re-queries;
  // capacity eviction drops the oldest (least-recently-inserted) entry first.
  private readonly resourcePermissionCache = new Map<string, {
    permissions: string[];
    cachedAt: number;
  }>();
  private readonly resourcePermissionCacheTtlMs = 60 * 1000; // 60 seconds

  constructor(
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
    this.hashRefreshTokens = this.configService.get<boolean>('HASH_REFRESH_TOKENS', true);
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
    options?: {
      mfaVerified?: boolean;
      familyId?: string;
      rememberMe?: boolean;
      /**
       * SUPER_ADMIN act-as: mint the token scoped to this target tenant instead
       * of the user's own tenant. The CALLER must have already verified the user
       * is a SUPER_ADMIN and the target tenant is ACTIVE (see
       * AuthService.switchTenant) — this method does not re-authorize.
       */
      actAsTenantId?: string;
    },
  ): Promise<AuthPayload> {
    // SSoT: the effective tenant this token is scoped to — the act-as target for
    // a SUPER_ADMIN switch, otherwise the user's own tenant.
    const effectiveTenantId = options?.actAsTenantId ?? user.tenantId ?? null;
    // Enforce concurrent session limit
    if (this.sessionManager) {
      await this.sessionManager.enforceSessionLimit(user.id, this.maxSessionsPerUser);
    }

    // PERF (PERF-HIGH-003): the refresh-token random bytes are independent of
    // every DB read, and bcrypt.hash is CPU-bound (~tens of ms). Generate the
    // random material now and START the hash promise BEFORE awaiting the reads
    // so the hash runs concurrently with the module/permission/plan round-trips
    // instead of serially after them. When HASH_REFRESH_TOKENS is off the raw
    // value is wrapped in an already-resolved promise so the await below is a
    // no-op — semantics are preserved either way.
    const refreshTokenRandom = crypto.randomBytes(64).toString('hex');
    const tokenToStorePromise: Promise<string> = this.hashRefreshTokens
      ? bcrypt.hash(refreshTokenRandom, SECURITY_CONSTANTS.BCRYPT_SALT_ROUNDS)
      : Promise.resolve(refreshTokenRandom);

    // Hot-path reads run concurrently: the user's module codes, tenant-level
    // resource permissions, the tenant's plan-tier ordinal (the MT-MEDIUM-001
    // JWT claim), the user's assigned site ids (SEC-HIGH-051) and enabled mobile
    // features (SEC-HIGH-052) are independent, so a single Promise.all keeps
    // token mint to one read latency instead of five serial round-trips.
    const [modules, resourcePermissions, planLevel, assignedSiteIds, mobileFeatures] =
      await Promise.all([
        this.getUserModules(user),
        this.getUserResourcePermissions(user),
        this.resolveTenantPlanLevel(effectiveTenantId),
        this.getUserAssignedSiteIds(user),
        this.getUserMobileFeatures(user),
      ]);
    const moduleCodes = modules.map((m) => m.code);

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
      // SUPER_ADMIN act-as audit marker (only when switching into a tenant).
      ...(options?.actAsTenantId ? { actAsTenantId: options.actAsTenantId } : {}),
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
      // IP-2: MFA step-up claim — set after successful TOTP verification.
      // TenantGuard checks this claim for cross-tenant access (MFA_REQUIRED_FOR_CROSS_TENANT=true).
      ...(options?.mfaVerified ? { mfaVerified: true } : {}),
    };

    // SECURITY (SEC-HIGH-003): include audience (anti cross-service replay)
    // AND the `kid` header so verifiers can deterministically select the
    // matching JWKS public key during a rotation overlap. The kid is derived
    // from the same SSoT (getActiveSigningKid) the JWKS controller publishes,
    // making header/JWKS drift impossible.
    const accessToken = await this.jwtService.signAsync(payload, {
      audience: this.configService.get<string>('JWT_AUDIENCE', 'aquaculture-platform'),
      keyid: getActiveSigningKid(this.configService),
    });

    // SECURITY: Prefix refresh token with userId so the lookup can be scoped per-user.
    const refreshTokenValue = this.hashRefreshTokens
      ? `${user.id}:${refreshTokenRandom}`
      : refreshTokenRandom;

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

    // Create refresh token
    const refreshToken = this.refreshTokenRepository.create({
      token: tokenToStore,
      userId: user.id,
      tenantId: user.tenantId,
      familyId,
      rememberMe,
      expiresAt: new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000),
      ipAddress,
      userAgent,
    });

    // PERF (PERF-HIGH-003): the refresh-token row insert and the session
    // creation are independent writes (the session limit was already enforced
    // up front), so issue both concurrently and await together rather than
    // serially. Order does not matter: neither depends on the other's result.
    const persistPromises: Array<Promise<unknown>> = [
      this.refreshTokenRepository.save(refreshToken),
    ];
    if (this.sessionManager) {
      persistPromises.push(
        this.sessionManager.createSession(user.id, {
          ipAddress,
          userAgent,
          tenantId: user.tenantId ?? undefined,
        }),
      );
    }
    await Promise.all(persistPromises);

    const expiresIn = this.configService.get<string>('JWT_EXPIRES_IN', '15m');
    const expiresInSeconds = parseExpiresIn(expiresIn);

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

  /**
   * Invalidate the per-user hot-path caches (call when module OR role
   * assignments change). Clears both the module cache and the
   * resource-permission cache (PERF-HIGH-001) so a permission change is not
   * masked for up to the TTL after an explicit invalidation.
   */
  invalidateModuleCache(userId: string): void {
    this.moduleCache.delete(userId);
    this.resourcePermissionCache.delete(userId);
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  async getUserModules(user: User): Promise<Array<{ code: string; name: string; defaultRoute: string }>> {
    if (user.role === Role.SUPER_ADMIN) {
      // SUPER_ADMIN sees ALL active modules (platform-wide, not tenant-scoped).
      // Previous behavior returned [] which made the sidebar empty.
      const allModules = await this.dataSource.query<Array<{ code: string; name: string; defaultRoute: string }>>(
        `SELECT code, name, "defaultRoute"
         FROM auth.modules
         WHERE "isActive" = true
         ORDER BY "sortOrder" ASC, name ASC`,
      );
      return allModules;
    }

    const cached = this.moduleCache.get(user.id);
    if (cached && (Date.now() - cached.cachedAt) < this.moduleCacheTtlMs) {
      return cached.modules;
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

    // LRU eviction: if at capacity, remove the oldest entry before inserting.
    // Map.keys() returns keys in insertion order — first key is the oldest entry.
    if (this.moduleCache.size >= TokenService.MAX_MODULE_CACHE_SIZE) {
      const oldestKey = this.moduleCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.moduleCache.delete(oldestKey);
      }
    }
    this.moduleCache.set(user.id, { modules, cachedAt: Date.now() });
    return modules;
  }

  /**
   * SEC-HIGH-051: resolve the user's assigned farm-service Site ids for the
   * `assignedSiteIds` JWT claim.
   *
   * SUPER_ADMIN/TENANT_ADMIN return [] — they bypass site checks via the
   * canonical `roleHasPermission(role, MODULE_MANAGER)` hierarchy (mirroring the
   * user_module_assignments TENANT_ADMIN-inherits precedent). MODULE_MANAGER and
   * MODULE_USER load their active, non-expired assignments. MODULE_MANAGER also
   * bypasses at the guard, but we still emit its sites so a future tighter
   * policy has the data and the claim is consistent.
   */
  private async getUserAssignedSiteIds(user: User): Promise<string[]> {
    if (user.role === Role.SUPER_ADMIN || user.role === Role.TENANT_ADMIN) {
      return [];
    }

    const assignments = await this.userSiteAssignmentRepository.find({
      where: { userId: user.id, isActive: true },
    });

    return assignments
      .filter((a) => a.isAccessible())
      .map((a) => a.siteId);
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
   * Resolve the tenant's plan-tier ordinal for the JWT `planLevel` claim
   * (MT-MEDIUM-001). Platform accounts with no tenant (SUPER_ADMIN) have no
   * plan, so the claim is omitted. An unrecognised plan string falls back to 0
   * (FREE-equivalent) so a data anomaly can never silently unlock a paid tier.
   */
  private async resolveTenantPlanLevel(
    tenantId: string | null,
  ): Promise<number | undefined> {
    if (!tenantId) {
      return undefined;
    }
    const rows = await this.dataSource.query<Array<{ plan: string }>>(
      `SELECT plan FROM auth.tenants WHERE id = $1 LIMIT 1`,
      [tenantId],
    );
    const plan = rows[0]?.plan as TenantPlan | undefined;
    if (!plan) {
      return undefined;
    }
    return PLAN_LEVEL[plan] ?? 0;
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
   * PERF-HIGH-001 (b) — the resolved permission set is cached per user in a
   * bounded LRU (see resourcePermissionCache) so this two-table JOIN does not
   * run on every token mint.
   */
  private async getUserResourcePermissions(user: User): Promise<string[]> {
    if (user.role === Role.SUPER_ADMIN || user.role === Role.TENANT_ADMIN) {
      return [];
    }

    if (!user.tenantId) {
      return [];
    }

    // Cache hit within TTL short-circuits the JOIN. Same lazy-TTL eviction as
    // the module cache: stale entries fall through and re-query below.
    const cached = this.resourcePermissionCache.get(user.id);
    if (cached && (Date.now() - cached.cachedAt) < this.resourcePermissionCacheTtlMs) {
      return cached.permissions;
    }

    let permissions: string[];
    try {
      // CENTRALIZED auth-schema role tables: the 1800500000000 topology migration
      // moved user_role_assignments / tenant_role_permissions / tenant_roles out of
      // per-tenant schemas into `auth` and DROPs the tenant copies (post-condition
      // RAISEs if any remain). This query targets auth.* with PARAMETER-BOUND
      // user_id + tenantId — no schema-name interpolation, so the prior SEC-M13
      // injection surface is structurally gone. TENANT ISOLATION is enforced by the
      // JOIN to auth.tenant_roles + WHERE tr."tenantId" = $2: only roles owned by
      // THIS user's tenant contribute, so a cross-tenant role_id can never leak
      // another tenant's resource permissions (stronger than the old per-schema
      // boundary, which the migration removed).
      const rows: Array<{ resource_permissions: string[] | null }> = await this.dataSource.query(
        `
        SELECT trp.resource_permissions
        FROM "auth"."user_role_assignments" ura
        JOIN "auth"."tenant_roles" tr ON ura.role_id = tr.id
        JOIN "auth"."tenant_role_permissions" trp ON ura.role_id = trp.role_id
        WHERE ura.user_id = $1
          AND ura.is_active = true
          AND tr."tenantId" = $2
        `,
        [user.id, user.tenantId],
      );

      const permissionSet = new Set<string>();
      for (const row of rows) {
        if (Array.isArray(row.resource_permissions)) {
          for (const perm of row.resource_permissions) {
            permissionSet.add(perm);
          }
        }
      }

      permissions = Array.from(permissionSet);
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

    // LRU eviction: if at capacity, remove the oldest entry before inserting.
    // Map.keys() returns keys in insertion order — first key is the oldest entry.
    if (this.resourcePermissionCache.size >= TokenService.MAX_MODULE_CACHE_SIZE) {
      const oldestKey = this.resourcePermissionCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.resourcePermissionCache.delete(oldestKey);
      }
    }
    this.resourcePermissionCache.set(user.id, { permissions, cachedAt: Date.now() });
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
