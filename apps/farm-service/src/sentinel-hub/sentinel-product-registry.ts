export type SentinelProductKey = 'natural-color' | 'chlorophyll' | 'turbidity' | 'ndwi';
export type SentinelPointLayerId =
  | 'sentinel:natural-color'
  | 'sentinel:chlorophyll'
  | 'sentinel:turbidity'
  | 'sentinel:ndwi';

export interface SentinelProcessProductDefinition {
  collection: string;
  evalscript: string;
}

export interface SentinelPointProductDefinition {
  unit: string;
  min: number;
  max: number;
  evalscript: string;
}

export const SENTINEL_PROCESS_PRODUCTS: Record<SentinelProductKey, SentinelProcessProductDefinition> = {
  'natural-color': {
    collection: 'sentinel-2-l2a',
    evalscript: `//VERSION=3
function setup() {
  return { input: ['B04', 'B03', 'B02', 'dataMask'], output: { bands: 4 } };
}
function evaluatePixel(sample) {
  return [2.5 * sample.B04, 2.5 * sample.B03, 2.5 * sample.B02, sample.dataMask];
}`,
  },
  chlorophyll: {
    collection: 'sentinel-2-l2a',
    evalscript: `//VERSION=3
function setup() {
  return { input: ['B03', 'B05', 'dataMask'], output: { bands: 4 } };
}
function evaluatePixel(sample) {
  const index = (sample.B05 - sample.B03) / (sample.B05 + sample.B03 + 0.0001);
  return [Math.max(index, 0), Math.max(1 - index, 0), 0.2, sample.dataMask];
}`,
  },
  turbidity: {
    collection: 'sentinel-2-l2a',
    evalscript: `//VERSION=3
function setup() {
  return { input: ['B04', 'B03', 'dataMask'], output: { bands: 4 } };
}
function evaluatePixel(sample) {
  const index = sample.B04 / (sample.B03 + 0.0001);
  return [Math.min(index, 1), Math.max(1 - index, 0), 0.1, sample.dataMask];
}`,
  },
  ndwi: {
    collection: 'sentinel-2-l2a',
    evalscript: `//VERSION=3
function setup() {
  return { input: ['B03', 'B08', 'dataMask'], output: { bands: 4 } };
}
function evaluatePixel(sample) {
  const ndwi = (sample.B03 - sample.B08) / (sample.B03 + sample.B08 + 0.0001);
  return [0.1, Math.max(ndwi, 0), Math.max(1 - ndwi, 0), sample.dataMask];
}`,
  },
};

const SENTINEL_PROCESS_PRODUCT_KEYS: ReadonlySet<string> = new Set(
  Object.keys(SENTINEL_PROCESS_PRODUCTS),
);

export const SENTINEL_POINT_PRODUCTS: Record<SentinelPointLayerId, SentinelPointProductDefinition> = {
  'sentinel:natural-color': {
    unit: '',
    min: 0,
    max: 1,
    evalscript: `//VERSION=3
function setup() { return { input: ['B04', 'B03', 'B02', 'dataMask'], output: { bands: 4 } }; }
function evaluatePixel(sample) {
  if (sample.dataMask === 0) return [0, 0, 0, 0];
  const val = (sample.B04 + sample.B03 + sample.B02) / 3;
  const norm = Math.round(Math.max(0, Math.min(val, 1)) * 65535);
  return [(norm >> 8) & 255, norm & 255, 255, 255].map((x) => x / 255);
}`,
  },
  'sentinel:chlorophyll': {
    unit: 'mg/m3',
    min: 0,
    max: 200,
    evalscript: `//VERSION=3
function setup() { return { input: ['B02', 'B03', 'B04', 'B05', 'dataMask', 'CLM'], output: { bands: 4 } }; }
function evaluatePixel(sample) {
  if (sample.dataMask === 0) return [0, 0, 0, 0];
  if (sample.CLM > 0) return [0, 0, 200 / 255, 1];
  if (sample.B05 > 0.1) return [0, 0, 100 / 255, 1];
  const r = Math.log10(Math.max(sample.B02, 0.001) / Math.max(sample.B03, 0.001));
  const chl = Math.max(0, Math.min(Math.pow(10, 0.2424 - 2.7423 * r + 1.8017 * r * r), 200));
  const norm = Math.round((chl / 200) * 65535);
  return [(norm >> 8) & 255, norm & 255, 255, 255].map((x) => x / 255);
}`,
  },
  'sentinel:turbidity': {
    unit: 'NTU',
    min: 0,
    max: 1000,
    evalscript: `//VERSION=3
function setup() { return { input: ['B04', 'B08', 'dataMask', 'CLM'], output: { bands: 4 } }; }
function evaluatePixel(sample) {
  if (sample.dataMask === 0) return [0, 0, 0, 0];
  if (sample.CLM > 0) return [0, 0, 200 / 255, 1];
  if (sample.B08 > 0.15) return [0, 0, 100 / 255, 1];
  const rho = sample.B04;
  const turb = Math.max(0, Math.min((378.46 * rho) / (1 - rho / 0.1728), 1000));
  const norm = Math.round((turb / 1000) * 65535);
  return [(norm >> 8) & 255, norm & 255, 255, 255].map((x) => x / 255);
}`,
  },
  'sentinel:ndwi': {
    unit: 'index',
    min: -1,
    max: 1,
    evalscript: `//VERSION=3
function setup() { return { input: ['B03', 'B08', 'dataMask'], output: { bands: 4 } }; }
function evaluatePixel(sample) {
  if (sample.dataMask === 0) return [0, 0, 0, 0];
  const ndwi = (sample.B03 - sample.B08) / (sample.B03 + sample.B08 + 0.0001);
  const norm = Math.round(((Math.max(-1, Math.min(ndwi, 1)) + 1) / 2) * 65535);
  return [(norm >> 8) & 255, norm & 255, 255, 255].map((x) => x / 255);
}`,
  },
};

export function getSentinelProcessProduct(
  key: string | undefined,
): SentinelProcessProductDefinition | null {
  if (!key || !isSentinelProductKey(key)) {
    return null;
  }
  return SENTINEL_PROCESS_PRODUCTS[key];
}

export function getSentinelPointProduct(layerId: string): SentinelPointProductDefinition | null {
  return isSentinelPointLayerId(layerId) ? SENTINEL_POINT_PRODUCTS[layerId] : null;
}

function isSentinelProductKey(value: string): value is SentinelProductKey {
  return SENTINEL_PROCESS_PRODUCT_KEYS.has(value);
}

function isSentinelPointLayerId(value: string): value is SentinelPointLayerId {
  return Object.prototype.hasOwnProperty.call(SENTINEL_POINT_PRODUCTS, value);
}
