import type { CircuitBreakerService } from '@aquaculture/backend-common/resilience';
import { stub } from '@aquaculture/testing';
import type { NatsRequestReply } from '@platform/event-bus';
import { FARM_TIME_ZONE_QUERY_SUBJECTS } from '@platform/event-contracts';
import type { QueryRunner } from 'typeorm';

import { SeriesTimeZoneSource } from '../../dto/channel-reading.dto';
import { SeriesTimeZoneService } from '../series-time-zone.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OSLO_SITE = '22222222-2222-4222-8222-222222222222';
const KOLKATA_SITE = '33333333-3333-4333-8333-333333333333';
const INHERITING_SITE = '44444444-4444-4444-8444-444444444444';

const FARM_ANSWER = {
  tenantZone: 'Europe/Istanbul',
  siteZones: {
    [OSLO_SITE]: 'Europe/Oslo',
    [KOLKATA_SITE]: 'Asia/Kolkata',
    [INHERITING_SITE]: 'Europe/Istanbul',
  },
};

function makeService(requestTyped: jest.Mock): SeriesTimeZoneService {
  return new SeriesTimeZoneService(
    stub<NatsRequestReply>({ requestTyped }),
    stub<CircuitBreakerService>({
      execute: <T>(args: { fn: () => Promise<T> }): Promise<T> => args.fn(),
    }),
  );
}

/** A query runner that knows the zones Postgres would list, with their offsets. */
function postgresKnowing(offsets: Record<string, number>): QueryRunner {
  return stub<QueryRunner>({
    query: jest.fn().mockImplementation(async (_sql: string, params: unknown[]) => {
      const offset = offsets[String(params[0])];
      return offset === undefined ? [] : [{ offset_seconds: offset }];
    }),
  });
}

const sites = (...entries: Array<[string, string | null]>): Map<string, string | null> =>
  new Map(entries);

describe('SeriesTimeZoneService', () => {
  it("names the sensors' site zone when they all share one", async () => {
    const requestTyped = jest.fn().mockResolvedValue(FARM_ANSWER);
    const candidate = await makeService(requestTyped).candidate(
      TENANT,
      sites(['s1', OSLO_SITE], ['s2', OSLO_SITE]),
    );
    expect(candidate).toEqual({ zone: 'Europe/Oslo', source: SeriesTimeZoneSource.SITE });
    expect(requestTyped).toHaveBeenCalledWith(
      FARM_TIME_ZONE_QUERY_SUBJECTS.RESOLVE,
      { tenantId: TENANT, siteIds: [OSLO_SITE] },
      { timeoutMs: expect.any(Number) },
    );
  });

  it('names the tenant zone for mixed sites, a sensor without a site, or an unknown site', async () => {
    const service = makeService(jest.fn().mockResolvedValue(FARM_ANSWER));
    for (const siteBySensor of [
      sites(['s1', OSLO_SITE], ['s2', KOLKATA_SITE]),
      sites(['s1', null]),
      sites(['s1', '55555555-5555-4555-8555-555555555555']),
      sites(['s1', 'not-a-uuid']),
    ]) {
      expect(await service.candidate(TENANT, siteBySensor)).toEqual({
        zone: 'Europe/Istanbul',
        source: SeriesTimeZoneSource.TENANT,
      });
    }
  });

  it('asks farm once per tenant and sites within the cache window', async () => {
    const requestTyped = jest.fn().mockResolvedValue(FARM_ANSWER);
    const service = makeService(requestTyped);
    await service.candidate(TENANT, sites(['s1', OSLO_SITE]));
    await service.candidate(TENANT, sites(['s2', OSLO_SITE]));
    expect(requestTyped).toHaveBeenCalledTimes(1);
    await service.candidate(TENANT, sites(['s3', KOLKATA_SITE]));
    expect(requestTyped).toHaveBeenCalledTimes(2);
  });

  it('has no candidate when farm fails or answers off-contract, and shows UTC as unavailable', async () => {
    for (const requestTyped of [
      jest.fn().mockRejectedValue(new Error('no responders')),
      jest.fn().mockResolvedValue({ zone: 'Europe/Oslo' }),
    ]) {
      const service = makeService(requestTyped);
      const candidate = await service.candidate(TENANT, sites(['s1', OSLO_SITE]));
      expect(candidate).toBeNull();
      expect(await service.validated(postgresKnowing({}), candidate)).toEqual({
        displayTimeZone: 'UTC',
        source: SeriesTimeZoneSource.UNAVAILABLE,
        bucketZone: { kind: 'utc' },
      });
    }
  });

  it('checks the zone against Postgres and reads whether its offset is a whole hour', async () => {
    const service = makeService(jest.fn());
    const pg = postgresKnowing({ 'Europe/Oslo': 7200, 'Asia/Kolkata': 19800, UTC: 0 });
    expect(
      await service.validated(pg, { zone: 'Europe/Oslo', source: SeriesTimeZoneSource.SITE }),
    ).toEqual({
      displayTimeZone: 'Europe/Oslo',
      source: SeriesTimeZoneSource.SITE,
      bucketZone: { kind: 'zoned', wholeHourOffset: true },
    });
    expect(
      (await service.validated(pg, { zone: 'Asia/Kolkata', source: SeriesTimeZoneSource.SITE }))
        .bucketZone,
    ).toEqual({ kind: 'zoned', wholeHourOffset: false });
    expect(
      (await service.validated(pg, { zone: 'UTC', source: SeriesTimeZoneSource.TENANT }))
        .bucketZone,
    ).toEqual({ kind: 'utc' });
  });

  it('shows UTC as unavailable when Postgres does not know the zone farm named', async () => {
    const service = makeService(jest.fn());
    expect(
      await service.validated(postgresKnowing({}), {
        zone: 'America/Ciudad_Juarez',
        source: SeriesTimeZoneSource.SITE,
      }),
    ).toEqual({
      displayTimeZone: 'UTC',
      source: SeriesTimeZoneSource.UNAVAILABLE,
      bucketZone: { kind: 'utc' },
    });
  });
});
