/**
 * Auth Guard
 *
 * Validates JWT tokens and handles authentication.
 * Supports multiple authentication methods: JWT, API Key, Basic Auth.
 * Implements token validation, blacklisting, and refresh token handling.
 */

import * as crypto from 'crypto';

import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { Request } from 'express';

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

/**
 * Token blacklist entry
 */
interface BlacklistEntry {
  jti: string;
  exp: number;
}

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
  private readonly jwtSecret: string;
  private readonly jwtIssuer: string;
  private readonly jwtAudience: string[];
  private readonly apiKeys: Map<string, ApiKeyInfo>;
  private readonly tokenBlacklist: Map<string, BlacklistEntry>;
  private readonly basicAuthCredentials: Map<string, string>;

  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
  ) {
    this.jwtSecret = this.configService.get<string>('JWT_SECRET', 'your-secret-key');
    this.jwtIssuer = this.configService.get<string>('JWT_ISSUER', 'aquaculture-platform');
    this.jwtAudience = this.configService
      .get<string>('JWT_AUDIENCE', 'aquaculture-api')
      .split(',');
    this.apiKeys = new Map();
    this.tokenBlacklist = new Map();
    this.basicAuthCredentials = new Map();

    this.loadApiKeys();
    this.loadBasicAuthCredentials();
    this.startBlacklistCleanup();
  }

  canActivate(context: ExecutionContext): boolean {
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
   */
  private validateJwt(request: AuthenticatedRequest): boolean {
    const authHeader = request.headers['authorization'];

    if (!authHeader) {
      throw new UnauthorizedException({
        code: 'MISSING_AUTH_HEADER',
        message: 'Authorization header is required',
      });
    }

    // Validate Bearer scheme
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer') {
      throw new UnauthorizedException({
        code: 'INVALID_AUTH_SCHEME',
        message: 'Authorization header must use Bearer scheme',
      });
    }

    const token = parts[1] as string;

    try {
      // Decode and validate token
      const payload = this.decodeAndValidateToken(token);

      // Check token type
      if (payload.type !== 'access') {
        throw new UnauthorizedException({
          code: 'INVALID_TOKEN_TYPE',
          message: 'Access token required',
        });
      }

      // Check blacklist
      if (payload.jti && this.isTokenBlacklisted(payload.jti)) {
        throw new UnauthorizedException({
          code: 'TOKEN_REVOKED',
          message: 'Token has been revoked',
        });
      }

      // Attach user to request
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
   * Decode and validate JWT token
   */
  private decodeAndValidateToken(token: string): JwtPayload {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid token format');
    }

    const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

    // Verify signature
    const data = `${headerB64}.${payloadB64}`;
    const signature = this.base64UrlDecode(signatureB64);
    const expectedSignature = crypto
      .createHmac('sha256', this.jwtSecret)
      .update(data)
      .digest();

    if (!crypto.timingSafeEqual(Buffer.from(signature), expectedSignature)) {
      throw new Error('Invalid signature');
    }

    // Decode payload
    const payloadJson = Buffer.from(this.base64UrlDecode(payloadB64)).toString('utf8');
    const payload = JSON.parse(payloadJson) as JwtPayload;

    // Validate expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      throw new UnauthorizedException({
        code: 'TOKEN_EXPIRED',
        message: 'Token has expired',
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

    return payload;
  }

  /**
   * Validate API key
   */
  private validateApiKey(request: AuthenticatedRequest): boolean {
    const apiKey =
      (request.headers['x-api-key'] as string) ||
      (request.query['api_key'] as string);

    if (!apiKey) {
      throw new UnauthorizedException({
        code: 'MISSING_API_KEY',
        message: 'API key is required',
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
   */
  private validateBasicAuth(request: AuthenticatedRequest): boolean {
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

    const storedPassword = this.basicAuthCredentials.get(username);
    if (!storedPassword || storedPassword !== password) {
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
   */
  blacklistToken(jti: string, exp: number): void {
    this.tokenBlacklist.set(jti, { jti, exp });
  }

  /**
   * Check if token is blacklisted
   */
  private isTokenBlacklisted(jti: string): boolean {
    return this.tokenBlacklist.has(jti);
  }

  /**
   * Hash API key for storage
   */
  private hashApiKey(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  /**
   * Base64 URL decode
   */
  private base64UrlDecode(str: string): Buffer {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) {
      str += '=';
    }
    return Buffer.from(str, 'base64');
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
   */
  private loadBasicAuthCredentials(): void {
    const credentialsConfig = this.configService.get<string>('BASIC_AUTH_CREDENTIALS', '');
    if (!credentialsConfig) return;

    try {
      const credentials = JSON.parse(credentialsConfig) as Record<string, string>;
      for (const [username, password] of Object.entries(credentials)) {
        this.basicAuthCredentials.set(username, password);
      }
    } catch {
      this.logger.warn('Failed to parse basic auth credentials');
    }
  }

  /**
   * Start blacklist cleanup interval
   */
  private startBlacklistCleanup(): void {
    setInterval(() => {
      const now = Math.floor(Date.now() / 1000);
      for (const [jti, entry] of this.tokenBlacklist.entries()) {
        if (entry.exp < now) {
          this.tokenBlacklist.delete(jti);
        }
      }
    }, 60000); // Cleanup every minute
  }
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
