import { getAccessToken, getTenantId } from '@aquaculture/shared-ui';

export type SentinelLayerId =
  | 'sentinel:natural-color'
  | 'sentinel:chlorophyll'
  | 'sentinel:turbidity'
  | 'sentinel:ndwi';

export type CmemsLayerId =
  | 'cmems:dissolved_oxygen'
  | 'cmems:chlorophyll'
  | 'cmems:nitrate'
  | 'cmems:phosphate'
  | 'cmems:ph'
  | 'cmems:temperature'
  | 'cmems:salinity';

export type MarineLayerId = SentinelLayerId | CmemsLayerId;
export type MarineLayerSource = 'sentinel' | 'cmems';
export type MapLayerType = 'osm' | 'satellite' | MarineLayerId;
export type DataSourceType = 'SENTINEL' | 'CMEMS' | 'BASE';
export type LegacySentinelLayerType =
  | 'TRUE-COLOR'
  | 'CHLOROPHYLL'
  | 'CYANOBACTERIA'
  | 'TURBIDITY'
  | 'CDOM'
  | 'TSS'
  | 'NDWI'
  | 'SECCHI'
  | 'NDVI'
  | 'MOISTURE';
export type LegacyCmemsLayerType =
  | 'DISSOLVED_OXYGEN'
  | 'CHLOROPHYLL'
  | 'NITRATE'
  | 'PHOSPHATE'
  | 'PH'
  | 'TEMPERATURE'
  | 'SALINITY';

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

export interface MarineAvailability {
  layerId: MarineLayerId;
  available: boolean;
  effectiveDate: string;
  elevation: number;
  source: MarineLayerSource;
  supportsDepth: boolean;
  fallbackApplied: boolean;
}

export interface MarinePointQueryResult {
  lat: number;
  lng: number;
  value: number | null;
  unit: string;
  variableId: MarineLayerId;
  datasetId: string;
  timestamp: string;
  quality?: 'good' | 'cloud' | 'land' | 'no_data';
}

export interface MarineLayerUiInfo {
  id: MarineLayerId;
  name: string;
  icon: string;
  category: 'base' | 'water' | 'model';
  description: string;
}

export const TILE_SIZE = 256;

const MARINE_API_BASE = '/api/marine';
const DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const SENTINEL_LAYER_IDS: readonly SentinelLayerId[] = [
  'sentinel:natural-color',
  'sentinel:chlorophyll',
  'sentinel:turbidity',
  'sentinel:ndwi',
];

const CMEMS_LAYER_IDS: readonly CmemsLayerId[] = [
  'cmems:dissolved_oxygen',
  'cmems:chlorophyll',
  'cmems:nitrate',
  'cmems:phosphate',
  'cmems:ph',
  'cmems:temperature',
  'cmems:salinity',
];

const LEGACY_SENTINEL_TO_MARINE: Record<LegacySentinelLayerType, MarineLayerId | null> = {
  'TRUE-COLOR': 'sentinel:natural-color',
  CHLOROPHYLL: 'sentinel:chlorophyll',
  CYANOBACTERIA: null,
  TURBIDITY: 'sentinel:turbidity',
  CDOM: null,
  TSS: null,
  NDWI: 'sentinel:ndwi',
  SECCHI: null,
  NDVI: null,
  MOISTURE: null,
};

const LEGACY_CMEMS_TO_MARINE: Record<LegacyCmemsLayerType, MarineLayerId> = {
  DISSOLVED_OXYGEN: 'cmems:dissolved_oxygen',
  CHLOROPHYLL: 'cmems:chlorophyll',
  NITRATE: 'cmems:nitrate',
  PHOSPHATE: 'cmems:phosphate',
  PH: 'cmems:ph',
  TEMPERATURE: 'cmems:temperature',
  SALINITY: 'cmems:salinity',
};

