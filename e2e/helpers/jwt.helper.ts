import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';

/**
 * JWT payload structure matching the auth-service TokenService
 */
export interface TestJwtPayload {
  sub: string;
  email: string;
  role: 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'MODULE_MANAGER' | 'MODULE_USER';
  roles: string[];
  tenantId: string | null;
  modules?: string[];
  resourcePermissions?: string[];
  jti: string;
  iat: number;
  exp: number;
}

/**
 * Options for generating a test JWT token
 */
export interface GenerateTokenOptions {
  userId?: string;
  email?: string;
  role?: TestJwtPayload['role'];
  tenantId?: string | null;
  modules?: string[];
  resourcePermissions?: string[];
  expiresInSeconds?: number;
}

/**
 * Generate a test JWT token for E2E workflow tests.
 *
 * Uses the same HS256 algorithm and payload structure as the auth-service.
 * JWT_SECRET must be set in the environment (defaults to a test secret).
 */
export function generateTestToken(options: GenerateTokenOptions = {}): string {
  const secret = process.env['JWT_SECRET'] || 'test-jwt-secret-for-e2e-at-least-32-chars';
  const audience = process.env['JWT_AUDIENCE'] || 'aquaculture-platform';

  const now = Math.floor(Date.now() / 1000);
  const expiresIn = options.expiresInSeconds ?? 3600;

  const payload: TestJwtPayload = {
    sub: options.userId ?? crypto.randomUUID(),
    email: options.email ?? `test-${Date.now()}@aquaculture.test`,
    role: options.role ?? 'TENANT_ADMIN',
    roles: [options.role ?? 'TENANT_ADMIN'],
    tenantId: options.tenantId !== undefined ? options.tenantId : crypto.randomUUID(),
    modules: options.modules,
    resourcePermissions: options.resourcePermissions,
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + expiresIn,
  };

  return jwt.sign(payload, secret, {
    algorithm: 'HS256',
    audience,
  });
}

/**
 * Generate a TENANT_ADMIN token with common defaults
 */
export function generateTenantAdminToken(tenantId: string, userId?: string): string {
  return generateTestToken({
    userId,
    role: 'TENANT_ADMIN',
    tenantId,
  });
}

/**
 * Generate a SUPER_ADMIN token
 */
export function generateSuperAdminToken(userId?: string): string {
  return generateTestToken({
    userId,
    role: 'SUPER_ADMIN',
    tenantId: null,
  });
}
