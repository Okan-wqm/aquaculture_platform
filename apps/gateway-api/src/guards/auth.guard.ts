/**
 * Auth Guard
 *
 * Validates JWT tokens and orchestrates authentication across multiple methods.
 * Delegates API Key and Basic Auth to dedicated strategy services.
 * Implements token validation, blacklisting, and SEC-COMPAT backward compatibility.
 *
 * This guard is registered as a global APP_GUARD in AppModule and runs on every
 * request unless the route is marked with @Public().
 */

import {
  enforceAccessTokenType,
  enforceTokenNotRevoked,
  getJwtVerifyOptions,
} from '@aquaculture/backend-common/auth';
import {
  ITokenRevocationReader,
  TOKEN_REVOCATION_READER,
} from '@aquaculture/backend-common/security';
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
  SetMetadata,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { JwtService } from '@nestjs/jwt';

import { AuthenticatedRequest, GqlContext, JwtPayload } from '../types/index';
import { ApiKeyAuthStrategy } from './strategies/api-key-auth.strategy';
import { BasicAuthStrategy } from './strategies/basic-auth.strategy';

/**
 * Public route decorator — marks a route as publicly accessible without authentication
 */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = (): ReturnType<typeof SetMetadata> => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * API Key auth decorator — marks a route to require API key authentication
 */
export const API_KEY_AUTH_KEY = 'apiKeyAuth';
export const ApiKeyAuth = (): ReturnType<typeof SetMetadata> => SetMetadata(API_KEY_AUTH_KEY, true);

/**
 * Basic auth decorator — marks a route to require Basic auth authentication
 */
export const BASIC_AUTH_KEY = 'basicAuth';
export const BasicAuth = (): ReturnType<typeof SetMetadata> => SetMetadata(BASIC_AUTH_KEY, true);

// Re-export key types from types/index.ts for backward compatibility during transition.
// Existing consumers that import from auth.guard.ts will continue to work.
// Type-only re-export under isolatedModules.
export type { JwtPayload, AuthenticatedRequest, GqlContext } from '../types/index';
export { getUserFromRequest, getTenantIdFromRequest } from '../types/index';

/**
 * Auth Guard
 * Orchestrates all authentication methods: JWT, API Key, and Basic Auth
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);
  // jwtIssuer/jwtAudience removed: previously used for manual conditional if-checks
  // (if payload.iss && ... / if payload.aud). These checks silently accepted tokens
  // without iss/aud claims. Now enforced at library level via getJwtVerifyOptions().
  private readonly isProduction: boolean;
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Inject(JwtService) private readonly jwtService: JwtService,
    @Inject(ApiKeyAuthStrategy) private readonly apiKeyAuthStrategy: ApiKeyAuthStrategy,
    @Inject(BasicAuthStrategy) private readonly basicAuthStrategy: BasicAuthStrategy,
    @Inject(TOKEN_REVOCATION_READER)
    private readonly tokenRevocationReader: ITokenRevocationReader,
  ) {
    this.isProduction = this.configService.get<string>('NODE_ENV', 'development') === 'production';
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if route is public
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = this.getRequest(context);

    // Check for API key auth
    const isApiKeyAuth = this.reflector.getAllAndOverride<boolean>(API_KEY_AUTH_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isApiKeyAuth) {
      return this.apiKeyAuthStrategy.validate(request);
    }

    // Check for basic auth
    const isBasicAuth = this.reflector.getAllAndOverride<boolean>(BASIC_AUTH_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isBasicAuth) {
      return this.basicAuthStrategy.validate(request);
    }

    // Default: JWT authentication
    return this.validateJwt(request);
  }

  /**
   * Validate JWT token
   *
   * SECURITY: Uses JwtService.verifyAsync() with explicit algorithm restriction
   * to prevent algorithm confusion attacks (HS256 vs RS256 downgrade).
   * If JwtMiddleware already verified the token and set req.user, we only
   * perform the blacklist check to avoid double cryptographic verification.
   */
  private async validateJwt(request: AuthenticatedRequest): Promise<boolean> {
    if (request.jwtAuthenticationFailure === 'TOKEN_REVOKED') {
      throw this.revokedTokenError();
    }

    // If JwtMiddleware already verified and set req.user (HTTP context),
    // trust it and only do the blacklist check
    if (request.user) {
      const payload = request.user;

      enforceAccessTokenType(payload, this.logger, this.isProduction);

      if (!(await this.hasValidRevocationState(payload))) {
        request.user = undefined;
        request.jwtAuthenticationFailure = 'TOKEN_REVOKED';
        throw this.revokedTokenError();
      }

      request.authMethod = 'jwt';
      return true;
    }

    // Full verification for non-HTTP contexts (e.g., GraphQL without middleware)
    const authHeader = request.headers['authorization'];

    if (!authHeader) {
      throw new UnauthorizedException({
        code: 'MISSING_AUTH_HEADER',
        message: 'Authorization header is required',
      });
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer') {
      throw new UnauthorizedException({
        code: 'INVALID_AUTH_SCHEME',
        message: 'Authorization header must use Bearer scheme',
      });
    }

    const token = parts[1] as string;

    try {
      // Use centralised getJwtVerifyOptions() for mandatory algorithm, issuer, audience.
      // BEFORE: verifyAsync() only passed algorithms:['HS256']; iss/aud were checked
      // via application-layer conditionals (if payload.iss && ...) which silently
      // accepted tokens WITHOUT those claims — the conditional skipped the check entirely.
      // AFTER: issuer and audience are passed to jsonwebtoken which enforces them at
      // library level — a token missing iss OR aud throws JsonWebTokenError immediately.
      const payload = await this.jwtService.verifyAsync<JwtPayload>(
        token,
        getJwtVerifyOptions(this.configService),
      );

      enforceAccessTokenType(payload, this.logger, this.isProduction);

      if (!(await this.hasValidRevocationState(payload))) {
        request.jwtAuthenticationFailure = 'TOKEN_REVOKED';
        throw this.revokedTokenError();
      }

      request.user = payload;
      request.authMethod = 'jwt';

      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }

      this.logger.warn(
        JSON.stringify({
          event: 'gateway_jwt_validation_failed',
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      );

      throw new UnauthorizedException({
        code: 'INVALID_TOKEN',
        message: 'Invalid or expired token',
      });
    }
  }

  private async hasValidRevocationState(payload: JwtPayload): Promise<boolean> {
    if (
      typeof payload.jti !== 'string' ||
      payload.jti.trim().length === 0 ||
      typeof payload.sub !== 'string' ||
      payload.sub.trim().length === 0 ||
      !Number.isSafeInteger(payload.iat) ||
      payload.iat <= 0
    ) {
      return false;
    }
    try {
      await enforceTokenNotRevoked(payload, this.tokenRevocationReader, this.logger);
      return true;
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'gateway_composite_token_validity_check_failed',
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
      return false;
    }
  }

  private revokedTokenError(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'TOKEN_REVOKED',
      message: 'Token has been revoked',
    });
  }

  /**
   * Get request from execution context (supports HTTP and GraphQL)
   */
  private getRequest(context: ExecutionContext): AuthenticatedRequest {
    const contextType = context.getType<string>();

    if (contextType === 'graphql') {
      const gqlContext = GqlExecutionContext.create(context);
      return gqlContext.getContext<GqlContext>().req;
    }

    return context.switchToHttp().getRequest<AuthenticatedRequest>();
  }
}
