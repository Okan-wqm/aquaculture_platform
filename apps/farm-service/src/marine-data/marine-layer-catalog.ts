export type CmemsLayerId =
  | 'cmems:dissolved_oxygen'
  | 'cmems:chlorophyll'
  | 'cmems:nitrate'
  | 'cmems:phosphate'
  | 'cmems:ph'
  | 'cmems:temperature'
  | 'cmems:salinity';

export type SentinelLayerId =
  | 'sentinel:natural-color'
  | 'sentinel:chlorophyll'
  | 'sentinel:turbidity'
  | 'sentinel:ndwi';

export type MarineLayerSource = 'sentinel' | 'cmems';
export type MarineLayerId = SentinelLayerId | CmemsLayerId;

export interface MarineLayerDefinition {
  id: MarineLayerId;
  source: MarineLayerSource;
  name: string;
  units: string;
  backendProduct: string;
  capabilityLayer: string;
  supportsDepth: boolean;
  datePolicy: 'sentinel-window' | 'cmems-latest-minus-two-days';
  minValue: number;
  maxValue: number;
}

export interface CmemsLayerDefinition {
  id: CmemsLayerId;
  name: string;
  unit: string;
  product: string;
  dataset: string;
  variable: string;
  minValue: number;
  maxValue: number;
}

export interface SentinelLayerDefinition {
  id: SentinelLayerId;
  name: string;
  unit: string;
  product: string;
  minValue: number;
  maxValue: number;
}

export const SENTINEL_LAYER_CATALOG: readonly SentinelLayerDefinition[] = [
  {
    id: 'sentinel:natural-color',
    name: 'Natural Color',
    unit: '',
    product: 'natural-color',
    minValue: 0,
    maxValue: 1,
  },
  {
    id: 'sentinel:chlorophyll',
    name: 'Chlorophyll-a',
    unit: 'mg/m3',
    product: 'chlorophyll',
    minValue: 0,
    maxValue: 200,
  },
  {
    id: 'sentinel:turbidity',
    name: 'Turbidity',
    unit: 'NTU',
    product: 'turbidity',
    minValue: 0,
    maxValue: 1000,
  },
  {
    id: 'sentinel:ndwi',
    name: 'Water Index',
    unit: 'index',
    product: 'ndwi',
    minValue: -1,
    maxValue: 1,
  },
] as const;

export const CMEMS_LAYER_CATALOG: readonly CmemsLayerDefinition[] = [
  {
    id: 'cmems:dissolved_oxygen',
    name: 'Dissolved Oxygen',
    unit: 'mmol/m3',
    product: 'GLOBAL_ANALYSISFORECAST_BGC_001_028',
    dataset: 'cmems_mod_glo_bgc-bio_anfc_0.25deg_P1D-m_202311',
    variable: 'o2',
    minValue: 150,
    maxValue: 350,
  },
  {
    id: 'cmems:chlorophyll',
    name: 'Chlorophyll (Model)',
    unit: 'mg/m3',
    product: 'GLOBAL_ANALYSISFORECAST_BGC_001_028',
    dataset: 'cmems_mod_glo_bgc-pft_anfc_0.25deg_P1D-m_202311',
    variable: 'chl',
    minValue: 0,
    maxValue: 5,
  },
  {
    id: 'cmems:nitrate',
    name: 'Nitrate',
    unit: 'mmol/m3',
    product: 'GLOBAL_ANALYSISFORECAST_BGC_001_028',
    dataset: 'cmems_mod_glo_bgc-nut_anfc_0.25deg_P1D-m_202311',
    variable: 'no3',
    minValue: 0,
    maxValue: 30,
  },
  {
    id: 'cmems:phosphate',
    name: 'Phosphate',
    unit: 'mmol/m3',
    product: 'GLOBAL_ANALYSISFORECAST_BGC_001_028',
    dataset: 'cmems_mod_glo_bgc-nut_anfc_0.25deg_P1D-m_202311',
    variable: 'po4',
    minValue: 0,
    maxValue: 2,
  },
  {
    id: 'cmems:ph',
    name: 'pH',
    unit: '',
    product: 'GLOBAL_ANALYSISFORECAST_BGC_001_028',
    dataset: 'cmems_mod_glo_bgc-car_anfc_0.25deg_P1D-m_202311',
    variable: 'ph',
    minValue: 7.6,
    maxValue: 8.4,
  },
  {
    id: 'cmems:temperature',
    name: 'Sea Temperature',
    unit: 'degC',
    product: 'GLOBAL_ANALYSISFORECAST_PHY_001_024',
    dataset: 'cmems_mod_glo_phy_anfc_0.083deg_P1D-m_202406',
    variable: 'thetao',
    minValue: -2,
    maxValue: 32,
  },
  {
    id: 'cmems:salinity',
    name: 'Salinity',
    unit: 'PSU',
    product: 'GLOBAL_ANALYSISFORECAST_PHY_001_024',
    dataset: 'cmems_mod_glo_phy_anfc_0.083deg_P1D-m_202406',
    variable: 'so',
    minValue: 0,
    maxValue: 40,
  },
] as const;

export const MARINE_LAYER_CATALOG: readonly MarineLayerDefinition[] = [
  ...SENTINEL_LAYER_CATALOG.map((layer) => ({
    id: layer.id,
    source: 'sentinel' as const,
    name: layer.name,
    units: layer.unit,
    backendProduct: layer.product,
    capabilityLayer: layer.product,
    supportsDepth: false,
    datePolicy: 'sentinel-window' as const,
    minValue: layer.minValue,
    maxValue: layer.maxValue,
  })),
  ...CMEMS_LAYER_CATALOG.map((layer) => ({
    id: layer.id,
    source: 'cmems' as const,
    name: layer.name,
    units: layer.unit,
    backendProduct: layer.product,
    capabilityLayer: `${layer.product}/${layer.dataset}/${layer.variable}`,
    supportsDepth: true,
    datePolicy: 'cmems-latest-minus-two-days' as const,
    minValue: layer.minValue,
    maxValue: layer.maxValue,
  })),
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
