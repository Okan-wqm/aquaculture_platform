/**
 * JWT Test Helper
 *
 * Generates test JWT tokens for e2e security testing.
 * Supports various token configurations: valid, expired, missing claims, wrong audience.
 */

import * as jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

/**
 * JWT payload interface matching the platform's JwtPayload
 */
export interface TestJwtPayload {
  sub: string;
  email?: string;
  tenantId: string;
  roles: string[];
  permissions?: string[];
  type: 'access' | 'refresh';
  iat?: number;
  exp?: number;
  iss?: string;
  aud?: string | string[];
  jti?: string;
  role?: string;
  tenantName?: string;
  plan?: string;
  modules?: string[];
  tenantActive?: boolean;
}

/**
 * Options for generating test tokens
 */
export interface GenerateTokenOptions {
  sub?: string;
  email?: string;
  tenantId?: string;
  roles?: string[];
  permissions?: string[];
  type?: 'access' | 'refresh';
  expiresInSeconds?: number;
  audience?: string | string[];
  issuer?: string;
  includeJti?: boolean;
  jti?: string;
  role?: string;
  secret?: string;
}

const DEFAULT_SECRET = process.env['JWT_SECRET'] || 'test-secret-key-that-is-at-least-32-characters-long';
const DEFAULT_ISSUER = 'aquaculture-platform';
const DEFAULT_AUDIENCE = 'aquaculture-api';

/**
 * Generate a valid test JWT token
 */
export function generateTestToken(options: GenerateTokenOptions = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const expiresInSeconds = options.expiresInSeconds ?? 900; // 15 minutes default

  const payload: Record<string, unknown> = {
    sub: options.sub ?? uuidv4(),
    email: options.email ?? 'test@example.com',
    tenantId: options.tenantId ?? uuidv4(),
    roles: options.roles ?? ['MODULE_USER'],
    type: options.type ?? 'access',
    iss: options.issuer ?? DEFAULT_ISSUER,
    aud: options.audience ?? DEFAULT_AUDIENCE,
    iat: now,
    exp: now + expiresInSeconds,
  };

  if (options.permissions) {
    payload['permissions'] = options.permissions;
  }

  if (options.role) {
    payload['role'] = options.role;
  }

  if (options.includeJti !== false) {
    payload['jti'] = options.jti ?? uuidv4();
  }

  const secret = options.secret ?? DEFAULT_SECRET;

  return jwt.sign(payload, secret, {
    algorithm: 'HS256',
  });
}

/**
 * Generate an expired JWT token
 */
export function generateExpiredToken(options: GenerateTokenOptions = {}): string {
  const now = Math.floor(Date.now() / 1000);

  const payload: Record<string, unknown> = {
    sub: options.sub ?? uuidv4(),
    email: options.email ?? 'expired@example.com',
    tenantId: options.tenantId ?? uuidv4(),
    roles: options.roles ?? ['MODULE_USER'],
    type: options.type ?? 'access',
    iss: options.issuer ?? DEFAULT_ISSUER,
    aud: options.audience ?? DEFAULT_AUDIENCE,
    jti: options.jti ?? uuidv4(),
    iat: now - 7200, // Issued 2 hours ago
    exp: now - 3600, // Expired 1 hour ago
  };

  const secret = options.secret ?? DEFAULT_SECRET;

  // Sign without expiresIn — we set exp directly in the payload
  return jwt.sign(payload, secret, {
    algorithm: 'HS256',
  });
}

/**
 * Generate a token without jti claim
 */
export function generateTokenWithoutJti(options: GenerateTokenOptions = {}): string {
  return generateTestToken({
    ...options,
    includeJti: false,
  });
}

/**
 * Generate a token with wrong audience
 */
export function generateTokenWithWrongAudience(options: GenerateTokenOptions = {}): string {
  return generateTestToken({
    ...options,
    audience: 'wrong-audience',
  });
}

/**
 * Generate a token with a different secret (simulates tampered token)
 */
export function generateTokenWithWrongSecret(options: GenerateTokenOptions = {}): string {
  return generateTestToken({
    ...options,
    secret: 'completely-wrong-secret-key-that-is-at-least-32-chars',
  });
}

/**
 * Generate a SUPER_ADMIN token
 */
export function generateSuperAdminToken(options: GenerateTokenOptions = {}): string {
  return generateTestToken({
    ...options,
    roles: ['SUPER_ADMIN'],
    role: 'SUPER_ADMIN',
  });
}

/**
 * Generate a TENANT_ADMIN token
 */
export function generateTenantAdminToken(options: GenerateTokenOptions = {}): string {
  return generateTestToken({
    ...options,
    roles: ['TENANT_ADMIN'],
    role: 'TENANT_ADMIN',
  });
}

/**
 * Generate a MODULE_USER token
 */
export function generateModuleUserToken(options: GenerateTokenOptions = {}): string {
  return generateTestToken({
    ...options,
    roles: ['MODULE_USER'],
    role: 'MODULE_USER',
  });
}

/**
 * Get the JWT secret used for test tokens
 */
export function getTestSecret(): string {
  return DEFAULT_SECRET;
}
