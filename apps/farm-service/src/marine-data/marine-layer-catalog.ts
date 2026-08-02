import {
  EnvironmentLayerCapability,
  EnvironmentMetric,
  EnvironmentProvider,
  EnvironmentQualityStatus,
  EnvironmentSemanticClass,
} from '../weather/entities/environment-observation.types';

export type SentinelLayerId =
  | 'sentinel:natural-color'
  | 'sentinel:ndwi'
  | 'sentinel:chlorophyll-proxy'
  | 'sentinel:turbidity-proxy';

export type CmemsLayerId =
  | 'cmems:sea-temperature'
  | 'cmems:salinity'
  | 'cmems:dissolved-oxygen'
  | 'cmems:model-chlorophyll'
  | 'cmems:wave'
  | 'cmems:wave-direction'
  | 'cmems:wave-period'
  | 'cmems:current'
  | 'cmems:current-direction';

export type MarineLayerId = SentinelLayerId | CmemsLayerId;
export type MetLayerId =
  | 'met:air-temperature'
  | 'met:wind-speed'
  | 'met:wind-direction'
  | 'met:wind-gust'
  | 'met:precipitation'
  | 'met:cloud-cover'
  | 'met:pressure-msl'
  | 'met:relative-humidity';
export type EnvironmentLayerId = MarineLayerId | MetLayerId;
export type MarineLayerSource = 'sentinel' | 'cmems' | 'met';
export type MarineLayerCapability = EnvironmentLayerCapability;

export interface MarineLayerDefinition {
  readonly id: EnvironmentLayerId;
  readonly source: MarineLayerSource;
  readonly provider: EnvironmentProvider;
  readonly providers: readonly EnvironmentProvider[];
  readonly name: string;
  readonly description: string;
  readonly scientificLabel: string;
  readonly semanticClass: EnvironmentSemanticClass;
  readonly units: string | null;
  readonly metric: EnvironmentMetric | null;
  readonly backendProduct: string;
  readonly datasetFamily: string;
  readonly variableId: string | null;
  readonly capabilities: readonly MarineLayerCapability[];
  readonly supportsDepth: boolean;
  readonly nominalResolutionM: number | null;
  readonly resolutionLabel: string;
  readonly minValue: number | null;
  readonly maxValue: number | null;
  readonly defaultQualityStatus: EnvironmentQualityStatus;
}
export interface SentinelLayerDefinition extends MarineLayerDefinition {
  readonly source: 'sentinel';
  readonly provider: EnvironmentProvider.CDSE_SENTINEL_2;
  readonly id: SentinelLayerId;
  readonly processProduct: 'natural-color' | 'ndwi' | 'chlorophyll' | 'turbidity';
}

export interface CmemsLayerDefinition extends MarineLayerDefinition {
  readonly source: 'cmems';
  readonly provider: EnvironmentProvider.CMEMS;
  readonly id: CmemsLayerId;
  readonly metric: EnvironmentMetric;
  readonly productFamily: 'PHY' | 'BGC' | 'WAV';
}

export interface MetLayerDefinition extends MarineLayerDefinition {
  readonly source: 'met';
  readonly provider: EnvironmentProvider.MET_LOCATIONFORECAST;
  readonly id: MetLayerId;
  readonly metric: EnvironmentMetric;
}

