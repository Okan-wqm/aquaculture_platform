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
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';

import { JwtPayload, AuthenticatedRequest, GqlContext } from '../types/index';
import { GatewayTokenVerifierService } from './gateway-token-verifier.service';
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

interface GatewayVerifiedJwtRequest extends AuthenticatedRequest {
  gatewayVerifiedJwtPayload?: JwtPayload;
}

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
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ApiKeyAuthStrategy) private readonly apiKeyAuthStrategy: ApiKeyAuthStrategy,
    @Inject(BasicAuthStrategy) private readonly basicAuthStrategy: BasicAuthStrategy,
    @Inject(GatewayTokenVerifierService)
    private readonly tokenVerifier: GatewayTokenVerifierService,
  ) {}

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
   * SECURITY: Uses GatewayTokenVerifierService for signature verification,
   * access-token type enforcement, and composite tenant-aware revocation checks.
   * If JwtMiddleware already verified the token and set req.user, we only
   * perform the blacklist check to avoid double cryptographic verification.
   */
  private async validateJwt(request: AuthenticatedRequest): Promise<boolean> {
    // If JwtMiddleware already verified the Authorization bearer token and
    // set req.user (HTTP context), trust that cryptographic verification and
    // only perform the central blacklist/session invalidation check.
    //
    // Do not trust a bare req.user from UserContextMiddleware. On the gateway,
    // x-user-payload is outbound subgraph context, not an inbound auth source.
    const verifiedJwtPayload = this.getGatewayVerifiedJwtPayload(request);
    if (verifiedJwtPayload) {
      const payload = verifiedJwtPayload;

      const allowed = await this.tokenVerifier.isPayloadAllowed(payload, 'AuthGuard.cached');
      if (!allowed) {
        request.user = undefined;
        request.jwtVerified = false;
        this.clearGatewayVerifiedJwtPayload(request);
        throw new UnauthorizedException({
          code: 'TOKEN_REVOKED',
          message: 'Token has been revoked',
        });
      }

      request.user = payload;
      request.authMethod = 'jwt';
      return true;
    }
    if (request.user || request.jwtVerified === true) {
      request.user = undefined;
      request.jwtVerified = false;
      this.clearGatewayVerifiedJwtPayload(request);
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
      const payload = await this.tokenVerifier.verifyAccessToken(token, {
        context: 'AuthGuard.fullVerify',
      });
      if (!payload) {
        throw new UnauthorizedException({
          code: 'TOKEN_REVOKED',
          message: 'Token has been revoked or is invalid',
        });
      }

      request.user = payload;
      request.jwtVerified = true;
      (request as GatewayVerifiedJwtRequest).gatewayVerifiedJwtPayload = payload;
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

  private getGatewayVerifiedJwtPayload(request: AuthenticatedRequest): JwtPayload | undefined {
    if (request.jwtVerified !== true) {
      return undefined;
    }
    return (request as GatewayVerifiedJwtRequest).gatewayVerifiedJwtPayload;
  }

  private clearGatewayVerifiedJwtPayload(request: AuthenticatedRequest): void {
    delete (request as GatewayVerifiedJwtRequest).gatewayVerifiedJwtPayload;
  }

  /**
   * Add token to blacklist
   *
   * SECURITY: Use this when user logs out or token is compromised.
   * In distributed deployments, this uses Redis for cross-instance revocation.
   */
  async blacklistToken(jti: string, exp: number): Promise<void> {
    await this.tokenVerifier.blacklistToken(jti, exp);
    this.logger.log(`Token blacklisted: ${jti.substring(0, 8)}...`);
  }

  // Note: blacklist cleanup is handled by the canonical backend-common
  // TOKEN_BLACKLIST implementation.
}
