import {
  enforceAccessTokenType,
  enforceTokenNotRevoked,
  getJwtVerifyOptions,
} from '@aquaculture/backend-common/auth';
import { requestContextStorage } from '@aquaculture/backend-common/logging';
import {
  extractClientIp,
  RateLimitAuthorityUnavailableError,
  RateLimitEnforcementService,
  type RateLimitEvaluation,
} from '@aquaculture/backend-common/rate-limit';
import {
  ITokenRevocationReader,
  SecurityEventService,
  TOKEN_REVOCATION_READER,
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
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import * as jwt from 'jsonwebtoken';

import { ROLES_KEY } from '../decorators/roles.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ADMIN_RATE_LIMIT_POLICIES } from '../security/admin-rate-limit.policy';
// Bind the verified principal to the canonical request-user SSoT: AuthenticatedUser extends
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
  mfaVerified?: boolean;
  iat: number;
  exp: number;
}

export { IS_PUBLIC_KEY } from '../decorators/public.decorator';

// Product language calls this actor "platform admin"; the auth domain
// represents that platform-level operator with the existing SUPER_ADMIN role.
const DEFAULT_ADMIN_ROLES = ['SUPER_ADMIN', 'super_admin'];

function unauthorizedReason(exception: UnauthorizedException): string {
  const response = exception.getResponse();
  if (typeof response === 'string') {
    return response;
  }
  if (typeof response === 'object' && response !== null && 'message' in response) {
    const message = response.message;
    if (typeof message === 'string') {
      return message;
    }
    if (Array.isArray(message)) {
      return message.filter((value): value is string => typeof value === 'string').join(', ');
    }
  }
  return exception.message;
}

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
    @Inject(TOKEN_REVOCATION_READER)
    private readonly tokenRevocationReader: ITokenRevocationReader,
    @Inject(RateLimitEnforcementService)
    private readonly rateLimitEnforcement: RateLimitEnforcementService,
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
      let revocationCoordinates: Awaited<ReturnType<typeof enforceTokenNotRevoked>>;
      try {
        revocationCoordinates = await enforceTokenNotRevoked(
          payload,
          this.tokenRevocationReader,
          this.logger,
        );
      } catch (error) {
        if (error instanceof UnauthorizedException) {
          throw error;
        }
        this.logger.error(`Token revocation authority unavailable: ${(error as Error).message}`);
        throw new ServiceUnavailableException({
          code: 'REVOCATION_AUTHORITY_UNAVAILABLE',
          message: 'Authentication authority temporarily unavailable',
        });
      }

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
        mfaVerified: payload.mfaVerified === true,
        iat: revocationCoordinates.issuedAtSeconds,
        jti: revocationCoordinates.jti,
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
      const requiredRoles = (decoratedRoles || DEFAULT_ADMIN_ROLES).filter(
        (role) => role.toUpperCase() === 'SUPER_ADMIN',
      );
      if (requiredRoles.length === 0) {
        requiredRoles.push('SUPER_ADMIN');
      }

      // Case-insensitive role check
      const hasRequiredRole = userRoles.some((userRole) =>
        requiredRoles.some((required) => required.toUpperCase() === userRole.toUpperCase()),
      );

      if (!hasRequiredRole) {
        // SECURITY: Log user ID only -- do not include email PII in logs (H-14)
        this.logger.warn(
          `Access denied for userId=${payload.sub}: ` +
            `has roles [${userRoles.join(', ')}], requires one of [${requiredRoles.join(', ')}]`,
        );
        throw new ForbiddenException(`Access denied. Required roles: ${requiredRoles.join(', ')}`);
      }

      return true;
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof ServiceUnavailableException) {
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

      this.logger.error(
        `Authentication error for ${request.method} ${request.url}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      return this.rejectAuthentication(
        context,
        request,
        new UnauthorizedException('Authentication failed'),
      );
    }
  }

  private async rejectAuthentication(
    context: ExecutionContext,
    request: AuthenticatedRequest,
    exception: UnauthorizedException,
  ): Promise<never> {
    const reason = unauthorizedReason(exception);
    const client = extractClientIp({
      url: request.url,
      method: request.method,
      headers: request.headers,
      ip: request.ip,
      remoteAddress: request.socket.remoteAddress,
    });
    if (client.unverifiedForwardedFor) {
      this.logger.warn(
        'Admin authentication IP resolved from unverified X-Forwarded-For; configure trust proxy',
      );
    }

    this.logger.warn(
      JSON.stringify({
        event: 'admin_authentication_rejected',
        method: request.method,
        path: request.path,
        reason,
      }),
    );

    let evaluation: RateLimitEvaluation;
    try {
      evaluation = await this.rateLimitEnforcement.evaluate(ADMIN_RATE_LIMIT_POLICIES.failedAuth, {
        ip: client.ip,
      });
    } catch (error) {
      if (error instanceof RateLimitAuthorityUnavailableError) {
        throw new ServiceUnavailableException({
          code: 'RATE_LIMIT_AUTHORITY_UNAVAILABLE',
          message: 'Authentication authority temporarily unavailable',
        });
      }
      throw error;
    }

    const userAgent = headerValue(request.headers['user-agent']);
    await this.securityEvents.publishTokenRejected({
      reason,
      ip: client.ip,
      userAgent,
    });

    if (!evaluation.allowed) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((evaluation.entry.resetTime - Date.now()) / 1000),
      );
      await this.securityEvents.publishRateLimitExceeded({
        key: evaluation.key,
        limit: ADMIN_RATE_LIMIT_POLICIES.failedAuth.limit,
        windowMs: ADMIN_RATE_LIMIT_POLICIES.failedAuth.windowMs,
        count: evaluation.entry.count,
        ip: client.ip,
        userAgent,
      });
      context
        .switchToHttp()
        .getResponse<{ setHeader(name: string, value: string): void }>()
        .setHeader('Retry-After', String(retryAfterSeconds));
      throw new HttpException(
        {
          code: 'TOO_MANY_FAILED_AUTH_ATTEMPTS',
          message: 'Too many failed authentication attempts',
          retryAfter: retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    throw exception;
  }
}