export const SENTINEL_LAYER_CATALOG: readonly SentinelLayerDefinition[] = [
  {
    id: 'sentinel:natural-color',
    source: 'sentinel',
    provider: EnvironmentProvider.CDSE_SENTINEL_2,
    providers: [EnvironmentProvider.CDSE_SENTINEL_2],
    name: 'Natural colour',
    description: 'Sentinel-2 L2A natural-colour imagery with catalogue cloud metadata.',
    scientificLabel:
      'Satellite imagery with scene-level cloud-quality classification; not pixel cloud masking or an in-water measurement.',
    semanticClass: EnvironmentSemanticClass.IMAGERY,
    units: null,
    metric: null,
    backendProduct: 'natural-color',
    processProduct: 'natural-color',
    datasetFamily: 'sentinel-2-l2a',
    variableId: null,
    capabilities: [EnvironmentLayerCapability.IMAGERY],
    supportsDepth: false,
    nominalResolutionM: 10,
    resolutionLabel: '10 m',
    minValue: null,
    maxValue: null,
    defaultQualityStatus: EnvironmentQualityStatus.PROVISIONAL,
  },
  {
    id: 'sentinel:ndwi',
    source: 'sentinel',
    provider: EnvironmentProvider.CDSE_SENTINEL_2,
    providers: [EnvironmentProvider.CDSE_SENTINEL_2],
    name: 'NDWI water indicator',
    description: 'Sentinel-2 green/NIR normalized-difference water indicator.',
    scientificLabel: 'Dimensionless optical indicator; not a water-quality concentration.',
    semanticClass: EnvironmentSemanticClass.INDICATOR,
    units: '1',
    metric: null,
    backendProduct: 'ndwi',
    processProduct: 'ndwi',
    datasetFamily: 'sentinel-2-l2a',
    variableId: 'NDWI',
    capabilities: [EnvironmentLayerCapability.IMAGERY],
    supportsDepth: false,
    nominalResolutionM: 10,
    resolutionLabel: '10 m',
    minValue: -1,
    maxValue: 1,
    defaultQualityStatus: EnvironmentQualityStatus.PROVISIONAL,
  },
  {
    id: 'sentinel:chlorophyll-proxy',
    source: 'sentinel',
    provider: EnvironmentProvider.CDSE_SENTINEL_2,
    providers: [EnvironmentProvider.CDSE_SENTINEL_2],
    name: 'Chlorophyll/algae optical proxy',
    description: 'Sentinel-2 red-edge/green optical response visualisation.',
    scientificLabel:
      'Dimensionless, uncalibrated proxy; not chlorophyll-a concentration or HAB diagnosis.',
    semanticClass: EnvironmentSemanticClass.INDICATOR,
    units: '1',
    metric: null,
    backendProduct: 'chlorophyll-proxy',
    processProduct: 'chlorophyll',
    datasetFamily: 'sentinel-2-l2a',
    variableId: 'S2_RE_GREEN_PROXY',
    capabilities: [EnvironmentLayerCapability.IMAGERY],
    supportsDepth: false,
    nominalResolutionM: 20,
    resolutionLabel: '20 m',
    minValue: -1,
    maxValue: 1,
    defaultQualityStatus: EnvironmentQualityStatus.PROVISIONAL,
  },
  {
    id: 'sentinel:turbidity-proxy',
    source: 'sentinel',
    provider: EnvironmentProvider.CDSE_SENTINEL_2,
    providers: [EnvironmentProvider.CDSE_SENTINEL_2],
    name: 'Turbidity optical proxy',
    description: 'Sentinel-2 red/green optical response visualisation.',
    scientificLabel:
      'Dimensionless, uncalibrated proxy; not NTU or suspended-matter concentration.',
    semanticClass: EnvironmentSemanticClass.INDICATOR,
    units: '1',
    metric: null,
    backendProduct: 'turbidity-proxy',
    processProduct: 'turbidity',
    datasetFamily: 'sentinel-2-l2a',
    variableId: 'S2_RED_GREEN_PROXY',
    capabilities: [EnvironmentLayerCapability.IMAGERY],
    supportsDepth: false,
    nominalResolutionM: 10,
    resolutionLabel: '10 m',
    minValue: 0,
    maxValue: null,
    defaultQualityStatus: EnvironmentQualityStatus.PROVISIONAL,
  },
] as const;

