import { CircuitBreakerService } from '@aquaculture/backend-common/resilience';

import { MonitoringAreaGeometry } from '../../site/entities/site.entity';
import { CdseTokenError, CdseTokenErrorCode } from '../../sentinel-hub/sentinel-hub.service';
import { EnvironmentQualityStatus } from '../entities/environment-observation.types';
import { CdseRenderAdmission } from './cdse-render-admission';
import {
  CDSE_CATALOG_PATH,
  CDSE_CLOUD_OBSCURED_PERCENT,
  CDSE_COVERAGE_METHOD,
  CDSE_MAX_CATALOG_BYTES,
  CDSE_MAX_IMAGE_BYTES,
  CDSE_MAX_FEATURE_GEOMETRY_POSITIONS,
  CDSE_MAX_COVERAGE_COMPLEXITY,
  CDSE_MAX_SCENES,
  CDSE_ORIGIN,
  CDSE_PROCESS_PATH,
  CDSE_REQUEST_TIMEOUT_MS,
  CDSE_SENTINEL_2_COLLECTION,
  CdseAccessTokenProvider,
  CdseClock,
  CdseDelay,
  CdseFetch,
  CdseProviderError,
  CdseProviderErrorCode,
  CdseSentinelProvider,
  assertCdseEndpointAllowed,
  calculateCdseSceneCoverage,
  classifySceneQuality,
} from './cdse-sentinel.provider';

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACQUIRED_AT = '2026-07-30T10:25:59.000Z';
const NOW = new Date('2026-07-31T12:00:00.000Z');
const AOI: MonitoringAreaGeometry = {
  type: 'Polygon',
  coordinates: [
    [
      [4.99, 59.99],
      [5.01, 59.99],
      [5.01, 60.01],
      [4.99, 60.01],
      [4.99, 59.99],
    ],
  ],
};
const FULL_FOOTPRINT: MonitoringAreaGeometry = {
  type: 'Polygon',
  coordinates: [
    [
      [4.9, 59.9],
      [5.1, 59.9],
      [5.1, 60.1],
      [4.9, 60.1],
      [4.9, 59.9],
    ],
  ],
};
const PARTIAL_FOOTPRINT: MonitoringAreaGeometry = {
  type: 'Polygon',
  coordinates: [
    [
      [5, 59.9],
      [5.1, 59.9],
      [5.1, 60.1],
      [5, 60.1],
      [5, 59.9],
    ],
  ],
};
const OUTSIDE_FOOTPRINT: MonitoringAreaGeometry = {
  type: 'Polygon',
  coordinates: [
    [
      [6, 61],
      [6.1, 61],
      [6.1, 61.1],
      [6, 61.1],
      [6, 61],
    ],
  ],
};
const BOUNDARY_TOUCH_FOOTPRINT: MonitoringAreaGeometry = {
  type: 'Polygon',
  coordinates: [
    [
      [5.01, 59.99],
      [5.1, 59.99],
      [5.1, 60.01],
      [5.01, 60.01],
      [5.01, 59.99],
    ],
  ],
};

interface StacFeature {
  type: 'Feature';
  id: string;
  collection: typeof CDSE_SENTINEL_2_COLLECTION;
  geometry: MonitoringAreaGeometry;
  properties: {
    datetime: string;
    'eo:cloud_cover': number;
  };
}

function feature(
  id: string,
  geometry: MonitoringAreaGeometry = FULL_FOOTPRINT,
  cloudCoverPercent = 5,
  acquiredAt = ACQUIRED_AT,
): StacFeature {
  return {
    type: 'Feature',
    id,
    collection: CDSE_SENTINEL_2_COLLECTION,
    geometry,
    properties: {
      datetime: acquiredAt,
      'eo:cloud_cover': cloudCoverPercent,
    },
  };
}

function catalogResponse(features: readonly StacFeature[], next?: string | number): Response {
  const body = JSON.stringify({
    type: 'FeatureCollection',
    features,
    ...(next === undefined ? {} : { context: { next } }),
  });
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/geo+json; charset=utf-8',
      'content-length': String(Buffer.byteLength(body)),
    },
  });
}

