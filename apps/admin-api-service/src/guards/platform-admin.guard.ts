import {
  enforceAccessTokenType,
  enforceTokenNotRevoked,
  getJwtVerifyOptions,
} from '@aquaculture/backend-common/auth';
import { requestContextStorage } from '@aquaculture/backend-common/logging';
import {
  SecurityEventService,
  SlidingWindowStrategy,
  TOKEN_BLACKLIST,
  USER_TOKEN_REVOCATION,
  type ITokenBlacklist,
  type IUserTokenRevocation,
} from '@aquaculture/backend-common/security';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PLATFORM_ROLE_DEFINITIONS, isPlatformRole, type Role } from '@platform/identity';
import { isTenantPermissionCode, type TenantPermissionCode } from '@platform/tenant-permissions';
import * as jwt from 'jsonwebtoken';

import { adminRouteContractIdFromExecutionContext } from '../bootstrap/admin-request-contract.guard';
import { ADMIN_SERVER_ROUTE_AUTHORIZATION } from '../bootstrap/generated/admin-request-contracts.generated';
// Bind the WRITER to the canonical request-user SSoT: AuthenticatedUser extends
// JwtUser, so `request.user = { ... }` below fails type-check if it omits `sub`
// (ORPHAN-146). The shared ThrottlerGuard reads that same `sub`.
import { AuthenticatedRequest } from '../shared/authenticated-request';

function errorDetails(error: unknown): { readonly message: string; readonly stack?: string } {
  return error instanceof Error
    ? { message: error.message, stack: error.stack }
    : { message: 'unknown authentication failure' };
}

function unauthorizedReason(exception: UnauthorizedException): string {
  const response = exception.getResponse();
  if (typeof response === 'string') return response;
  if (typeof response === 'object' && response !== null && 'message' in response) {
    const message = response.message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message))
      return message.filter((entry) => typeof entry === 'string').join(', ');
  }
  return exception.message || 'Unauthorized';
}

