export type SentinelProductKey = 'natural-color' | 'chlorophyll' | 'turbidity' | 'ndwi';

export interface SentinelProcessProductDefinition {
  collection: string;
  evalscript: string;
}

export const SENTINEL_PROCESS_PRODUCTS: Record<
  SentinelProductKey,
  SentinelProcessProductDefinition
> = {
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

export function getSentinelProcessProduct(
  key: string | undefined,
): SentinelProcessProductDefinition | null {
  if (!key || !isSentinelProductKey(key)) {
    return null;
  }
  return SENTINEL_PROCESS_PRODUCTS[key];
}

function isSentinelProductKey(value: string): value is SentinelProductKey {
  return SENTINEL_PROCESS_PRODUCT_KEYS.has(value);
}
