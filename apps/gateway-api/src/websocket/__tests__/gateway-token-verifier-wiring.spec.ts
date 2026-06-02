import type { ConfigService } from '@nestjs/config';

import type { GatewayTokenVerifierService } from '../../guards/gateway-token-verifier.service';
import { FarmGateway } from '../farm.gateway';
import { MessagingGateway } from '../messaging.gateway';
import { SensorReadingsGateway } from '../sensor-readings.gateway';
import { STLanguageGateway } from '../st-language.gateway';

interface GatewayWithPrivateValidate {
  validateToken(token: string): Promise<unknown>;
}

function configService(): ConfigService {
  return {
    get: jest.fn((key: string, defaultValue?: unknown) => {
      if (key === 'NODE_ENV') return 'test';
      return defaultValue;
    }),
  } as unknown as ConfigService;
}

function tokenVerifier(): jest.Mocked<Pick<GatewayTokenVerifierService, 'verifyAccessToken'>> {
  return {
    verifyAccessToken: jest.fn().mockResolvedValue({
      sub: 'user-1',
      tenantId: 'tenant-1',
      roles: ['MODULE_USER'],
      type: 'access',
      jti: 'jti-1',
      iat: 1_700_000_000,
      exp: 1_700_001_000,
    }),
  };
}

describe('WebSocket gateway token verifier wiring', () => {
  it.each([
    [
      'FarmGateway',
      () =>
        new FarmGateway(tokenVerifier() as unknown as GatewayTokenVerifierService, configService()),
    ],
    [
      'SensorReadingsGateway',
      () =>
        new SensorReadingsGateway(
          tokenVerifier() as unknown as GatewayTokenVerifierService,
          undefined as never,
          configService(),
        ),
    ],
    [
      'MessagingGateway',
      () =>
        new MessagingGateway(
          tokenVerifier() as unknown as GatewayTokenVerifierService,
          configService(),
        ),
    ],
    [
      'STLanguageGateway',
      () =>
        new STLanguageGateway(
          tokenVerifier() as unknown as GatewayTokenVerifierService,
          configService(),
        ),
    ],
  ])('%s requires tenant-aware gateway token verification', async (_name, buildGateway) => {
    const gateway = buildGateway() as unknown as GatewayWithPrivateValidate & {
      tokenVerifier: jest.Mocked<Pick<GatewayTokenVerifierService, 'verifyAccessToken'>>;
    };

    await gateway.validateToken('token');

    expect(gateway.tokenVerifier.verifyAccessToken).toHaveBeenCalledWith(
      'token',
      expect.objectContaining({ requireTenantId: true }),
    );
  });
});
