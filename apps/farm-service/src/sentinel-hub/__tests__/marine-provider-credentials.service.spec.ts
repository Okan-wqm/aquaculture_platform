import {
  MarineProviderCredentialResolveOutcome,
  serializeMarineProviderCdseCredentialBundle,
} from '@platform/event-contracts';

import {
  MarineProviderCredentialsService,
  type MarineProviderCredentialResolver,
  MarineProviderCredentialUnavailableError,
} from '../marine-provider-credentials.service';

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('MarineProviderCredentialsService', () => {
  let resolve: jest.Mock;
  let service: MarineProviderCredentialsService;

  beforeEach(() => {
    resolve = jest.fn();
    const client: MarineProviderCredentialResolver = { resolve };
    service = new MarineProviderCredentialsService(client);
  });

  it('returns the exact resolved credential provenance and generation', async () => {
    resolve.mockResolvedValue({
      outcome: MarineProviderCredentialResolveOutcome.RESOLVED,
      found: true,
      bundleJson: serializeMarineProviderCdseCredentialBundle({
        clientId: 'client-id',
        clientSecret: 'client-secret',
      }),
      sourceTenantId: TENANT_ID,
      configVersion: 7,
    });

    await expect(service.resolveCdse(TENANT_ID)).resolves.toEqual({
      bundle: { clientId: 'client-id', clientSecret: 'client-secret' },
      sourceTenantId: TENANT_ID,
      configVersion: 7,
    });
  });

  it('returns null only for the explicit NOT_FOUND outcome', async () => {
    resolve.mockResolvedValue({
      outcome: MarineProviderCredentialResolveOutcome.NOT_FOUND,
      found: false,
      bundleJson: null,
      sourceTenantId: null,
      configVersion: null,
    });

    await expect(service.resolveCdse(TENANT_ID)).resolves.toBeNull();
  });

  it('does not conflate sanitized infrastructure failure with absent credentials', async () => {
    resolve.mockResolvedValue({
      outcome: MarineProviderCredentialResolveOutcome.UNAVAILABLE,
      found: false,
      bundleJson: null,
      sourceTenantId: null,
      configVersion: null,
    });

    await expect(service.resolveCdse(TENANT_ID)).rejects.toBeInstanceOf(
      MarineProviderCredentialUnavailableError,
    );
  });
});
