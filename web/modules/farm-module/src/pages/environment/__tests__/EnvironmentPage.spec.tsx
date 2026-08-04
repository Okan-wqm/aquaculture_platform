import React from 'react';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

const { blobRequestMock } = vi.hoisted(() => ({
  blobRequestMock: vi.fn(),
}));

vi.mock('@aquaculture/shared-ui', async () => {
  const { createSharedUiMock } = await import('../../../test-utils/sharedUiMock');
  return {
    ...(await createSharedUiMock()),
    restClient: { requestBlob: blobRequestMock },
  };
});

import { requestMock } from '../../../test-utils/sharedUiMock';
import { routeGraphql } from '../../../test-utils/mockGraphqlClient';
import { renderWithProviders } from '../../../test-utils/renderWithProviders';
import { ENVIRONMENT_SCENE_RENDER_TIMEOUT_MS } from '../../../hooks/useEnvironment';
import EnvironmentPage from '../EnvironmentPage';

const AUTHORIZED_SITE_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_SITE_ID = '20000000-0000-4000-8000-000000000002';

const AUTHORIZED_SITE = {
  id: AUTHORIZED_SITE_ID,
  name: 'Nordfjord Cage A',
  code: 'NF-A',
  type: 'SEA_CAGE',
  status: 'ACTIVE',
  location: { latitude: 61.925, longitude: 5.113 },
  monitoringRadiusM: 2_000,
  monitoringArea: null,
  monitoringLocationRevision: 3,
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
};

const CURRENT_WAVE_VALUE = {
  metric: 'WAVE_HEIGHT',
  value: 1.4,
  unit: 'm',
  source: 'CMEMS',
  semanticClass: 'ANALYSIS',
  validAt: '2026-07-30T12:00:00.000Z',
  issuedAt: '2026-07-30T00:00:00.000Z',
  fetchedAt: '2026-07-30T12:05:00.000Z',
  qualityStatus: 'VALID',
  depthM: null,
  requestedDepthM: null,
  datasetId: 'regional-wave',
  productId: 'nws-wave',
  variableId: 'VHM0',
  resolutionM: 1_500,
  gridCellDistanceM: 340,
  locationRevision: 3,
  stationId: null,
  stationDistanceKm: null,
};

function layer(
  id: string,
  name: string,
  availability:
    | 'PREPARING'
    | 'READY'
    | 'PARTIAL_FAILURE'
    | 'PARTIAL_COVERAGE'
    | 'NO_DATA'
    | 'CLOUD_OBSCURED'
    | 'OUT_OF_COVERAGE'
    | 'STALE'
    | 'PROVIDER_UNAVAILABLE'
    | 'CONFIGURATION_ERROR',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    name,
    description: `${name} description from backend`,
    scientificLabel: `${name} scientific label from backend`,
    source: 'CMEMS',
    semanticClass: 'ANALYSIS',
    unit: 'm',
    metric: 'WAVE_HEIGHT',
    capabilities: ['HISTORY', 'FORECAST'],
    supportsDepth: false,
    nominalResolutionM: 1_500,
    resolutionLabel: '1.5 km model grid',
    minValue: 0,
    maxValue: null,
    availability,
    availableFrom: '2026-07-01T00:00:00.000Z',
    availableTo: '2026-07-30T12:00:00.000Z',
    coverage: {
      expected: 1,
      successful: 1,
      failed: 0,
      noData: 0,
      outOfCoverage: 0,
      scopes: [
        {
          provider: 'CMEMS',
          metric: 'WAVE_HEIGHT',
          scopeKind: 'METRIC_SUMMARY',
          scopeKey: 'CMEMS:WAVE_HEIGHT',
          validFrom: '2026-07-01T00:00:00.000Z',
          validTo: '2026-07-30T12:00:00.000Z',
          outcome: 'AVAILABLE',
          errorCode: null,
          observationCount: 1,
          completedAt: '2026-07-30T12:05:00.000Z',
        },
      ],
    },
    ...overrides,
  };
}