function imageResponse(bytes: Uint8Array = new Uint8Array([1, 2, 3])): Response {
  return new Response(responseBody(bytes), {
    status: 200,
    headers: {
      'content-type': 'image/png',
      'content-length': String(bytes.byteLength),
    },
  });
}

function responseBody(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function catalogInput() {
  return {
    tenantId: TENANT_ID,
    siteId: SITE_ID,
    monitoringLocationRevision: 4,
    geometry: AOI,
    from: new Date('2026-07-02T12:00:00.000Z'),
    to: NOW,
    limit: 100,
  };
}

function renderInput() {
  return {
    tenantId: TENANT_ID,
    siteId: SITE_ID,
    monitoringLocationRevision: 4,
    geometry: AOI,
    scene: {
      sceneId: 'S2B_EXACT_SCENE',
      collection: CDSE_SENTINEL_2_COLLECTION,
      acquiredAt: new Date(ACQUIRED_AT),
    },
    product: 'ndwi' as const,
    width: 512,
    height: 512,
  };
}

describe('CdseSentinelProvider', () => {
  let fetchFn: jest.MockedFunction<CdseFetch>;
  let getAccessToken: jest.Mock;
  let delay: jest.Mocked<CdseDelay>;
  let provider: CdseSentinelProvider;
  let renderAdmission: CdseRenderAdmission;

  beforeEach(() => {
    fetchFn = jest.fn();
    getAccessToken = jest.fn().mockResolvedValue({ accessToken: 'access-token', expiresIn: 1800 });
    const tokenProvider: CdseAccessTokenProvider = { getAccessToken };
    const clock: CdseClock = { now: () => new Date(NOW) };
    delay = { wait: jest.fn().mockResolvedValue(undefined) };
    renderAdmission = new CdseRenderAdmission();
    provider = new CdseSentinelProvider(
      tokenProvider,
      new CircuitBreakerService(),
      fetchFn,
      clock,
      delay,
      renderAdmission,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses only the fixed HTTPS CDSE catalog and processing endpoints', () => {
    expect(CDSE_CATALOG_PATH).toBe('/catalog/v1/search');
    expect(CDSE_PROCESS_PATH).toBe('/process/v1');
    expect(() =>
      assertCdseEndpointAllowed(new URL(CDSE_CATALOG_PATH, CDSE_ORIGIN), 'CATALOG'),
    ).not.toThrow();
    expect(() =>
      assertCdseEndpointAllowed(new URL(CDSE_PROCESS_PATH, CDSE_ORIGIN), 'PROCESS'),
    ).not.toThrow();

    for (const url of [
      new URL('https://attacker.invalid/api/v1/catalog/1.0.0/search'),
      new URL('https://sh.dataspace.copernicus.eu.attacker.invalid/api/v1/catalog/1.0.0/search'),
      new URL('https://user:secret@sh.dataspace.copernicus.eu/api/v1/catalog/1.0.0/search'),
      new URL(
        'https://sh.dataspace.copernicus.eu/api/v1/catalog/1.0.0/search?url=https://attacker.invalid',
      ),
    ]) {
      expect(() => assertCdseEndpointAllowed(url, 'CATALOG')).toThrow(CdseProviderError);
    }
  });

  it('searches the real AOI and preserves acquisition, cloud, coverage, and quality provenance', async () => {
    fetchFn.mockResolvedValueOnce(
      catalogResponse([
        feature('FULL_VALID', FULL_FOOTPRINT, 5),
        feature('PARTIAL_PROVISIONAL', PARTIAL_FOOTPRINT, 30),
        feature('FULL_CLOUD', FULL_FOOTPRINT, CDSE_CLOUD_OBSCURED_PERCENT),
        feature('OUTSIDE', OUTSIDE_FOOTPRINT, 5),
      ]),
    );

    const result = await provider.searchScenes({
      ...catalogInput(),
      maxCloudCoverPercent: 100,
    });

    const byId = new Map(result.scenes.map((scene) => [scene.sceneId, scene]));
    expect(byId.get('FULL_VALID')).toEqual(
      expect.objectContaining({
        acquiredAt: ACQUIRED_AT,
        cloudCoverPercent: 5,
        coveragePercent: 100,
        coverageStatus: 'FULL',
        coverageMethod: CDSE_COVERAGE_METHOD,
        coverageSampleCount: 0,
        qualityStatus: EnvironmentQualityStatus.VALID,
        monitoringLocationRevision: 4,
      }),
    );
    expect(byId.get('PARTIAL_PROVISIONAL')).toEqual(
      expect.objectContaining({
        coveragePercent: 50,
        coverageStatus: 'PARTIAL',
        coverageMethod: CDSE_COVERAGE_METHOD,
        coverageSampleCount: 256,
        qualityStatus: EnvironmentQualityStatus.PROVISIONAL,
      }),
    );
    expect(byId.get('FULL_CLOUD')?.qualityStatus).toBe(EnvironmentQualityStatus.CLOUD_OBSCURED);
    expect(byId.get('OUTSIDE')).toEqual(
      expect.objectContaining({
        coveragePercent: 0,
        coverageStatus: 'OUT_OF_COVERAGE',
        coverageMethod: CDSE_COVERAGE_METHOD,
        coverageSampleCount: 0,
        qualityStatus: EnvironmentQualityStatus.OUT_OF_COVERAGE,
      }),
    );
    expect(result.endCursor).toBeTruthy();

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe(`${CDSE_ORIGIN}${CDSE_CATALOG_PATH}`);
    expect(init?.redirect).toBe('manual');
    expect(init?.headers).toEqual(
      expect.objectContaining({
        Authorization: 'Bearer access-token',
      }),
    );
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body['intersects']).toEqual(AOI);
    expect(body).not.toHaveProperty('bbox');
    expect(body['collections']).toEqual([CDSE_SENTINEL_2_COLLECTION]);
    expect(body['filter']).toEqual({
      op: '<=',
      args: [{ property: 'eo:cloud_cover' }, 100],
    });
    expect(body['filter-lang']).toBe('cql2-json');
    expect(body).not.toHaveProperty('query');
  });

  it('records catalogue fetch completion after provider I/O', async () => {
    const completedAt = new Date('2026-07-31T12:00:05.000Z');
    let clockReads = 0;
    const clock: CdseClock = {
      now: (): Date => (clockReads++ === 0 ? new Date(NOW) : completedAt),
    };
    provider = new CdseSentinelProvider(
      { getAccessToken },
      new CircuitBreakerService(),
      fetchFn,
      clock,
      delay,
    );
    fetchFn.mockResolvedValueOnce(catalogResponse([feature('SCENE')]));

    const result = await provider.searchScenes(catalogInput());

    expect(result.scenes[0]?.fetchedAt).toBe(completedAt.toISOString());
  });

  it('uses bounded provider pagination and deterministic de-duplication', async () => {
    fetchFn
      .mockResolvedValueOnce(
        catalogResponse(
          [
            feature('SCENE_B', FULL_FOOTPRINT, 5, ACQUIRED_AT),
            feature('SCENE_A', FULL_FOOTPRINT, 5, ACQUIRED_AT),
          ],
          'provider-cursor',
        ),
      )
      .mockResolvedValueOnce(
        catalogResponse([
          feature('SCENE_A', FULL_FOOTPRINT, 5, ACQUIRED_AT),
          feature('SCENE_C', FULL_FOOTPRINT, 5, '2026-07-29T10:25:59.000Z'),
        ]),
      );

    const result = await provider.searchScenes({
      ...catalogInput(),
      limit: 4,
    });

    expect(result.scenes.map((scene) => scene.sceneId)).toEqual(['SCENE_A', 'SCENE_B', 'SCENE_C']);
    expect(new Set(result.scenes.map((scene) => scene.cursor)).size).toBe(3);
    expect(result.hasMore).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String(fetchFn.mock.calls[1]![1]?.body)) as Record<
      string,
      unknown
    >;
    expect(secondBody['next']).toBe('provider-cursor');
  });

  it('fails closed before provider I/O when effective company/cutover credentials are unavailable', async () => {
    getAccessToken.mockResolvedValueOnce(null);
    await expect(provider.searchScenes(catalogInput())).rejects.toMatchObject({
      code: CdseProviderErrorCode.CONFIGURATION,
      retryable: false,
    });
    expect(fetchFn).not.toHaveBeenCalled();

    getAccessToken.mockRejectedValueOnce(new Error('config transport down'));
    await expect(provider.searchScenes(catalogInput())).rejects.toMatchObject({
      code: CdseProviderErrorCode.TRANSPORT,
      retryable: true,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    [CdseTokenErrorCode.CREDENTIAL_SERVICE, CdseProviderErrorCode.CREDENTIAL_SERVICE, true],
    [CdseTokenErrorCode.AUTHENTICATION, CdseProviderErrorCode.AUTHENTICATION, false],
    [CdseTokenErrorCode.RATE_LIMITED, CdseProviderErrorCode.RATE_LIMITED, true],
    [CdseTokenErrorCode.UPSTREAM, CdseProviderErrorCode.UPSTREAM, true],
    [CdseTokenErrorCode.TIMEOUT, CdseProviderErrorCode.TIMEOUT, true],
    [CdseTokenErrorCode.TRANSPORT, CdseProviderErrorCode.TRANSPORT, true],
    [CdseTokenErrorCode.SCHEMA, CdseProviderErrorCode.SCHEMA, false],
    [CdseTokenErrorCode.REDIRECT_BLOCKED, CdseProviderErrorCode.REDIRECT_BLOCKED, false],
  ])(
    'maps typed token failure %s to provider failure %s',
    async (tokenCode, providerCode, retryable) => {
      getAccessToken.mockRejectedValueOnce(
        new CdseTokenError({
          code: tokenCode,
          message: 'classified token failure',
          retryable,
          httpStatus: tokenCode === CdseTokenErrorCode.RATE_LIMITED ? 429 : undefined,
          retryAfterMs: tokenCode === CdseTokenErrorCode.RATE_LIMITED ? 2_000 : undefined,
        }),
      );

      await expect(provider.searchScenes(catalogInput())).rejects.toMatchObject({
        code: providerCode,
        retryable,
        ...(tokenCode === CdseTokenErrorCode.RATE_LIMITED
          ? { httpStatus: 429, retryAfterMs: 2_000 }
          : {}),
      });
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it('classifies a structurally invalid token result as schema failure', async () => {
    getAccessToken.mockResolvedValueOnce({ accessToken: '', expiresIn: 0 });

    await expect(provider.searchScenes(catalogInput())).rejects.toMatchObject({
      code: CdseProviderErrorCode.SCHEMA,
      retryable: false,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('never retries authentication, redirect, or schema failures', async () => {
    for (const response of [
      new Response(null, { status: 401 }),
      new Response(null, {
        status: 302,
        headers: { location: 'https://attacker.invalid' },
      }),
      new Response('{', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
      new Response('{}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': String(CDSE_MAX_CATALOG_BYTES + 1),
        },
      }),
      new Response('{}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': '1e3',
        },
      }),
    ]) {
      fetchFn.mockReset();
      fetchFn.mockResolvedValueOnce(response);
      await expect(provider.searchScenes(catalogInput())).rejects.toBeInstanceOf(CdseProviderError);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    }
  });

  it('retries a transient upstream response once and then succeeds', async () => {
    fetchFn
      .mockResolvedValueOnce(
        new Response(null, {
          status: 429,
          headers: { 'retry-after': '1' },
        }),
      )
      .mockResolvedValueOnce(catalogResponse([feature('SCENE')]));

    const result = await provider.searchScenes(catalogInput());

    expect(result.scenes).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(delay.wait).toHaveBeenCalledWith(1_000);
  });

  it('does not delay on a non-decimal Retry-After value', async () => {
    fetchFn
      .mockResolvedValueOnce(
        new Response(null, {
          status: 429,
          headers: { 'retry-after': '1e3' },
        }),
      )
      .mockResolvedValueOnce(catalogResponse([feature('SCENE')]));

    await expect(provider.searchScenes(catalogInput())).resolves.toMatchObject({
      scenes: [expect.objectContaining({ sceneId: 'SCENE' })],
    });
    expect(delay.wait).not.toHaveBeenCalled();
  });

  it('enforces the catalog body limit while streaming without a Content-Length', async () => {
    fetchFn.mockResolvedValueOnce(
      new Response(responseBody(new Uint8Array(CDSE_MAX_CATALOG_BYTES + 1)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(provider.searchScenes(catalogInput())).rejects.toMatchObject({
      code: CdseProviderErrorCode.RESPONSE_TOO_LARGE,
      retryable: false,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('times out a hanging request and performs only the one bounded retry', async () => {
    jest.useFakeTimers();
    fetchFn.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        }),
    );

    const search = provider.searchScenes(catalogInput());
    const assertion = expect(search).rejects.toMatchObject({
      code: CdseProviderErrorCode.TIMEOUT,
      retryable: true,
    });
    await jest.advanceTimersByTimeAsync(CDSE_REQUEST_TIMEOUT_MS + 1);
    await jest.advanceTimersByTimeAsync(CDSE_REQUEST_TIMEOUT_MS + 1);
    await assertion;
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('keeps the timeout active while reading a stalled catalogue body', async () => {
    jest.useFakeTimers();
    const cancel = jest.fn();
    fetchFn
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            cancel,
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      )
      .mockResolvedValueOnce(catalogResponse([feature('SCENE')]));
    const pending = provider.searchScenes(catalogInput());

    await jest.advanceTimersByTimeAsync(CDSE_REQUEST_TIMEOUT_MS);

    await expect(pending).resolves.toMatchObject({
      scenes: [expect.objectContaining({ sceneId: 'SCENE' })],
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('cancels an interactive request immediately without retrying provider I/O', async () => {
    const abortController = new AbortController();
    fetchFn.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        }),
    );

    const render = provider.renderScene({
      ...renderInput(),
      signal: abortController.signal,
    });
    for (let attempt = 0; attempt < 10 && fetchFn.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(fetchFn).toHaveBeenCalledTimes(1);

    abortController.abort();

    await expect(render).rejects.toMatchObject({
      code: CdseProviderErrorCode.CANCELLED,
      retryable: false,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('revalidates the exact scene and acquisition before a canonical render', async () => {
    fetchFn
      .mockResolvedValueOnce(catalogResponse([feature('S2B_EXACT_SCENE')]))
      .mockResolvedValueOnce(catalogResponse([feature('S2B_EXACT_SCENE')]))
      .mockResolvedValueOnce(imageResponse());

    const rendered = await provider.renderScene(renderInput());

    expect(rendered.sceneId).toBe('S2B_EXACT_SCENE');
    expect(rendered.validAt.toISOString()).toBe(ACQUIRED_AT);
    expect(rendered.contentLength).toBe(3);
    expect(fetchFn).toHaveBeenCalledTimes(3);

    const catalogBody = JSON.parse(String(fetchFn.mock.calls[0]![1]?.body)) as Record<
      string,
      unknown
    >;
    expect(catalogBody['ids']).toEqual(['S2B_EXACT_SCENE']);
    expect(catalogBody['datetime']).toBe('2026-07-30T10:25:59.000Z/2026-07-30T10:25:59.001Z');

    const processBody = JSON.parse(String(fetchFn.mock.calls[2]![1]?.body)) as {
      input: {
        bounds: {
          geometry: MonitoringAreaGeometry;
          properties: { crs: string };
        };
        data: Array<{
          type: string;
          dataFilter: {
            timeRange: { from: string; to: string };
          };
        }>;
      };
      evalscript: string;
    };
    expect(processBody.input.bounds.geometry).toEqual(AOI);
    expect(processBody.input.bounds).not.toHaveProperty('bbox');
    expect(processBody.input.bounds.properties.crs).toBe(
      'http://www.opengis.net/def/crs/EPSG/0/4326',
    );
    expect(processBody.input.data[0]).toEqual(
      expect.objectContaining({
        type: CDSE_SENTINEL_2_COLLECTION,
        dataFilter: expect.objectContaining({
          timeRange: {
            from: ACQUIRED_AT,
            to: '2026-07-30T10:25:59.001Z',
          },
        }),
      }),
    );
    expect(processBody.evalscript).toContain("input: ['B03', 'B08', 'dataMask']");
    rendered.dispose();
  });

  it('cancels a stalled image stream when the interactive request disconnects', async () => {
    const abortController = new AbortController();
    const cancel = jest.fn();
    fetchFn
      .mockResolvedValueOnce(catalogResponse([feature('S2B_EXACT_SCENE')]))
      .mockResolvedValueOnce(catalogResponse([feature('S2B_EXACT_SCENE')]))
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            cancel,
          }),
          {
            status: 200,
            headers: { 'content-type': 'image/png' },
          },
        ),
      );

    const rendered = await provider.renderScene({
      ...renderInput(),
      signal: abortController.signal,
    });
    const reader = rendered.body.getReader();
    const pending = reader.read();
    abortController.abort();

    await expect(pending).rejects.toMatchObject({
      code: CdseProviderErrorCode.CANCELLED,
      retryable: false,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    rendered.dispose();
  });

  it('rejects a stale scene identity before calling the processing API', async () => {
    fetchFn.mockResolvedValueOnce(catalogResponse([]));

    await expect(provider.renderScene(renderInput())).rejects.toMatchObject({
      code: CdseProviderErrorCode.SCENE_MISMATCH,
      retryable: false,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('rejects an ambiguous same-time AOI acquisition instead of claiming false scene provenance', async () => {
    fetchFn
      .mockResolvedValueOnce(catalogResponse([feature('S2B_EXACT_SCENE')]))
      .mockResolvedValueOnce(
        catalogResponse([feature('S2B_EXACT_SCENE'), feature('S2B_OVERLAPPING_SCENE')]),
      );

    await expect(provider.renderScene(renderInput())).rejects.toMatchObject({
      code: CdseProviderErrorCode.SCENE_MISMATCH,
      retryable: false,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(
      fetchFn.mock.calls.some(([url]) => String(url) === `${CDSE_ORIGIN}${CDSE_PROCESS_PATH}`),
    ).toBe(false);
  });

  it('rejects a covering scene at the inclusive T+1ms processing boundary', async () => {
    fetchFn
      .mockResolvedValueOnce(catalogResponse([feature('S2B_EXACT_SCENE')]))
      .mockResolvedValueOnce(
        catalogResponse([
          feature('S2B_EXACT_SCENE'),
          feature('S2B_BOUNDARY_SCENE', FULL_FOOTPRINT, 5, '2026-07-30T10:25:59.001Z'),
        ]),
      );

    await expect(provider.renderScene(renderInput())).rejects.toMatchObject({
      code: CdseProviderErrorCode.SCENE_MISMATCH,
      retryable: false,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(
      fetchFn.mock.calls.some(([url]) => String(url) === `${CDSE_ORIGIN}${CDSE_PROCESS_PATH}`),
    ).toBe(false);
  });

  it('suppresses an identical render before credentials or provider I/O', async () => {
    const stalledResponse = new Response(new ReadableStream<Uint8Array>({}), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    });
    fetchFn
      .mockResolvedValueOnce(catalogResponse([feature('S2B_EXACT_SCENE')]))
      .mockResolvedValueOnce(catalogResponse([feature('S2B_EXACT_SCENE')]))
      .mockResolvedValueOnce(stalledResponse);
    const active = await provider.renderScene(renderInput());

    await expect(provider.renderScene(renderInput())).rejects.toMatchObject({
      code: CdseProviderErrorCode.SATURATED,
      retryable: true,
    });
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(3);

    active.dispose();
    fetchFn
      .mockResolvedValueOnce(catalogResponse([feature('S2B_EXACT_SCENE')]))
      .mockResolvedValueOnce(catalogResponse([feature('S2B_EXACT_SCENE')]))
      .mockResolvedValueOnce(imageResponse());
    const replacement = await provider.renderScene(renderInput());
    replacement.dispose();
  });

  it('releases an exact-flight slot on EOF, stream error, cancel, and dispose', async () => {
    const queueRender = (response: Response): void => {
      fetchFn
        .mockResolvedValueOnce(catalogResponse([feature('S2B_EXACT_SCENE')]))
        .mockResolvedValueOnce(catalogResponse([feature('S2B_EXACT_SCENE')]))
        .mockResolvedValueOnce(response);
    };

    queueRender(imageResponse());
    const eofRender = await provider.renderScene(renderInput());
    await expect(new Response(eofRender.body).arrayBuffer()).resolves.toHaveProperty(
      'byteLength',
      3,
    );

    queueRender(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new Error('source failed'));
          },
        }),
        { status: 200, headers: { 'content-type': 'image/png' } },
      ),
    );
    const errorRender = await provider.renderScene(renderInput());
    await expect(errorRender.body.getReader().read()).rejects.toThrow('source failed');

    const upstreamCancel = jest.fn();
    queueRender(
      new Response(new ReadableStream<Uint8Array>({ cancel: upstreamCancel }), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );
    const cancelRender = await provider.renderScene(renderInput());
    await cancelRender.body.cancel('test cancellation');
    expect(upstreamCancel).toHaveBeenCalledWith('test cancellation');

    queueRender(
      new Response(new ReadableStream<Uint8Array>({}), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );
    const disposedRender = await provider.renderScene(renderInput());
    disposedRender.dispose();

    queueRender(imageResponse());
    const finalRender = await provider.renderScene(renderInput());
    finalRender.dispose();
  });

  it('rejects provider footprints above the geometry cost cap before coverage work', async () => {
    const ring: Array<[number, number]> = [];
    for (let index = 0; index < CDSE_MAX_FEATURE_GEOMETRY_POSITIONS; index += 1) {
      const angle = (index / CDSE_MAX_FEATURE_GEOMETRY_POSITIONS) * Math.PI * 2;
      ring.push([5 + Math.cos(angle), 60 + Math.sin(angle)]);
    }
    ring.push(ring[0]!);
    fetchFn.mockResolvedValueOnce(
      catalogResponse([feature('OVERSIZED', { type: 'Polygon', coordinates: [ring] })]),
    );

    await expect(provider.searchScenes(catalogInput())).rejects.toMatchObject({
      code: CdseProviderErrorCode.SCHEMA,
    });
  });

  it('yields the event loop while processing the maximum catalog geometry budget', async () => {
    const ring: Array<[number, number]> = [];
    for (let index = 0; index < CDSE_MAX_FEATURE_GEOMETRY_POSITIONS - 1; index += 1) {
      const angle = (index / (CDSE_MAX_FEATURE_GEOMETRY_POSITIONS - 1)) * Math.PI * 2;
      ring.push([5.01 + Math.cos(angle) * 0.015, 60 + Math.sin(angle) * 0.03]);
    }
    ring.push(ring[0]!);
    const footprint: MonitoringAreaGeometry = { type: 'Polygon', coordinates: [ring] };
    const boundedFeatureCount = CDSE_MAX_COVERAGE_COMPLEXITY / CDSE_MAX_FEATURE_GEOMETRY_POSITIONS;
    fetchFn.mockResolvedValueOnce(
      catalogResponse(
        Array.from({ length: boundedFeatureCount }, (_, index) =>
          feature(`BOUNDED_${index}`, footprint),
        ),
      ),
    );
    let heartbeatObserved = false;
    const startedAt = performance.now();
    const pending = provider.searchScenes({ ...catalogInput(), limit: boundedFeatureCount });
    setImmediate(() => {
      heartbeatObserved = true;
    });

    const result = await pending;

    expect(Number.isInteger(boundedFeatureCount)).toBe(true);
    expect(boundedFeatureCount).toBeLessThanOrEqual(CDSE_MAX_SCENES);
    expect(result.scenes).toHaveLength(boundedFeatureCount);
    expect(heartbeatObserved).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(5_000);
  }, 10_000);

  it('rejects a catalog whose actual combined geometry exceeds the joint budget', async () => {
    const ring: Array<[number, number]> = [];
    for (let index = 0; index < CDSE_MAX_FEATURE_GEOMETRY_POSITIONS - 1; index += 1) {
      const angle = (index / (CDSE_MAX_FEATURE_GEOMETRY_POSITIONS - 1)) * Math.PI * 2;
      ring.push([5.01 + Math.cos(angle) * 0.015, 60 + Math.sin(angle) * 0.03]);
    }
    ring.push(ring[0]!);
    const overBudgetCount = CDSE_MAX_COVERAGE_COMPLEXITY / CDSE_MAX_FEATURE_GEOMETRY_POSITIONS + 1;
    fetchFn.mockResolvedValueOnce(
      catalogResponse(
        Array.from({ length: overBudgetCount }, (_, index) =>
          feature(`OVER_BUDGET_${index}`, { type: 'Polygon', coordinates: [ring] }),
        ),
      ),
    );

    await expect(
      provider.searchScenes({ ...catalogInput(), limit: overBudgetCount }),
    ).rejects.toMatchObject({ code: CdseProviderErrorCode.SCHEMA });
  });

  it('rejects oversized and non-PNG processing responses without exposing a body', async () => {
    for (const response of [
      new Response(responseBody(new Uint8Array([1])), {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'content-length': String(CDSE_MAX_IMAGE_BYTES + 1),
        },
      }),
      new Response(responseBody(new Uint8Array([1])), {
        status: 200,
        headers: {
          'content-type': 'text/html',
          'content-length': '1',
        },
      }),
    ]) {
      fetchFn.mockReset();
      fetchFn
        .mockResolvedValueOnce(catalogResponse([feature('S2B_EXACT_SCENE')]))
        .mockResolvedValueOnce(catalogResponse([feature('S2B_EXACT_SCENE')]))
        .mockResolvedValueOnce(response);
      await expect(provider.renderScene(renderInput())).rejects.toBeInstanceOf(CdseProviderError);
      expect(fetchFn).toHaveBeenCalledTimes(3);
    }
  });

  it('classifies topology and cloud state without inventing scientific values', () => {
    expect(calculateCdseSceneCoverage(AOI, FULL_FOOTPRINT)).toMatchObject({
      status: 'FULL',
      percent: 100,
    });
    expect(calculateCdseSceneCoverage(AOI, PARTIAL_FOOTPRINT)).toMatchObject({
      status: 'PARTIAL',
      percent: 50,
    });
    expect(calculateCdseSceneCoverage(AOI, OUTSIDE_FOOTPRINT)).toMatchObject({
      status: 'OUT_OF_COVERAGE',
      percent: 0,
    });
    expect(calculateCdseSceneCoverage(AOI, BOUNDARY_TOUCH_FOOTPRINT)).toMatchObject({
      status: 'OUT_OF_COVERAGE',
      percent: 0,
    });
    expect(classifySceneQuality('FULL', 0)).toBe(EnvironmentQualityStatus.VALID);
    expect(classifySceneQuality('FULL', CDSE_CLOUD_OBSCURED_PERCENT)).toBe(
      EnvironmentQualityStatus.CLOUD_OBSCURED,
    );
    expect(classifySceneQuality('PARTIAL', 0)).toBe(EnvironmentQualityStatus.PROVISIONAL);
  });

  it('rejects ranges, limits, and geometries outside the backend contract before credentials', async () => {
    await expect(
      provider.searchScenes({
        ...catalogInput(),
        from: new Date('2026-06-01T00:00:00.000Z'),
      }),
    ).rejects.toMatchObject({
      code: CdseProviderErrorCode.CLIENT_REQUEST,
    });
    await expect(
      provider.searchScenes({
        ...catalogInput(),
        limit: 201,
      }),
    ).rejects.toMatchObject({
      code: CdseProviderErrorCode.CLIENT_REQUEST,
    });
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