export const CMEMS_LAYER_CATALOG: readonly CmemsLayerDefinition[] = [
  {
    id: 'cmems:sea-temperature',
    source: 'cmems',
    provider: EnvironmentProvider.CMEMS,
    providers: [EnvironmentProvider.CMEMS],
    name: 'Sea temperature',
    description: 'Regional Copernicus Marine model temperature.',
    scientificLabel: 'Model analysis/forecast at the surface-nearest model level.',
    semanticClass: EnvironmentSemanticClass.ANALYSIS,
    units: '°C',
    metric: EnvironmentMetric.SEA_TEMPERATURE,
    backendProduct: 'regional-phy',
    productFamily: 'PHY',
    datasetFamily: 'regional:phy-temperature',
    variableId: 'thetao',
    capabilities: [EnvironmentLayerCapability.HISTORY, EnvironmentLayerCapability.FORECAST],
    supportsDepth: false,
    nominalResolutionM: null,
    resolutionLabel: 'Regional model grid; reported per value',
    minValue: -3,
    maxValue: 40,
    defaultQualityStatus: EnvironmentQualityStatus.PROVISIONAL,
  },
  {
    id: 'cmems:salinity',
    source: 'cmems',
    provider: EnvironmentProvider.CMEMS,
    providers: [EnvironmentProvider.CMEMS],
    name: 'Salinity',
    description: 'Regional Copernicus Marine model salinity.',
    scientificLabel: 'Model analysis/forecast at the surface-nearest model level.',
    semanticClass: EnvironmentSemanticClass.ANALYSIS,
    units: 'PSU',
    metric: EnvironmentMetric.SALINITY,
    backendProduct: 'regional-phy',
    productFamily: 'PHY',
    datasetFamily: 'regional:phy-salinity',
    variableId: 'so',
    capabilities: [EnvironmentLayerCapability.HISTORY, EnvironmentLayerCapability.FORECAST],
    supportsDepth: false,
    nominalResolutionM: null,
    resolutionLabel: 'Regional model grid; reported per value',
    minValue: 0,
    maxValue: 50,
    defaultQualityStatus: EnvironmentQualityStatus.PROVISIONAL,
  },
  {
    id: 'cmems:dissolved-oxygen',
    source: 'cmems',
    provider: EnvironmentProvider.CMEMS,
    providers: [EnvironmentProvider.CMEMS],
    name: 'Dissolved oxygen (model)',
    description: 'Regional Copernicus Marine biogeochemical model dissolved oxygen.',
    scientificLabel: 'Surface-nearest model estimate; not an on-site oxygen sensor measurement.',
    semanticClass: EnvironmentSemanticClass.ANALYSIS,
    units: 'mmol/m³',
    metric: EnvironmentMetric.DISSOLVED_OXYGEN,
    backendProduct: 'regional-bgc',
    productFamily: 'BGC',
    datasetFamily: 'regional:bgc-oxygen',
    variableId: 'o2',
    capabilities: [EnvironmentLayerCapability.HISTORY, EnvironmentLayerCapability.FORECAST],
    supportsDepth: false,
    nominalResolutionM: null,
    resolutionLabel: 'Regional model grid; reported per value',
    minValue: 0,
    maxValue: null,
    defaultQualityStatus: EnvironmentQualityStatus.PROVISIONAL,
  },
  {
    id: 'cmems:model-chlorophyll',
    source: 'cmems',
    provider: EnvironmentProvider.CMEMS,
    providers: [EnvironmentProvider.CMEMS],
    name: 'Chlorophyll (model)',
    description: 'Regional Copernicus Marine biogeochemical model chlorophyll.',
    scientificLabel:
      'Surface-nearest model estimate; not algal species, toxicity, or HAB diagnosis.',
    semanticClass: EnvironmentSemanticClass.ANALYSIS,
    units: 'mg/m³',
    metric: EnvironmentMetric.MODEL_CHLOROPHYLL,
    backendProduct: 'regional-bgc',
    productFamily: 'BGC',
    datasetFamily: 'regional:bgc-chlorophyll',
    variableId: 'chl',
    capabilities: [EnvironmentLayerCapability.HISTORY, EnvironmentLayerCapability.FORECAST],
    supportsDepth: false,
    nominalResolutionM: null,
    resolutionLabel: 'Regional model grid; reported per value',
    minValue: 0,
    maxValue: null,
    defaultQualityStatus: EnvironmentQualityStatus.PROVISIONAL,
  },
  {
    id: 'cmems:wave',
    source: 'cmems',
    provider: EnvironmentProvider.CMEMS,
    providers: [EnvironmentProvider.CMEMS],
    name: 'Wave conditions',
    description: 'Regional Copernicus Marine significant wave height, direction, and period.',
    scientificLabel:
      'Model analysis/forecast at the sea surface; VMDR is the mean direction waves come from, clockwise from true north.',
    semanticClass: EnvironmentSemanticClass.FORECAST,
    units: 'm',
    metric: EnvironmentMetric.WAVE_HEIGHT,
    backendProduct: 'regional-wav',
    productFamily: 'WAV',
    datasetFamily: 'regional:wave',
    variableId: 'VHM0',
    capabilities: [EnvironmentLayerCapability.HISTORY, EnvironmentLayerCapability.FORECAST],
    supportsDepth: false,
    nominalResolutionM: null,
    resolutionLabel: 'Regional model grid; reported per value',
    minValue: 0,
    maxValue: null,
    defaultQualityStatus: EnvironmentQualityStatus.PROVISIONAL,
  },
  {
    id: 'cmems:wave-direction',
    source: 'cmems',
    provider: EnvironmentProvider.CMEMS,
    providers: [EnvironmentProvider.CMEMS],
    name: 'Mean wave direction (from)',
    description: 'Regional Copernicus Marine total-spectrum mean wave direction.',
    scientificLabel: 'VMDR is the direction waves come from, clockwise from true north.',
    semanticClass: EnvironmentSemanticClass.FORECAST,
    units: '°',
    metric: EnvironmentMetric.WAVE_DIRECTION,
    backendProduct: 'regional-wav',
    productFamily: 'WAV',
    datasetFamily: 'regional:wave',
    variableId: 'VMDR',
    capabilities: [EnvironmentLayerCapability.HISTORY, EnvironmentLayerCapability.FORECAST],
    supportsDepth: false,
    nominalResolutionM: null,
    resolutionLabel: 'Regional model grid; reported per value',
    minValue: 0,
    maxValue: 360,
    defaultQualityStatus: EnvironmentQualityStatus.PROVISIONAL,
  },
  {
    id: 'cmems:wave-period',
    source: 'cmems',
    provider: EnvironmentProvider.CMEMS,
    providers: [EnvironmentProvider.CMEMS],
    name: 'Mean wave period (Tm02)',
    description: 'Regional Copernicus Marine spectral-moment mean wave period.',
    scientificLabel: 'VTM02 is the mean wave period derived from spectral moments 0 and 2.',
    semanticClass: EnvironmentSemanticClass.FORECAST,
    units: 's',
    metric: EnvironmentMetric.WAVE_PERIOD,
    backendProduct: 'regional-wav',
    productFamily: 'WAV',
    datasetFamily: 'regional:wave',
    variableId: 'VTM02',
    capabilities: [EnvironmentLayerCapability.HISTORY, EnvironmentLayerCapability.FORECAST],
    supportsDepth: false,
    nominalResolutionM: null,
    resolutionLabel: 'Regional model grid; reported per value',
    minValue: 0,
    maxValue: null,
    defaultQualityStatus: EnvironmentQualityStatus.PROVISIONAL,
  },
  {
    id: 'cmems:current',
    source: 'cmems',
    provider: EnvironmentProvider.CMEMS,
    providers: [EnvironmentProvider.CMEMS],
    name: 'Current speed',
    description: 'Regional Copernicus Marine current-speed magnitude.',
    scientificLabel:
      'Surface-nearest model speed from provider vector components; Arctic polar-grid components are transformed to local east/north for direction.',
    semanticClass: EnvironmentSemanticClass.FORECAST,
    units: 'm/s',
    metric: EnvironmentMetric.CURRENT_SPEED,
    backendProduct: 'regional-phy',
    productFamily: 'PHY',
    datasetFamily: 'regional:phy-current',
    variableId: 'uo+vo or vxo+vyo',
    capabilities: [EnvironmentLayerCapability.HISTORY, EnvironmentLayerCapability.FORECAST],
    supportsDepth: false,
    nominalResolutionM: null,
    resolutionLabel: 'Regional model grid; reported per value',
    minValue: 0,
    maxValue: null,
    defaultQualityStatus: EnvironmentQualityStatus.PROVISIONAL,
  },
  {
    id: 'cmems:current-direction',
    source: 'cmems',
    provider: EnvironmentProvider.CMEMS,
    providers: [EnvironmentProvider.CMEMS],
    name: 'Current direction (toward)',
    description: 'Regional Copernicus Marine current flow direction.',
    scientificLabel:
      'Direction the current flows toward, clockwise from true north; Arctic polar-grid components are transformed to local east/north first.',
    semanticClass: EnvironmentSemanticClass.FORECAST,
    units: '°',
    metric: EnvironmentMetric.CURRENT_DIRECTION,
    backendProduct: 'regional-phy',
    productFamily: 'PHY',
    datasetFamily: 'regional:phy-current',
    variableId: 'uo+vo or vxo+vyo',
    capabilities: [EnvironmentLayerCapability.HISTORY, EnvironmentLayerCapability.FORECAST],
    supportsDepth: false,
    nominalResolutionM: null,
    resolutionLabel: 'Regional model grid; reported per value',
    minValue: 0,
    maxValue: 360,
    defaultQualityStatus: EnvironmentQualityStatus.PROVISIONAL,
  },
] as const;

