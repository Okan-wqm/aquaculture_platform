import {
  EnvironmentLayerCapability,
  EnvironmentMetric,
  EnvironmentProvider,
} from '../../weather/entities/environment-observation.types';
import { MarineCachePolicy } from '../marine-cache.policy';
import {
  CMEMS_LAYER_CATALOG,
  ENVIRONMENT_LAYER_CATALOG,
  MARINE_LAYER_CATALOG,
  MET_LAYER_CATALOG,
  SENTINEL_LAYER_CATALOG,
} from '../marine-layer-catalog';

describe('environment layer catalog contract', () => {
  it('publishes only active providers in the GraphQL environment enum', () => {
    expect(Object.values(EnvironmentProvider)).toEqual([
      EnvironmentProvider.MET_LOCATIONFORECAST,
      EnvironmentProvider.MET_FROST,
      EnvironmentProvider.CMEMS,
      EnvironmentProvider.CDSE_SENTINEL_2,
    ]);
  });

  it('publishes one backend-owned catalog including MET, Sentinel, and CMEMS', () => {
    const ids = ENVIRONMENT_LAYER_CATALOG.map((layer) => layer.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      ...MET_LAYER_CATALOG.map((layer) => layer.id),
      ...SENTINEL_LAYER_CATALOG.map((layer) => layer.id),
      ...CMEMS_LAYER_CATALOG.map((layer) => layer.id),
    ]);
    expect(MARINE_LAYER_CATALOG).toEqual([...SENTINEL_LAYER_CATALOG, ...CMEMS_LAYER_CATALOG]);
  });

  it('owns layer capabilities as a registered finite contract', () => {
    expect(Object.values(EnvironmentLayerCapability)).toEqual([
      EnvironmentLayerCapability.IMAGERY,
      EnvironmentLayerCapability.HISTORY,
      EnvironmentLayerCapability.FORECAST,
    ]);
    for (const layer of ENVIRONMENT_LAYER_CATALOG) {
      expect(layer.capabilities.length).toBeGreaterThan(0);
      expect(
        layer.capabilities.every((capability) =>
          Object.values(EnvironmentLayerCapability).includes(capability),
        ),
      ).toBe(true);
    }
  });
  it('makes every atmosphere metric discoverable without observation data', () => {
    expect(MET_LAYER_CATALOG.map((layer) => layer.metric)).toEqual([
      EnvironmentMetric.AIR_TEMPERATURE,
      EnvironmentMetric.WIND_SPEED,
      EnvironmentMetric.WIND_DIRECTION,
      EnvironmentMetric.WIND_GUST,
      EnvironmentMetric.PRECIPITATION,
      EnvironmentMetric.CLOUD_COVER,
      EnvironmentMetric.PRESSURE_MSL,
      EnvironmentMetric.RELATIVE_HUMIDITY,
    ]);
  });

  it('lists Frost only for metrics the Frost ingestion contract actually writes', () => {
    const gust = MET_LAYER_CATALOG.find((layer) => layer.id === 'met:wind-gust')!;
    const cloud = MET_LAYER_CATALOG.find((layer) => layer.id === 'met:cloud-cover')!;
    const precipitation = MET_LAYER_CATALOG.find((layer) => layer.id === 'met:precipitation')!;
    const pressure = MET_LAYER_CATALOG.find((layer) => layer.id === 'met:pressure-msl')!;

    expect(gust.providers).toEqual([EnvironmentProvider.MET_LOCATIONFORECAST]);
    expect(cloud.providers).toEqual([EnvironmentProvider.MET_LOCATIONFORECAST]);
    expect(precipitation.providers).toEqual([
      EnvironmentProvider.MET_LOCATIONFORECAST,
      EnvironmentProvider.MET_FROST,
    ]);
    expect(pressure.providers).toEqual([
      EnvironmentProvider.MET_LOCATIONFORECAST,
    ]);
    expect(gust.description).not.toMatch(/Frost/i);
    expect(pressure.description).not.toMatch(/Frost|station/i);
    expect(precipitation.variableId).toBe(
      'next_1_hours.precipitation_amount',
    );
    expect(precipitation.scientificLabel).toMatch(/PT1H/);
  });

  it('exposes only the approved v1 satellite and CMEMS products', () => {
    expect(SENTINEL_LAYER_CATALOG.map((layer) => layer.id)).toEqual([
      'sentinel:natural-color',
      'sentinel:ndwi',
      'sentinel:chlorophyll-proxy',
      'sentinel:turbidity-proxy',
    ]);
    expect(CMEMS_LAYER_CATALOG.map((layer) => layer.id)).toEqual([
      'cmems:sea-temperature',
      'cmems:salinity',
      'cmems:dissolved-oxygen',
      'cmems:model-chlorophyll',
      'cmems:wave',
      'cmems:wave-direction',
      'cmems:wave-period',
      'cmems:current',
      'cmems:current-direction',
    ]);
    expect(ENVIRONMENT_LAYER_CATALOG.map((layer) => layer.id)).not.toEqual(
      expect.arrayContaining(['cmems:nitrate', 'cmems:phosphate', 'cmems:ph']),
    );
  });

  it('labels optical proxies as dimensionless indicators, never concentrations', () => {
    const proxyLayers = SENTINEL_LAYER_CATALOG.filter((layer) => layer.id.endsWith('-proxy'));
    for (const layer of proxyLayers) {
      expect(layer.units).toBe('1');
      expect(layer.scientificLabel).toMatch(/Dimensionless/);
      expect(layer.scientificLabel).toMatch(/not .*(concentration|diagnosis)/i);
    }
  });

  it('does not claim that natural-colour pixels are cloud-screened', () => {
    const naturalColour = SENTINEL_LAYER_CATALOG.find(
      (layer) => layer.id === 'sentinel:natural-color',
    )!;

    expect(naturalColour.description).not.toMatch(/cloud-screened/i);
    expect(naturalColour.description).toMatch(/cloud metadata/i);
    expect(naturalColour.scientificLabel).toMatch(/not pixel cloud masking/i);
  });

  it('states the CMEMS wave-from and derived current-toward direction conventions', () => {
    const wave = CMEMS_LAYER_CATALOG.find((layer) => layer.id === 'cmems:wave-direction')!;
    const current = CMEMS_LAYER_CATALOG.find((layer) => layer.id === 'cmems:current-direction')!;

    expect(wave.scientificLabel).toMatch(/waves come from/i);
    expect(wave.scientificLabel).toMatch(/clockwise from true north/i);
    expect(current.scientificLabel).toMatch(/current flows toward/i);
    expect(current.scientificLabel).toMatch(/clockwise from true north/i);
    expect(current.scientificLabel).toMatch(/transformed to local east\/north/i);
  });

  it('owns one label for every exposed environmental metric', () => {
    const catalogMetrics = ENVIRONMENT_LAYER_CATALOG.map((layer) => layer.metric).filter(
      (metric): metric is EnvironmentMetric => metric !== null,
    );

    expect(catalogMetrics.sort()).toEqual(Object.values(EnvironmentMetric).sort());
    expect(new Set(catalogMetrics).size).toBe(catalogMetrics.length);
  });

  it('does not advertise depth or point-value exploration that has no public contract', () => {
    for (const layer of ENVIRONMENT_LAYER_CATALOG) {
      expect(layer.capabilities).not.toContain('DEPTH');
      expect(layer.capabilities).not.toContain('SITE_VALUE');
      expect(layer.supportsDepth).toBe(false);
    }
  });

  it('makes the authenticated render response private no-store', () => {
    const policy = new MarineCachePolicy();

    expect(policy.headersFor('render')).toEqual({
      cacheControl: 'no-store',
      vary: ['Authorization', 'Cookie'],
    });
    expect(policy.headersFor('render', 502)).toEqual({
      cacheControl: 'no-store',
      vary: ['Authorization', 'Cookie'],
    });
  });
});
