import { UnauthorizedException } from '@nestjs/common';

import { generateVerifiedUserAssertion } from '../../utils/verified-user-assertion.util';
import { UserContextMiddleware } from '../tenant-context.middleware';

const SECRET = 'gateway-user-assertion-test-secret';
const ACTOR_TENANT_ID = '11111111-1111-4111-8111-111111111111';
const EFFECTIVE_TENANT_ID = '22222222-2222-4222-8222-222222222222';

function createConfig(overrides: Record<string, string> = {}): { get: jest.Mock } {
  return {
    get: jest.fn((key: string, fallback?: string) => {
      const values: Record<string, string> = {
        VERIFIED_USER_ASSERTION_SECRET: SECRET,
        SERVICE_NAME: 'farm-service',
        NODE_ENV: 'production',
        ...overrides,
      };
      return values[key] ?? fallback;
    }),
  };
}

describe('UserContextMiddleware', () => {
  it('does not trust raw x-user-payload without a verified assertion', () => {
    const middleware = new UserContextMiddleware(createConfig() as never);
    const req = {
      headers: {
        'x-user-payload': JSON.stringify({
          sub: 'spoofed-user',
          tenantId: EFFECTIVE_TENANT_ID,
          roles: ['SUPER_ADMIN'],
        }),
      },
    } as never;
    const next = jest.fn();

    middleware.use(req, {} as never, next);

    expect((req as { user?: unknown }).user).toBeUndefined();
    expect((req as { tenantId?: string }).tenantId).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('sets actor and effective tenant from the signed gateway assertion', () => {
    const middleware = new UserContextMiddleware(createConfig() as never);
    const assertion = generateVerifiedUserAssertion({
      user: {
        sub: 'admin-1',
        tenantId: ACTOR_TENANT_ID,
        email: 'admin@example.test',
        roles: ['SUPER_ADMIN'],
        mfaVerified: true,
      },
      secret: SECRET,
      audience: 'farm-service',
      effectiveTenantId: EFFECTIVE_TENANT_ID,
    });
    const req = {
      headers: { 'x-verified-user-assertion': assertion },
      verifiedIdentity: {
        serviceName: 'gateway-api',
        signatureVersion: 'v2',
        verifiedAt: new Date().toISOString(),
      },
    } as never;
    const next = jest.fn();

    middleware.use(req, {} as never, next);

    expect((req as { user: { tenantId: string } }).user.tenantId).toBe(ACTOR_TENANT_ID);
    expect((req as { tenantId: string }).tenantId).toBe(EFFECTIVE_TENANT_ID);
    expect(
      (req as { farmVerifiedIdentity: { actorTenantId: string } }).farmVerifiedIdentity,
    ).toMatchObject({
      callerServiceName: 'gateway-api',
      actorUserId: 'admin-1',
      actorTenantId: ACTOR_TENANT_ID,
      effectiveTenantId: EFFECTIVE_TENANT_ID,
      roles: ['SUPER_ADMIN'],
      mfaVerified: true,
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects tampered assertions before user context is created', () => {
    const middleware = new UserContextMiddleware(createConfig() as never);
    const req = { headers: { 'x-verified-user-assertion': 'bad.assertion.value' } } as never;

    expect(() => middleware.use(req, {} as never, jest.fn())).toThrow(UnauthorizedException);
    expect((req as { user?: unknown }).user).toBeUndefined();
  });
});
