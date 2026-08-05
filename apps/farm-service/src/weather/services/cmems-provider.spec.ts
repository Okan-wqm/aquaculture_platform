import { CircuitBreakerService } from '@aquaculture/backend-common/resilience';

import {
  EnvironmentMetric,
  EnvironmentSyncScopeOutcome,
} from '../entities/environment-observation.types';
import {
  buildCmemsCapabilitiesUrl,
  buildCmemsFeatureInfoUrl,
  CMEMS_MAX_JSON_BYTES,
  CMEMS_MAX_OUTBOUND_CONCURRENCY,
  CMEMS_PRODUCTS,
  CMEMS_REQUEST_TIMEOUT_MS,
  CmemsCachePolicy,
  CmemsClock,
  CmemsDatasetRegistry,
  CmemsDelay,
  CmemsEndpoint,
  CmemsFetch,
  CmemsHttpClient,
  CmemsProductDefinition,
  CmemsProductKey,
  CmemsProviderError,
  CmemsProviderErrorCode,
  parseCmemsCapabilities,
  parseCmemsCswRecord,
  selectNearestCmemsElevation,
  selectNearestCmemsTime,
  webMercatorPixel,
} from './cmems-provider';
import {
  CmemsVectorReference,
  CmemsRegionalService,
  cmemsVectorToEastNorth,
  currentToDirectionDegrees,
  selectCmemsRegion,
} from './cmems-regional.service';

const NOW = new Date('2026-07-31T04:30:00.000Z');
const TEST_CACHE_POLICY: CmemsCachePolicy = {
  discoveryFreshMs: 1_000,
  discoveryStaleMs: 10_000,
  capabilityFreshMs: 1_000,
  capabilityStaleMs: 10_000,
};

class MutableClock implements CmemsClock {
  constructor(private current: Date = NOW) {}

  now(): Date {
    return new Date(this.current);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

class DelayRecorder implements CmemsDelay {
  readonly waits: number[] = [];

  async wait(milliseconds: number): Promise<void> {
    this.waits.push(milliseconds);
  }
}

class FetchHarness {
  readonly calls: URL[] = [];

  constructor(
    private readonly responder: (url: URL, callNumber: number) => Promise<Response> | Response,
  ) {}

  readonly fetch: CmemsFetch = async (input: string | URL): Promise<Response> => {
    const url = new URL(input.toString());
    this.calls.push(url);
    return this.responder(url, this.calls.length);
  };
}

function xmlResponse(
  body: string,
  init?: { status?: number; headers?: Record<string, string> },
): Response {
  return new Response(body, {
    status: init?.status ?? 200,
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      ...init?.headers,
    },
  });
}

function jsonResponse(
  payload: unknown,
  init?: { status?: number; headers?: Record<string, string> },
): Response {
  return new Response(JSON.stringify(payload), {
    status: init?.status ?? 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...init?.headers,
    },
  });
}

function cswFixture(product: CmemsProductDefinition, tags: readonly string[] = ['202511']): string {
  const urls = product.datasetBases
    .flatMap((base) =>
      tags.map(
        (tag) =>
          `<gmd:onLine><gmd:CI_OnlineResource><gmd:linkage><gmd:URL>https://wmts.marine.copernicus.eu/teroWmts/${product.productId}/${base}_${tag}</gmd:URL></gmd:linkage></gmd:CI_OnlineResource></gmd:onLine>`,
      ),
    )
    .join('');
  return [
    '<csw:GetRecordByIdResponse xmlns:csw="http://www.opengis.net/cat/csw/2.0.2" xmlns:gmd="http://www.isotc211.org/2005/gmd" xmlns:gco="http://www.isotc211.org/2005/gco">',
    '<gmd:MD_Metadata>',
    '<gmd:dateStamp><gco:DateTime>2026-07-30T09:17:52.648226Z</gco:DateTime></gmd:dateStamp>',
    `<gmd:citation><gco:CharacterString>${product.productId}</gco:CharacterString></gmd:citation>`,
    `<gmd:distributionInfo>${urls}</gmd:distributionInfo>`,
    '</gmd:MD_Metadata>',
    '</csw:GetRecordByIdResponse>',
  ].join('');
}

interface FixtureVariable {
  id: string;
  unit: string;
}

function datasetVariables(datasetId: string): FixtureVariable[] {
  if (datasetId.includes('phy-tem')) {
    return [{ id: 'thetao', unit: 'degrees_C' }];
  }
  if (datasetId.includes('phy-sal')) {
    return [{ id: 'so', unit: '1e-3' }];
  }
  if (datasetId.includes('phy-cur')) {
    return [{ id: 'sea_water_velocity', unit: 'm s-1' }];
  }
  if (datasetId.includes('nws_wav') || datasetId.includes('wam-arctic')) {
    return [
      { id: 'VHM0', unit: 'm' },
      { id: 'VMDR', unit: 'degree' },
      { id: 'VTM02', unit: 's' },
    ];
  }
  if (datasetId.includes('bgc-o2')) {
    return [{ id: 'o2', unit: 'mmol m-3' }];
  }
  if (datasetId.includes('bgc-chl')) {
    return [{ id: 'chl', unit: 'mg m-3' }];
  }
  if (datasetId.includes('arc_phy')) {
    return [
      { id: 'thetao', unit: 'degrees_C' },
      { id: 'so', unit: '1e-3' },
      { id: 'sea_water_velocity', unit: 'm s-1' },
    ];
  }
  if (datasetId.includes('arc_bgc')) {
    return [
      { id: 'o2', unit: 'mmol m-3' },
      { id: 'chl', unit: 'mg m-3' },
    ];
  }
  throw new Error(`Missing sanitized fixture mapping for ${datasetId}`);
}

