/**
 * JWT Test Helper
 * Generates test JWT tokens for E2E tests with tenant isolation.
 */
import * as jwt from 'jsonwebtoken';

const TEST_JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-for-e2e';

export interface TestTokenPayload {
  sub: string;
  email: string;
  tenantId: string;
  roles: string[];
  iat?: number;
  exp?: number;
}

/**
 * Generate a signed JWT token for test purposes.
 */
export function generateTestToken(overrides: Partial<TestTokenPayload> = {}): string {
  const payload: TestTokenPayload = {
    sub: overrides.sub || 'e2e-test-user-' + Date.now(),
    email: overrides.email || 'e2e@test.local',
    tenantId: overrides.tenantId || 'tenant-a-' + Date.now(),
    roles: overrides.roles || ['TENANT_ADMIN'],
    ...overrides,
  };

  return jwt.sign(payload, TEST_JWT_SECRET, { expiresIn: '1h' });
}

/**
 * Generate a pair of tokens for cross-tenant tests.
 * Returns two tokens with DIFFERENT tenantIds for isolation testing.
 */
export function generateCrossTenantTokens(): {
  tenantA: { token: string; tenantId: string; userId: string };
  tenantB: { token: string; tenantId: string; userId: string };
} {
  const suffix = Date.now();
  const tenantAId = `tenant-a-${suffix}`;
  const tenantBId = `tenant-b-${suffix}`;
  const userAId = `user-a-${suffix}`;
  const userBId = `user-b-${suffix}`;

  return {
    tenantA: {
      token: generateTestToken({ tenantId: tenantAId, sub: userAId }),
      tenantId: tenantAId,
      userId: userAId,
    },
    tenantB: {
      token: generateTestToken({ tenantId: tenantBId, sub: userBId }),
      tenantId: tenantBId,
      userId: userBId,
    },
  };
}