function installBaseRoutes(
  sites: Record<string, unknown>[] = [AUTHORIZED_SITE],
  layers: Record<string, unknown>[] = [layer('backend:wave', 'Backend wave label', 'READY')],
  currentValues: Record<string, unknown>[] = [CURRENT_WAVE_VALUE],
): void {
  routeGraphql([
    {
      match: 'query Sites(',
      result: { sites: { items: sites, total: sites.length, page: 1, limit: 100 } },
    },
    {
      match: 'query SiteEnvironmentCurrent',
      result: {
        siteEnvironmentCurrent: {
          siteId: AUTHORIZED_SITE_ID,
          values: currentValues,
        },
      },
    },
    {
      match: 'query EnvironmentLayerCatalog',
      result: { environmentLayerCatalog: layers },
    },
    {
      match: 'query SiteEnvironmentHistory',
      result: {
        siteEnvironmentHistory: {
          siteId: AUTHORIZED_SITE_ID,
          values: [
            {
              ...CURRENT_WAVE_VALUE,
              value: 1.1,
              validAt: '2026-07-29T12:00:00.000Z',
            },
          ],
        },
      },
    },
    {
      match: 'query SiteEnvironmentForecast',
      result: {
        siteEnvironmentForecast: {
          siteId: AUTHORIZED_SITE_ID,
          values: [
            {
              ...CURRENT_WAVE_VALUE,
              semanticClass: 'FORECAST',
              value: 1.8,
              validAt: '2026-08-01T12:00:00.000Z',
            },
          ],
        },
      },
    },
    {
      match: 'query EnvironmentScenes',
      result: {
        environmentScenes: {
          siteId: AUTHORIZED_SITE_ID,
          edges: [],
          pageInfo: {
            hasNextPage: false,
            endCursor: null,
          },
        },
      },
    },
  ]);
}

beforeEach(() => {
  requestMock.mockReset();
  blobRequestMock.mockReset();
});