const MET_FORECAST_AND_FROST_PROVIDERS = [
  EnvironmentProvider.MET_LOCATIONFORECAST,
  EnvironmentProvider.MET_FROST,
] as const;
const MET_FORECAST_PROVIDERS = [EnvironmentProvider.MET_LOCATIONFORECAST] as const;

export const MET_LAYER_CATALOG: readonly MetLayerDefinition[] = [
  {
    id: 'met:air-temperature',
    source: 'met',
    provider: EnvironmentProvider.MET_LOCATIONFORECAST,
    providers: MET_FORECAST_AND_FROST_PROVIDERS,
    name: 'Air temperature',
    description: 'MET Norway forecast and nearby Frost station observation.',
    scientificLabel: 'Atmospheric model forecast or station observation as reported per value.',
    semanticClass: EnvironmentSemanticClass.FORECAST,
    units: '°C',
    metric: EnvironmentMetric.AIR_TEMPERATURE,
    backendProduct: 'met-atmosphere',
    datasetFamily: 'met:locationforecast,frost',
    variableId: 'air_temperature',
    capabilities: [EnvironmentLayerCapability.HISTORY, EnvironmentLayerCapability.FORECAST],
    supportsDepth: false,
    nominalResolutionM: null,
    resolutionLabel: 'Provider grid/station distance reported per value',
    minValue: null,
    maxValue: null,
    defaultQualityStatus: EnvironmentQualityStatus.PROVISIONAL,
  },
  {
    id: 'met:wind-speed',
    source: 'met',
    provider: EnvironmentProvider.MET_LOCATIONFORECAST,
    providers: MET_FORECAST_AND_FROST_PROVIDERS,
    name: 'Wind speed',
    description: 'MET Norway wind-speed forecast and Frost observation.',
    scientificLabel: 'Wind speed; direction is reported separately.',
    semanticClass: EnvironmentSemanticClass.FORECAST,
    units: 'm/s',
    metric: EnvironmentMetric.WIND_SPEED,
    backendProduct: 'met-atmosphere',
    datasetFamily: 'met:locationforecast,frost',
    variableId: 'wind_speed',
    capabilities: [EnvironmentLayerCapability.HISTORY, EnvironmentLayerCapability.FORECAST],
    supportsDepth: false,
    nominalResolutionM: null,
    resolutionLabel: 'Provider grid/station distance reported per value',
    minValue: 0,
    maxValue: null,
    defaultQualityStatus: EnvironmentQualityStatus.PROVISIONAL,
  },
  {
    id: 'met:wind-direction',
    source: 'met',
    provider: EnvironmentProvider.MET_LOCATIONFORECAST,
    providers: MET_FORECAST_AND_FROST_PROVIDERS,
    name: 'Wind direction',
    description: 'MET Norway wind-from direction forecast and Frost observation.',
    scientificLabel: 'Meteorological direction from which the wind blows.',
    semanticClass: EnvironmentSemanticClass.FORECAST,
    units: '°',
    metric: EnvironmentMetric.WIND_DIRECTION,
    backendProduct: 'met-atmosphere',
    datasetFamily: 'met:locationforecast,frost',
    variableId: 'wind_from_direction',
    capabilities: [EnvironmentLayerCapability.HISTORY, EnvironmentLayerCapability.FORECAST],
    supportsDepth: false,
    nominalResolutionM: null,
    resolutionLabel: 'Provider grid/station distance reported per value',
    minValue: 0,
    maxValue: 360,
    defaultQualityStatus: EnvironmentQualityStatus.PROVISIONAL,
  },
  {
    id: 'met:wind-gust',
    source: 'met',
    provider: EnvironmentProvider.MET_LOCATIONFORECAST,
    providers: MET_FORECAST_PROVIDERS,
    name: 'Wind gust',
    description: 'MET Norway wind-gust forecast.',
    scientificLabel: 'Maximum gust speed over the provider reporting interval.',
    semanticClass: EnvironmentSemanticClass.FORECAST,
    units: 'm/s',
    metric: EnvironmentMetric.WIND_GUST,
    backendProduct: 'met-atmosphere',
    datasetFamily: 'met:locationforecast',
    variableId: 'wind_speed_of_gust',
    capabilities: [EnvironmentLayerCapability.HISTORY, EnvironmentLayerCapability.FORECAST],
    supportsDepth: false,
    nominalResolutionM: null,
    resolutionLabel: 'Provider grid/station distance reported per value',
    minValue: 0,
    maxValue: null,
    defaultQualityStatus: EnvironmentQualityStatus.PROVISIONAL,
  },
  {
    id: 'met:precipitation',
    source: 'met',
    provider: EnvironmentProvider.MET_LOCATIONFORECAST,
    providers: MET_FORECAST_AND_FROST_PROVIDERS,
    name: 'Hourly precipitation',
    description: 'MET Norway one-hour precipitation accumulation.',
    scientificLabel:
      'PT1H accumulation; six-hour forecast totals are intentionally excluded and this is not an instantaneous rate.',
    semanticClass: EnvironmentSemanticClass.FORECAST,
    units: 'mm',
    metric: EnvironmentMetric.PRECIPITATION,
    backendProduct: 'met-atmosphere',
    datasetFamily: 'met:locationforecast,frost',
    variableId: 'next_1_hours.precipitation_amount',
    capabilities: [EnvironmentLayerCapability.HISTORY, EnvironmentLayerCapability.FORECAST],
    supportsDepth: false,
    nominalResolutionM: null,
    resolutionLabel: 'Provider grid/station distance reported per value',
    minValue: 0,
    maxValue: null,
    defaultQualityStatus: EnvironmentQualityStatus.PROVISIONAL,
  },
  {
    id: 'met:cloud-cover',
    source: 'met',
    provider: EnvironmentProvider.MET_LOCATIONFORECAST,
    providers: MET_FORECAST_PROVIDERS,
    name: 'Cloud cover',
    description: 'MET Norway total cloud-area fraction.',
    scientificLabel: 'Atmospheric model estimate.',
    semanticClass: EnvironmentSemanticClass.FORECAST,
    units: '%',
    metric: EnvironmentMetric.CLOUD_COVER,
    backendProduct: 'met-atmosphere',
    datasetFamily: 'met:locationforecast',
    variableId: 'cloud_area_fraction',
    capabilities: [EnvironmentLayerCapability.HISTORY, EnvironmentLayerCapability.FORECAST],
    supportsDepth: false,
    nominalResolutionM: null,
    resolutionLabel: 'Provider grid reported per value',
    minValue: 0,
    maxValue: 100,
    defaultQualityStatus: EnvironmentQualityStatus.PROVISIONAL,
  },
  {
    id: 'met:pressure-msl',
    source: 'met',
    provider: EnvironmentProvider.MET_LOCATIONFORECAST,
    providers: MET_FORECAST_PROVIDERS,
    name: 'Sea-level pressure',
    description: 'MET Norway air pressure reduced to mean sea level.',
    scientificLabel: 'Atmospheric model pressure reduced to mean sea level.',
    semanticClass: EnvironmentSemanticClass.FORECAST,
    units: 'hPa',
    metric: EnvironmentMetric.PRESSURE_MSL,
    backendProduct: 'met-atmosphere',
    datasetFamily: 'met:locationforecast',
    variableId: 'air_pressure_at_sea_level',
    capabilities: [EnvironmentLayerCapability.HISTORY, EnvironmentLayerCapability.FORECAST],
    supportsDepth: false,
    nominalResolutionM: null,
    resolutionLabel: 'Provider grid reported per value',
    minValue: null,
    maxValue: null,
    defaultQualityStatus: EnvironmentQualityStatus.PROVISIONAL,
  },
  {
    id: 'met:relative-humidity',
    source: 'met',
    provider: EnvironmentProvider.MET_LOCATIONFORECAST,
    providers: MET_FORECAST_AND_FROST_PROVIDERS,
    name: 'Relative humidity',
    description: 'MET Norway relative humidity forecast and Frost observation.',
    scientificLabel: 'Relative atmospheric humidity.',
    semanticClass: EnvironmentSemanticClass.FORECAST,
    units: '%',
    metric: EnvironmentMetric.RELATIVE_HUMIDITY,
    backendProduct: 'met-atmosphere',
    datasetFamily: 'met:locationforecast,frost',
    variableId: 'relative_humidity',
    capabilities: [EnvironmentLayerCapability.HISTORY, EnvironmentLayerCapability.FORECAST],
    supportsDepth: false,
    nominalResolutionM: null,
    resolutionLabel: 'Provider grid/station distance reported per value',
    minValue: 0,
    maxValue: 100,
    defaultQualityStatus: EnvironmentQualityStatus.PROVISIONAL,
  },
] as const;

export const MARINE_LAYER_CATALOG: readonly MarineLayerDefinition[] = [
  ...SENTINEL_LAYER_CATALOG,
  ...CMEMS_LAYER_CATALOG,
] as const;

export const ENVIRONMENT_LAYER_CATALOG: readonly MarineLayerDefinition[] = [
  ...MET_LAYER_CATALOG,
  ...MARINE_LAYER_CATALOG,
] as const;

export function findMarineLayer(layerId: string): MarineLayerDefinition | undefined {
  return MARINE_LAYER_CATALOG.find((layer) => layer.id === layerId);
}

export function findCmemsLayer(layerId: string): CmemsLayerDefinition | undefined {
  return CMEMS_LAYER_CATALOG.find((layer) => layer.id === layerId);
}

export function findSentinelLayer(layerId: string): SentinelLayerDefinition | undefined {
  return SENTINEL_LAYER_CATALOG.find((layer) => layer.id === layerId);
}