const MARINE_LAYER_UI: Record<MarineLayerId, MarineLayerUiInfo> = {
  'sentinel:natural-color': {
    id: 'sentinel:natural-color',
    name: 'Gercek Renk',
    icon: 'S2',
    category: 'base',
    description: 'Sentinel-2 optik dogal renk goruntusu',
  },
  'sentinel:chlorophyll': {
    id: 'sentinel:chlorophyll',
    name: 'Klorofil-a',
    icon: 'Chl',
    category: 'water',
    description: 'Sentinel-2 optik klorofil gostergesi',
  },
  'sentinel:turbidity': {
    id: 'sentinel:turbidity',
    name: 'Bulaniklik',
    icon: 'Turb',
    category: 'water',
    description: 'Sentinel-2 optik bulaniklik gostergesi',
  },
  'sentinel:ndwi': {
    id: 'sentinel:ndwi',
    name: 'Su Indeksi',
    icon: 'NDWI',
    category: 'water',
    description: 'Sentinel-2 su kutlesi gostergesi',
  },
  'cmems:dissolved_oxygen': {
    id: 'cmems:dissolved_oxygen',
    name: 'Cozunmus Oksijen',
    icon: 'O2',
    category: 'model',
    description: 'CMEMS model cozunmus oksijen',
  },
  'cmems:chlorophyll': {
    id: 'cmems:chlorophyll',
    name: 'Klorofil Model',
    icon: 'Chl',
    category: 'model',
    description: 'CMEMS model klorofil',
  },
  'cmems:nitrate': {
    id: 'cmems:nitrate',
    name: 'Nitrat',
    icon: 'NO3',
    category: 'model',
    description: 'CMEMS model nitrat',
  },
  'cmems:phosphate': {
    id: 'cmems:phosphate',
    name: 'Fosfat',
    icon: 'PO4',
    category: 'model',
    description: 'CMEMS model fosfat',
  },
  'cmems:ph': {
    id: 'cmems:ph',
    name: 'pH',
    icon: 'pH',
    category: 'model',
    description: 'CMEMS model pH',
  },
  'cmems:temperature': {
    id: 'cmems:temperature',
    name: 'Deniz Sicakligi',
    icon: 'Temp',
    category: 'model',
    description: 'CMEMS model deniz sicakligi',
  },
  'cmems:salinity': {
    id: 'cmems:salinity',
    name: 'Tuzluluk',
    icon: 'PSU',
    category: 'model',
    description: 'CMEMS model tuzluluk',
  },
};

const FALLBACK_LAYER_RANGES: Record<MarineLayerId, { min: number; max: number; units: string }> = {
  'sentinel:natural-color': { min: 0, max: 1, units: '' },
  'sentinel:chlorophyll': { min: 0, max: 200, units: 'mg/m3' },
  'sentinel:turbidity': { min: 0, max: 1000, units: 'NTU' },
  'sentinel:ndwi': { min: -1, max: 1, units: 'index' },
  'cmems:dissolved_oxygen': { min: 150, max: 350, units: 'mmol/m3' },
  'cmems:chlorophyll': { min: 0, max: 5, units: 'mg/m3' },
  'cmems:nitrate': { min: 0, max: 30, units: 'mmol/m3' },
  'cmems:phosphate': { min: 0, max: 2, units: 'mmol/m3' },
  'cmems:ph': { min: 7.6, max: 8.4, units: '' },
  'cmems:temperature': { min: -2, max: 32, units: 'degC' },
  'cmems:salinity': { min: 0, max: 40, units: 'PSU' },
};

export const BASE_LAYERS = [
  { id: 'osm', name: 'OpenStreetMap', icon: 'Map', category: 'base' as const },
  { id: 'satellite', name: 'Uydu (Esri)', icon: 'Sat', category: 'base' as const },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid marine layer field: ${field}`);
  }
  return value;
}

function readNumber(source: Record<string, unknown>, field: string): number {
  const value = source[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid marine layer field: ${field}`);
  }
  return value;
}

