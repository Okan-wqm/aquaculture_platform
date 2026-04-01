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
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
  SetMetadata,
  Inject,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { JwtService } from '@nestjs/jwt';

import {
  JwtPayload,
  AuthenticatedRequest,
  GqlContext,
} from '../types/index';
import {
  TokenBlacklistStore,
  TOKEN_BLACKLIST_STORE,
  InMemoryTokenBlacklistStore,
} from './redis-token-blacklist.store';
import { ApiKeyAuthStrategy } from './strategies/api-key-auth.strategy';
import { BasicAuthStrategy } from './strategies/basic-auth.strategy';
import { validateAccessTokenCompat } from './utils/token-validation.util';

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
export { JwtPayload, AuthenticatedRequest, GqlContext } from '../types/index';
export { getUserFromRequest, getTenantIdFromRequest } from '../types/index';

/**
 * Auth Guard
 * Orchestrates all authentication methods: JWT, API Key, and Basic Auth
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);
  private readonly jwtIssuer: string;
  private readonly jwtAudience: string[];
  private readonly isProduction: boolean;
  private readonly tokenBlacklist: TokenBlacklistStore;

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Inject(JwtService) private readonly jwtService: JwtService,
    @Inject(ApiKeyAuthStrategy) private readonly apiKeyAuthStrategy: ApiKeyAuthStrategy,
    @Inject(BasicAuthStrategy) private readonly basicAuthStrategy: BasicAuthStrategy,
    @Optional()
    @Inject(TOKEN_BLACKLIST_STORE)
    tokenBlacklistStore?: TokenBlacklistStore,
  ) {
    // Use injected store or fallback to in-memory
    this.tokenBlacklist = tokenBlacklistStore ?? new InMemoryTokenBlacklistStore();

    /**
     * SECURITY (H-04): JWT audience must match the canonical value used by auth-service.
     * Auth-service signs tokens with audience 'aquaculture-platform'. Both services must
     * agree on the same audience string to ensure issued tokens are accepted at the gate.
     */
    this.jwtIssuer = this.configService.get<string>('JWT_ISSUER', 'aquaculture-platform');
    this.jwtAudience = this.configService
      .get<string>('JWT_AUDIENCE', 'aquaculture-platform')
      .split(',');
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
    // If JwtMiddleware already verified and set req.user (HTTP context),
    // trust it and only do the blacklist check
    if (request.user) {
      const payload = request.user;

      validateAccessTokenCompat(payload, this.logger, this.isProduction);

      // Blacklist check already done in JwtMiddleware, but verify again for safety
      if (payload.jti && await this.tokenBlacklist.isBlacklisted(payload.jti)) {
        request.user = undefined;
        throw new UnauthorizedException({
          code: 'TOKEN_REVOKED',
          message: 'Token has been revoked',
        });
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
      // SECURITY: Use JwtService with explicit algorithm to prevent confusion attacks
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
        algorithms: ['HS256'],
      });

      validateAccessTokenCompat(payload, this.logger, this.isProduction);

      // Validate issuer
      if (payload.iss && payload.iss !== this.jwtIssuer) {
        throw new UnauthorizedException({
          code: 'INVALID_ISSUER',
          message: 'Invalid token issuer',
        });
      }

      // Validate audience
      if (payload.aud) {
        const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
        const hasValidAudience = audiences.some((aud) => this.jwtAudience.includes(aud));
        if (!hasValidAudience) {
          throw new UnauthorizedException({
            code: 'INVALID_AUDIENCE',
            message: 'Invalid token audience',
          });
        }
      }

      // Check blacklist
      if (payload.jti && await this.tokenBlacklist.isBlacklisted(payload.jti)) {
        throw new UnauthorizedException({
          code: 'TOKEN_REVOKED',
          message: 'Token has been revoked',
        });
      }

      request.user = payload;
      request.authMethod = 'jwt';

      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }

      this.logger.warn('JWT validation failed', {
        error: (error as Error).message,
        ip: request.ip,
      });

      throw new UnauthorizedException({
        code: 'INVALID_TOKEN',
        message: 'Invalid or expired token',
      });
    }
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

  /**
   * Add token to blacklist
   *
   * SECURITY: Use this when user logs out or token is compromised.
   * In distributed deployments, this uses Redis for cross-instance revocation.
   */
  async blacklistToken(jti: string, exp: number): Promise<void> {
    await this.tokenBlacklist.add(jti, exp);
    this.logger.log(`Token blacklisted: ${jti.substring(0, 8)}...`);
  }

  // Note: Blacklist cleanup is handled by TokenBlacklistStore implementation
  // - Redis store uses TTL for automatic cleanup
  // - In-memory store has its own cleanup interval
}