function capabilitiesFixture(input: {
  productId: string;
  datasetId: string;
  variables?: readonly FixtureVariable[];
  bbox?: readonly [number, number, number, number];
  hasDepth?: boolean;
}): string {
  const variables = input.variables ?? datasetVariables(input.datasetId);
  const bbox =
    input.bbox ??
    (input.productId.startsWith('NWS')
      ? ([-16, 46, 13, 62.74324035644531] as const)
      : ([-180, 50, 180, 85.05112878] as const));
  const hasDepth =
    input.hasDepth ?? (!input.datasetId.includes('wav') && !input.datasetId.includes('wam-arctic'));
  const layers = variables
    .map(
      (variable) => `
        <Layer queryable="1">
          <ows:Identifier>${input.productId}/${input.datasetId}/${variable.id}</ows:Identifier>
          <ows:Title>${variable.id}</ows:Title>
          <ows:WGS84BoundingBox>
            <ows:LowerCorner>${bbox[0]} ${bbox[1]}</ows:LowerCorner>
            <ows:UpperCorner>${bbox[2]} ${bbox[3]}</ows:UpperCorner>
          </ows:WGS84BoundingBox>
          <Format>image/png</Format>
          <InfoFormat>application/json</InfoFormat>
          ${
            hasDepth
              ? '<Dimension><ows:Identifier>elevation</ows:Identifier><UnitSymbol>m</UnitSymbol><Default>0</Default><Value>-100</Value><Value>-10</Value><Value>0</Value></Dimension>'
              : ''
          }
          <Dimension>
            <ows:Identifier>time</ows:Identifier>
            <ows:UOM>ISO8601</ows:UOM>
            <Default>2026-07-31T04:00:00.000Z</Default>
            <Value>2026-07-30T00:00:00.000000000Z/2026-08-07T00:00:00Z/PT1H</Value>
          </Dimension>
          <ows:Metadata>
            <VariableInformation>
              <Id>${variable.id}</Id>
              <StandardName>${variable.id}</StandardName>
              <Name>${variable.id}</Name>
              <Unit>${variable.unit}</Unit>
            </VariableInformation>
            <DataCubeInformation>
              <admp_updated>2026-07-30T09:17:52.648226Z</admp_updated>
              <admp_updated_data>2026-07-30T09:17:51.723Z</admp_updated_data>
            </DataCubeInformation>
          </ows:Metadata>
          <TileMatrixSetLink><TileMatrixSet>EPSG:3857</TileMatrixSet></TileMatrixSetLink>
        </Layer>`,
    )
    .join('');
  return `
    <Capabilities xmlns="http://www.opengis.net/wmts/1.0" xmlns:ows="http://www.opengis.net/ows/1.1">
      <ows:ServiceIdentification>
        <ows:Title>Copernicus Marine Data Store - ${input.productId}/${input.datasetId}</ows:Title>
      </ows:ServiceIdentification>
      <Contents>
        ${layers}
        <TileMatrixSet>
          <ows:Identifier>EPSG:3857</ows:Identifier>
          <ows:SupportedCRS>urn:ogc:def:crs:EPSG::3857</ows:SupportedCRS>
          <TileMatrix><ows:Identifier>10</ows:Identifier><TileWidth>256</TileWidth><TileHeight>256</TileHeight></TileMatrix>
        </TileMatrixSet>
      </Contents>
    </Capabilities>`;
}

function featureFixture(input: {
  productId: string;
  datasetId: string;
  variableId: string;
  latitude: number;
  longitude: number;
  value: number | null;
  unit: string;
  componentIds?: readonly [string, string];
  componentValues?: readonly [number | null, number | null];
}): unknown {
  const properties: Record<string, unknown> = {
    lat: input.latitude,
    lon: input.longitude,
    variableId: input.variableId,
    datasetId: `${input.productId}/${input.datasetId}`,
    value: input.value,
    units: input.unit,
  };
  if (input.componentIds && input.componentValues) {
    properties.component1VariableId = input.componentIds[0];
    properties.component1Value = input.componentValues[0];
    properties.component1Units = input.unit;
    properties.component2VariableId = input.componentIds[1];
    properties.component2Value = input.componentValues[1];
    properties.component2Units = input.unit;
  }
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'Point',
          // The official endpoint returns [lat, lon], not GeoJSON [lon, lat].
          coordinates: [input.latitude, input.longitude],
        },
        properties,
      },
    ],
  };
}

function productForUuid(uuid: string): CmemsProductDefinition {
  const product = Object.values(CMEMS_PRODUCTS).find((candidate) => candidate.uuid === uuid);
  if (!product) throw new Error(`Unknown fixture product UUID ${uuid}`);
  return product;
}

function datasetProduct(datasetId: string): CmemsProductDefinition {
  const product = Object.values(CMEMS_PRODUCTS).find((candidate) =>
    candidate.datasetBases.some((base) => datasetId.startsWith(`${base}_`)),
  );
  if (!product) throw new Error(`Unknown fixture dataset ${datasetId}`);
  return product;
}

function standardProviderHarness(input?: {
  featureValue?: number | null;
  currentValues?: readonly [number, number, number];
  invalidFeatureVariables?: readonly string[];
  invalidCapabilitiesDatasetFragments?: readonly string[];
  outOfCoverageDatasetFragments?: readonly string[];
}): FetchHarness {
  return new FetchHarness((url) => {
    if (url.origin.includes('csw.marine.copernicus.eu')) {
      const product = productForUuid(url.searchParams.get('id') ?? '');
      return xmlResponse(cswFixture(product));
    }
    if (url.pathname.startsWith('/teroWmts/')) {
      const parts = url.pathname.split('/');
      const productId = parts[2];
      const datasetId = parts[3];
      if (!productId || !datasetId) {
        throw new Error('Capabilities URL fixture is malformed');
      }
      if (
        input?.invalidCapabilitiesDatasetFragments?.some((fragment) => datasetId.includes(fragment))
      ) {
        return xmlResponse('<Capabilities/>');
      }
      if (input?.outOfCoverageDatasetFragments?.some((fragment) => datasetId.includes(fragment))) {
        return xmlResponse(capabilitiesFixture({ productId, datasetId, bbox: [0, 0, 1, 1] }));
      }
      return xmlResponse(capabilitiesFixture({ productId, datasetId }));
    }
    const layer = url.searchParams.get('layer')?.split('/');
    const productId = layer?.[0];
    const datasetId = layer?.[1];
    const variableId = layer?.[2];
    if (!productId || !datasetId || !variableId) {
      throw new Error('Feature URL fixture is malformed');
    }
    if (input?.invalidFeatureVariables?.includes(variableId)) {
      return jsonResponse({ type: 'InvalidFeatureResponse' });
    }
    const unit =
      datasetVariables(datasetId).find((variable) => variable.id === variableId)?.unit ?? '';
    if (variableId === 'sea_water_velocity') {
      const isArctic = productId.startsWith('ARCTIC');
      const vector = input?.currentValues ?? [0.05, 0.03, 0.04];
      return jsonResponse(
        featureFixture({
          productId,
          datasetId,
          variableId,
          latitude: 60,
          longitude: 5,
          value: vector[0],
          unit,
          componentIds: isArctic ? ['vxo', 'vyo'] : ['uo', 'vo'],
          componentValues: [vector[1], vector[2]],
        }),
      );
    }
    return jsonResponse(
      featureFixture({
        productId,
        datasetId,
        variableId,
        latitude: productId.startsWith('ARCTIC') ? 70 : 60,
        longitude: 5,
        value: input?.featureValue === undefined ? 0 : input.featureValue,
        unit,
      }),
    );
  });
}

