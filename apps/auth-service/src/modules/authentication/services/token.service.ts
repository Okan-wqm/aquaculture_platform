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
 * JWT Payload structure — exported for guards and other consumers.
 */
export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
  roles: Role[];
  tenantId: string | null;
  modules?: string[];
  resourcePermissions?: string[];
  /**
   * User's first and last name, included in the JWT so that downstream services
   * can denormalize the display name into audit trail records (e.g., stock
   * movements, task completions) without cross-service queries to auth-service.
   * These fields are optional — older tokens without them will still work.
   */
  firstName?: string;
  lastName?: string;
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

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      roles: [user.role],
      tenantId: user.tenantId ?? null,
      modules: moduleCodes.length > 0 ? moduleCodes : undefined,
      resourcePermissions: resourcePermissions.length > 0 ? resourcePermissions : undefined,
      // Include user display name for audit trail denormalization in downstream
      // services. Farm-service stores this on stock movements so the movement
      // history shows WHO performed each action without cross-service queries.
      firstName: user.firstName ?? undefined,
      lastName: user.lastName ?? undefined,
      jti,
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