function positiveIntegerConfig(
  configService: ConfigService,
  key: string,
  fallback: number,
): number {
  const configured = configService.get<string | number>(key);
  if (configured === undefined) return fallback;
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${key} must be a positive integer`);
  }
  return parsed;
}

export function hasGeneratedRoutePermissions(
  matchingRoles: readonly Role[],
  grantedPermissions: ReadonlySet<TenantPermissionCode>,
  requiredPermissions: readonly TenantPermissionCode[],
): boolean {
  if (matchingRoles.some((role) => PLATFORM_ROLE_DEFINITIONS[role].permissionMode === 'all')) {
    return true;
  }
  return requiredPermissions.every((permission) => grantedPermissions.has(permission));
}

// WHY: Explicit @Inject() required — useClass + APP_GUARD relies on design:paramtypes
// metadata which may not survive all build/runtime environments (Alpine musl, prod-only deps).
// getJwtVerifyOptions: centralised JWT verification options (RS256 public
// key, issuer, audience).
// BEFORE: guard used `import * as jwt from 'jsonwebtoken'` with jwt.verify() —
// synchronous (blocks event loop), no algorithm restriction, no issuer/audience check.
// AFTER: guard uses JwtService.verifyAsync() with getJwtVerifyOptions() — async,
// algorithm-restricted to RS256 (asymmetric — auth-service signs with the
// private key, every consumer verifies with the public key), issuer + audience
// enforced at library level. jsonwebtoken still imported for error
// type-checking in the catch block.

/**
 * JWT payload structure for admin-api guard.
 *
 * SECURITY (H-08): email is now optional because auth-service no longer
 * embeds PII (email, firstName, lastName) in JWT tokens. Services that
 * need the user's email should fetch it from auth-service using the sub (user ID).
 */
export interface JwtPayload {
  sub: string;
  /** @deprecated Optional -- JWT no longer carries email PII (H-08) */
  email?: string;
  role?: unknown;
  roles?: unknown;
  resourcePermissions?: unknown;
  tenantId?: string;
  mfaVerified?: boolean;
  type?: string;
  jti?: string;
  iat: number;
  exp: number;
}

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  private readonly logger = new Logger(PlatformAdminGuard.name);
  private readonly failedAuthLimit: number;
  private readonly failedAuthWindowMs: number;

  constructor(
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Inject(JwtService) private readonly jwtService: JwtService,
    @Inject(TOKEN_BLACKLIST) private readonly tokenBlacklist: ITokenBlacklist,
    @Inject(USER_TOKEN_REVOCATION)
    private readonly userTokenRevocation: IUserTokenRevocation,
    @Inject(SlidingWindowStrategy)
    private readonly rateLimiter: SlidingWindowStrategy,
    @Inject(SecurityEventService)
    private readonly securityEvents: SecurityEventService,
  ) {
    // SECURITY (CRITICAL-001): JWT_SECRET length validation removed in WS2.B
    // (2026-04-14). The check was a hold-over from the HS256 era — verifyAsync
    // already uses getJwtVerifyOptions() which loads the RS256 public key and
    // throws at startup if it is missing. There is no JWT_SECRET to validate
    // anymore; reading it would also trip the ESLint no-restricted-syntax
    // ban on JWT_SECRET reads (WS2.C).
    this.failedAuthLimit = positiveIntegerConfig(this.configService, 'ADMIN_FAILED_AUTH_LIMIT', 20);
    this.failedAuthWindowMs = positiveIntegerConfig(
      this.configService,
      'ADMIN_FAILED_AUTH_WINDOW_MS',
      60_000,
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const routeId = adminRouteContractIdFromExecutionContext(context);
    const authorization = ADMIN_SERVER_ROUTE_AUTHORIZATION[routeId];
    if (authorization === undefined) {
      throw new ServiceUnavailableException(
        `admin authorization catalog has no entry for ${routeId}`,
      );
    }
    if (authorization.authentication === 'public') return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authHeader = request.headers.authorization;

    if (!authHeader) {
      return this.rejectAuthentication(
        context,
        request,
        new UnauthorizedException('No authorization header provided'),
      );
    }

    const [type, token] = authHeader.split(' ');

    if (type !== 'Bearer' || !token) {
      return this.rejectAuthentication(
        context,
        request,
        new UnauthorizedException('Invalid authorization header format'),
      );
    }

    try {
      // BEFORE: jwt.verify() — synchronous, no algorithm restriction, no iss/aud validation.
      // AFTER: JwtService.verifyAsync() with getJwtVerifyOptions() — async (non-blocking),
      // RS256 algorithm enforced, issuer and audience validated at jsonwebtoken library level.
      const payload = await this.jwtService.verifyAsync<JwtPayload>(
        token,
        getJwtVerifyOptions(this.configService),
      );
      enforceAccessTokenType(
        payload,
        this.logger,
        this.configService.get<string>('NODE_ENV') === 'production',
      );
      await enforceTokenNotRevoked(
        payload,
        {
          tokenBlacklist: this.tokenBlacklist,
          userTokenRevocation: this.userTokenRevocation,
        },
        this.logger,
      );

      // Normalize user roles - tekil role varsa array'e çevir
      const claimedRoles = Array.isArray(payload.roles)
        ? payload.roles
        : typeof payload.role === 'string'
          ? [payload.role]
          : [];
      const userRoles = claimedRoles.filter(isPlatformRole);
      const resourcePermissions = Array.isArray(payload.resourcePermissions)
        ? payload.resourcePermissions.filter(isTenantPermissionCode)
        : [];

      // Attach user to request first (for later use in controllers).
      // WHY both `sub` and `id`: the shared backend-common ThrottlerGuard (and
      // every `@CurrentUser('sub')` consumer) reads the canonical JWT subject
      // as `request.user.sub`. This guard historically exposed ONLY `id`, so
      // the throttler saw `user.sub === undefined`, classified every
      // authenticated SUPER_ADMIN as ANONYMOUS (20 req/60s) AND keyed the bucket
      // by IP instead of user — a single operator's admin-panel fan-out tripped
      // 429s. `id` stays as admin-api's local convention (controllers read it).
      request.user = {
        sub: payload.sub,
        id: payload.sub,
        email: payload.email,
        roles: userRoles,
        role: userRoles[0],
        tenantId: payload.tenantId,
        mfaVerified: payload.mfaVerified === true,
        resourcePermissions,
      };

      const requestContext = requestContextStorage.getStore();
      if (requestContext) {
        requestContext.userId = payload.sub;
        requestContext.tenantId = payload.tenantId;
      }

      const matchingRoles = userRoles.filter((userRole) =>
        authorization.requiredRoles.includes(userRole),
      );

      if (matchingRoles.length === 0) {
        // SECURITY: Log user ID only -- do not include email PII in logs (H-14)
        this.logger.warn(
          `Access denied for userId=${payload.sub}: ` +
            `has roles [${userRoles.join(', ')}], requires one of ` +
            `[${authorization.requiredRoles.join(', ')}]`,
        );
        throw new ForbiddenException(
          `Access denied. Required roles: ${authorization.requiredRoles.join(', ')}`,
        );
      }

      const grantedPermissions = new Set(resourcePermissions);
      if (
        !hasGeneratedRoutePermissions(
          matchingRoles,
          grantedPermissions,
          authorization.requiredPermissions,
        )
      ) {
        const missingPermissions = authorization.requiredPermissions.filter(
          (permission) => !grantedPermissions.has(permission),
        );
        this.logger.warn(
          `Access denied for userId=${payload.sub}: missing generated route permissions ` +
            `[${missingPermissions.join(', ')}]`,
        );
        throw new ForbiddenException('Access denied. Required permissions are missing');
      }

      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }

      if (error instanceof UnauthorizedException) {
        return this.rejectAuthentication(context, request, error);
      }

      if (error instanceof jwt.TokenExpiredError) {
        return this.rejectAuthentication(
          context,
          request,
          new UnauthorizedException('Token has expired'),
        );
      }

      if (error instanceof jwt.JsonWebTokenError) {
        return this.rejectAuthentication(
          context,
          request,
          new UnauthorizedException('Invalid token'),
        );
      }

      const details = errorDetails(error);
      this.logger.error(
        `Authentication error for ${request.method} ${request.url}: ${details.message}`,
        details.stack,
      );
      return this.rejectAuthentication(
        context,
        request,
        new UnauthorizedException('Authentication failed'),
      );
    }
  }

  /**
   * PlatformAdminGuard runs before the ordinary ThrottlerGuard, therefore all
   * failed JWT attempts are accounted here. The bucket is backed by the same
   * atomic Redis sliding-window authority as normal requests.
   */
  private async rejectAuthentication(
    context: ExecutionContext,
    request: AuthenticatedRequest,
    unauthorized: UnauthorizedException,
  ): Promise<never> {
    const ip = request.ip || request.socket?.remoteAddress || 'unknown-ip';
    const reason = unauthorizedReason(unauthorized);
    const result = await this.rateLimiter.consumeWithConfig(
      `admin-failed-auth:ip:${ip}`,
      this.failedAuthLimit,
      this.failedAuthWindowMs,
    );

    this.logger.warn(
      JSON.stringify({
        event: 'admin_authentication_rejected',
        method: request.method,
        path: request.path || request.url,
        ip,
        reason,
      }),
    );
    await this.securityEvents.publishTokenRejected({
      ip,
      userAgent: request.get?.('user-agent'),
      reason,
    });

    if (!result.allowed) {
      const retryAfter = result.retryAfter ?? Math.ceil(this.failedAuthWindowMs / 1000);
      context
        .switchToHttp()
        .getResponse<{ setHeader?(name: string, value: string): void }>()
        ?.setHeader?.('Retry-After', String(retryAfter));
      await this.securityEvents.publishRateLimitExceeded({
        ip,
        key: 'admin-failed-auth:ip',
        limit: this.failedAuthLimit,
        windowMs: this.failedAuthWindowMs,
        count: this.failedAuthLimit + 1,
      });
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too many failed authentication attempts',
          error: 'Too Many Requests',
          retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    throw unauthorized;
  }
}
