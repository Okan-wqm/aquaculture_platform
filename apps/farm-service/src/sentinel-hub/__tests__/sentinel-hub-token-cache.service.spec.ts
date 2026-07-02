jest.mock('@aquaculture/backend-common/database', () => ({
  runInTenantTransaction: jest.fn(),
}));

import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { createMockDataSource, createMockRepository } from '@aquaculture/testing';

import { SentinelHubSettings } from '../entities/sentinel-hub-settings.entity';
import { SentinelHubService } from '../sentinel-hub.service';

/**
 * Per-tenant CDSE token cache + in-flight dedup (ORPHAN-MEDIUM-269). Without it
 * every WMS tile in a map pan fired a fresh OAuth POST + a credential-read
 * transaction. These cases pin: cache-hit serves without re-authenticating,
 * concurrent calls share one fetch, and a credential change invalidates it.
 */
describe('SentinelHubService — access-token cache', () => {
  const tenantId = 't1';
  let service: SentinelHubService;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    (runInTenantTransaction as jest.Mock).mockImplementation(
      (_ds: unknown, _schema: unknown, _tid: unknown, fn: (qr: unknown) => unknown) =>
        fn({
          manager: {
            findOne: jest
              .fn()
              .mockResolvedValue({ tenantId, clientId: 'cid', clientSecret: 'sec', usageCount: 0, isConfigured: true }),
            save: jest.fn().mockResolvedValue(undefined),
          },
        }),
    );
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'tok-1', expires_in: 1800 }),
    } as Response);

    service = new SentinelHubService(
      createMockRepository<SentinelHubSettings>(),
      createMockDataSource().mockDataSource,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('serves the second request from cache without a second OAuth fetch', async () => {
    const first = await service.getAccessToken(tenantId);
    const second = await service.getAccessToken(tenantId);

    expect(first?.accessToken).toBe('tok-1');
    expect(second?.accessToken).toBe('tok-1');
    expect(fetchSpy).toHaveBeenCalledTimes(1); // cache hit on the second call
  });

  it('coalesces concurrent refreshes for the same tenant into one fetch', async () => {
    const [a, b, c] = await Promise.all([
      service.getAccessToken(tenantId),
      service.getAccessToken(tenantId),
      service.getAccessToken(tenantId),
    ]);

    expect(a?.accessToken).toBe('tok-1');
    expect(b?.accessToken).toBe('tok-1');
    expect(c?.accessToken).toBe('tok-1');
    expect(fetchSpy).toHaveBeenCalledTimes(1); // in-flight dedup
  });

  it('re-authenticates after the cache is invalidated (e.g. credentials changed)', async () => {
    await service.getAccessToken(tenantId);
    service.invalidateTokenCache(tenantId);
    await service.getAccessToken(tenantId);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('keeps tenants isolated — one tenant cache hit does not serve another', async () => {
    await service.getAccessToken('tenant-a');
    await service.getAccessToken('tenant-b');

    expect(fetchSpy).toHaveBeenCalledTimes(2); // distinct tenants → distinct fetches
  });
});