function readBoolean(source: Record<string, unknown>, field: string): boolean {
  const value = source[field];
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid marine layer field: ${field}`);
  }
  return value;
}

export function isSentinelLayerId(layer: string): layer is SentinelLayerId {
  return SENTINEL_LAYER_IDS.some((id) => id === layer);
}

export function isCmemsLayerId(layer: string): layer is CmemsLayerId {
  return CMEMS_LAYER_IDS.some((id) => id === layer);
}

export function isMarineLayerId(layer: string): layer is MarineLayerId {
  return isSentinelLayerId(layer) || isCmemsLayerId(layer);
}

export function toMarineLayerId(layer: string): MarineLayerId | null {
  if (isMarineLayerId(layer)) {
    return layer;
  }
  if (layer in LEGACY_SENTINEL_TO_MARINE) {
    return LEGACY_SENTINEL_TO_MARINE[layer as LegacySentinelLayerType];
  }
  if (layer in LEGACY_CMEMS_TO_MARINE) {
    return LEGACY_CMEMS_TO_MARINE[layer as LegacyCmemsLayerType];
  }
  return null;
}

export function getLayerDataSource(layer: MapLayerType): DataSourceType {
  if (isSentinelLayerId(layer)) return 'SENTINEL';
  if (isCmemsLayerId(layer)) return 'CMEMS';
  return 'BASE';
}

export function getLayerUiInfo(layer: MarineLayerId): MarineLayerUiInfo {
  return MARINE_LAYER_UI[layer];
}

export function getLayerUnit(layer: MarineLayerId, layers: readonly MarineLayerDefinition[] = []): string {
  return layers.find((entry) => entry.id === layer)?.units ?? FALLBACK_LAYER_RANGES[layer].units;
}

export function getLayerLegend(
  layer: MarineLayerId,
  layers: readonly MarineLayerDefinition[] = [],
): { color: string; label: string }[] {
  const definition = layers.find((entry) => entry.id === layer);
  const range = definition
    ? { min: definition.minValue, max: definition.maxValue, units: definition.units }
    : FALLBACK_LAYER_RANGES[layer];
  const unitSuffix = range.units ? ` ${range.units}` : '';
  const middle = range.min + (range.max - range.min) / 2;
  return [
    { color: '#2166ac', label: `${range.min}${unitSuffix}` },
    { color: '#1a9850', label: `${Number(middle.toFixed(2))}${unitSuffix}` },
    { color: '#d73027', label: `${range.max}${unitSuffix}` },
  ];
}

function formatDate(date: Date): string {
  return DATE_FORMATTER.format(date);
}

function getAuthHeaders(): HeadersInit {
  const token = getAccessToken();
  const tenantId = getTenantId();
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(tenantId ? { 'x-tenant-id': tenantId } : {}),
  };
}

async function fetchMarine(path: string, init?: RequestInit): Promise<globalThis.Response> {
  return fetch(`${MARINE_API_BASE}${path}`, {
    ...init,
    headers: {
      ...getAuthHeaders(),
      ...init?.headers,
    },
  });
}

function parseMarineLayer(value: unknown): MarineLayerDefinition {
  if (!isRecord(value)) {
    throw new Error('Invalid marine layer payload');
  }

  const id = readString(value, 'id');
  if (!isMarineLayerId(id)) {
    throw new Error(`Unsupported marine layer id: ${id}`);
  }
  const source = readString(value, 'source');
  if (source !== 'sentinel' && source !== 'cmems') {
    throw new Error(`Unsupported marine layer source: ${source}`);
  }
  const datePolicy = readString(value, 'datePolicy');
  if (datePolicy !== 'sentinel-window' && datePolicy !== 'cmems-latest-minus-two-days') {
    throw new Error(`Unsupported marine date policy: ${datePolicy}`);
  }

  return {
    id,
    source,
    name: readString(value, 'name'),
    units: readString(value, 'units'),
    backendProduct: readString(value, 'backendProduct'),
    capabilityLayer: readString(value, 'capabilityLayer'),
    supportsDepth: readBoolean(value, 'supportsDepth'),
    datePolicy,
    minValue: readNumber(value, 'minValue'),
    maxValue: readNumber(value, 'maxValue'),
  };
}

function parseMarinePoint(value: unknown): MarinePointQueryResult | null {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new Error('Invalid marine point payload');
  }
  const variableId = readString(value, 'variableId');
  if (!isMarineLayerId(variableId)) {
    throw new Error(`Unsupported marine point layer id: ${variableId}`);
  }
  const rawQuality = value.quality;
  const quality = rawQuality === 'good' || rawQuality === 'cloud' || rawQuality === 'land' || rawQuality === 'no_data'
    ? rawQuality
    : undefined;
  const rawValue = value.value;
  if (rawValue !== null && (typeof rawValue !== 'number' || !Number.isFinite(rawValue))) {
    throw new Error('Invalid marine point value');
  }
  const pointValue = rawValue === null ? null : rawValue;
  return {
    lat: readNumber(value, 'lat'),
    lng: readNumber(value, 'lng'),
    value: pointValue,
    unit: readString(value, 'unit'),
    variableId,
    datasetId: readString(value, 'datasetId'),
    timestamp: readString(value, 'timestamp'),
    ...(quality ? { quality } : {}),
  };
}

export async function fetchMarineLayers(): Promise<MarineLayerDefinition[]> {
  const response = await fetchMarine('/layers');
  if (!response.ok) {
    throw new Error(`Marine layers request failed: ${response.status}`);
  }
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error('Marine layers response is not an array');
  }
  return payload.map(parseMarineLayer);
}

export async function fetchMarineAvailability(input: {
  layerId: MarineLayerId;
  date?: Date;
  depth?: number;
}): Promise<MarineAvailability> {
  const params = new URLSearchParams();
  if (input.date) params.set('date', formatDate(input.date));
  if (input.depth !== undefined) params.set('depth', String(input.depth));
  const response = await fetchMarine(`/layers/${encodeURIComponent(input.layerId)}/availability?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Marine availability request failed: ${response.status}`);
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload)) {
    throw new Error('Invalid marine availability payload');
  }
  const source = readString(payload, 'source');
  if (source !== 'sentinel' && source !== 'cmems') {
    throw new Error(`Unsupported marine availability source: ${source}`);
  }
  return {
    layerId: input.layerId,
    available: readBoolean(payload, 'available'),
    effectiveDate: readString(payload, 'effectiveDate'),
    elevation: readNumber(payload, 'elevation'),
    source,
    supportsDepth: readBoolean(payload, 'supportsDepth'),
    fallbackApplied: readBoolean(payload, 'fallbackApplied'),
  };
}

export function buildMarineTileUrl(input: {
  layerId: MarineLayerId;
  date: Date;
  depth?: number;
}): string {
  const params = new URLSearchParams({ date: formatDate(input.date) });
  if (input.depth !== undefined) {
    params.set('depth', String(input.depth));
  }
  return `${MARINE_API_BASE}/tiles/${encodeURIComponent(input.layerId)}/{z}/{x}/{y}.png?${params.toString()}`;
}

export async function fetchMarineTileBlob(input: {
  layerId: MarineLayerId;
  z: number;
  x: number;
  y: number;
  date: Date;
  depth?: number;
}): Promise<Blob> {
  const params = new URLSearchParams({ date: formatDate(input.date) });
  if (input.depth !== undefined) {
    params.set('depth', String(input.depth));
  }
  const response = await fetchMarine(
    `/tiles/${encodeURIComponent(input.layerId)}/${input.z}/${input.x}/${input.y}.png?${params.toString()}`,
  );
  if (!response.ok) {
    throw new Error(`Marine tile request failed: ${response.status}`);
  }
  return response.blob();
}

export async function fetchMarinePointValue(input: {
  lat: number;
  lng: number;
  layerId: MarineLayerId;
  date: Date;
  depth?: number;
}): Promise<MarinePointQueryResult | null> {
  const response = await fetchMarine('/point-query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      layerId: input.layerId,
      lat: input.lat,
      lng: input.lng,
      date: formatDate(input.date),
      depth: input.depth,
    }),
  });
  if (!response.ok) {
    throw new Error(`Marine point request failed: ${response.status}`);
  }
  const payload: unknown = await response.json();
  return parseMarinePoint(payload);
}

export async function fetchMarineAoiImage(input: {
  layerId: MarineLayerId;
  bbox: readonly number[] | string;
  fromDate: Date;
  toDate: Date;
  width?: number;
  height?: number;
}): Promise<Blob> {
  const response = await fetchMarine('/aoi-analysis', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      layerId: input.layerId,
      bbox: Array.isArray(input.bbox) ? [...input.bbox] : input.bbox,
      fromDate: input.fromDate.toISOString(),
      toDate: input.toDate.toISOString(),
      width: input.width ?? 1024,
      height: input.height ?? 1024,
    }),
  });
  if (!response.ok) {
    throw new Error(`Marine AOI request failed: ${response.status}`);
  }
  return response.blob();
}