function createServices(
  harness: FetchHarness,
  clock: MutableClock = new MutableClock(),
): {
  http: CmemsHttpClient;
  registry: CmemsDatasetRegistry;
  regional: CmemsRegionalService;
} {
  const http = new CmemsHttpClient(
    new CircuitBreakerService(),
    harness.fetch,
    clock,
    new DelayRecorder(),
  );
  const registry = new CmemsDatasetRegistry(http, clock, TEST_CACHE_POLICY);
  return {
    http,
    registry,
    regional: new CmemsRegionalService(registry, http, clock),
  };
}

describe('CMEMS provider endpoint and transport contract', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses standard Web Mercator tile and pixel addressing at zoom 10', () => {
    expect(webMercatorPixel(60, 5, 10)).toEqual({
      tileCol: 526,
      tileRow: 297,
      i: 56,
      j: 94,
    });
    const url = buildCmemsFeatureInfoUrl({
      productId: 'NWSHELF_ANALYSISFORECAST_PHY_004_013',
      datasetId: 'cmems_mod_nws_phy-tem_anfc_1.5km-3D_PT1H-i_202511',
      variableId: 'thetao',
      latitude: 60,
      longitude: 5,
      validAt: '2026-07-31T04:00:00.000Z',
      modelElevationM: -10,
    });
    expect(url.origin).toBe('https://wmts.marine.copernicus.eu');
    expect(url.pathname).toBe('/teroWmts');
    expect(url.searchParams.get('tilematrix')).toBe('10');
    expect(url.searchParams.get('elevation')).toBe('-10');
  });

  it('uses a dataset-specific capabilities path instead of the generic catalogue', () => {
    const url = buildCmemsCapabilitiesUrl(
      'NWSHELF_ANALYSISFORECAST_PHY_004_013',
      'cmems_mod_nws_phy-tem_anfc_1.5km-3D_PT1H-i_202511',
    );
    expect(url.pathname).toBe(
      '/teroWmts/NWSHELF_ANALYSISFORECAST_PHY_004_013/cmems_mod_nws_phy-tem_anfc_1.5km-3D_PT1H-i_202511',
    );
  });

  it('rejects an endpoint that could redirect requests to an attacker host', () => {
    const harness = standardProviderHarness();
    const { http } = createServices(harness);
    const endpoint: CmemsEndpoint = {
      kind: 'FEATURE_INFO',
      url: new URL(
        'https://attacker.example/teroWmts?service=WMTS&request=GetFeatureInfo&version=1.0.0&tilematrixset=EPSG%3A3857&tilematrix=10&INFOFORMAT=application%2Fjson',
      ),
    };
    expect(() => http.assertAllowedEndpoint(endpoint)).toThrow(CmemsProviderError);
  });

  it('blocks redirects and does not retry a non-retryable redirect', async () => {
    const harness = new FetchHarness(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://attacker.example/' },
        }),
    );
    const { http } = createServices(harness);
    const request = buildCmemsFeatureInfoUrl({
      productId: 'NWSHELF_ANALYSISFORECAST_PHY_004_013',
      datasetId: 'cmems_mod_nws_phy-tem_anfc_1.5km-3D_PT1H-i_202511',
      variableId: 'thetao',
      latitude: 60,
      longitude: 5,
      validAt: '2026-07-31T04:00:00.000Z',
      modelElevationM: 0,
    });
    await expect(http.getFeatureInfo(request)).rejects.toMatchObject({
      code: CmemsProviderErrorCode.REDIRECT_BLOCKED,
    });
    expect(harness.calls).toHaveLength(1);
  });

  it('rejects oversized and wrong-content-type bodies before parsing', async () => {
    const oversized = new FetchHarness(() =>
      jsonResponse(
        {},
        {
          headers: {
            'content-length': String(CMEMS_MAX_JSON_BYTES + 1),
          },
        },
      ),
    );
    const request = buildCmemsFeatureInfoUrl({
      productId: 'NWSHELF_ANALYSISFORECAST_PHY_004_013',
      datasetId: 'cmems_mod_nws_phy-tem_anfc_1.5km-3D_PT1H-i_202511',
      variableId: 'thetao',
      latitude: 60,
      longitude: 5,
      validAt: '2026-07-31T04:00:00.000Z',
      modelElevationM: 0,
    });
    await expect(createServices(oversized).http.getFeatureInfo(request)).rejects.toMatchObject({
      code: CmemsProviderErrorCode.RESPONSE_TOO_LARGE,
      retryable: false,
    });

    const invalidLengthCancel = jest.fn();
    const invalidLength = new FetchHarness(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel: invalidLengthCancel,
          }),
          {
            headers: {
              'content-length': '1e3',
              'content-type': 'application/json',
            },
          },
        ),
    );
    await expect(createServices(invalidLength).http.getFeatureInfo(request)).rejects.toMatchObject({
      code: CmemsProviderErrorCode.SCHEMA,
      retryable: false,
    });
    expect(invalidLengthCancel).toHaveBeenCalledTimes(1);
    expect(invalidLength.calls).toHaveLength(1);

    const emptyLength = new FetchHarness(() =>
      jsonResponse({}, { headers: { 'content-length': '' } }),
    );
    await expect(createServices(emptyLength).http.getFeatureInfo(request)).rejects.toMatchObject({
      code: CmemsProviderErrorCode.SCHEMA,
      retryable: false,
    });
    expect(emptyLength.calls).toHaveLength(1);

    const html = new FetchHarness(
      () =>
        new Response('<html></html>', {
          headers: { 'content-type': 'text/html' },
        }),
    );
    await expect(createServices(html).http.getFeatureInfo(request)).rejects.toMatchObject({
      code: CmemsProviderErrorCode.SCHEMA,
      retryable: false,
    });
    expect(html.calls).toHaveLength(1);
  });

  it('rejects invalid UTF-8 and an undeclared oversized stream without retrying', async () => {
    const request = buildCmemsFeatureInfoUrl({
      productId: 'NWSHELF_ANALYSISFORECAST_PHY_004_013',
      datasetId: 'cmems_mod_nws_phy-tem_anfc_1.5km-3D_PT1H-i_202511',
      variableId: 'thetao',
      latitude: 60,
      longitude: 5,
      validAt: '2026-07-31T04:00:00.000Z',
      modelElevationM: 0,
    });
    const invalidUtf8 = new FetchHarness(
      () =>
        new Response(new Uint8Array([0xc3, 0x28]), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(createServices(invalidUtf8).http.getFeatureInfo(request)).rejects.toMatchObject({
      code: CmemsProviderErrorCode.SCHEMA,
      retryable: false,
    });
    expect(invalidUtf8.calls).toHaveLength(1);

    const oversizedStream = new FetchHarness(
      () =>
        new Response(new Uint8Array(CMEMS_MAX_JSON_BYTES + 1), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(
      createServices(oversizedStream).http.getFeatureInfo(request),
    ).rejects.toMatchObject({
      code: CmemsProviderErrorCode.RESPONSE_TOO_LARGE,
      retryable: false,
    });
    expect(oversizedStream.calls).toHaveLength(1);
  });

  it('retries a retryable upstream response exactly once', async () => {
    const harness = new FetchHarness((_url, callNumber) =>
      callNumber === 1
        ? jsonResponse({}, { status: 503 })
        : jsonResponse({ type: 'FeatureCollection', features: [] }),
    );
    const { http } = createServices(harness);
    const request = buildCmemsFeatureInfoUrl({
      productId: 'NWSHELF_ANALYSISFORECAST_PHY_004_013',
      datasetId: 'cmems_mod_nws_phy-tem_anfc_1.5km-3D_PT1H-i_202511',
      variableId: 'thetao',
      latitude: 60,
      longitude: 5,
      validAt: '2026-07-31T04:00:00.000Z',
      modelElevationM: 0,
    });
    await expect(http.getFeatureInfo(request)).resolves.toMatchObject({
      status: 'AVAILABLE',
    });
    expect(harness.calls).toHaveLength(2);

    const failing = new FetchHarness(() => jsonResponse({}, { status: 503 }));
    await expect(createServices(failing).http.getFeatureInfo(request)).rejects.toMatchObject({
      code: CmemsProviderErrorCode.PROVIDER_UNAVAILABLE,
    });
    expect(failing.calls).toHaveLength(2);
  });

  it('does not delay on a non-decimal Retry-After value', async () => {
    const delay = new DelayRecorder();
    const harness = new FetchHarness((_url, callNumber) =>
      callNumber === 1
        ? jsonResponse({}, { status: 429, headers: { 'retry-after': '1e3' } })
        : jsonResponse({ type: 'FeatureCollection', features: [] }),
    );
    const http = new CmemsHttpClient(
      new CircuitBreakerService(),
      harness.fetch,
      new MutableClock(),
      delay,
    );
    const request = buildCmemsFeatureInfoUrl({
      productId: 'NWSHELF_ANALYSISFORECAST_PHY_004_013',
      datasetId: 'cmems_mod_nws_phy-tem_anfc_1.5km-3D_PT1H-i_202511',
      variableId: 'thetao',
      latitude: 60,
      longitude: 5,
      validAt: '2026-07-31T04:00:00.000Z',
      modelElevationM: 0,
    });

    await expect(http.getFeatureInfo(request)).resolves.toMatchObject({ status: 'AVAILABLE' });
    expect(delay.waits).toEqual([]);
  });

  it('honors a bounded Retry-After exactly once before its single retry', async () => {
    const delay = new DelayRecorder();
    const harness = new FetchHarness((_url, callNumber) =>
      callNumber === 1
        ? jsonResponse({}, { status: 429, headers: { 'retry-after': '1' } })
        : jsonResponse({ type: 'FeatureCollection', features: [] }),
    );
    const http = new CmemsHttpClient(
      new CircuitBreakerService(),
      harness.fetch,
      new MutableClock(),
      delay,
    );
    const request = buildCmemsFeatureInfoUrl({
      productId: 'NWSHELF_ANALYSISFORECAST_PHY_004_013',
      datasetId: 'cmems_mod_nws_phy-tem_anfc_1.5km-3D_PT1H-i_202511',
      variableId: 'thetao',
      latitude: 60,
      longitude: 5,
      validAt: '2026-07-31T04:00:00.000Z',
      modelElevationM: 0,
    });

    await expect(http.getFeatureInfo(request)).resolves.toMatchObject({ status: 'AVAILABLE' });
    expect(delay.waits).toEqual([1_000]);
    expect(harness.calls).toHaveLength(2);
  });

  it('keeps the timeout active while reading a stalled response body', async () => {
    jest.useFakeTimers();
    const cancel = jest.fn();
    const harness = new FetchHarness((_url, callNumber) =>
      callNumber === 1
        ? new Response(
            new ReadableStream<Uint8Array>({
              cancel,
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          )
        : jsonResponse({ type: 'FeatureCollection', features: [] }),
    );
    const { http } = createServices(harness);
    const request = buildCmemsFeatureInfoUrl({
      productId: 'NWSHELF_ANALYSISFORECAST_PHY_004_013',
      datasetId: 'cmems_mod_nws_phy-tem_anfc_1.5km-3D_PT1H-i_202511',
      variableId: 'thetao',
      latitude: 60,
      longitude: 5,
      validAt: '2026-07-31T04:00:00.000Z',
      modelElevationM: 0,
    });
    const pending = http.getFeatureInfo(request);

    await jest.advanceTimersByTimeAsync(CMEMS_REQUEST_TIMEOUT_MS);

    await expect(pending).resolves.toMatchObject({ status: 'AVAILABLE' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(harness.calls).toHaveLength(2);
  });

  it('hard-bounds aggregate outbound CMEMS requests across concurrent callers', async () => {
    let active = 0;
    let maximumActive = 0;
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const harness = new FetchHarness(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gate;
      active -= 1;
      return jsonResponse({ type: 'FeatureCollection', features: [] });
    });
    const firstClient = createServices(harness).http;
    const secondClient = createServices(harness).http;
    const request = buildCmemsFeatureInfoUrl({
      productId: 'NWSHELF_ANALYSISFORECAST_PHY_004_013',
      datasetId: 'cmems_mod_nws_phy-tem_anfc_1.5km-3D_PT1H-i_202511',
      variableId: 'thetao',
      latitude: 60,
      longitude: 5,
      validAt: '2026-07-31T04:00:00.000Z',
      modelElevationM: 0,
    });

    const pending = Array.from({ length: CMEMS_MAX_OUTBOUND_CONCURRENCY * 3 }, (_, index) =>
      (index % 2 === 0 ? firstClient : secondClient).getFeatureInfo(request),
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(active).toBe(CMEMS_MAX_OUTBOUND_CONCURRENCY);
    expect(maximumActive).toBe(CMEMS_MAX_OUTBOUND_CONCURRENCY);

    releaseGate?.();
    await Promise.all(pending);
    expect(maximumActive).toBe(CMEMS_MAX_OUTBOUND_CONCURRENCY);
  });
});

describe('CMEMS dataset and capabilities SSoT', () => {
  it('extracts only exact current tagged WMTS datasets and chooses the latest tag', () => {
    const product = CMEMS_PRODUCTS[CmemsProductKey.NWS_PHY];
    const parsed = parseCmemsCswRecord(
      cswFixture(product, ['202411', '202511']),
      product,
      NOW.toISOString(),
    );
    expect(parsed.datasetIds['cmems_mod_nws_phy-tem_anfc_1.5km-3D_PT1H-i']).toBe(
      'cmems_mod_nws_phy-tem_anfc_1.5km-3D_PT1H-i_202511',
    );
    const extensionOnly = cswFixture(product).replace(
      /_202511<\/gmd:URL>/gu,
      '_202511--ext--history</gmd:URL>',
    );
    expect(() => parseCmemsCswRecord(extensionOnly, product, NOW.toISOString())).toThrow(
      CmemsProviderError,
    );
  });

  it('serves a bounded stale discovery record only for a retryable outage', async () => {
    const clock = new MutableClock();
    let unavailable = false;
    const product = CMEMS_PRODUCTS[CmemsProductKey.NWS_PHY];
    const harness = new FetchHarness(() => {
      if (unavailable) throw new TypeError('network unavailable');
      return xmlResponse(cswFixture(product));
    });
    const { registry } = createServices(harness, clock);
    await expect(registry.resolveProduct(CmemsProductKey.NWS_PHY)).resolves.toMatchObject({
      stale: false,
    });
    clock.advance(1_001);
    unavailable = true;
    await expect(registry.resolveProduct(CmemsProductKey.NWS_PHY)).resolves.toMatchObject({
      stale: true,
    });
    expect(harness.calls).toHaveLength(3);

    clock.advance(500);
    await expect(registry.resolveProduct(CmemsProductKey.NWS_PHY)).resolves.toMatchObject({
      stale: true,
    });
    expect(harness.calls).toHaveLength(3);

    clock.advance(9_501);
    await expect(registry.resolveProduct(CmemsProductKey.NWS_PHY)).rejects.toMatchObject({
      code: CmemsProviderErrorCode.TRANSPORT,
    });
  });

  it('suppresses repeated stale capability refreshes without extending absolute expiry', async () => {
    const clock = new MutableClock();
    const product = CMEMS_PRODUCTS[CmemsProductKey.NWS_PHY];
    const datasetBase = 'cmems_mod_nws_phy-tem_anfc_1.5km-3D_PT1H-i';
    let capabilitiesUnavailable = false;
    const harness = new FetchHarness((url) => {
      if (url.origin.includes('csw.marine.copernicus.eu')) {
        return xmlResponse(cswFixture(product));
      }
      const parts = url.pathname.split('/');
      const productId = parts[2];
      const datasetId = parts[3];
      if (!productId || !datasetId) {
        throw new Error('Capabilities URL fixture is malformed');
      }
      if (capabilitiesUnavailable) {
        throw new TypeError('capabilities unavailable');
      }
      return xmlResponse(capabilitiesFixture({ productId, datasetId }));
    });
    const http = new CmemsHttpClient(
      new CircuitBreakerService(),
      harness.fetch,
      clock,
      new DelayRecorder(),
    );
    const capabilityFreshMs = 2 * 60 * 60 * 1000;
    const capabilityStaleMs = 24 * 60 * 60 * 1000;
    const registry = new CmemsDatasetRegistry(http, clock, {
      discoveryFreshMs: 48 * 60 * 60 * 1000,
      discoveryStaleMs: 72 * 60 * 60 * 1000,
      capabilityFreshMs,
      capabilityStaleMs,
    });
    const discovered = await registry.resolveProduct(CmemsProductKey.NWS_PHY);
    const input = {
      product: discovered,
      datasetBase,
      variableId: 'thetao',
      expectedUnits: ['degrees_C'],
      requiresDepth: true,
    } as const;
    await expect(registry.resolveCapabilities(input)).resolves.toMatchObject({ stale: false });

    clock.advance(capabilityFreshMs + 1);
    capabilitiesUnavailable = true;
    await expect(registry.resolveCapabilities(input)).resolves.toMatchObject({ stale: true });
    const capabilityCallsAfterFailedRefresh = harness.calls.filter((url) =>
      url.pathname.startsWith('/teroWmts/'),
    ).length;
    expect(capabilityCallsAfterFailedRefresh).toBe(3);

    for (let horizon = 0; horizon < 15; horizon += 1) {
      clock.advance(4 * 60 * 1000);
      await expect(registry.resolveCapabilities(input)).resolves.toMatchObject({ stale: true });
    }
    expect(harness.calls.filter((url) => url.pathname.startsWith('/teroWmts/'))).toHaveLength(
      capabilityCallsAfterFailedRefresh,
    );

    clock.advance(capabilityStaleMs);
    await expect(registry.resolveCapabilities(input)).rejects.toMatchObject({
      code: CmemsProviderErrorCode.TRANSPORT,
    });
  });

  it('validates layer identity, unit, EPSG:3857, time and depth metadata', () => {
    const productId = 'NWSHELF_ANALYSISFORECAST_PHY_004_013';
    const datasetId = 'cmems_mod_nws_phy-tem_anfc_1.5km-3D_PT1H-i_202511';
    const capabilities = parseCmemsCapabilities(capabilitiesFixture({ productId, datasetId }), {
      productId,
      datasetId,
      variableId: 'thetao',
      expectedUnits: ['degrees_C'],
      requiresDepth: true,
      fetchedAt: NOW.toISOString(),
    });
    expect(selectNearestCmemsTime(capabilities, new Date('2026-07-31T04:29:00.000Z'))).toBe(
      '2026-07-31T04:00:00.000Z',
    );
    expect(selectNearestCmemsTime(capabilities, new Date('2026-07-29T23:59:00.000Z'))).toBeNull();
    expect(selectNearestCmemsTime(capabilities, new Date('2026-08-07T00:01:00.000Z'))).toBeNull();
    expect(selectNearestCmemsElevation(capabilities, 12)).toBe(-10);
    expect(capabilities.updatedAt).toBe('2026-07-30T09:17:52.648Z');

    expect(() =>
      parseCmemsCapabilities(
        capabilitiesFixture({
          productId,
          datasetId,
          variables: [{ id: 'thetao', unit: 'kelvin' }],
        }),
        {
          productId,
          datasetId,
          variableId: 'thetao',
          expectedUnits: ['degrees_C'],
          requiresDepth: true,
          fetchedAt: NOW.toISOString(),
        },
      ),
    ).toThrow(CmemsProviderError);
  });
});

describe('CMEMS regional environment service', () => {
  it('selects NWS inclusively at its north/east boundary and Arctic outside it', () => {
    expect(selectCmemsRegion(62.74324035644531, 13)).toBe('NORTH_WEST_SHELF');
    expect(selectCmemsRegion(62.74324035644532, 13)).toBe('ARCTIC');
    expect(selectCmemsRegion(60, 13.0001)).toBe('ARCTIC');
    expect(selectCmemsRegion(45, 5)).toBeNull();
  });

  it('preserves a scalar zero and normalizes degrees_C to °C', async () => {
    const harness = standardProviderHarness({ featureValue: 0 });
    const { regional } = createServices(harness);
    const result = await regional.fetchEnvironment({
      latitude: 60,
      longitude: 5,
      validAt: new Date('2026-07-31T04:20:00.000Z'),
      requestedDepthM: 12,
      metrics: [EnvironmentMetric.SEA_TEMPERATURE],
    });
    expect(result).toMatchObject({
      status: 'AVAILABLE',
      region: 'NORTH_WEST_SHELF',
      values: [
        {
          metric: EnvironmentMetric.SEA_TEMPERATURE,
          value: 0,
          unit: '°C',
          validAt: '2026-07-31T04:00:00.000Z',
          requestedDepthM: 12,
          modelDepthM: 10,
          horizontalResolutionM: 1500,
          qualityStatus: 'PROVISIONAL',
          semanticClass: 'ANALYSIS',
        },
      ],
    });
    const featureCall = harness.calls.find(
      (call) => call.searchParams.get('request') === 'GetFeatureInfo',
    );
    expect(featureCall?.searchParams.get('elevation')).toBe('-10');
  });

  it('emits an explicit null metric and NO_DATA when the upstream cell is null', async () => {
    const harness = standardProviderHarness({ featureValue: null });
    const { regional } = createServices(harness);
    const result = await regional.fetchEnvironment({
      latitude: 60,
      longitude: 5,
      validAt: new Date('2026-07-31T04:00:00.000Z'),
      metrics: [EnvironmentMetric.SALINITY],
    });
    expect(result).toMatchObject({
      status: 'NO_DATA',
      values: [
        {
          metric: EnvironmentMetric.SALINITY,
          value: null,
          unit: 'PSU',
        },
      ],
    });
  });

  it('returns temporal NO_DATA without querying a boundary feature outside capabilities', async () => {
    const harness = standardProviderHarness();
    const result = await createServices(harness).regional.fetchEnvironment({
      latitude: 60,
      longitude: 5,
      // Within the public API's seven-day request contract but beyond the
      // fixture capability end (2026-08-07T00:00Z).
      validAt: new Date('2026-08-07T04:00:00.000Z'),
      metrics: [EnvironmentMetric.SEA_TEMPERATURE],
    });

    expect(result).toMatchObject({
      status: 'NO_DATA',
      region: 'NORTH_WEST_SHELF',
      requestedAt: '2026-08-07T04:00:00.000Z',
      values: [],
      coverage: [
        expect.objectContaining({
          metric: EnvironmentMetric.SEA_TEMPERATURE,
          outcome: EnvironmentSyncScopeOutcome.NO_DATA,
          validFrom: new Date('2026-08-07T04:00:00.000Z'),
          observationCount: 0,
        }),
      ],
    });
    expect(
      harness.calls.some((call) => call.searchParams.get('request') === 'GetFeatureInfo'),
    ).toBe(false);
  });

  it('preserves resolved product groups when a separate product capability contract fails', async () => {
    const harness = standardProviderHarness({
      invalidCapabilitiesDatasetFragments: ['nws_wav'],
    });
    const result = await createServices(harness).regional.fetchEnvironment({
      latitude: 60,
      longitude: 5,
      validAt: new Date('2026-07-31T04:00:00.000Z'),
      metrics: [EnvironmentMetric.SEA_TEMPERATURE, EnvironmentMetric.WAVE_HEIGHT],
    });

    expect(result).toMatchObject({
      status: 'AVAILABLE',
      region: 'NORTH_WEST_SHELF',
      values: [{ metric: EnvironmentMetric.SEA_TEMPERATURE, value: 0 }],
    });
    expect(result.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric: EnvironmentMetric.WAVE_HEIGHT,
          outcome: EnvironmentSyncScopeOutcome.PROVIDER_UNAVAILABLE,
          errorCode: 'CMEMS_SCHEMA',
        }),
      ]),
    );
  });

  it('preserves successful feature groups when a separate feature contract fails', async () => {
    const harness = standardProviderHarness({ invalidFeatureVariables: ['VHM0'] });
    const result = await createServices(harness).regional.fetchEnvironment({
      latitude: 60,
      longitude: 5,
      validAt: new Date('2026-07-31T04:00:00.000Z'),
      metrics: [EnvironmentMetric.SEA_TEMPERATURE, EnvironmentMetric.WAVE_HEIGHT],
    });

    expect(result).toMatchObject({
      status: 'AVAILABLE',
      values: [{ metric: EnvironmentMetric.SEA_TEMPERATURE, value: 0 }],
    });
    expect(result.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric: EnvironmentMetric.WAVE_HEIGHT,
          outcome: EnvironmentSyncScopeOutcome.PROVIDER_UNAVAILABLE,
          errorCode: 'CMEMS_SCHEMA',
        }),
      ]),
    );
  });

  it('fails the provider request when every independent product resolution fails', async () => {
    const harness = standardProviderHarness({
      invalidCapabilitiesDatasetFragments: ['phy-tem', 'nws_wav'],
    });

    const result = await createServices(harness).regional.fetchEnvironment({
      latitude: 60,
      longitude: 5,
      validAt: new Date('2026-07-31T04:00:00.000Z'),
      metrics: [EnvironmentMetric.SEA_TEMPERATURE, EnvironmentMetric.WAVE_HEIGHT],
    });

    expect(result).toMatchObject({
      status: 'PROVIDER_FAILURE',
      errorCode: 'CMEMS_SCHEMA',
      configurationError: false,
      values: [],
    });
    expect(result.coverage).toHaveLength(2);
  });

  it('reports NO_DATA only for successful null-valued groups and omits failed metrics', async () => {
    const harness = standardProviderHarness({
      featureValue: null,
      invalidFeatureVariables: ['VHM0'],
    });
    const result = await createServices(harness).regional.fetchEnvironment({
      latitude: 60,
      longitude: 5,
      validAt: new Date('2026-07-31T04:00:00.000Z'),
      metrics: [EnvironmentMetric.SEA_TEMPERATURE, EnvironmentMetric.WAVE_HEIGHT],
    });

    expect(result).toMatchObject({
      status: 'NO_DATA',
      values: [{ metric: EnvironmentMetric.SEA_TEMPERATURE, value: null }],
    });
    expect(result.values.some((value) => value.metric === EnvironmentMetric.WAVE_HEIGHT)).toBe(
      false,
    );
  });

  it('fails the provider request when every independent feature group fails', async () => {
    const harness = standardProviderHarness({
      invalidFeatureVariables: ['thetao', 'VHM0'],
    });

    const result = await createServices(harness).regional.fetchEnvironment({
      latitude: 60,
      longitude: 5,
      validAt: new Date('2026-07-31T04:00:00.000Z'),
      metrics: [EnvironmentMetric.SEA_TEMPERATURE, EnvironmentMetric.WAVE_HEIGHT],
    });

    expect(result).toMatchObject({
      status: 'PROVIDER_FAILURE',
      errorCode: 'CMEMS_SCHEMA',
      values: [],
    });
    expect(result.coverage).toHaveLength(2);
  });

  it('keeps covered product groups when a separate product is outside its declared bbox', async () => {
    const harness = standardProviderHarness({
      outOfCoverageDatasetFragments: ['nws_wav'],
    });
    const result = await createServices(harness).regional.fetchEnvironment({
      latitude: 60,
      longitude: 5,
      validAt: new Date('2026-07-31T04:00:00.000Z'),
      metrics: [EnvironmentMetric.SEA_TEMPERATURE, EnvironmentMetric.WAVE_HEIGHT],
    });

    expect(result).toMatchObject({
      status: 'AVAILABLE',
      values: [{ metric: EnvironmentMetric.SEA_TEMPERATURE }],
    });
    const waveFeatureCall = harness.calls.find(
      (call) =>
        call.searchParams.get('request') === 'GetFeatureInfo' &&
        call.searchParams.get('layer')?.endsWith('/VHM0'),
    );
    expect(waveFeatureCall).toBeUndefined();
  });

  it('reports OUT_OF_COVERAGE when every successfully resolved group excludes the location', async () => {
    const harness = standardProviderHarness({
      outOfCoverageDatasetFragments: ['nws_wav'],
    });

    await expect(
      createServices(harness).regional.fetchEnvironment({
        latitude: 60,
        longitude: 5,
        validAt: new Date('2026-07-31T04:00:00.000Z'),
        metrics: [EnvironmentMetric.WAVE_HEIGHT],
      }),
    ).resolves.toMatchObject({
      status: 'OUT_OF_COVERAGE',
      region: null,
      requestedAt: '2026-07-31T04:00:00.000Z',
      values: [],
    });
  });

  it('rejects CMEMS values outside the variable contract', async () => {
    const harness = standardProviderHarness({ featureValue: 361 });

    await expect(
      createServices(harness).regional.fetchEnvironment({
        latitude: 60,
        longitude: 5,
        validAt: new Date('2026-07-31T04:00:00.000Z'),
        metrics: [EnvironmentMetric.WAVE_DIRECTION],
      }),
    ).resolves.toMatchObject({
      status: 'PROVIDER_FAILURE',
      errorCode: 'CMEMS_SCHEMA',
      retryAfterMs: null,
    });
  });

  it('derives clockwise-from-north current-to direction and verifies magnitude', async () => {
    const harness = standardProviderHarness({
      currentValues: [0.05, 0.03, 0.04],
    });
    const { regional } = createServices(harness);
    const result = await regional.fetchEnvironment({
      latitude: 60,
      longitude: 5,
      validAt: new Date('2026-07-31T04:00:00.000Z'),
      metrics: [EnvironmentMetric.CURRENT_SPEED, EnvironmentMetric.CURRENT_DIRECTION],
    });
    expect(result.status).toBe('AVAILABLE');
    expect(result.values).toHaveLength(2);
    expect(result.values[0]).toMatchObject({
      metric: EnvironmentMetric.CURRENT_SPEED,
      value: 0.05,
      unit: 'm/s',
    });
    expect(result.values[1]?.metric).toBe(EnvironmentMetric.CURRENT_DIRECTION);
    expect(result.values[1]?.value).toBeCloseTo(36.86989765);
    expect(currentToDirectionDegrees(1, 0)).toBe(90);

    const invalidVector = standardProviderHarness({
      currentValues: [0.9, 0.03, 0.04],
    });
    await expect(
      createServices(invalidVector).regional.fetchEnvironment({
        latitude: 60,
        longitude: 5,
        validAt: new Date('2026-07-31T04:00:00.000Z'),
        metrics: [EnvironmentMetric.CURRENT_SPEED],
      }),
    ).resolves.toMatchObject({
      status: 'PROVIDER_FAILURE',
      errorCode: 'CMEMS_SCHEMA',
    });
  });

  it('does not invent a current direction for a zero-speed vector', async () => {
    const harness = standardProviderHarness({
      currentValues: [0, 0, 0],
    });
    const result = await createServices(harness).regional.fetchEnvironment({
      latitude: 60,
      longitude: 5,
      validAt: new Date('2026-07-31T04:00:00.000Z'),
      metrics: [EnvironmentMetric.CURRENT_SPEED, EnvironmentMetric.CURRENT_DIRECTION],
    });

    expect(result).toMatchObject({
      status: 'AVAILABLE',
      values: [
        { metric: EnvironmentMetric.CURRENT_SPEED, value: 0 },
        { metric: EnvironmentMetric.CURRENT_DIRECTION, value: null },
      ],
    });
  });

  it('uses Arctic product IDs and component names north of NWS coverage', async () => {
    const harness = standardProviderHarness({
      currentValues: [0.05, 0.03, 0.04],
    });
    const { regional } = createServices(harness);
    const result = await regional.fetchEnvironment({
      latitude: 70,
      longitude: 5,
      validAt: new Date('2026-07-31T04:00:00.000Z'),
      metrics: [EnvironmentMetric.CURRENT_DIRECTION],
    });
    expect(result).toMatchObject({
      status: 'AVAILABLE',
      region: 'ARCTIC',
      values: [
        {
          metric: EnvironmentMetric.CURRENT_DIRECTION,
          productId: 'ARCTIC_ANALYSISFORECAST_PHY_002_001',
          horizontalResolutionM: 6250,
        },
      ],
    });
    expect(result.values[0]?.value).toBeCloseTo(86.86989765);
    const [eastward, northward] = cmemsVectorToEastNorth(
      CmemsVectorReference.ARCTIC_POLAR_STEREOGRAPHIC_X_Y,
      0.03,
      0.04,
      5,
    );
    expect(eastward).toBeCloseTo(0.049925406, 8);
    expect(northward).toBeCloseTo(0.002730171, 8);
    const featureLayer = harness.calls
      .find((call) => call.searchParams.has('layer'))
      ?.searchParams.get('layer');
    expect(featureLayer).toContain('ARCTIC_ANALYSISFORECAST_PHY_002_001');
  });

  it('returns explicit OUT_OF_COVERAGE without calling CMEMS', async () => {
    const harness = standardProviderHarness();
    const { regional } = createServices(harness);
    await expect(
      regional.fetchEnvironment({
        latitude: 40,
        longitude: 5,
        validAt: new Date('2026-07-31T04:00:00.000Z'),
        metrics: [EnvironmentMetric.WAVE_HEIGHT],
      }),
    ).resolves.toMatchObject({
      status: 'OUT_OF_COVERAGE',
      region: null,
      requestedAt: '2026-07-31T04:00:00.000Z',
      values: [],
    });
    expect(harness.calls).toHaveLength(0);
  });

  it('rejects requests outside the 30-day history and 7-day forecast window', async () => {
    const harness = standardProviderHarness();
    const { regional } = createServices(harness);
    await expect(
      regional.fetchEnvironment({
        latitude: 60,
        longitude: 5,
        validAt: new Date('2026-08-07T04:30:00.001Z'),
        metrics: [EnvironmentMetric.WAVE_HEIGHT],
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      regional.fetchEnvironment({
        latitude: 60,
        longitude: 5,
        validAt: new Date('2026-07-01T04:29:59.999Z'),
        metrics: [EnvironmentMetric.WAVE_HEIGHT],
      }),
    ).rejects.toThrow(RangeError);
    expect(harness.calls).toHaveLength(0);
  });

  it('rejects a FeatureInfo dataset identity mismatch instead of accepting foreign data', async () => {
    const harness = new FetchHarness((url) => {
      if (url.origin.includes('csw.marine.copernicus.eu')) {
        return xmlResponse(cswFixture(CMEMS_PRODUCTS[CmemsProductKey.NWS_PHY]));
      }
      if (url.pathname.startsWith('/teroWmts/')) {
        const parts = url.pathname.split('/');
        const productId = parts[2] ?? '';
        const datasetId = parts[3] ?? '';
        return xmlResponse(capabilitiesFixture({ productId, datasetId }));
      }
      const layer = url.searchParams.get('layer')?.split('/') ?? [];
      return jsonResponse(
        featureFixture({
          productId: layer[0] ?? '',
          datasetId: 'foreign_dataset_202511',
          variableId: layer[2] ?? '',
          latitude: 60,
          longitude: 5,
          value: 1,
          unit: 'degrees_C',
        }),
      );
    });
    await expect(
      createServices(harness).regional.fetchEnvironment({
        latitude: 60,
        longitude: 5,
        validAt: new Date('2026-07-31T04:00:00.000Z'),
        metrics: [EnvironmentMetric.SEA_TEMPERATURE],
      }),
    ).resolves.toMatchObject({
      status: 'PROVIDER_FAILURE',
      errorCode: 'CMEMS_SCHEMA',
    });
  });
});
