import {
  CanonicalEnvironmentProvider,
  EnvironmentMetric,
  EnvironmentProvider,
  EnvironmentQualityStatus,
  EnvironmentSemanticClass,
  EnvironmentSyncScopeKind,
  EnvironmentSyncScopeOutcome,
  EnvironmentSyncStatus,
} from '../entities/environment-observation.types';
import { FarmDomainMetricsService } from '../../common/metrics/farm-domain-metrics.service';
import {
  CDSE_COVERAGE_METHOD,
  CDSE_SENTINEL_2_COLLECTION,
  CdseProviderError,
  CdseProviderErrorCode,
  CdseSentinelProvider,
} from './cdse-sentinel.provider';
import { CmemsEnvironmentValue, CmemsRegionalService } from './cmems-regional.service';
import { CmemsProviderError, CmemsProviderErrorCode } from './cmems-provider';
import { EnvironmentIngestionService, runBounded } from './environment-ingestion.service';
import { EnvironmentMonitoringGate } from './environment-monitoring-gate.service';
import { EnvironmentProviderConfigurationService } from './environment-provider-configuration.service';
import {
  EnvironmentSyncCompletion,
  EnvironmentSyncLease,
  EnvironmentSyncStore,
} from './environment-sync-store.service';
import {
  FrostElementId,
  FrostHistoryAvailable,
  FrostObservationsService,
  FrostQualityStatus,
} from './frost-observations.service';
import {
  MetLocationForecastAvailable,
  MetLocationForecastService,
} from './met-locationforecast.service';
import { MetNorwayProvider } from './met-norway-provider';

const NOW = new Date('2026-07-31T04:00:00.000Z');
const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function lease(provider: CanonicalEnvironmentProvider): EnvironmentSyncLease {
  return {
    schema: 'tenant_aaaaaaaaaaaa4aaa',
    tenantId: TENANT_ID,
    siteId: SITE_ID,
    provider,
    token: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    monitoringLocationRevision: 3,
    latitude: 0,
    longitude: 0,
    altitudeM: 0,
    monitoringRadiusM: 2_000,
    monitoringArea: null,
    cursor: null,
    consecutiveFailures: 0,
  };
}

interface Harness {
  service: EnvironmentIngestionService;
  assertEnabled: jest.Mock;
  complete: jest.Mock<Promise<boolean>, [EnvironmentSyncLease, EnvironmentSyncCompletion, Date]>;
  checkMetNorway: jest.Mock;
  fetchForecast: jest.Mock;
  fetchFrost: jest.Mock;
  fetchCmems: jest.Mock;
  searchScenes: jest.Mock;
  recordProviderCompletion: jest.Mock;
  recordLeaseDiscard: jest.Mock;
}

function harness(): Harness {
  const complete = jest
    .fn<Promise<boolean>, [EnvironmentSyncLease, EnvironmentSyncCompletion, Date]>()
    .mockResolvedValue(true);
  const checkMetNorway = jest.fn().mockReturnValue({
    configured: true,
    errorCode: null,
  });
  const fetchForecast = jest.fn();
  const fetchFrost = jest.fn();
  const fetchCmems = jest.fn();
  const searchScenes = jest.fn();
  const store: EnvironmentSyncStore = Object.create(EnvironmentSyncStore.prototype);
  store.complete = complete;
  const gate: EnvironmentMonitoringGate = Object.create(EnvironmentMonitoringGate.prototype);
  const assertEnabled = jest.fn();
  gate.assertEnabled = assertEnabled;
  const providerConfiguration: EnvironmentProviderConfigurationService = Object.create(
    EnvironmentProviderConfigurationService.prototype,
  );
  providerConfiguration.checkMetNorway = checkMetNorway;
  const locationForecast: MetLocationForecastService = Object.create(
    MetLocationForecastService.prototype,
  );
  locationForecast.fetchForecast = fetchForecast;
  const frost: FrostObservationsService = Object.create(FrostObservationsService.prototype);
  frost.fetchLast30Days = fetchFrost;
  const cmems: CmemsRegionalService = Object.create(CmemsRegionalService.prototype);
  cmems.fetchEnvironment = fetchCmems;
  const cdse: CdseSentinelProvider = Object.create(CdseSentinelProvider.prototype);
  cdse.searchScenes = searchScenes;
  const metrics: FarmDomainMetricsService = Object.create(FarmDomainMetricsService.prototype);
  const recordProviderCompletion = jest.fn();
  const recordLeaseDiscard = jest.fn();
  metrics.recordEnvironmentProviderCompletion = recordProviderCompletion;
  metrics.recordEnvironmentLeaseDiscard = recordLeaseDiscard;
  return {
    service: new EnvironmentIngestionService(
      store,
      gate,
      providerConfiguration,
      locationForecast,
      frost,
      cmems,
      cdse,
      metrics,
    ),
    assertEnabled,
    complete,
    checkMetNorway,
    fetchForecast,
    fetchFrost,
    fetchCmems,
    searchScenes,
    recordProviderCompletion,
    recordLeaseDiscard,
  };
}

