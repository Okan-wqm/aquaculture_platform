import {
  enforceAccessTokenType,
  enforceTokenNotRevoked,
  getJwtVerifyOptions,
} from '@aquaculture/backend-common/auth';
import { requestContextStorage } from '@aquaculture/backend-common/logging';
import {
  IpRateLimiterService,
  ITokenBlacklist,
  IUserTokenRevocation,
  SecurityEventService,
  TOKEN_BLACKLIST,
  USER_TOKEN_REVOCATION,
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
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import * as jwt from 'jsonwebtoken';

import { ROLES_KEY } from '../decorators/roles.decorator';
// APA-371: read the platform-SSoT bypass key (re-exported from backend-common)
// instead of declaring a local 'isPublic' copy the guard must keep in sync.
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
// Bind the WRITER to the canonical request-user SSoT: AuthenticatedUser extends
// JwtUser, so `request.user = { ... }` below fails type-check if it omits `sub`
// (ORPHAN-146). The shared ThrottlerGuard reads that same `sub`.
import { AuthenticatedRequest } from '../shared/authenticated-request';

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
  role?: string;
  roles?: string[];
  tenantId?: string;
  type?: string;
  jti?: string;
  iat: number;
  exp: number;
}

// Product language calls this actor "platform admin"; the auth domain
// represents that platform-level operator with the existing SUPER_ADMIN role.
const DEFAULT_ADMIN_ROLES = ['SUPER_ADMIN', 'super_admin'];

/** Extract a human-readable reason from an UnauthorizedException for logging + events. */
function reasonOf(exception: UnauthorizedException): string {
  const response = exception.getResponse();
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object' && 'message' in response) {
    const message = (response as { message?: unknown }).message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.join(', ');
  }
  return exception.message || 'Unauthorized';
}

