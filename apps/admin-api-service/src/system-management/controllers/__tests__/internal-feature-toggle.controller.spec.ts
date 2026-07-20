import { verifyFeatureEvaluationSnapshot } from '@aquaculture/backend-common/feature-toggle';
import type { TenantRequest } from '@aquaculture/backend-common/types';
import { ConfigService } from '@nestjs/config';

import { InternalFeatureToggleController } from '../internal-feature-toggle.controller';
import { GlobalSettingsService } from '../../services/global-settings.service';
import { InternalFeatureEvaluationSigner } from '../../services/internal-feature-evaluation-signer.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const KEYRING = [
  {
    kid: 'active',
    secret: 'a'.repeat(32),
    status: 'active' as const,
  },
];

describe('InternalFeatureToggleController', () => {
  it('derives tenant and audience only from the verified service identity', async () => {
    const settings = {
      evaluateFeatureToggle: jest.fn().mockResolvedValue({
        key: 'marine_explorer',
        enabled: false,
        reason: 'Feature is disabled',
      }),
    } as Partial<GlobalSettingsService> as GlobalSettingsService;
    const config = new ConfigService({
      SERVICE_IDENTITY_KEYRING: JSON.stringify(KEYRING),
      SERVICE_IDENTITY_SIGNING_KID: 'active',
    });
    const controller = new InternalFeatureToggleController(
      settings,
      new InternalFeatureEvaluationSigner(config),
    );
    const request = {
      verifiedIdentity: {
        serviceName: 'gateway-api',
        tenantId: TENANT_ID,
        effectiveTenantId: TENANT_ID,
        keyId: 'active',
        audience: 'admin-api-service',
        nonce: 'nonce',
        version: 'v2' as const,
      },
    } as TenantRequest;

    const snapshot = await controller.evaluate(request, {
      featureKeys: ['marine_explorer'],
    });

    expect(settings.evaluateFeatureToggle).toHaveBeenCalledWith('marine_explorer', {
      tenantId: TENANT_ID,
    });
    expect(
      verifyFeatureEvaluationSnapshot(snapshot, {
        keyring: KEYRING,
        expectedAudience: 'gateway-api',
        expectedTenantId: TENANT_ID,
        expectedFeatureKeys: ['marine_explorer'],
      }).evaluations,
    ).toEqual([{ key: 'marine_explorer', enabled: false }]);
  });

  it('refuses a request without middleware-verified tenant identity', async () => {
    const controller = new InternalFeatureToggleController(
      {} as GlobalSettingsService,
      {} as InternalFeatureEvaluationSigner,
    );

    await expect(
      controller.evaluate({} as TenantRequest, { featureKeys: ['marine_explorer'] }),
    ).rejects.toThrow('Verified tenant-bound service identity is required');
  });

  it('supports only the established non-production signer fallback', () => {
    const developmentSecret = 'local-development-feature-key-material';
    const signer = new InternalFeatureEvaluationSigner(
      new ConfigService({
        NODE_ENV: 'development',
        SERVICE_IDENTITY_SIGNING_SECRET: developmentSecret,
      }),
    );
    const snapshot = signer.sign({
      audience: 'gateway-api',
      tenantId: TENANT_ID,
      evaluations: [{ key: 'marine_explorer', enabled: false }],
    });

    expect(
      verifyFeatureEvaluationSnapshot(snapshot, {
        keyring: [{ kid: 'local-dev', secret: developmentSecret, status: 'active' }],
        expectedAudience: 'gateway-api',
        expectedTenantId: TENANT_ID,
        expectedFeatureKeys: ['marine_explorer'],
      }).keyId,
    ).toBe('local-dev');

    expect(() =>
      new InternalFeatureEvaluationSigner(
        new ConfigService({
          NODE_ENV: 'production',
          SERVICE_IDENTITY_SIGNING_SECRET: developmentSecret,
        }),
      ).sign({
        audience: 'gateway-api',
        tenantId: TENANT_ID,
        evaluations: [{ key: 'marine_explorer', enabled: false }],
      }),
    ).toThrow('Production feature evaluation keyring configuration is invalid');
  });
});
