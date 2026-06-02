import type { AccessTokenVerifierService } from '@aquaculture/backend-common/security';

import { ScadaRuntimeGateway } from './scada-runtime.gateway';

function createGateway(overrides: {
  payload?: Record<string, unknown> | null;
} = {}): {
  gateway: ScadaRuntimeGateway;
  accessTokenVerifier: jest.Mocked<Pick<AccessTokenVerifierService, 'verifyAccessToken'>>;
} {
  const payload =
    overrides.payload === undefined
      ? {
          sub: 'user-1',
          tenantId: 'tenant-1',
          type: 'access',
          jti: 'jti-1',
          iat: 1_700_000_000,
          exp: 1_700_000_900,
          roles: ['operator'],
        }
      : overrides.payload;
  const accessTokenVerifier = {
    verifyAccessToken: jest.fn().mockResolvedValue(payload),
  };
  const configService = {
    get: jest.fn((_key: string, fallback?: string) => fallback),
  };

  const gateway = new ScadaRuntimeGateway(
    {} as never,
    configService as never,
    accessTokenVerifier as unknown as AccessTokenVerifierService,
  );

  return { gateway, accessTokenVerifier };
}

describe('ScadaRuntimeGateway token validation', () => {
  it('uses the canonical access-token verifier', async () => {
    const { gateway, accessTokenVerifier } = createGateway();

    const payload = await (
      gateway as unknown as { validateToken(token: string): Promise<unknown> }
    ).validateToken('token');

    expect(payload).toMatchObject({ sub: 'user-1', tenantId: 'tenant-1' });
    expect(accessTokenVerifier.verifyAccessToken).toHaveBeenCalledWith('token', {
      context: 'sensor-service.ScadaRuntimeGateway',
      requireTenantId: true,
    });
  });

  it('rejects revoked or invalid tenant tokens from the canonical verifier', async () => {
    const { gateway } = createGateway({ payload: null });

    await expect(
      (gateway as unknown as { validateToken(token: string): Promise<unknown> }).validateToken(
        'token',
      ),
    ).resolves.toBeNull();
  });
});