/** Normalize a possibly-array header to a single string value. */
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  private readonly logger = new Logger(PlatformAdminGuard.name);

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Inject(JwtService) private readonly jwtService: JwtService,
    // APA-367: admin-api is a directly-reachable auth boundary (prod nginx routes
    // /api/ straight here, bypassing gateway-api's blacklist-checking guard), so
    // it MUST self-enforce token revocation. Both stores are REQUIRED (not
    // @Optional): the @Global TokenBlacklistModule + UserTokenRevocationModule are
    // registered in app.module, so a missing wiring fails DI at boot rather than
    // silently disabling revocation on the most privileged surface. In production
    // TokenBlacklistService itself fails fast unless Redis is configured, so the
    // check is cross-instance correct.
    @Inject(TOKEN_BLACKLIST) private readonly tokenBlacklist: ITokenBlacklist,
    @Inject(USER_TOKEN_REVOCATION)
    private readonly userTokenRevocation: IUserTokenRevocation,
    // APA-369: this guard is the FIRST APP_GUARD, so a request with a
    // missing/invalid/expired/forged/revoked Bearer is rejected here BEFORE the
    // shared ThrottlerGuard (registered second) ever runs — token brute-force /
    // credential-stuffing against the platform-admin API was never app-throttled
    // and produced no security event. Reordering the guards is unsound (the
    // ThrottlerGuard reads request.user.sub, which only THIS guard populates, so
    // throttle-first would re-classify every authenticated SUPER_ADMIN as
    // anonymous). Instead we account each auth FAILURE against a per-IP bucket
    // (only failures increment it, so a valid operator's fan-out never counts)
    // and emit a security event that reaches the incident pipeline.
    @Inject(IpRateLimiterService)
    private readonly failedAuthIpLimiter: IpRateLimiterService,
    @Inject(SecurityEventService)
    private readonly securityEvents: SecurityEventService,
  ) {
    // SECURITY (CRITICAL-001): JWT_SECRET length validation removed in WS2.B
    // (2026-04-14). The check was a hold-over from the HS256 era — verifyAsync
    // already uses getJwtVerifyOptions() which loads the RS256 public key and
    // throws at startup if it is missing. There is no JWT_SECRET to validate
    // anymore; reading it would also trip the ESLint no-restricted-syntax
    // ban on JWT_SECRET reads (WS2.C).
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Hybrid-app boundary: this guard authenticates the HTTP surface only.
    // admin-api-service also consumes NATS events (RPC context) — those are
    // authenticated by the broker-verified mTLS client-cert CN (ADR-015) and
    // the per-subject publish ACL (e.g. only farm-service may publish
    // TenantOnboardingAck), NOT by a Bearer JWT, which does not exist on the
    // NATS surface. Without this short-circuit the guard would call
    // switchToHttp().getRequest() on an RPC context and reject every event.
    if (context.getType() !== 'http') {
      return true;
    }

    // Check if route is marked as public
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authHeader = request.headers.authorization;

    if (!authHeader) {
      return this.rejectAuth(
        context,
        request,
        new UnauthorizedException('No authorization header provided'),
      );
    }

    const [type, token] = authHeader.split(' ');

    if (type !== 'Bearer' || !token) {
      return this.rejectAuth(
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

      // APA-367: mandatory post-verify revocation check. A signature-valid
      // SUPER_ADMIN token whose session was force-logged-out, whose owner was
      // deactivated/deleted, or whose password was reset must be rejected here —
      // otherwise the token keeps working against admin-api until natural expiry,
      // silently defeating the platform's emergency-cutoff controls. Consults
      // both revocation namespaces (per-jti/user blacklist + user_blacklist epoch)
      // via the shared primitive so admin-api cannot drift out of the contract
      // that gateway-api and auth-service already enforce.
      await enforceTokenNotRevoked(
        payload,
        {
          tokenBlacklist: this.tokenBlacklist,
          userTokenRevocation: this.userTokenRevocation,
        },
        this.logger,
      );

      // Normalize user roles - tekil role varsa array'e çevir
      const userRoles = payload.roles || (payload.role ? [payload.role] : []);

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
        role: payload.role || userRoles[0],
        tenantId: payload.tenantId,
      };

      const requestContext = requestContextStorage.getStore();
      if (requestContext) {
        requestContext.userId = payload.sub;
        requestContext.tenantId = payload.tenantId;
      }

      // Admin API is a platform-admin boundary. In the current auth model that
      // platform actor is encoded as SUPER_ADMIN; decorators may narrow to that
      // role, but must never widen admin-api access to tenant/module roles.
      const decoratedRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      const requiredRoles = (decoratedRoles || DEFAULT_ADMIN_ROLES)
        .filter((role) => role.toUpperCase() === 'SUPER_ADMIN');
      if (requiredRoles.length === 0) {
        requiredRoles.push('SUPER_ADMIN');
      }

      // Case-insensitive role check
      const hasRequiredRole = userRoles.some((userRole) =>
        requiredRoles.some(
          (required) => required.toUpperCase() === userRole.toUpperCase(),
        ),
      );

      if (!hasRequiredRole) {
        // SECURITY: Log user ID only -- do not include email PII in logs (H-14)
        this.logger.warn(
          `Access denied for userId=${payload.sub}: ` +
          `has roles [${userRoles.join(', ')}], requires one of [${requiredRoles.join(', ')}]`,
        );
        throw new ForbiddenException(
          `Access denied. Required roles: ${requiredRoles.join(', ')}`,
        );
      }

      return true;
    } catch (error) {
      // A valid token with an insufficient role is NOT an authentication failure
      // (it is a real, authenticated principal) — rethrow as-is; it must not fill
      // the failed-auth IP bucket and is already logged at warn above.
      if (error instanceof ForbiddenException) {
        throw error;
      }

      // Rejections from enforceAccessTokenType / enforceTokenNotRevoked (wrong
      // token type, missing jti, revoked token) — preserve their code by routing
      // the original exception through the failed-auth accounting.
      if (error instanceof UnauthorizedException) {
        return this.rejectAuth(context, request, error);
      }

      if (error instanceof jwt.TokenExpiredError) {
        return this.rejectAuth(context, request, new UnauthorizedException('Token has expired'));
      }

      if (error instanceof jwt.JsonWebTokenError) {
        return this.rejectAuth(context, request, new UnauthorizedException('Invalid token'));
      }

      // Unexpected error — keep the stack trace at error level, then account the
      // failure and reject.
      this.logger.error(
        `Authentication error for ${request.method} ${request.url}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      return this.rejectAuth(context, request, new UnauthorizedException('Authentication failed'));
    }
  }

  /**
   * Best-effort client IP: the left-most X-Forwarded-For hop (the original
   * client through nginx), falling back to the request address. Keyed per-IP so
   * a failed-auth flood from one source is bounded regardless of the (spoofable)
   * identity a forged token might claim.
   */
  private getClientIp(request: AuthenticatedRequest): string {
    const forwarded = headerValue(request.headers['x-forwarded-for']);
    const firstHop = forwarded?.split(',')[0]?.trim();
    return firstHop || request.ip || 'unknown';
  }

  /**
   * APA-369: record a failed authentication against the per-IP bucket, emit the
   * AUTH_TOKEN_REJECTED security event, and — once an IP crosses the failed-auth
   * limit — emit RATE_LIMIT_EXCEEDED and reject with 429 (instead of 401) so
   * token brute-force is APP-throttled (not merely nginx-throttled) and reaches
   * the incident pipeline. Only auth FAILURES call this, so an authenticated
   * operator's request fan-out from one IP never fills the bucket.
   */
  private async rejectAuth(
    context: ExecutionContext,
    request: AuthenticatedRequest,
    unauthorized: UnauthorizedException,
  ): Promise<never> {
    const reason = reasonOf(unauthorized);
    // WARN, not DEBUG: failed auth on the most privileged surface must be
    // visible at production log levels.
    this.logger.warn(
      `401 Unauthorized: ${reason} for ${request.method} ${request.url}`,
    );

    const ip = this.getClientIp(request);
    const userAgent = headerValue(request.headers['user-agent']);
    const limit = this.failedAuthIpLimiter.checkLimit(ip);

    await this.securityEvents.publishTokenRejected({ reason, ip, userAgent });

    if (!limit.allowed) {
      const windowMs = this.configService.get<number>('IP_RATE_WINDOW_MS', 60000);
      const maxPerWindow = this.configService.get<number>('IP_RATE_LIMIT', 100);
      await this.securityEvents.publishRateLimitExceeded({
        key: `admin-auth:ip:${ip}`,
        limit: maxPerWindow,
        windowMs,
        count: maxPerWindow + 1,
        ip,
        userAgent,
      });
      const response = context
        .switchToHttp()
        .getResponse<{ setHeader(name: string, value: string): void }>();
      if (limit.retryAfter) {
        response.setHeader('Retry-After', String(limit.retryAfter));
      }
      throw new HttpException(
        { code: 'TOO_MANY_FAILED_AUTH', message: 'Too many failed authentication attempts' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    throw unauthorized;
  }
}
