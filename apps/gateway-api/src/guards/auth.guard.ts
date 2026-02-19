/**
 * Auth Guard
 *
 * Validates JWT tokens and handles authentication.
 * Supports multiple authentication methods: JWT, API Key, Basic Auth.
 * Implements token validation, blacklisting, and refresh token handling.
 */

import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';

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
import { Request } from 'express';

import {
  TokenBlacklistStore,
  TOKEN_BLACKLIST_STORE,
  InMemoryTokenBlacklistStore,
} from './redis-token-blacklist.store';

/**
 * Public route decorator
 */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = (): ReturnType<typeof SetMetadata> => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * API Key auth decorator
 */
export const API_KEY_AUTH_KEY = 'apiKeyAuth';
export const ApiKeyAuth = (): ReturnType<typeof SetMetadata> => SetMetadata(API_KEY_AUTH_KEY, true);

/**
 * Basic auth decorator
 */
export const BASIC_AUTH_KEY = 'basicAuth';
export const BasicAuth = (): ReturnType<typeof SetMetadata> => SetMetadata(BASIC_AUTH_KEY, true);

/**
 * JWT payload interface
 */
export interface JwtPayload {
  sub: string; // User ID
  email?: string;
  tenantId: string;
  roles: string[];
  permissions?: string[];
  type: 'access' | 'refresh';
  iat: number;
  exp: number;
  iss?: string;
  aud?: string | string[];
  jti?: string; // JWT ID for blacklisting
}

/**
 * Authenticated request
 */
export interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
  authMethod?: 'jwt' | 'api_key' | 'basic';
  apiKey?: string;
}

// Token blacklist is now handled by TokenBlacklistStore (Redis or in-memory)

/**
 * GraphQL context with request
 */
interface GqlContext {
  req: AuthenticatedRequest;
}

