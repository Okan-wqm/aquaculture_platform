import observationFixture from './__fixtures__/frost-observations.json';
import sourceFixture from './__fixtures__/frost-source.json';
import {
  FROST_ACCEPTED_MAX_STATION_DISTANCE_KM,
  FROST_DEFAULT_ELEMENTS,
  FrostElementId,
  FrostObservationsService,
  FrostQualityStatus,
} from './frost-observations.service';
import {
  MetNorwayProviderErrorCode,
  type MetNorwayFetch,
  type MetNorwayProviderConfig,
} from './met-norway-provider';

const NOW = new Date('2026-08-01T00:00:00.000Z');
const CONFIG: MetNorwayProviderConfig = {
  applicationName: 'AquaSaaS/1.0',
  contact: 'support@example.test',
  frostClientId: 'sanitized-client-id',
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/ld+json' },
  });
}

function createFrostFetch(): jest.MockedFunction<MetNorwayFetch> {
  return jest
    .fn<Promise<Response>, [string | URL, RequestInit?]>()
    .mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/sources/v0.jsonld') {
        return jsonResponse(sourceFixture);
      }
      if (
        url.pathname === '/observations/v0.jsonld' &&
        (url.searchParams.get('referencetime') ?? '').startsWith('2026-07-27T00:00:00.000Z/')
      ) {
        return jsonResponse(observationFixture);
      }
      return jsonResponse({}, 404);
    });
}

function sourceAtDistance(distanceKm: number): typeof sourceFixture {
  const source = structuredClone(sourceFixture);
  source.data[0]!.distance = distanceKm;
  return source;
}