function locationForecastResult(): MetLocationForecastAvailable {
  const observation = (validAt: string, temperature: number) => ({
    validAt,
    airTemperature: { value: temperature, unit: 'celsius' },
    windSpeed: { value: 0, unit: 'm/s' },
    windFromDirection: { value: 0, unit: 'degrees' },
    windGust: { value: 0, unit: 'm/s' },
    precipitation: { amount: { value: 0, unit: 'mm' }, periodHours: 1 as const },
    cloudAreaFraction: { value: 0, unit: '%' },
    airPressureAtSeaLevel: { value: 1000, unit: 'hPa' },
    relativeHumidity: { value: 80, unit: '%' },
    symbolCode: null,
  });
  const current = observation('2026-07-31T03:00:00.000Z', 10);
  return {
    status: 'AVAILABLE',
    provider: MetNorwayProvider.LOCATIONFORECAST,
    issuedAt: '2026-07-31T02:45:00.000Z',
    fetchedAt: NOW.toISOString(),
    forecastUntil: '2026-08-07T04:00:00.000Z',
    returnedLocation: { latitude: 0, longitude: 0, altitudeM: 0 },
    current,
    forecast: [current, observation('2026-08-07T04:00:00.000Z', 12)],
  };
}

function frostResult(value: number): FrostHistoryAvailable {
  return {
    status: 'AVAILABLE',
    provider: MetNorwayProvider.FROST,
    fetchedAt: NOW.toISOString(),
    requestedFrom: '2026-07-01T04:00:00.000Z',
    requestedTo: NOW.toISOString(),
    station: {
      id: 'SN00001',
      name: 'Station',
      latitude: 0,
      longitude: 0,
      distanceKm: 1.5,
    },
    elements: [FrostElementId.AIR_TEMPERATURE],
    observations: [
      {
        stationId: 'SN00001',
        referenceTime: '2026-07-30T04:00:00.000Z',
        elementId: FrostElementId.AIR_TEMPERATURE,
        value,
        unit: 'degC',
        qualityCode: 0,
        qualityStatus: FrostQualityStatus.CONTROLLED_OK,
        timeOffset: 'PT0H',
        timeResolution: 'PT1H',
      },
    ],
    elementCoverage: [
      {
        elementId: FrostElementId.AIR_TEMPERATURE,
        status: 'AVAILABLE',
        observationCount: 1,
      },
    ],
    missingIntervals: [],
  };
}

function cmemsValue(validAt: Date, value = 1.2): CmemsEnvironmentValue {
  return {
    provider: EnvironmentProvider.CMEMS,
    metric: EnvironmentMetric.WAVE_HEIGHT,
    value,
    unit: 'm',
    productId: 'NWSHELF_ANALYSISFORECAST_WAV_004_014',
    datasetId: 'cmems_mod_nws_wav_anfc_1.5km_PT1H-i_202511',
    variableId: 'VHM0',
    sourceVariableIds: ['VHM0'],
    validAt: validAt.toISOString(),
    productMetadataUpdatedAt: '2026-07-30T00:00:00.000Z',
    capabilityUpdatedAt: '2026-07-30T01:00:00.000Z',
    dataUpdatedAt: '2026-07-30T02:00:00.000Z',
    fetchedAt: NOW.toISOString(),
    requestedDepthM: null,
    modelDepthM: null,
    horizontalResolutionM: 1_500,
    gridDistanceM: 250,
    qualityStatus: EnvironmentQualityStatus.PROVISIONAL,
    semanticClass:
      validAt > NOW ? EnvironmentSemanticClass.FORECAST : EnvironmentSemanticClass.ANALYSIS,
    discoveryStale: false,
    capabilityStale: false,
  };
}