/**
 * Auth Guard
 * Handles all authentication methods
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);
  private readonly jwtIssuer: string;
  private readonly jwtAudience: string[];
  private readonly apiKeys: Map<string, ApiKeyInfo>;
  private readonly tokenBlacklist: TokenBlacklistStore;
  private readonly basicAuthCredentials: Map<string, string>;

  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    @Optional()
    @Inject(TOKEN_BLACKLIST_STORE)
    tokenBlacklistStore?: TokenBlacklistStore,
  ) {
    // Use injected store or fallback to in-memory
    this.tokenBlacklist = tokenBlacklistStore ?? new InMemoryTokenBlacklistStore();

    this.jwtIssuer = this.configService.get<string>('JWT_ISSUER', 'aquaculture-platform');
    this.jwtAudience = this.configService
      .get<string>('JWT_AUDIENCE', 'aquaculture-api')
      .split(',');
    this.apiKeys = new Map();
    this.basicAuthCredentials = new Map();

    this.loadApiKeys();
    this.loadBasicAuthCredentials();
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
      return this.validateApiKey(request);
    }

    // Check for basic auth
    const isBasicAuth = this.reflector.getAllAndOverride<boolean>(BASIC_AUTH_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isBasicAuth) {
      return this.validateBasicAuth(request);
    }

    // Default: JWT authentication
    return this.validateJwt(request);
  }

  /**
   * Validate JWT token
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

      // Check token type
      if (payload.type !== 'access') {
        throw new UnauthorizedException({
          code: 'INVALID_TOKEN_TYPE',
          message: 'Access token required',
        });
      }

      // SECURITY: Reject tokens without jti in production - they cannot be revoked
      const isProduction = process.env['NODE_ENV'] === 'production';
      if (isProduction && !payload.jti) {
        throw new UnauthorizedException({
          code: 'MISSING_JTI',
          message: 'Token must include jti claim',
        });
      }

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

      // Check token type
      if (payload.type !== 'access') {
        throw new UnauthorizedException({
          code: 'INVALID_TOKEN_TYPE',
          message: 'Access token required',
        });
      }

      // SECURITY: Reject tokens without jti in production
      const isProduction = process.env['NODE_ENV'] === 'production';
      if (isProduction && !payload.jti) {
        throw new UnauthorizedException({
          code: 'MISSING_JTI',
          message: 'Token must include jti claim',
        });
      }

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
   * Validate API key
   * SECURITY: API keys must only be accepted from headers, never from query parameters
   * Query parameters are logged, cached, and visible in browser history
   */
  private validateApiKey(request: AuthenticatedRequest): boolean {
    // SECURITY: Only accept API key from x-api-key header
    // Never from query parameters (would be exposed in logs, URLs, referrer headers)
    const apiKey = request.headers['x-api-key'] as string;

    if (!apiKey) {
      throw new UnauthorizedException({
        code: 'MISSING_API_KEY',
        message: 'API key is required. Use x-api-key header.',
      });
    }

    const keyInfo = this.apiKeys.get(this.hashApiKey(apiKey));

    if (!keyInfo) {
      throw new UnauthorizedException({
        code: 'INVALID_API_KEY',
        message: 'Invalid API key',
      });
    }

    if (!keyInfo.active) {
      throw new UnauthorizedException({
        code: 'API_KEY_DISABLED',
        message: 'API key is disabled',
      });
    }

    if (keyInfo.expiresAt && keyInfo.expiresAt < new Date()) {
      throw new UnauthorizedException({
        code: 'API_KEY_EXPIRED',
        message: 'API key has expired',
      });
    }

    // Attach API key info to request
    request.apiKey = apiKey;
    request.authMethod = 'api_key';
    request.user = {
      sub: keyInfo.userId,
      tenantId: keyInfo.tenantId,
      roles: keyInfo.roles,
      permissions: keyInfo.permissions,
      type: 'access',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    return true;
  }

  /**
   * Validate basic auth
   * SECURITY: Uses async bcrypt.compare() to avoid blocking the event loop
   */
  private async validateBasicAuth(request: AuthenticatedRequest): Promise<boolean> {
    const authHeader = request.headers['authorization'];

    if (!authHeader) {
      throw new UnauthorizedException({
        code: 'MISSING_AUTH_HEADER',
        message: 'Authorization header is required',
      });
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'basic' || !parts[1]) {
      throw new UnauthorizedException({
        code: 'INVALID_AUTH_SCHEME',
        message: 'Authorization header must use Basic scheme',
      });
    }

    const credentials = Buffer.from(parts[1], 'base64').toString('utf8');
    const [username, password] = credentials.split(':') as [string | undefined, string | undefined];

    if (!username || !password) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS_FORMAT',
        message: 'Invalid credentials format',
      });
    }

    const storedPasswordHash = this.basicAuthCredentials.get(username);
    if (!storedPasswordHash || !(await bcrypt.compare(password, storedPasswordHash))) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid username or password',
      });
    }

    request.authMethod = 'basic';
    request.user = {
      sub: username,
      tenantId: 'system',
      roles: ['service'],
      type: 'access',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    return true;
  }

  /**
   * Get request from context
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
   * SECURITY: Use this when user logs out or token is compromised
   * In distributed deployments, this uses Redis for cross-instance revocation
   */
  async blacklistToken(jti: string, exp: number): Promise<void> {
    await this.tokenBlacklist.add(jti, exp);
    this.logger.log(`Token blacklisted: ${jti.substring(0, 8)}...`);
  }

  /**
   * Hash API key for storage
   */
  private hashApiKey(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  /**
   * Load API keys from config
   */
  private loadApiKeys(): void {
    const keysConfig = this.configService.get<string>('API_KEYS', '');
    if (!keysConfig) return;

    try {
      const keys = JSON.parse(keysConfig) as ApiKeyInfo[];
      for (const key of keys) {
        const hashedKey = this.hashApiKey(key.key || '');
        this.apiKeys.set(hashedKey, key);
      }
    } catch {
      this.logger.warn('Failed to parse API keys config');
    }
  }

  /**
   * Load basic auth credentials from config
   * SECURITY: Accepts pre-hashed bcrypt values to avoid synchronous hashing at startup.
   * If a value starts with '$2a$' or '$2b$', it is treated as already hashed.
   * Otherwise it is hashed asynchronously.
   */
  private loadBasicAuthCredentials(): void {
    const credentialsConfig = this.configService.get<string>('BASIC_AUTH_CREDENTIALS', '');
    if (!credentialsConfig) return;

    try {
      const credentials = JSON.parse(credentialsConfig) as Record<string, string>;
      for (const [username, password] of Object.entries(credentials)) {
        // Accept pre-hashed bcrypt passwords to avoid blocking hashSync at startup
        if (password.startsWith('$2a$') || password.startsWith('$2b$')) {
          this.basicAuthCredentials.set(username, password);
        } else {
          // Fallback: hash asynchronously for backwards compatibility
          void bcrypt.hash(password, 10).then((hashed) => {
            this.basicAuthCredentials.set(username, hashed);
          });
        }
      }
    } catch {
      this.logger.warn('Failed to parse basic auth credentials');
    }
  }

  // Note: Blacklist cleanup is handled by TokenBlacklistStore implementation
  // - Redis store uses TTL for automatic cleanup
  // - In-memory store has its own cleanup interval
}

/**
 * API key info
 */
interface ApiKeyInfo {
  key?: string;
  userId: string;
  tenantId: string;
  roles: string[];
  permissions?: string[];
  active: boolean;
  expiresAt?: Date;
  name?: string;
}

/**
 * Get user from request
 */
export function getUserFromRequest(req: Request): JwtPayload | undefined {
  return (req as AuthenticatedRequest).user;
}

/**
 * Get tenant ID from request
 */
export function getTenantIdFromRequest(req: Request): string | undefined {
  return (req as AuthenticatedRequest).user?.tenantId;
}