describe('FrostObservationsService', () => {
  it('does not request station surface pressure for the sea-level pressure metric', () => {
    expect(FROST_DEFAULT_ELEMENTS).not.toContain(FrostElementId.SURFACE_AIR_PRESSURE);
  });

  it('discovers a nearby station and returns provenance, units, quality and gaps', async () => {
    const fetchFn = createFrostFetch();
    const service = new FrostObservationsService(CONFIG, fetchFn, {
      now: (): Date => NOW,
    });

    const result = await service.fetchLast30Days({
      latitude: 60.3929,
      longitude: 5.3221,
      elements: [FrostElementId.AIR_TEMPERATURE, FrostElementId.WIND_SPEED],
    });

    expect(result.status).toBe('AVAILABLE');
    if (result.status !== 'AVAILABLE') throw new Error('fixture must be available');
    expect(result.requestedFrom).toBe('2026-07-02T00:00:00.000Z');
    expect(result.requestedTo).toBe(NOW.toISOString());
    expect(result.station).toEqual({
      id: 'SN99999',
      name: 'SANITIZED COASTAL STATION',
      latitude: 60.4011,
      longitude: 5.3412,
      distanceKm: 1.42,
    });
    expect(result.observations).toEqual([
      {
        stationId: 'SN99999',
        referenceTime: '2026-07-31T12:00:00.000Z',
        elementId: FrostElementId.AIR_TEMPERATURE,
        value: 0,
        unit: 'degC',
        qualityCode: 0,
        qualityStatus: FrostQualityStatus.CONTROLLED_OK,
        timeOffset: 'PT0H',
        timeResolution: 'PT1H',
      },
      {
        stationId: 'SN99999',
        referenceTime: '2026-07-31T12:00:00.000Z',
        elementId: FrostElementId.WIND_SPEED,
        value: 4.6,
        unit: 'm/s',
        qualityCode: 2,
        qualityStatus: FrostQualityStatus.SLIGHTLY_UNCERTAIN,
        timeOffset: 'PT0H',
        timeResolution: 'PT1H',
      },
    ]);
    expect(result.elementCoverage).toEqual([
      {
        elementId: FrostElementId.AIR_TEMPERATURE,
        status: 'AVAILABLE',
        observationCount: 1,
      },
      {
        elementId: FrostElementId.WIND_SPEED,
        status: 'AVAILABLE',
        observationCount: 1,
      },
    ]);
    expect(result.missingIntervals).toHaveLength(10);
    expect(result.missingIntervals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ elementId: FrostElementId.AIR_TEMPERATURE }),
        expect.objectContaining({ elementId: FrostElementId.WIND_SPEED }),
      ]),
    );

    const sourceCall = fetchFn.mock.calls[0];
    const sourceUrl = new URL(String(sourceCall?.[0]));
    expect(sourceUrl.origin).toBe('https://frost.met.no');
    expect(sourceUrl.pathname).toBe('/sources/v0.jsonld');
    expect(sourceUrl.searchParams.get('geometry')).toBe('nearest(POINT(5.3221 60.3929))');
    expect(sourceUrl.searchParams.get('nearestmaxcount')).toBe('1');
    expect(sourceCall?.[1]).toMatchObject({
      redirect: 'manual',
      headers: {
        Authorization: `Basic ${Buffer.from('sanitized-client-id:').toString('base64')}`,
        'User-Agent': 'AquaSaaS/1.0 support@example.test',
      },
    });
  });

  it('keeps the history window anchor separate from fetch completion provenance', async () => {
    const completedAt = new Date('2026-08-01T00:00:12.000Z');
    let clockReads = 0;
    const service = new FrostObservationsService(CONFIG, createFrostFetch(), {
      now: (): Date => (clockReads++ === 0 ? NOW : completedAt),
    });

    const result = await service.fetchLast30Days({
      latitude: 60.3929,
      longitude: 5.3221,
      elements: [FrostElementId.AIR_TEMPERATURE],
    });

    expect(result).toMatchObject({
      fetchedAt: completedAt.toISOString(),
      requestedFrom: '2026-07-02T00:00:00.000Z',
      requestedTo: NOW.toISOString(),
    });
  });

  it('records a missing interval only for elements absent from a mixed chunk', async () => {
    const windOnly = structuredClone(observationFixture);
    windOnly.data[0]!.observations = windOnly.data[0]!.observations.filter(
      ({ elementId }) => elementId === FrostElementId.WIND_SPEED,
    );
    const fetchFn = createFrostFetch().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/sources/v0.jsonld') return jsonResponse(sourceFixture);
      return (url.searchParams.get('referencetime') ?? '').startsWith('2026-07-27T00:00:00.000Z/')
        ? jsonResponse(windOnly)
        : jsonResponse({}, 404);
    });
    const service = new FrostObservationsService(CONFIG, fetchFn, {
      now: (): Date => NOW,
    });

    const result = await service.fetchLast30Days({
      latitude: 60.3929,
      longitude: 5.3221,
      elements: [FrostElementId.AIR_TEMPERATURE, FrostElementId.WIND_SPEED],
    });

    expect(result.status).toBe('AVAILABLE');
    if (result.status !== 'AVAILABLE') throw new Error('fixture must be available');
    expect(result.elementCoverage).toEqual([
      {
        elementId: FrostElementId.AIR_TEMPERATURE,
        status: 'NO_DATA',
        observationCount: 0,
      },
      {
        elementId: FrostElementId.WIND_SPEED,
        status: 'AVAILABLE',
        observationCount: 1,
      },
    ]);
    expect(result.missingIntervals).toHaveLength(11);
    const finalChunkGaps = result.missingIntervals.filter(
      ({ from }) => from === '2026-07-27T00:00:00.000Z',
    );
    expect(finalChunkGaps).toEqual([
      expect.objectContaining({ elementId: FrostElementId.AIR_TEMPERATURE }),
    ]);
  });

  it('returns explicit no coverage when no matching nearby station exists', async () => {
    const fetchFn = jest
      .fn<Promise<Response>, [string | URL, RequestInit?]>()
      .mockResolvedValue(jsonResponse({}, 404));
    const service = new FrostObservationsService(CONFIG, fetchFn, {
      now: (): Date => NOW,
    });

    await expect(
      service.fetchLast30Days({
        latitude: 60.3929,
        longitude: 5.3221,
        elements: [FrostElementId.AIR_TEMPERATURE],
      }),
    ).resolves.toEqual({
      status: 'NO_COVERAGE',
      provider: 'FROST',
      fetchedAt: NOW.toISOString(),
      requestedFrom: '2026-07-02T00:00:00.000Z',
      requestedTo: NOW.toISOString(),
      reason: 'NO_STATION_WITH_REQUIRED_ELEMENTS',
    });
  });

  it('accepts a station exactly on the locality boundary', async () => {
    const fetchFn = createFrostFetch().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/sources/v0.jsonld') {
        return jsonResponse(sourceAtDistance(FROST_ACCEPTED_MAX_STATION_DISTANCE_KM));
      }
      if (
        url.pathname === '/observations/v0.jsonld' &&
        (url.searchParams.get('referencetime') ?? '').startsWith('2026-07-27T00:00:00.000Z/')
      ) {
        return jsonResponse(observationFixture);
      }
      return jsonResponse({}, 404);
    });
    const service = new FrostObservationsService(CONFIG, fetchFn, {
      now: (): Date => NOW,
    });

    const result = await service.fetchLast30Days({
      latitude: 60.3929,
      longitude: 5.3221,
      elements: [FrostElementId.AIR_TEMPERATURE, FrostElementId.WIND_SPEED],
    });

    expect(result).toMatchObject({
      status: 'AVAILABLE',
      station: { distanceKm: FROST_ACCEPTED_MAX_STATION_DISTANCE_KM },
    });
  });

  it('returns no coverage without reading observations when the nearest station is too distant', async () => {
    const fetchFn = createFrostFetch().mockImplementation(async (input) => {
      const url = new URL(String(input));
      return url.pathname === '/sources/v0.jsonld'
        ? jsonResponse(sourceAtDistance(FROST_ACCEPTED_MAX_STATION_DISTANCE_KM + 0.001))
        : jsonResponse(observationFixture);
    });
    const service = new FrostObservationsService(CONFIG, fetchFn, {
      now: (): Date => NOW,
    });

    await expect(
      service.fetchLast30Days({
        latitude: 60.3929,
        longitude: 5.3221,
        elements: [FrostElementId.AIR_TEMPERATURE],
      }),
    ).resolves.toEqual({
      status: 'NO_COVERAGE',
      provider: 'FROST',
      fetchedAt: NOW.toISOString(),
      requestedFrom: '2026-07-02T00:00:00.000Z',
      requestedTo: NOW.toISOString(),
      reason: 'NO_STATION_WITH_REQUIRED_ELEMENTS',
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('returns explicit no observations when every five-day chunk has no data', async () => {
    const fetchFn = jest
      .fn<Promise<Response>, [string | URL, RequestInit?]>()
      .mockImplementation(async (input) => {
        const url = new URL(String(input));
        return url.pathname === '/sources/v0.jsonld'
          ? jsonResponse(sourceFixture)
          : jsonResponse({}, 404);
      });
    const service = new FrostObservationsService(CONFIG, fetchFn, {
      now: (): Date => NOW,
    });

    const result = await service.fetchLast30Days({
      latitude: 60.3929,
      longitude: 5.3221,
      elements: [FrostElementId.AIR_TEMPERATURE],
    });
    expect(result).toMatchObject({
      status: 'NO_COVERAGE',
      reason: 'NO_OBSERVATIONS',
    });
  });

  it('accepts an observation on an inclusive Frost chunk boundary', async () => {
    const boundaryFixture = structuredClone(observationFixture);
    boundaryFixture.data[0]!.referenceTime = '2026-07-07T00:00:00Z';
    const fetchFn = jest
      .fn<Promise<Response>, [string | URL, RequestInit?]>()
      .mockImplementation(async (input) => {
        const url = new URL(String(input));
        if (url.pathname === '/sources/v0.jsonld') return jsonResponse(sourceFixture);
        return (url.searchParams.get('referencetime') ?? '').startsWith('2026-07-07T00:00:00.000Z/')
          ? jsonResponse(boundaryFixture)
          : jsonResponse({}, 404);
      });
    const service = new FrostObservationsService(CONFIG, fetchFn, {
      now: (): Date => NOW,
    });

    const result = await service.fetchLast30Days({
      latitude: 60.3929,
      longitude: 5.3221,
      elements: [FrostElementId.AIR_TEMPERATURE, FrostElementId.WIND_SPEED],
    });

    expect(result).toMatchObject({
      status: 'AVAILABLE',
      observations: [
        expect.objectContaining({ referenceTime: '2026-07-07T00:00:00.000Z' }),
        expect.objectContaining({ referenceTime: '2026-07-07T00:00:00.000Z' }),
      ],
    });
  });

  it('rejects an observation outside the requested half-open Frost chunk', async () => {
    const outsideFixture = structuredClone(observationFixture);
    outsideFixture.data[0]!.referenceTime = '2026-07-07T00:00:00Z';
    const fetchFn = jest
      .fn<Promise<Response>, [string | URL, RequestInit?]>()
      .mockImplementation(async (input) => {
        const url = new URL(String(input));
        if (url.pathname === '/sources/v0.jsonld') return jsonResponse(sourceFixture);
        return (url.searchParams.get('referencetime') ?? '').startsWith('2026-07-02T00:00:00.000Z/')
          ? jsonResponse(outsideFixture)
          : jsonResponse({}, 404);
      });
    const service = new FrostObservationsService(CONFIG, fetchFn, {
      now: (): Date => NOW,
    });

    await expect(
      service.fetchLast30Days({
        latitude: 60.3929,
        longitude: 5.3221,
        elements: [FrostElementId.AIR_TEMPERATURE],
      }),
    ).rejects.toMatchObject({
      code: MetNorwayProviderErrorCode.SCHEMA,
      retryable: false,
    });
  });

  it('rejects timezone-less timestamps and invalid physical ranges', async () => {
    const timezoneLess = structuredClone(observationFixture);
    timezoneLess.data[0]!.referenceTime = '2026-07-31T12:00:00';
    const negativeWind = structuredClone(observationFixture);
    negativeWind.data[0]!.observations[1]!.value = -1;

    for (const payload of [timezoneLess, negativeWind]) {
      const fetchFn = jest
        .fn<Promise<Response>, [string | URL, RequestInit?]>()
        .mockImplementation(async (input) => {
          const url = new URL(String(input));
          if (url.pathname === '/sources/v0.jsonld') return jsonResponse(sourceFixture);
          return (url.searchParams.get('referencetime') ?? '').startsWith(
            '2026-07-27T00:00:00.000Z/',
          )
            ? jsonResponse(payload)
            : jsonResponse({}, 404);
        });
      const service = new FrostObservationsService(CONFIG, fetchFn, {
        now: (): Date => NOW,
      });
      await expect(
        service.fetchLast30Days({
          latitude: 60.3929,
          longitude: 5.3221,
          elements: [FrostElementId.AIR_TEMPERATURE, FrostElementId.WIND_SPEED],
        }),
      ).rejects.toMatchObject({
        code: MetNorwayProviderErrorCode.SCHEMA,
      });
    }
  });

  it('fails closed before network access when the Frost client ID is absent', async () => {
    const fetchFn = createFrostFetch();
    const service = new FrostObservationsService(
      { applicationName: 'AquaSaaS/1.0', contact: 'support@example.test' },
      fetchFn,
      { now: (): Date => NOW },
    );

    await expect(
      service.fetchLast30Days({
        latitude: 60.3929,
        longitude: 5.3221,
      }),
    ).rejects.toMatchObject({
      code: MetNorwayProviderErrorCode.CONFIGURATION,
      retryable: false,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('fails closed on malformed station metadata', async () => {
    const fetchFn = jest
      .fn<Promise<Response>, [string | URL, RequestInit?]>()
      .mockResolvedValue(jsonResponse({ data: [{ id: 'SN99999' }] }));
    const service = new FrostObservationsService(CONFIG, fetchFn, {
      now: (): Date => NOW,
    });

    await expect(
      service.fetchLast30Days({
        latitude: 60.3929,
        longitude: 5.3221,
      }),
    ).rejects.toMatchObject({
      code: MetNorwayProviderErrorCode.SCHEMA,
      retryable: false,
    });
  });
});
