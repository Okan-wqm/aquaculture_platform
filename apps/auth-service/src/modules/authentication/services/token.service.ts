import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';

import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  Role,
  ISessionManager,
  SESSION_MANAGER,
} from '@aquaculture/backend-common';

import { SECURITY_CONSTANTS } from '../../../constants/auth.constants';
import { RefreshToken } from '../entities/refresh-token.entity';
import { UserModuleAssignment } from '../entities/user-module-assignment.entity';
import { User } from '../entities/user.entity';
import { AuthPayload } from '../dto/auth-response.dto';

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
  modules?: string[];
  resourcePermissions?: string[];
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
  private readonly hashRefreshTokens: boolean;
  private readonly maxSessionsPerUser: number;

  // PERF: In-memory cache for user module assignments (CRIT-03)
  // SECURITY (AUTH-M2): Bounded to MAX_MODULE_CACHE_SIZE using Map insertion-order LRU.
  // BEFORE: raw Map with no size bound — mass account creation / enumeration attacks
  // could grow this map to hundreds of thousands of entries, exhausting process memory.
  // AFTER: when the cache reaches capacity, the oldest (least-recently-inserted) entry
  // is evicted before the new one is added. Map preserves insertion order in JS/TS,
  // so keys().next().value is always the oldest entry — O(1) eviction.
  // Combined with 5-minute TTL (lazy eviction on access), memory is always bounded.
  private static readonly MAX_MODULE_CACHE_SIZE = 5_000;
  private readonly moduleCache = new Map<string, {
    modules: Array<{ code: string; name: string; defaultRoute: string }>;
    cachedAt: number;
  }>();
  private readonly moduleCacheTtlMs = 5 * 60 * 1000; // 5 minutes

  constructor(
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepository: Repository<RefreshToken>,
    @InjectRepository(UserModuleAssignment)
    private readonly userModuleAssignmentRepository: Repository<UserModuleAssignment>,
    private readonly dataSource: DataSource,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Optional() @Inject(SESSION_MANAGER) private readonly sessionManager?: ISessionManager,
  ) {
    this.refreshTokenExpiryDays = this.configService.get<number>(
      'REFRESH_TOKEN_EXPIRY_DAYS',
      SECURITY_CONSTANTS.DEFAULT_REFRESH_TOKEN_EXPIRY_DAYS,
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
    options?: { mfaVerified?: boolean },
  ): Promise<AuthPayload> {
    // Enforce concurrent session limit
    if (this.sessionManager) {
      await this.sessionManager.enforceSessionLimit(user.id, this.maxSessionsPerUser);
    }

    // Get user's module codes for JWT
    const modules = await this.getUserModules(user);
    const moduleCodes = modules.map((m) => m.code);

    // Get user's tenant-level resource permissions for JWT (MODULE_MANAGER, MODULE_USER only)
    const resourcePermissions = await this.getUserResourcePermissions(user);

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
      tenantId: user.tenantId ?? null,
      modules: moduleCodes.length > 0 ? moduleCodes : undefined,
      resourcePermissions: resourcePermissions.length > 0 ? resourcePermissions : undefined,
      type: 'access',
      jti,
      // IP-2: MFA step-up claim — set after successful TOTP verification.
      // TenantGuard checks this claim for cross-tenant access (MFA_REQUIRED_FOR_CROSS_TENANT=true).
      ...(options?.mfaVerified ? { mfaVerified: true } : {}),
    };

    // SECURITY: Include audience claim to prevent cross-service token replay
    const accessToken = await this.jwtService.signAsync(payload, {
      audience: this.configService.get<string>('JWT_AUDIENCE', 'aquaculture-platform'),
    });
    const refreshTokenRandom = crypto.randomBytes(64).toString('hex');

    // SECURITY: Prefix refresh token with userId so the lookup can be scoped per-user.
    const refreshTokenValue = this.hashRefreshTokens
      ? `${user.id}:${refreshTokenRandom}`
      : refreshTokenRandom;

    // SECURITY: Hash refresh token before storage
    let tokenToStore = refreshTokenRandom;
    if (this.hashRefreshTokens) {
      tokenToStore = await bcrypt.hash(refreshTokenRandom, SECURITY_CONSTANTS.BCRYPT_SALT_ROUNDS);
    }

    // Create refresh token
    const refreshToken = this.refreshTokenRepository.create({
      token: tokenToStore,
      userId: user.id,
      tenantId: user.tenantId,
      expiresAt: new Date(Date.now() + this.refreshTokenExpiryDays * 24 * 60 * 60 * 1000),
      ipAddress,
      userAgent,
    });

    await this.refreshTokenRepository.save(refreshToken);

    // Create session if session manager is available
    if (this.sessionManager) {
      await this.sessionManager.createSession(user.id, {
        ipAddress,
        userAgent,
        tenantId: user.tenantId ?? undefined,
      });
    }

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
    };
  }

  /**
   * Invalidate module cache for a user (call when module assignments change).
   */
  invalidateModuleCache(userId: string): void {
    this.moduleCache.delete(userId);
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  async getUserModules(user: User): Promise<Array<{ code: string; name: string; defaultRoute: string }>> {
    if (user.role === Role.SUPER_ADMIN) {
      return [];
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
   * Get user's tenant-level resource permissions from their role assignment.
   */
  private async getUserResourcePermissions(user: User): Promise<string[]> {
    if (user.role === Role.SUPER_ADMIN || user.role === Role.TENANT_ADMIN) {
      return [];
    }

    if (!user.tenantId) {
      return [];
    }

    try {
      const cleanId = user.tenantId.replace(/-/g, '').substring(0, 16).toLowerCase();
      const schemaName = `tenant_${cleanId}`;

      /**
       * SEC-M13: Validate schema name before SQL interpolation to prevent injection.
       * Defense-in-depth — the cleanId derivation above already constrains the format,
       * but explicit validation ensures no code path can bypass the check.
       */
      const TENANT_SCHEMA_REGEX = /^tenant_[a-f0-9]{16}$/;
      if (!TENANT_SCHEMA_REGEX.test(schemaName)) {
        throw new Error(`SEC-M13: Invalid schema name format: ${schemaName}`);
      }

      const rows: Array<{ resource_permissions: string[] | null }> = await this.dataSource.query(
        `
        SELECT trp.resource_permissions
        FROM "${schemaName}"."user_role_assignments" ura
        JOIN "${schemaName}"."tenant_role_permissions" trp ON ura.role_id = trp.role_id
        WHERE ura.user_id = $1 AND ura.is_active = true
        `,
        [user.id],
      );

      const permissionSet = new Set<string>();
      for (const row of rows) {
        if (Array.isArray(row.resource_permissions)) {
          for (const perm of row.resource_permissions) {
            permissionSet.add(perm);
          }
        }
      }

      return Array.from(permissionSet);
    } catch (error) {
      this.logger.warn(
        `Failed to load resource permissions for user ${user.id} in tenant ${user.tenantId}: ${(error as Error).message}`,
      );
      return [];
    }
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
