/**
 * D-9 okuma fallback'i: site'li istekte site kapsamlı snapshot YOKSA tenant
 * kapsamına inilir — storage lokasyonu olmayan sitenin atamaları yalnız
 * tenant kapsamlı satır üretir (kullanıcı kararı 1, yazar tarafı), FE ise
 * her zaman siteId gönderir. Bu spec okuma tarafının sözleşmesini pinler:
 *
 *  - site satırı VARSA fallback okuması yapılmaz (tek findOne),
 *  - site satırı yoksa TENANT_SCOPE_KEY okunur ve dönen payload kapsam
 *    değişimini poolScope: 'TENANT' olarak GÖRÜNÜR taşır,
 *  - iki kapsam da yoksa null (yanlış sıfır değil, dürüst "veri yok"),
 *  - siteId'siz istekte ikinci okuma yapılmaz (tenant zaten istenen kapsam).
 */
import 'reflect-metadata';

const mockRunInTenantRead = jest.fn();
jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantRead: (...args: unknown[]): unknown => mockRunInTenantRead(...args),
}));

import { DataSource } from 'typeorm';
import { collaborator, createMockDataSource, stub } from '@aquaculture/testing';
import { Role } from '@aquaculture/backend-common/decorators';

import { FeedForecastResolver } from '../resolvers/feed-forecast.resolver';
import { FeedingForecastSnapshot } from '../entities/feeding-forecast-snapshot.entity';
import {
  TENANT_SCOPE_KEY,
  type ProtocolFeedForecastService,
} from '../services/protocol-feed-forecast.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
/** Scope anahtarları birbirinin UUID-önekli taklidi OLMAMALI (test izolasyonu). */

const findOne = jest.fn();
const admin = { sub: 'user-1', roles: [Role.TENANT_ADMIN] };

function snapshotFor(scopeKey: string): FeedingForecastSnapshot {
  return stub<FeedingForecastSnapshot>({
    id: `snap-${scopeKey}`,
    tenantId: TENANT,
    siteScopeKey: scopeKey,
    poolScope: scopeKey === TENANT_SCOPE_KEY ? 'TENANT' : 'SITE',
    horizonDays: 120,
    computedAt: new Date('2026-10-10T07:00:00.000Z'),
    perFeed: [],
    perUnit: [],
    alerts: [],
    mortalityAssumption: { applied: false, source: 'none' },
  });
}

describe('FeedForecastResolver — D-9 okuma fallback', () => {
  let resolver: FeedForecastResolver;

  beforeEach(() => {
    findOne.mockReset();
    mockRunInTenantRead.mockReset();
    mockRunInTenantRead.mockImplementation(
      async (
        _ds: unknown,
        schema: string,
        tenantId: string,
        fn: (qr: unknown) => Promise<unknown>,
      ) => {
        expect(schema).toBe('farm');
        expect(tenantId).toBe(TENANT);
        return fn({ manager: { findOne } });
      },
    );
    const { mockDataSource } = createMockDataSource();
    const forecastService = collaborator<ProtocolFeedForecastService>(
      {},
      'ProtocolFeedForecastService',
    );
    resolver = new FeedForecastResolver(mockDataSource as DataSource, forecastService);
  });

  it('site satırı VARSA onu döner — fallback okuması yapılmaz', async () => {
    findOne.mockResolvedValueOnce(snapshotFor(SITE));

    const result = await resolver.protocolFeedForecast(TENANT, admin, SITE, 7);

    expect(result?.siteScopeKey).toBe(SITE);
    expect(result?.poolScope).toBe('SITE');
    expect(findOne).toHaveBeenCalledTimes(1);
    expect(findOne).toHaveBeenCalledWith(FeedingForecastSnapshot, {
      where: { tenantId: TENANT, siteScopeKey: SITE },
    });
  });

  it('site satırı YOKSA tenant kapsamına iner ve poolScope görünür kalır', async () => {
    findOne
      .mockResolvedValueOnce(null) // site kapsamı — storage'sız site hiç yazmaz
      .mockResolvedValueOnce(snapshotFor(TENANT_SCOPE_KEY));

    const result = await resolver.protocolFeedForecast(TENANT, admin, SITE, 7);

    expect(result?.siteScopeKey).toBe(TENANT_SCOPE_KEY);
    expect(result?.poolScope).toBe('TENANT');
    expect(findOne).toHaveBeenCalledTimes(2);
    expect(findOne).toHaveBeenLastCalledWith(FeedingForecastSnapshot, {
      where: { tenantId: TENANT, siteScopeKey: TENANT_SCOPE_KEY },
    });
  });

  it('iki kapsam da yoksa null döner (0 uydurma yok)', async () => {
    findOne.mockResolvedValue(null);

    const result = await resolver.protocolFeedForecast(TENANT, admin, SITE, 7);

    expect(result).toBeNull();
    expect(findOne).toHaveBeenCalledTimes(2);
  });

  it("siteId'siz istekte tenant kapsamı zaten istenen kapsamdır — ikinci okuma yok", async () => {
    findOne.mockResolvedValueOnce(null);

    const result = await resolver.protocolFeedForecast(TENANT, admin, undefined, 7);

    expect(result).toBeNull();
    expect(findOne).toHaveBeenCalledTimes(1);
    expect(findOne).toHaveBeenCalledWith(FeedingForecastSnapshot, {
      where: { tenantId: TENANT, siteScopeKey: TENANT_SCOPE_KEY },
    });
  });
});
