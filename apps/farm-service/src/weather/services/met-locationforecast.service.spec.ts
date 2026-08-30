import fixture from './__fixtures__/locationforecast-compact.json';
import {
  MetLocationForecastService,
  type MetLocationForecastAvailable,
} from './met-locationforecast.service';
import {
  MetNorwayProviderErrorCode,
  type MetNorwayFetch,
  type MetNorwayProviderConfig,
} from './met-norway-provider';

const NOW = new Date('2026-07-31T00:00:00.000Z');
const CONFIG: MetNorwayProviderConfig = {
  applicationName: 'AquaSaaS/1.0',
  contact: 'support@example.test',
};

function mockFetch(response: Response): jest.MockedFunction<MetNorwayFetch> {
  return jest.fn<Promise<Response>, [string | URL, RequestInit?]>().mockResolvedValue(response);
}

function fixtureResponse(payload: unknown = fixture): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/geo+json' },
  });
}

describe('MetLocationForecastService', () => {
  it('uses the fixed compact endpoint, mandatory identity, UTC and a seven-day window', async () => {
    const fetchFn = mockFetch(fixtureResponse());
    const service = new MetLocationForecastService(CONFIG, fetchFn, {
      now: (): Date => NOW,
    });

    const result = await service.fetchForecast({
      latitude: 60.3929123,
      longitude: 5.3221234,
      altitudeM: 0,
    });

    expect(result.status).toBe('AVAILABLE');
    const available = result as MetLocationForecastAvailable;
    expect(available.issuedAt).toBe('2026-07-30T23:30:00.000Z');
    expect(available.fetchedAt).toBe(NOW.toISOString());
    expect(available.forecastUntil).toBe('2026-08-07T00:00:00.000Z');
    expect(available.forecast).toHaveLength(3);
    expect(available.current.validAt).toBe('2026-07-31T00:00:00.000Z');

    const requestUrl = fetchFn.mock.calls[0]?.[0];
    const requestInit = fetchFn.mock.calls[0]?.[1];
    expect(requestUrl).toBeInstanceOf(URL);
    expect(String(requestUrl)).toBe(
      'https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=60.3929&lon=5.3221&altitude=0',
    );
    expect(requestInit).toMatchObject({
      method: 'GET',
      redirect: 'manual',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'AquaSaaS/1.0 support@example.test',
      },
    });
  });

  it('timestamps fetch completion without moving the forecast selection window', async () => {
    const completedAt = new Date('2026-07-31T00:00:05.000Z');
    let clockReads = 0;
    const service = new MetLocationForecastService(CONFIG, mockFetch(fixtureResponse()), {
      now: (): Date => (clockReads++ === 0 ? NOW : completedAt),
    });

    const result = await service.fetchForecast({
      latitude: 60.3929,
      longitude: 5.3221,
    });

    expect(result).toMatchObject({
      status: 'AVAILABLE',
      fetchedAt: completedAt.toISOString(),
      current: { validAt: NOW.toISOString() },
    });
  });

  it('uses the latest valid row at or before now instead of a future forecast row', async () => {
    const betweenForecastRows = new Date('2026-07-31T00:30:00.000Z');
    const service = new MetLocationForecastService(CONFIG, mockFetch(fixtureResponse()), {
      now: (): Date => betweenForecastRows,
    });

    const result = await service.fetchForecast({
      latitude: 60.3929,
      longitude: 5.3221,
    });

    expect(result).toMatchObject({
      status: 'AVAILABLE',
      current: { validAt: '2026-07-31T00:00:00.000Z' },
    });
  });

  it('preserves legitimate zero values and period semantics', async () => {
    const service = new MetLocationForecastService(CONFIG, mockFetch(fixtureResponse()), {
      now: (): Date => NOW,
    });
    const result = await service.fetchForecast({
      latitude: 60.3929,
      longitude: 5.3221,
    });
    expect(result.status).toBe('AVAILABLE');
    if (result.status !== 'AVAILABLE') throw new Error('fixture must be available');

    expect(result.current.airTemperature?.value).toBe(0);
    expect(result.current.windSpeed?.value).toBe(0);
    expect(result.current.windFromDirection?.value).toBe(0);
    expect(result.current.windGust?.value).toBe(0);
    expect(result.current.cloudAreaFraction?.value).toBe(0);
    expect(result.current.precipitation).toEqual({
      amount: { value: 0, unit: 'mm' },
      periodHours: 1,
    });
    expect(result.forecast[1]?.precipitation?.periodHours).toBe(6);
  });

  it('returns typed no coverage instead of substituting another forecast', async () => {
    const fetchFn = mockFetch(
      new Response('{}', {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const service = new MetLocationForecastService(CONFIG, fetchFn, {
      now: (): Date => NOW,
    });

    await expect(service.fetchForecast({ latitude: 60.3929, longitude: 5.3221 })).resolves.toEqual({
      status: 'NO_COVERAGE',
      provider: 'LOCATIONFORECAST',
      fetchedAt: NOW.toISOString(),
      reason: 'OUT_OF_COVERAGE',
    });
  });

  it('fails closed when provider JSON violates the compact schema', async () => {
    const service = new MetLocationForecastService(
      CONFIG,
      mockFetch(fixtureResponse({ type: 'Feature', properties: {} })),
      { now: (): Date => NOW },
    );

    await expect(
      service.fetchForecast({ latitude: 60.3929, longitude: 5.3221 }),
    ).rejects.toMatchObject({
      code: MetNorwayProviderErrorCode.SCHEMA,
      retryable: false,
    });
  });

  it('rejects timezone-less provenance and physically invalid measurement ranges', async () => {
    const timezoneLess = structuredClone(fixture);
    timezoneLess.properties.meta.updated_at = '2026-07-30T23:30:00';
    const invalidHumidity = structuredClone(fixture);
    invalidHumidity.properties.timeseries[0]!.data.instant.details.relative_humidity = 101;

    for (const payload of [timezoneLess, invalidHumidity]) {
      const service = new MetLocationForecastService(CONFIG, mockFetch(fixtureResponse(payload)), {
        now: (): Date => NOW,
      });
      await expect(
        service.fetchForecast({ latitude: 60.3929, longitude: 5.3221 }),
      ).rejects.toMatchObject({
        code: MetNorwayProviderErrorCode.SCHEMA,
        retryable: false,
      });
    }
  });

  it('rejects a non-identifiable User-Agent configuration at construction', () => {
    expect(
      () =>
        new MetLocationForecastService(
          { applicationName: 'curl', contact: 'not-a-contact' },
          mockFetch(fixtureResponse()),
          { now: (): Date => NOW },
        ),
    ).toThrow(expect.objectContaining({ code: MetNorwayProviderErrorCode.CONFIGURATION }));
  });
});