function cmemsCoverage(
  validAt: Date,
  outcome: EnvironmentSyncScopeOutcome,
): EnvironmentSyncCompletion['coverage'] {
  return [
    {
      scopeKind: EnvironmentSyncScopeKind.METRIC_HORIZON,
      scopeKey: 'CMEMS:NWS_WAV:cmems_mod_nws_wav_anfc_1.5km_PT1H-i',
      metric: EnvironmentMetric.WAVE_HEIGHT,
      validFrom: validAt,
      validTo: validAt,
      outcome,
      errorCode: null,
      observationCount: outcome === EnvironmentSyncScopeOutcome.AVAILABLE ? 1 : 0,
    },
  ];
}

describe('EnvironmentIngestionService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('persists zero-coordinate Locationforecast current and +7d values as forecast semantics', async () => {
    const test = harness();
    test.fetchForecast.mockResolvedValue(locationForecastResult());

    await expect(
      test.service.processLease(lease(EnvironmentProvider.MET_LOCATIONFORECAST)),
    ).resolves.toBe(true);

    expect(test.fetchForecast).toHaveBeenCalledWith({
      latitude: 0,
      longitude: 0,
      altitudeM: 0,
    });
    const completion = test.complete.mock.calls[0]![1];
    expect(completion.status).toBe(EnvironmentSyncStatus.READY);
    expect(completion.weather).toHaveLength(2);
    expect(
      completion.weather.every((row) => row.semanticClass === EnvironmentSemanticClass.FORECAST),
    ).toBe(true);
    expect(completion.weather).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          observedAt: new Date('2026-08-07T04:00:00.000Z'),
          dataType: 'forecast',
        }),
      ]),
    );
    expect(test.recordProviderCompletion).toHaveBeenCalledWith({
      provider: EnvironmentProvider.MET_LOCATIONFORECAST,
      status: EnvironmentSyncStatus.READY,
      successfulProviderResponse: true,
      scopeOutcomes: Array(8).fill(EnvironmentSyncScopeOutcome.AVAILABLE),
    });
  });

  it('does not mix a six-hour Locationforecast total into the canonical hourly precipitation series', async () => {
    const test = harness();
    const result = locationForecastResult();
    const sixHourCurrent = {
      ...result.current,
      precipitation: {
        amount: { value: 12, unit: 'mm' },
        periodHours: 6 as const,
      },
    };
    result.current = sixHourCurrent;
    result.forecast = [sixHourCurrent, ...result.forecast.slice(1)];
    test.fetchForecast.mockResolvedValue(result);

    await test.service.processLease(lease(EnvironmentProvider.MET_LOCATIONFORECAST));

    const current = test.complete.mock.calls[0]![1].weather.find(
      (row) => row.observedAt.toISOString() === sixHourCurrent.validAt,
    );
    expect(current?.precipitation).toBeNull();
  });

  it('turns an oversized finite provider value into a terminal lease outcome before persistence', async () => {
    const test = harness();
    const result = locationForecastResult();
    result.current.airTemperature = { value: 10_000, unit: 'celsius' };
    result.forecast = [result.current];
    test.fetchForecast.mockResolvedValue(result);

    await test.service.processLease(lease(EnvironmentProvider.MET_LOCATIONFORECAST));

    expect(test.complete).toHaveBeenCalledTimes(1);
    expect(test.complete.mock.calls[0]![1]).toMatchObject({
      status: EnvironmentSyncStatus.PROVIDER_UNAVAILABLE,
      errorCode: 'PROVIDER_DATA_CONTRACT',
      successfulProviderResponse: false,
      weather: [],
    });
  });

  it('fails closed before provider I/O or persistence when the rollout gate is disabled', async () => {
    const test = harness();
    test.assertEnabled.mockImplementation(() => {
      throw new Error('ENVIRONMENT_MONITORING_DISABLED');
    });

    await expect(
      test.service.processLease(lease(EnvironmentProvider.MET_LOCATIONFORECAST)),
    ).rejects.toThrow('ENVIRONMENT_MONITORING_DISABLED');

    expect(test.fetchForecast).not.toHaveBeenCalled();
    expect(test.complete).not.toHaveBeenCalled();
  });

  it('deduplicates unchanged Frost polls but appends a deterministic correction revision', async () => {
    const test = harness();
    test.fetchFrost
      .mockResolvedValueOnce(frostResult(5))
      .mockResolvedValueOnce(frostResult(5))
      .mockResolvedValueOnce(frostResult(6));

    await test.service.processLease(lease(EnvironmentProvider.MET_FROST));
    await test.service.processLease(lease(EnvironmentProvider.MET_FROST));
    await test.service.processLease(lease(EnvironmentProvider.MET_FROST));

    const first = test.complete.mock.calls[0]![1].weather[0]!.sourceRunKey;
    const replay = test.complete.mock.calls[1]![1].weather[0]!.sourceRunKey;
    const correction = test.complete.mock.calls[2]![1].weather[0]!.sourceRunKey;
    expect(replay).toBe(first);
    expect(correction).not.toBe(first);
    expect(first).toMatch(/^frost:[a-f0-9]{64}$/u);
  });

  it('does not project Frost station surface pressure as sea-level pressure', async () => {
    const test = harness();
    const result = frostResult(5);
    result.observations.push({
      stationId: 'SN00001',
      referenceTime: '2026-07-30T04:00:00.000Z',
      elementId: FrostElementId.SURFACE_AIR_PRESSURE,
      value: 990,
      unit: 'hPa',
      qualityCode: 0,
      qualityStatus: FrostQualityStatus.CONTROLLED_OK,
      timeOffset: 'PT0H',
      timeResolution: 'PT1H',
    });
    test.fetchFrost.mockResolvedValue(result);

    await test.service.processLease(lease(EnvironmentProvider.MET_FROST));

    expect(test.complete.mock.calls[0]![1].weather[0]?.pressureMsl).toBeNull();
  });

  it('persists a Frost chunk gap only for the element missing from that chunk', async () => {
    const test = harness();
    const result = frostResult(5);
    result.elements = [FrostElementId.AIR_TEMPERATURE, FrostElementId.WIND_SPEED];
    result.observations = [
      {
        stationId: 'SN00001',
        referenceTime: '2026-07-30T04:00:00.000Z',
        elementId: FrostElementId.WIND_SPEED,
        value: 3.4,
        unit: 'm/s',
        qualityCode: 0,
        qualityStatus: FrostQualityStatus.CONTROLLED_OK,
        timeOffset: 'PT0H',
        timeResolution: 'PT1H',
      },
    ];
    result.elementCoverage = [
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
    ];
    result.missingIntervals = [
      {
        elementId: FrostElementId.AIR_TEMPERATURE,
        from: '2026-07-25T04:00:00.000Z',
        to: '2026-07-30T04:00:00.000Z',
        reason: 'NO_OBSERVATIONS',
      },
    ];
    test.fetchFrost.mockResolvedValue(result);

    await test.service.processLease(lease(EnvironmentProvider.MET_FROST));

    const completion = test.complete.mock.calls[0]![1];
    const intervalScopes = completion.coverage.filter(
      ({ scopeKind }) => scopeKind === EnvironmentSyncScopeKind.METRIC_INTERVAL,
    );
    expect(intervalScopes).toEqual([
      expect.objectContaining({
        metric: EnvironmentMetric.AIR_TEMPERATURE,
        outcome: EnvironmentSyncScopeOutcome.NO_DATA,
        validFrom: new Date('2026-07-25T04:00:00.000Z'),
        validTo: new Date('2026-07-30T04:00:00.000Z'),
      }),
    ]);
    expect(intervalScopes).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ metric: EnvironmentMetric.WIND_SPEED })]),
    );
  });

  it('keeps all 15 CMEMS 12-hour horizons through +7d and persists actual valid times', async () => {
    const test = harness();
    test.fetchCmems.mockImplementation(({ validAt }: { validAt: Date }) =>
      Promise.resolve({
        status: 'AVAILABLE',
        region: 'NORTH_WEST_SHELF',
        requestedAt: validAt.toISOString(),
        values: [cmemsValue(validAt)],
        coverage: cmemsCoverage(validAt, EnvironmentSyncScopeOutcome.AVAILABLE),
      }),
    );

    await test.service.processLease(lease(EnvironmentProvider.CMEMS));

    expect(test.fetchCmems).toHaveBeenCalledTimes(15);
    expect(test.fetchCmems.mock.calls[14]![0].validAt).toEqual(
      new Date('2026-08-07T04:00:00.000Z'),
    );
    const completion = test.complete.mock.calls[0]![1];
    expect(completion.marine).toHaveLength(15);
    expect(completion.marine.at(-1)).toMatchObject({
      observedAt: new Date('2026-08-07T04:00:00.000Z'),
      dataType: 'forecast',
      variableSetId: 'WAVE_HEIGHT=VHM0',
      issuedAt: null,
    });
  });

  it('persists successful CMEMS horizons when a separate horizon fails', async () => {
    const test = harness();
    test.fetchCmems.mockImplementation(({ validAt }: { validAt: Date }) => {
      if (validAt.getTime() === NOW.getTime()) {
        return Promise.reject(
          new CmemsProviderError({
            code: CmemsProviderErrorCode.PROVIDER_UNAVAILABLE,
            message: 'one horizon unavailable',
            retryable: true,
          }),
        );
      }
      return Promise.resolve({
        status: 'AVAILABLE',
        region: 'NORTH_WEST_SHELF',
        requestedAt: validAt.toISOString(),
        values: [cmemsValue(validAt)],
        coverage: cmemsCoverage(validAt, EnvironmentSyncScopeOutcome.AVAILABLE),
      });
    });

    await test.service.processLease(lease(EnvironmentProvider.CMEMS));

    expect(test.fetchCmems).toHaveBeenCalledTimes(15);
    expect(test.complete.mock.calls[0]![1]).toMatchObject({
      status: EnvironmentSyncStatus.PARTIAL_FAILURE,
      errorCode: 'CMEMS_PARTIAL_FAILURE',
      successfulProviderResponse: true,
    });
    expect(test.complete.mock.calls[0]![1].marine).toHaveLength(14);
    expect(test.complete.mock.calls[0]![1].marine[0]?.observedAt).toEqual(
      new Date('2026-07-31T16:00:00.000Z'),
    );
  });

  it('classifies CMEMS as unavailable only when every horizon fails', async () => {
    const test = harness();
    test.fetchCmems.mockRejectedValue(
      new CmemsProviderError({
        code: CmemsProviderErrorCode.PROVIDER_UNAVAILABLE,
        message: 'all horizons unavailable',
        retryable: true,
      }),
    );

    await test.service.processLease(lease(EnvironmentProvider.CMEMS));

    expect(test.fetchCmems).toHaveBeenCalledTimes(15);
    expect(test.complete.mock.calls[0]![1]).toMatchObject({
      status: EnvironmentSyncStatus.PROVIDER_UNAVAILABLE,
      errorCode: 'CMEMS_PROVIDER_UNAVAILABLE',
      successfulProviderResponse: false,
      marine: [],
    });
  });

  it.each([
    {
      providerStatus: 'NO_DATA' as const,
      region: 'NORTH_WEST_SHELF' as const,
    },
    {
      providerStatus: 'OUT_OF_COVERAGE' as const,
      region: null,
    },
  ])(
    'keeps a successful $providerStatus horizon authoritative when the other horizons fail',
    async ({ providerStatus, region }) => {
      const test = harness();
      let call = 0;
      test.fetchCmems.mockImplementation(({ validAt }: { validAt: Date }) => {
        call += 1;
        if (call === 1) {
          return Promise.resolve({
            status: providerStatus,
            region,
            requestedAt: validAt.toISOString(),
            values: [],
            coverage: cmemsCoverage(
              validAt,
              providerStatus === 'NO_DATA'
                ? EnvironmentSyncScopeOutcome.NO_DATA
                : EnvironmentSyncScopeOutcome.OUT_OF_COVERAGE,
            ),
          });
        }
        return Promise.reject(new Error('horizon unavailable'));
      });

      await test.service.processLease(lease(EnvironmentProvider.CMEMS));

      expect(test.fetchCmems).toHaveBeenCalledTimes(15);
      expect(test.complete.mock.calls[0]![1]).toMatchObject({
        status: EnvironmentSyncStatus.PARTIAL_FAILURE,
        errorCode: 'CMEMS_PARTIAL_FAILURE',
        successfulProviderResponse: true,
        marine: [],
      });
    },
  );

  it('creates a new CMEMS source revision when a corrected cell value changes', async () => {
    const test = harness();
    let correctedValue = 1.2;
    test.fetchCmems.mockImplementation(({ validAt }: { validAt: Date }) =>
      Promise.resolve({
        status: 'AVAILABLE',
        region: 'NORTH_WEST_SHELF',
        requestedAt: validAt.toISOString(),
        values: [cmemsValue(validAt, correctedValue)],
        coverage: cmemsCoverage(validAt, EnvironmentSyncScopeOutcome.AVAILABLE),
      }),
    );

    await test.service.processLease(lease(EnvironmentProvider.CMEMS));
    correctedValue = 1.4;
    await test.service.processLease(lease(EnvironmentProvider.CMEMS));

    const original = test.complete.mock.calls[0]![1].marine[0]!;
    const corrected = test.complete.mock.calls[1]![1].marine[0]!;
    expect(original).toMatchObject({ waveHeight: 1.2 });
    expect(corrected).toMatchObject({ waveHeight: 1.4 });
    expect(corrected.sourceRunKey).not.toBe(original.sourceRunKey);
  });

  it('records missing MET deployment identity as CONFIGURATION_ERROR without network I/O', async () => {
    const test = harness();
    test.checkMetNorway.mockReturnValue({
      configured: false,
      errorCode: 'MET_APPLICATION_IDENTITY',
    });

    await test.service.processLease(lease(EnvironmentProvider.MET_LOCATIONFORECAST));

    expect(test.fetchForecast).not.toHaveBeenCalled();
    expect(test.complete.mock.calls[0]![1]).toMatchObject({
      status: EnvironmentSyncStatus.CONFIGURATION_ERROR,
      successfulProviderResponse: false,
    });
    expect(test.recordProviderCompletion).toHaveBeenCalledWith({
      provider: EnvironmentProvider.MET_LOCATIONFORECAST,
      status: EnvironmentSyncStatus.CONFIGURATION_ERROR,
      successfulProviderResponse: false,
      scopeOutcomes: [EnvironmentSyncScopeOutcome.CONFIGURATION_ERROR],
    });
  });

  it('persists the complete versioned CDSE site-coverage provenance bundle', async () => {
    const test = harness();
    test.searchScenes.mockResolvedValue({
      scenes: [
        {
          tenantId: TENANT_ID,
          siteId: SITE_ID,
          sceneId: 'S2B_TEST_SCENE',
          collection: CDSE_SENTINEL_2_COLLECTION,
          provider: EnvironmentProvider.CDSE_SENTINEL_2,
          productId: 'S2B_TEST_SCENE',
          datasetId: CDSE_SENTINEL_2_COLLECTION,
          acquiredAt: '2026-07-30T10:25:59.000Z',
          cloudCoverPercent: 30,
          coveragePercent: 50,
          coverageStatus: 'PARTIAL',
          coverageMethod: CDSE_COVERAGE_METHOD,
          coverageSampleCount: 256,
          qualityStatus: EnvironmentQualityStatus.PROVISIONAL,
          monitoringLocationRevision: 3,
          fetchedAt: NOW.toISOString(),
          cursor: 'scene-cursor',
        },
      ],
      hasMore: false,
      endCursor: 'scene-cursor',
    });

    await test.service.processLease(lease(EnvironmentProvider.CDSE_SENTINEL_2));

    expect(test.complete.mock.calls[0]![1].scenes).toEqual([
      expect.objectContaining({
        sceneId: 'S2B_TEST_SCENE',
        coveragePercent: 50,
        coverageStatus: 'PARTIAL',
        coverageMethod: CDSE_COVERAGE_METHOD,
        coverageSampleCount: 256,
      }),
    ]);
  });

  it.each([
    CdseProviderErrorCode.CREDENTIAL_SERVICE,
    CdseProviderErrorCode.TRANSPORT,
    CdseProviderErrorCode.TIMEOUT,
    CdseProviderErrorCode.RATE_LIMITED,
    CdseProviderErrorCode.UPSTREAM,
  ])('backs off transient CDSE token failure %s as provider unavailable', async (code) => {
    const test = harness();
    test.searchScenes.mockRejectedValue(
      new CdseProviderError({
        code,
        message: 'classified transient token failure',
        retryable: true,
        ...(code === CdseProviderErrorCode.RATE_LIMITED ? { retryAfterMs: 2_000 } : {}),
      }),
    );

    await test.service.processLease(lease(EnvironmentProvider.CDSE_SENTINEL_2));

    expect(test.complete.mock.calls[0]![1]).toMatchObject({
      status: EnvironmentSyncStatus.PROVIDER_UNAVAILABLE,
      errorCode: `CDSE_${code}`,
      nextRunAt: new Date(NOW.getTime() + 15 * 60_000),
      successfulProviderResponse: false,
    });
  });

  it('keeps invalid CDSE client authentication in configuration recheck state', async () => {
    const test = harness();
    test.searchScenes.mockRejectedValue(
      new CdseProviderError({
        code: CdseProviderErrorCode.AUTHENTICATION,
        message: 'invalid client',
        retryable: false,
        httpStatus: 401,
      }),
    );

    await test.service.processLease(lease(EnvironmentProvider.CDSE_SENTINEL_2));

    expect(test.complete.mock.calls[0]![1]).toMatchObject({
      status: EnvironmentSyncStatus.CONFIGURATION_ERROR,
      errorCode: 'CDSE_AUTHENTICATION',
      nextRunAt: new Date(NOW.getTime() + 24 * 60 * 60_000),
      successfulProviderResponse: false,
    });
  });

  it('discards provider output when the fenced completion detects a location revision change', async () => {
    const test = harness();
    test.complete.mockResolvedValue(false);
    test.fetchForecast.mockResolvedValue(locationForecastResult());

    await expect(
      test.service.processLease(lease(EnvironmentProvider.MET_LOCATIONFORECAST)),
    ).resolves.toBe(false);
    expect(test.recordLeaseDiscard).toHaveBeenCalledWith(EnvironmentProvider.MET_LOCATIONFORECAST);
  });

  it('stops scheduling bounded work after the first failure and drains work already in flight', async () => {
    const firstFailure = new Error('first worker failed');
    const started: number[] = [];
    let releaseInFlight: () => void = () => {
      throw new Error('in-flight worker was not started');
    };
    const inFlight = new Promise<void>((resolve) => {
      releaseInFlight = resolve;
    });
    const pending = runBounded([0, 1, 2, 3], 2, async (value): Promise<number> => {
      started.push(value);
      if (value === 0) throw firstFailure;
      if (value === 1) await inFlight;
      return value;
    });
    let settled = false;
    const observed = pending.then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(started).toEqual([0, 1]);
    expect(settled).toBe(false);

    releaseInFlight();

    await expect(observed).resolves.toBe(firstFailure);
    expect(started).toEqual([0, 1]);
  });
});
