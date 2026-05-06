import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';

/**
 * JWT secret for E2E tests.
 * In CI, this MUST match the secret configured for the gateway/auth services.
 */
const JWT_SECRET =
  process.env.JWT_SECRET || 'test-secret-that-is-at-least-32-characters-long!!';

/**
 * Platform role hierarchy — mirrors @platform/backend-common Role enum.
 * Using string literal union instead of importing to keep e2e decoupled.
 */
export type TestRole =
  | 'SUPER_ADMIN'
  | 'TENANT_ADMIN'
  | 'MODULE_MANAGER'
  | 'MODULE_USER';

/**
 * Options for generating a test JWT token.
 * All fields optional — sensible defaults are applied.
 */
export interface TestTokenOptions {
  /** User ID (sub claim). Defaults to random UUID. */
  userId?: string;
  /** User email. Defaults to `e2e-{uuid}@test.aquaculture.io`. */
  email?: string;
  /** Primary role. Defaults to TENANT_ADMIN. */
  role?: TestRole;
  /** Tenant ID. Null for SUPER_ADMIN. Defaults to random UUID. */
  tenantId?: string | null;
  /** Assigned module codes. Defaults to all platform modules. */
  modules?: string[];
  /** Resource-level permissions. Defaults to empty array. */
  resourcePermissions?: string[];
  /** Token expiration (ms/zeit format). Defaults to '1h'. */
  expiresIn?: string;
  /** Whether to include jti claim. Defaults to true. */
  includeJti?: boolean;
  /** Token type (access/refresh). Defaults to 'access'. */
  type?: 'access' | 'refresh';
  /** Custom additional claims. */
  customClaims?: Record<string, unknown>;
}

/**
 * JWT payload structure matching the platform's auth-service TokenService.
 * Mirrors apps/auth-service/src/modules/authentication/services/token.service.ts
 */
export interface TestJwtPayload {
  sub: string;
  email: string;
  role: TestRole;
  roles: TestRole[];
  tenantId: string | null;
  modules: string[];
  resourcePermissions: string[];
  type: 'access' | 'refresh';
  jti?: string;
  iat?: number;
  exp?: number;
  iss: string;
  aud: string;
}

/** All platform module codes */
const ALL_MODULES = [
  'sensor',
  'farm',
  'hr',
  'hydroponics',
  'billing',
  'alert',
  'config',
] as const;

/**
 * Generate a signed JWT token for E2E testing.
 *
 * This creates tokens directly (without calling auth-service) so tests
 * can run independently of the authentication service.
 *
 * The payload mirrors the real JwtPayload from token.service.ts:
 *   sub, email, role, roles, tenantId, modules, resourcePermissions, jti, iss, aud
 */
export function generateTestToken(options: TestTokenOptions = {}): string {
  const userId = options.userId ?? randomUUID();
  const role = options.role ?? 'TENANT_ADMIN';

  // SUPER_ADMIN has no tenant, others default to a random tenant
  const tenantId =
    options.tenantId !== undefined
      ? options.tenantId
      : role === 'SUPER_ADMIN'
        ? null
        : randomUUID();

  const payload: Record<string, unknown> = {
    sub: userId,
    email: options.email ?? `e2e-${userId.slice(0, 8)}@test.aquaculture.io`,
    role,
    roles: [role],
    tenantId,
    modules: options.modules ?? [...ALL_MODULES],
    resourcePermissions: options.resourcePermissions ?? [],
    type: options.type ?? 'access',
    ...options.customClaims,
  };

  // Include jti by default (matches production behavior)
  const includeJti = options.includeJti ?? true;
  if (includeJti) {
    payload['jti'] = randomUUID();
  }

  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: options.expiresIn ?? '1h',
    issuer: 'aquaculture-platform',
    audience: 'aquaculture-platform',
  });
}

/**
 * Generate an expired JWT token for testing auth rejection.
 */
export function generateExpiredToken(
  options: TestTokenOptions = {},
): string {
  return generateTestToken({ ...options, expiresIn: '-1s' });
}

/**
 * Generate a token without jti claim for testing jti-required guards.
 */
export function generateTokenWithoutJti(
  options: TestTokenOptions = {},
): string {
  return generateTestToken({ ...options, includeJti: false });
}

/**
 * Generate a token signed with a wrong secret for testing signature validation.
 */
export function generateTokenWithWrongSecret(
  options: TestTokenOptions = {},
): string {
  const userId = options.userId ?? randomUUID();
  const role = options.role ?? 'TENANT_ADMIN';

  const payload: Record<string, unknown> = {
    sub: userId,
    email: options.email ?? `e2e-${userId.slice(0, 8)}@test.aquaculture.io`,
    role,
    roles: [role],
    tenantId: options.tenantId ?? randomUUID(),
    modules: options.modules ?? [...ALL_MODULES],
    resourcePermissions: options.resourcePermissions ?? [],
    type: options.type ?? 'access',
    jti: randomUUID(),
  };

  return jwt.sign(payload, 'wrong-secret-that-does-not-match-the-real-one!!!', {
    expiresIn: options.expiresIn ?? '1h',
    issuer: 'aquaculture-platform',
    audience: 'aquaculture-platform',
  });
}

/**
 * Decode a JWT token without verification (useful for debugging).
 */
export function decodeTestToken(token: string): TestJwtPayload | null {
  const decoded = jwt.decode(token);
  if (!decoded || typeof decoded === 'string') {
    return null;
  }
  return decoded as TestJwtPayload;
}

/**
 * Verify a JWT token with the test secret.
 * Returns the payload or throws if invalid.
 */
export function verifyTestToken(token: string): TestJwtPayload {
  return jwt.verify(token, JWT_SECRET, {
    issuer: 'aquaculture-platform',
    audience: 'aquaculture-platform',
  }) as TestJwtPayload;
}
