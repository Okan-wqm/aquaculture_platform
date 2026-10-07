import 'reflect-metadata';

const mockRunInTenantRead = jest.fn();
jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantRead: (...args: unknown[]): unknown => mockRunInTenantRead(...args),
}));

import { createMockDataSource, stub } from '@aquaculture/testing';
import { Test } from '@nestjs/testing';
import { NatsRequestReply } from '@platform/event-bus';
import {
  FARM_TIME_ZONE_QUERY_SUBJECTS,
  isResolveFarmTimeZonesResponse,
} from '@platform/event-contracts';
import { DataSource } from 'typeorm';

import {
  FarmTimeZoneAuthorityUnavailableError,
  FarmTimeZoneRequestInvalidError,
  ResolveTimeZonesResponder,
} from '../responders/resolve-time-zones.responder';
import { SiteTimeZoneService, type TenantZoneMap } from '../services/site-time-zone.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OSLO_SITE = '22222222-2222-4222-8222-222222222222';
const INHERITING_SITE = '33333333-3333-4333-8333-333333333333';
const DELETED_SITE = '44444444-4444-4444-8444-444444444444';

const ZONES: TenantZoneMap = {
  tenantZone: 'Europe/Istanbul',
  zoneOf: (siteId) => (siteId === OSLO_SITE ? 'Europe/Oslo' : 'Europe/Istanbul'),
  knows: (siteId) => siteId === OSLO_SITE || siteId === INHERITING_SITE,
};

/**
 * The farm answer behind sensor charts' local days: same resolver as feeding,
 * zones only for the sites asked about that are live.
 */
describe('ResolveTimeZonesResponder', () => {
  const drain = jest.fn().mockResolvedValue(undefined);
  const respond = jest.fn().mockResolvedValue({
    subject: FARM_TIME_ZONE_QUERY_SUBJECTS.RESOLVE,
    drain,
  });
  const siteZones = jest.fn();
  let responder: ResolveTimeZonesResponder;

  beforeEach(async () => {
    jest.clearAllMocks();
    siteZones.mockResolvedValue(ZONES);
    mockRunInTenantRead.mockImplementation(
      async (
        _dataSource: unknown,
        schema: string,
        tenantId: string,
        read: (queryRunner: unknown) => Promise<unknown>,
      ) => {
        expect(schema).toBe('farm');
        expect(tenantId).toBe(TENANT_ID);
        return read({ manager: {} });
      },
    );
    const { mockDataSource } = createMockDataSource();
    const module = await Test.createTestingModule({
      providers: [
        ResolveTimeZonesResponder,
        { provide: DataSource, useValue: mockDataSource },
        { provide: NatsRequestReply, useValue: { respond } },
        { provide: SiteTimeZoneService, useValue: stub<SiteTimeZoneService>({ siteZones }) },
      ],
    }).compile();
    responder = module.get(ResolveTimeZonesResponder);
  });

  it('registers and drains the shared subject', async () => {
    await responder.onModuleInit();
    expect(respond).toHaveBeenCalledWith(
      FARM_TIME_ZONE_QUERY_SUBJECTS.RESOLVE,
      expect.any(Function),
      { queue: 'farm-service' },
    );
    await responder.onModuleDestroy();
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it('names a zone for each live site asked about, and the tenant zone', async () => {
    const reply = await responder.resolve({
      tenantId: TENANT_ID,
      siteIds: [OSLO_SITE, INHERITING_SITE, DELETED_SITE, 'not-a-uuid', OSLO_SITE],
    });
    expect(reply).toEqual({
      tenantZone: 'Europe/Istanbul',
      siteZones: { [OSLO_SITE]: 'Europe/Oslo', [INHERITING_SITE]: 'Europe/Istanbul' },
    });
    expect(isResolveFarmTimeZonesResponse(reply)).toBe(true);
  });

  it('refuses a request that does not match the contract, before any read', async () => {
    await expect(responder.resolve({ tenantId: 'bad', siteIds: [] })).rejects.toBeInstanceOf(
      FarmTimeZoneRequestInvalidError,
    );
    await expect(
      responder.resolve({ tenantId: TENANT_ID, siteIds: Array(101).fill(OSLO_SITE) }),
    ).rejects.toBeInstanceOf(FarmTimeZoneRequestInvalidError);
    expect(mockRunInTenantRead).not.toHaveBeenCalled();
  });

  it('reports an unavailable authority instead of guessing a zone', async () => {
    siteZones.mockRejectedValue(new Error('relation "sites" does not exist'));
    await expect(
      responder.resolve({ tenantId: TENANT_ID, siteIds: [OSLO_SITE] }),
    ).rejects.toBeInstanceOf(FarmTimeZoneAuthorityUnavailableError);
  });
});
