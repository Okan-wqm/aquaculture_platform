import type { AccessTokenVerifierService } from '@aquaculture/backend-common/security';

import { GatewayTokenVerifierService } from '../gateway-token-verifier.service';

describe('GatewayTokenVerifierService', () => {
  const payload = {
    sub: 'user-1',
    tenantId: 'tenant-1',
    roles: ['user'],
    type: 'access' as const,
    jti: 'jti-1',
    iat: 1_700_000_000,
    exp: 1_700_001_000,
  };

  function buildService(): {
    service: GatewayTokenVerifierService;
    accessTokenVerifier: jest.Mocked<
      Pick<AccessTokenVerifierService, 'verifyAccessToken' | 'isPayloadAllowed' | 'blacklistToken'>
    >;
  } {
    const accessTokenVerifier = {
      verifyAccessToken: jest.fn().mockResolvedValue(payload),
      isPayloadAllowed: jest.fn().mockResolvedValue(true),
      blacklistToken: jest.fn(),
    };

    return {
      service: new GatewayTokenVerifierService(
        accessTokenVerifier as unknown as AccessTokenVerifierService,
      ),
      accessTokenVerifier,
    };
  }

  it('delegates full token verification to the backend-common SSoT', async () => {
    const { service, accessTokenVerifier } = buildService();

    await expect(
      service.verifyAccessToken('token', { context: 'unit', requireTenantId: true }),
    ).resolves.toEqual(payload);

    expect(accessTokenVerifier.verifyAccessToken).toHaveBeenCalledWith('token', {
      context: 'unit',
      requireTenantId: true,
    });
  });

  it('delegates cached payload policy checks to the backend-common SSoT', async () => {
    const { service, accessTokenVerifier } = buildService();

    await expect(service.isPayloadAllowed(payload, 'cached')).resolves.toBe(true);

    expect(accessTokenVerifier.isPayloadAllowed).toHaveBeenCalledWith(payload, {
      context: 'cached',
    });
  });

  it('delegates token blacklist writes to the canonical blacklist path', async () => {
    const { service, accessTokenVerifier } = buildService();

    await service.blacklistToken('jti-1', 1_700_001_000);

    expect(accessTokenVerifier.blacklistToken).toHaveBeenCalledWith('jti-1', 1_700_001_000);
  });
});