describe('EnvironmentPage', () => {
  it('shows a terminal error when the authorized site list has never loaded', async () => {
    requestMock.mockRejectedValueOnce(new Error('site list unavailable'));

    renderWithProviders(<EnvironmentPage />, { route: '/sites/environment' });

    expect(
      await screen.findByText('Your authorized sites could not be loaded.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Environmental monitoring' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/site list unavailable/i)).not.toBeInTheDocument();
  });

  it('shows onboarding and does not query environment data without an eligible sea-cage site', async () => {
    installBaseRoutes([
      {
        ...AUTHORIZED_SITE,
        id: '30000000-0000-4000-8000-000000000003',
        type: 'LAND_BASED',
      },
    ]);

    renderWithProviders(<EnvironmentPage />, { route: '/sites/environment' });

    expect(
      await screen.findByRole('heading', {
        name: 'Add a sea-cage site to start monitoring',
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open site setup' })).toHaveAttribute(
      'href',
      '/sites/setup/sites',
    );
    expect(
      requestMock.mock.calls.some(([query]) => String(query).includes('SiteEnvironmentCurrent')),
    ).toBe(false);
  });

  it('never queries a route site outside the authorized site list', async () => {
    installBaseRoutes();

    renderWithProviders(<EnvironmentPage />, {
      route: `/sites/environment/${OTHER_SITE_ID}`,
      path: '/sites/environment/:siteId',
    });

    expect(
      await screen.findByRole('heading', { name: 'Environmental monitoring' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Sea-cage site' })).toHaveValue(AUTHORIZED_SITE_ID);

    await waitFor(() => {
      expect(
        requestMock.mock.calls.filter(([query]) => String(query).includes('SiteEnvironment'))
          .length,
      ).toBeGreaterThan(0);
    });
    const siteEnvironmentCalls = requestMock.mock.calls.filter(([query]) =>
      String(query).includes('SiteEnvironment'),
    );
    for (const call of siteEnvironmentCalls) {
      expect(call[1]).not.toEqual(expect.objectContaining({ siteId: OTHER_SITE_ID }));
      expect(JSON.stringify(call[1])).not.toContain(OTHER_SITE_ID);
    }
  });

  it('keeps last-known-good sites, values, and layers visible after metadata refresh failures', async () => {
    let rejectMetadataRefresh = false;
    const readyLayer = layer('backend:wave', 'Backend wave label', 'READY');

    routeGraphql([
      {
        match: 'query Sites(',
        result: () => {
          if (rejectMetadataRefresh) {
            throw new Error('site list refresh failed');
          }
          return {
            sites: { items: [AUTHORIZED_SITE], total: 1, page: 1, limit: 100 },
          };
        },
      },
      {
        match: 'query SiteEnvironmentCurrent',
        result: {
          siteEnvironmentCurrent: {
            siteId: AUTHORIZED_SITE_ID,
            values: [CURRENT_WAVE_VALUE],
          },
        },
      },
      {
        match: 'query EnvironmentLayerCatalog',
        result: () => {
          if (rejectMetadataRefresh) {
            throw new Error('layer catalog refresh failed');
          }
          return { environmentLayerCatalog: [readyLayer] };
        },
      },
    ]);

    const rendered = renderWithProviders(<EnvironmentPage />, {
      route: `/sites/environment/${AUTHORIZED_SITE_ID}`,
      path: '/sites/environment/:siteId',
    });

    expect(await screen.findByText(/^1\.4/)).toBeInTheDocument();
    expect(screen.getAllByText('Backend wave label').length).toBeGreaterThan(0);

    rejectMetadataRefresh = true;
    await act(async () => {
      await rendered.queryClient.invalidateQueries({ queryKey: ['tenant'] });
    });

    expect(
      await screen.findByText(
        'Authorized sites could not be refreshed. The last available site list remains in use.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Layer metadata could not be refreshed. Current values and the last available layer catalog remain visible.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/^1\.4/)).toBeInTheDocument();
    expect(screen.getAllByText('Backend wave label').length).toBeGreaterThan(0);
    expect(screen.queryByText('Opening an authorized sea-cage site…')).not.toBeInTheDocument();
  });

  it('renders backend catalog labels and every distinct availability state', async () => {
    installBaseRoutes(
      [AUTHORIZED_SITE],
      [
        layer('backend:ready', 'Backend wave label', 'READY'),
        layer('backend:partial-failure', 'Partial-failure layer', 'PARTIAL_FAILURE', {
          coverage: {
            expected: 2,
            successful: 1,
            failed: 1,
            noData: 0,
            outOfCoverage: 0,
            scopes: [
              {
                provider: 'CMEMS',
                metric: 'WAVE_HEIGHT',
                scopeKind: 'METRIC_HORIZON',
                scopeKey: 'CMEMS:WAVE_HEIGHT:+0h',
                validFrom: '2026-07-30T12:00:00.000Z',
                validTo: '2026-07-30T12:00:00.000Z',
                outcome: 'AVAILABLE',
                errorCode: null,
                observationCount: 1,
                completedAt: '2026-07-30T12:05:00.000Z',
              },
              {
                provider: 'CMEMS',
                metric: 'WAVE_HEIGHT',
                scopeKind: 'METRIC_HORIZON',
                scopeKey: 'CMEMS:WAVE_HEIGHT:+12h',
                validFrom: '2026-07-31T00:00:00.000Z',
                validTo: '2026-07-31T00:00:00.000Z',
                outcome: 'PROVIDER_UNAVAILABLE',
                errorCode: 'CMEMS_TIMEOUT',
                observationCount: 0,
                completedAt: '2026-07-30T12:05:00.000Z',
              },
            ],
          },
        }),
        layer('backend:partial-coverage', 'Partial-coverage layer', 'PARTIAL_COVERAGE', {
          coverage: {
            expected: 2,
            successful: 2,
            failed: 0,
            noData: 1,
            outOfCoverage: 0,
            scopes: [
              {
                provider: 'MET_FROST',
                metric: 'WIND_SPEED',
                scopeKind: 'METRIC_SUMMARY',
                scopeKey: 'MET_FROST:wind_speed',
                validFrom: '2026-07-01T00:00:00.000Z',
                validTo: '2026-07-30T12:00:00.000Z',
                outcome: 'AVAILABLE',
                errorCode: null,
                observationCount: 20,
                completedAt: '2026-07-30T12:05:00.000Z',
              },
              {
                provider: 'MET_FROST',
                metric: 'WIND_SPEED',
                scopeKind: 'METRIC_INTERVAL',
                scopeKey: 'MET_FROST:wind_speed:gap',
                validFrom: '2026-07-15T00:00:00.000Z',
                validTo: '2026-07-20T00:00:00.000Z',
                outcome: 'NO_DATA',
                errorCode: null,
                observationCount: 0,
                completedAt: '2026-07-30T12:05:00.000Z',
              },
            ],
          },
        }),
        layer('backend:preparing', 'Preparing layer', 'PREPARING'),
        layer('backend:no-data', 'No-data layer', 'NO_DATA'),
        layer('backend:cloud', 'Backend algae proxy label', 'CLOUD_OBSCURED', {
          source: 'CDSE_SENTINEL_2',
          semanticClass: 'INDICATOR',
          unit: '1',
          metric: null,
          capabilities: ['IMAGERY'],
          scientificLabel:
            'Dimensionless backend proxy label; not chlorophyll concentration or HAB diagnosis.',
        }),
        layer('backend:coverage', 'Coverage layer', 'OUT_OF_COVERAGE'),
        layer('backend:stale', 'Stale layer', 'STALE'),
        layer('backend:unavailable', 'Unavailable layer', 'PROVIDER_UNAVAILABLE'),
        layer('backend:config', 'Configuration layer', 'CONFIGURATION_ERROR'),
      ],
    );

    renderWithProviders(<EnvironmentPage />, {
      route: `/sites/environment/${AUTHORIZED_SITE_ID}`,
      path: '/sites/environment/:siteId',
    });

    expect(await screen.findByText('Backend algae proxy label')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Dimensionless backend proxy label; not chlorophyll concentration or HAB diagnosis.',
      ),
    ).toBeInTheDocument();
    for (const status of [
      'READY',
      'PARTIAL_FAILURE',
      'PARTIAL_COVERAGE',
      'PREPARING',
      'NO_DATA',
      'CLOUD_OBSCURED',
      'OUT_OF_COVERAGE',
      'STALE',
      'PROVIDER_UNAVAILABLE',
      'CONFIGURATION_ERROR',
    ]) {
      expect(screen.getAllByText(status).length).toBeGreaterThan(0);
    }
    expect(
      screen.getByText('The company-managed provider connection requires attention.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 failed/)).toBeInTheDocument();
    expect(screen.getByText(/1 no-data/)).toBeInTheDocument();
    expect(screen.getByText(/CMEMS_TIMEOUT/)).toBeInTheDocument();
    expect(screen.getByText(/15 Jul 2026, 00:00 to 20 Jul 2026, 00:00 UTC/)).toBeInTheDocument();
    expect(screen.getByText('Model output — not an on-site sensor reading.')).toBeInTheDocument();
  });

  it('uses the backend catalog as the label source for wave and current direction semantics', async () => {
    installBaseRoutes(
      [AUTHORIZED_SITE],
      [
        layer('cmems:wave-direction', 'Mean wave direction (from)', 'READY', {
          metric: 'WAVE_DIRECTION',
          unit: '°',
        }),
        layer('cmems:wave-period', 'Mean wave period (Tm02)', 'READY', {
          metric: 'WAVE_PERIOD',
          unit: 's',
        }),
        layer('cmems:current-direction', 'Current direction (toward)', 'READY', {
          metric: 'CURRENT_DIRECTION',
          unit: '°',
        }),
      ],
      [
        {
          ...CURRENT_WAVE_VALUE,
          metric: 'WAVE_DIRECTION',
          value: 225,
          unit: '°',
          variableId: 'VMDR',
        },
        {
          ...CURRENT_WAVE_VALUE,
          metric: 'WAVE_PERIOD',
          value: 7.5,
          unit: 's',
          variableId: 'VTM02',
        },
        {
          ...CURRENT_WAVE_VALUE,
          metric: 'CURRENT_DIRECTION',
          value: 42,
          unit: '°',
          variableId: 'uo,vo',
        },
      ],
    );

    renderWithProviders(<EnvironmentPage />, {
      route: `/sites/environment/${AUTHORIZED_SITE_ID}`,
      path: '/sites/environment/:siteId',
    });

    expect((await screen.findAllByText('Mean wave direction (from)')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Mean wave period (Tm02)').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Current direction (toward)').length).toBeGreaterThan(0);
  });

  it('shows station locality, model-grid locality and source timestamps without implying on-site sensors', async () => {
    installBaseRoutes(
      [AUTHORIZED_SITE],
      [
        layer('backend:wave', 'Backend wave label', 'READY'),
        layer('frost:air-temperature', 'Observed air temperature', 'READY', {
          source: 'MET_FROST',
          semanticClass: 'OBSERVATION',
          metric: 'AIR_TEMPERATURE',
          unit: '°C',
          nominalResolutionM: null,
          resolutionLabel: 'Nearby station',
          capabilities: ['CURRENT', 'HISTORY'],
        }),
      ],
      [
        CURRENT_WAVE_VALUE,
        {
          ...CURRENT_WAVE_VALUE,
          metric: 'AIR_TEMPERATURE',
          value: 7.2,
          unit: '°C',
          source: 'MET_FROST',
          semanticClass: 'OBSERVATION',
          issuedAt: null,
          datasetId: 'SN99999:timeseries-0',
          productId: 'frost-observations-v0',
          variableId: 'air_temperature',
          resolutionM: null,
          gridCellDistanceM: null,
          stationId: 'SN99999',
          stationDistanceKm: 1.42,
        },
      ],
    );

    renderWithProviders(<EnvironmentPage />, {
      route: `/sites/environment/${AUTHORIZED_SITE_ID}`,
      path: '/sites/environment/:siteId',
    });

    expect((await screen.findAllByText('Observed air temperature')).length).toBeGreaterThan(0);
    expect(screen.getByText('Model output — not an on-site sensor reading.')).toBeInTheDocument();
    expect(
      screen.getByText('Nearby weather-station observation — not an on-site sensor reading.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Model grid:').parentElement).toHaveTextContent(
      '1.5 km resolution · cell centre 340 m from site',
    );
    expect(screen.getByText('Station:').parentElement).toHaveTextContent(
      'SN99999 · 1.42 km from site',
    );
    expect(screen.getAllByText('Issued:')).toHaveLength(2);
    expect(screen.getByText('not applicable for observations')).toBeInTheDocument();
    expect(screen.getAllByText('Retrieved:')).toHaveLength(2);
    expect(screen.getAllByText('30 Jul 2026, 12:05 UTC')).toHaveLength(2);
  });

  it('loads bounded history and a seven-day forecast for a catalog-discovered metric', async () => {
    const user = userEvent.setup();
    installBaseRoutes();

    renderWithProviders(<EnvironmentPage />, {
      route: `/sites/environment/${AUTHORIZED_SITE_ID}`,
      path: '/sites/environment/:siteId',
    });

    expect((await screen.findAllByText('Backend wave label')).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'History (max 30 days)' }));
    expect(await screen.findByText('1.1 m')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Source and provenance' })).toBeInTheDocument();
    expect(screen.getByText('Model grid:').parentElement).toHaveTextContent(
      '1.5 km resolution · cell centre 340 m from site',
    );
    expect(screen.getByText('Retrieved:')).toBeInTheDocument();

    const historyCall = requestMock.mock.calls.find(([query]) =>
      String(query).includes('query SiteEnvironmentHistory'),
    );
    expect(historyCall).toBeDefined();
    const historyInput = historyCall?.[1]?.input;
    expect(historyInput.metrics).toEqual(['WAVE_HEIGHT']);
    const historyDuration =
      new Date(historyInput.to).getTime() - new Date(historyInput.from).getTime();
    expect(historyDuration).toBe(30 * 24 * 60 * 60 * 1_000);

    await user.click(screen.getByRole('button', { name: '7-day forecast' }));
    expect(await screen.findByText('1.8 m')).toBeInTheDocument();

    const forecastCall = requestMock.mock.calls.find(([query]) =>
      String(query).includes('query SiteEnvironmentForecast'),
    );
    expect(forecastCall?.[1]?.input).toEqual({
      siteId: AUTHORIZED_SITE_ID,
      metrics: ['WAVE_HEIGHT'],
      days: 7,
    });
  });

  it('aborts superseded GraphQL requests when the operator changes site', async () => {
    const user = userEvent.setup();
    const secondSite = {
      ...AUTHORIZED_SITE,
      id: OTHER_SITE_ID,
      name: 'Nordfjord Cage B',
      code: 'NF-B',
    };
    let firstCurrentSignal: AbortSignal | undefined;

    requestMock.mockImplementation(
      async (
        query: string,
        variables?: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ) => {
        if (query.includes('query Sites(')) {
          return {
            sites: {
              items: [AUTHORIZED_SITE, secondSite],
              total: 2,
              page: 1,
              limit: 100,
            },
          };
        }
        if (query.includes('query EnvironmentLayerCatalog')) {
          return {
            environmentLayerCatalog: [layer('backend:wave', 'Backend wave label', 'READY')],
          };
        }
        if (query.includes('query SiteEnvironmentCurrent')) {
          if (variables?.siteId === AUTHORIZED_SITE_ID) {
            firstCurrentSignal = options?.signal;
            return await new Promise((_resolve, reject) => {
              options?.signal?.addEventListener(
                'abort',
                () => reject(new DOMException('Aborted', 'AbortError')),
                { once: true },
              );
            });
          }
          return {
            siteEnvironmentCurrent: {
              siteId: OTHER_SITE_ID,
              values: [{ ...CURRENT_WAVE_VALUE, value: 2.2 }],
            },
          };
        }
        throw new Error(`Unrouted GraphQL operation: ${query.slice(0, 80)}`);
      },
    );

    renderWithProviders(<EnvironmentPage />, {
      route: `/sites/environment/${AUTHORIZED_SITE_ID}`,
      path: '/sites/environment/:siteId',
    });

    const siteSelect = await screen.findByRole('combobox', { name: 'Sea-cage site' });
    await waitFor(() => expect(firstCurrentSignal).toBeDefined());
    await user.selectOptions(siteSelect, OTHER_SITE_ID);

    await waitFor(() => expect(firstCurrentSignal?.aborted).toBe(true));
    expect(await screen.findByText(/^2\.2/)).toBeInTheDocument();
    expect(siteSelect).toHaveValue(OTHER_SITE_ID);
  });

  it('loads bounded scene pages by cursor and never exposes upstream render errors', async () => {
    const user = userEvent.setup();
    const imageryLayer = layer(
      'catalog:sentinel-image',
      'Catalog natural colour',
      'PARTIAL_FAILURE',
      {
        source: 'CDSE_SENTINEL_2',
        semanticClass: 'IMAGERY',
        unit: null,
        metric: null,
        capabilities: ['IMAGERY'],
        nominalResolutionM: 10,
        resolutionLabel: '10 m',
        scientificLabel: 'Satellite imagery; not an in-water measurement.',
        coverage: {
          expected: 2,
          successful: 1,
          failed: 1,
          noData: 0,
          outOfCoverage: 0,
          scopes: [
            {
              provider: 'CDSE_SENTINEL_2',
              metric: null,
              scopeKind: 'PROVIDER_RUN',
              scopeKey: 'CDSE_SENTINEL_2:catalog',
              validFrom: '2026-07-25T10:15:00.000Z',
              validTo: '2026-07-30T10:15:00.000Z',
              outcome: 'AVAILABLE',
              errorCode: null,
              observationCount: 2,
              completedAt: '2026-07-30T11:00:00.000Z',
            },
            {
              provider: 'CDSE_SENTINEL_2',
              metric: null,
              scopeKind: 'METRIC_INTERVAL',
              scopeKey: 'CDSE_SENTINEL_2:render-gap',
              validFrom: '2026-07-20T10:15:00.000Z',
              validTo: '2026-07-20T10:15:00.000Z',
              outcome: 'PROVIDER_UNAVAILABLE',
              errorCode: 'CDSE_TIMEOUT',
              observationCount: 0,
              completedAt: '2026-07-30T11:00:00.000Z',
            },
          ],
        },
      },
    );
    const scenes = [
      {
        id: 'scene-row-1',
        sceneId: 'S2-PAGE-1',
        collection: 'sentinel-2-l2a',
        productId: 'S2-L2A',
        datasetId: 'sentinel-2-l2a',
        acquiredAt: '2026-07-30T10:15:00.000Z',
        cloudCoverPercent: 4,
        coveragePercent: 50,
        coverageStatus: 'PARTIAL',
        coverageMethod: 'TOPOLOGY_WITH_16_X_16_STRATIFIED_GRID_V3',
        coverageSampleCount: 256,
        qualityStatus: 'PROVISIONAL',
        locationRevision: 3,
        fetchedAt: '2026-07-30T11:00:00.000Z',
      },
      {
        id: 'scene-row-2',
        sceneId: 'S2-PAGE-2',
        collection: 'sentinel-2-l2a',
        productId: 'S2-L2A',
        datasetId: 'sentinel-2-l2a',
        acquiredAt: '2026-07-25T10:15:00.000Z',
        cloudCoverPercent: 8,
        coveragePercent: 100,
        coverageStatus: 'FULL',
        coverageMethod: 'TOPOLOGY_WITH_16_X_16_STRATIFIED_GRID_V3',
        coverageSampleCount: 0,
        qualityStatus: 'VALID',
        locationRevision: 3,
        fetchedAt: '2026-07-25T11:00:00.000Z',
      },
    ];

    requestMock.mockImplementation(async (query: string, variables?: Record<string, unknown>) => {
      if (query.includes('query Sites(')) {
        return {
          sites: {
            items: [AUTHORIZED_SITE],
            total: 1,
            page: 1,
            limit: 100,
          },
        };
      }
      if (query.includes('query SiteEnvironmentCurrent')) {
        return {
          siteEnvironmentCurrent: {
            siteId: AUTHORIZED_SITE_ID,
            values: [CURRENT_WAVE_VALUE],
          },
        };
      }
      if (query.includes('query EnvironmentLayerCatalog')) {
        return { environmentLayerCatalog: [imageryLayer] };
      }
      if (query.includes('query EnvironmentScenes')) {
        const input = variables?.input as { after?: string; first: number } | undefined;
        return {
          environmentScenes:
            input?.after === 'cursor-1'
              ? {
                  siteId: AUTHORIZED_SITE_ID,
                  edges: [{ cursor: 'cursor-2', node: scenes[1] }],
                  pageInfo: {
                    hasNextPage: false,
                    endCursor: 'cursor-2',
                  },
                }
              : {
                  siteId: AUTHORIZED_SITE_ID,
                  edges: [{ cursor: 'cursor-1', node: scenes[0] }],
                  pageInfo: {
                    hasNextPage: true,
                    endCursor: 'cursor-1',
                  },
                },
        };
      }
      throw new Error(`Unrouted GraphQL operation: ${query.slice(0, 80)}`);
    });
    blobRequestMock.mockRejectedValue(new Error('private upstream host and provider response'));

    renderWithProviders(<EnvironmentPage />, {
      route: `/sites/environment/${AUTHORIZED_SITE_ID}`,
      path: '/sites/environment/:siteId',
    });

    await user.click(await screen.findByRole('button', { name: 'Sentinel-2 scenes' }));
    expect(await screen.findByRole('option', { name: /25 Jul 2026/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /~50% of site AOI/ })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Sentinel scene' })).toHaveValue('S2-PAGE-2');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Sentinel scene' }), 'S2-PAGE-1');
    expect(
      await screen.findByText(/covers only part of the site monitoring AOI/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/deterministic grid estimate/i)).toBeInTheDocument();

    const sceneCalls = requestMock.mock.calls.filter(([query]) =>
      String(query).includes('query EnvironmentScenes'),
    );
    expect(sceneCalls).toHaveLength(2);
    expect(sceneCalls[0][1].input).toEqual(expect.objectContaining({ first: 100 }));
    expect(sceneCalls[0][1].input).not.toHaveProperty('after');
    expect(sceneCalls[1][1].input).toEqual(
      expect.objectContaining({ after: 'cursor-1', first: 100 }),
    );
    expect(
      await screen.findByText('The selected satellite image could not be loaded.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/private upstream host and provider response/),
    ).not.toBeInTheDocument();
  });

  it('aborts superseded scene renders and revokes the generated object URL', async () => {
    const user = userEvent.setup();
    const imageryLayer = layer('catalog:sentinel-image', 'Catalog natural colour', 'READY', {
      source: 'CDSE_SENTINEL_2',
      semanticClass: 'IMAGERY',
      unit: null,
      metric: null,
      capabilities: ['IMAGERY'],
      nominalResolutionM: 10,
      resolutionLabel: '10 m',
      scientificLabel: 'Satellite imagery; not an in-water measurement.',
    });
    const scenes = [
      {
        id: 'scene-row-1',
        sceneId: 'S2-REAL-SCENE-1',
        collection: 'sentinel-2-l2a',
        productId: 'S2-L2A',
        datasetId: 'sentinel-2-l2a',
        acquiredAt: '2026-07-30T10:15:00.000Z',
        cloudCoverPercent: 4,
        coveragePercent: 100,
        coverageStatus: 'FULL',
        coverageMethod: 'TOPOLOGY_WITH_16_X_16_STRATIFIED_GRID_V3',
        coverageSampleCount: 0,
        qualityStatus: 'VALID',
        locationRevision: 3,
        fetchedAt: '2026-07-30T11:00:00.000Z',
      },
      {
        id: 'scene-row-2',
        sceneId: 'S2-REAL-SCENE-2',
        collection: 'sentinel-2-l2a',
        productId: 'S2-L2A',
        datasetId: 'sentinel-2-l2a',
        acquiredAt: '2026-07-25T10:15:00.000Z',
        cloudCoverPercent: 8,
        coveragePercent: null,
        coverageStatus: 'UNKNOWN',
        coverageMethod: 'LEGACY_UNKNOWN',
        coverageSampleCount: null,
        qualityStatus: 'VALID',
        locationRevision: 3,
        fetchedAt: '2026-07-25T11:00:00.000Z',
      },
    ];

    installBaseRoutes([AUTHORIZED_SITE], [imageryLayer]);
    requestMock.mockImplementation(async (query: string, variables?: Record<string, unknown>) => {
      if (query.includes('query Sites(')) {
        return {
          sites: { items: [AUTHORIZED_SITE], total: 1, page: 1, limit: 100 },
        };
      }
      if (query.includes('query SiteEnvironmentCurrent')) {
        return {
          siteEnvironmentCurrent: {
            siteId: AUTHORIZED_SITE_ID,
            values: [CURRENT_WAVE_VALUE],
          },
        };
      }
      if (query.includes('query EnvironmentLayerCatalog')) {
        return { environmentLayerCatalog: [imageryLayer] };
      }
      if (query.includes('query EnvironmentScenes')) {
        return {
          environmentScenes: {
            siteId: AUTHORIZED_SITE_ID,
            edges: scenes.map((scene, index) => ({
              cursor: `cursor-${index + 1}`,
              node: scene,
            })),
            pageInfo: {
              hasNextPage: false,
              endCursor: `cursor-${scenes.length}`,
            },
          },
        };
      }
      throw new Error(
        `Unrouted GraphQL operation: ${query.slice(0, 80)} ${JSON.stringify(variables)}`,
      );
    });

    let firstSignal: AbortSignal | undefined;
    blobRequestMock
      .mockImplementationOnce(
        (_method: string, _path: string, options: { signal: AbortSignal }) =>
          new Promise<Blob>((_resolve, reject) => {
            firstSignal = options.signal;
            options.signal.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          }),
      )
      .mockResolvedValueOnce(new Blob(['second-scene'], { type: 'image/png' }));

    const createObjectUrl = vi.fn(() => 'blob:scene-2');
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectUrl,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectUrl,
    });

    const rendered = renderWithProviders(<EnvironmentPage />, {
      route: `/sites/environment/${AUTHORIZED_SITE_ID}`,
      path: '/sites/environment/:siteId',
    });

    await user.click(await screen.findByRole('button', { name: 'Sentinel-2 scenes' }));
    await waitFor(() => expect(blobRequestMock).toHaveBeenCalledTimes(1));

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Sentinel scene' }),
      'S2-REAL-SCENE-2',
    );

    expect(
      await screen.findByText(/legacy catalog row: its saved site-AOI coverage method/i),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(firstSignal?.aborted).toBe(true);
      expect(blobRequestMock).toHaveBeenCalledTimes(2);
    });
    expect(
      await screen.findByRole('img', {
        name: /Catalog natural colour, acquired/,
      }),
    ).toHaveAttribute('src', 'blob:scene-2');
    expect(screen.getByText('Coverage method: LEGACY_UNKNOWN')).toBeInTheDocument();
    expect(screen.getByText(/Coverage samples: not recorded \(legacy\)/)).toBeInTheDocument();

    expect(blobRequestMock.mock.calls[1][1]).toBe(`/marine/sites/${AUTHORIZED_SITE_ID}/render`);
    expect(blobRequestMock.mock.calls[1][2].body).toEqual({
      layerId: 'catalog:sentinel-image',
      sceneId: 'S2-REAL-SCENE-2',
      width: 1200,
      height: 675,
    });
    expect(blobRequestMock.mock.calls[1][2].timeout).toBe(ENVIRONMENT_SCENE_RENDER_TIMEOUT_MS);
    expect(blobRequestMock.mock.calls[1][2].body).not.toHaveProperty('bbox');

    rendered.unmount();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:scene-2');
  });
});
