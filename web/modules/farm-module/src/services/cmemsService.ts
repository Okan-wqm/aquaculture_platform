/**
 * Copernicus Marine Service (CMEMS) Integration
 *
 * Provides access to oceanographic model data:
 * - Dissolved Oxygen (DO)
 * - Nitrate
 * - Phosphate
 * - pH
 * - Temperature
 * - Salinity
 *
 * Browser-owned scope: display names, legend labels, and UI availability hints.
 * Dataset ids, upstream URLs, WMTS params, and point/tile requests are owned by
 * the backend marine data module.
 */

/**
 * CMEMS Layer Types
 */
export type CMEMSLayerType =
  | 'DISSOLVED_OXYGEN'
  | 'CHLOROPHYLL'
  | 'NITRATE'
  | 'PHOSPHATE'
  | 'PH'
  | 'TEMPERATURE'
  | 'SALINITY';

/**
 * CMEMS Layer Information
 */
export interface CMEMSLayerInfo {
  id: CMEMSLayerType;
  name: string;
  nameEn: string;
  icon: string;
  unit: string;
  description: string;
  colorscale: string;
  minValue: number;
  maxValue: number;
}

/**
 * CMEMS Layer Definitions for UI only. Backend marine-layer-catalog.ts owns
 * product ids, datasets, variables, and cache policy.
 */
export const CMEMS_LAYERS: CMEMSLayerInfo[] = [
  {
    id: 'DISSOLVED_OXYGEN',
    name: 'Çözünmüş Oksijen',
    nameEn: 'Dissolved Oxygen',
    icon: '💨',
    unit: 'mmol/m³',
    description: 'Suda çözünmüş oksijen konsantrasyonu',
    colorscale: 'rainbow',
    minValue: 150,
    maxValue: 350,
  },
  {
    id: 'CHLOROPHYLL',
    name: 'Klorofil (Model)',
    nameEn: 'Chlorophyll (Model)',
    icon: '🌿',
    unit: 'mg/m³',
    description: 'Model tabanlı klorofil tahmini',
    colorscale: 'rainbow',
    minValue: 0,
    maxValue: 5,
  },
  {
    id: 'NITRATE',
    name: 'Nitrat',
    nameEn: 'Nitrate',
    icon: '🧪',
    unit: 'mmol/m³',
    description: 'Nitrat konsantrasyonu (NO3)',
    colorscale: 'rainbow',
    minValue: 0,
    maxValue: 30,
  },
  {
    id: 'PHOSPHATE',
    name: 'Fosfat',
    nameEn: 'Phosphate',
    icon: '🔬',
    unit: 'mmol/m³',
    description: 'Fosfat konsantrasyonu (PO4)',
    colorscale: 'rainbow',
    minValue: 0,
    maxValue: 2,
  },
  {
    id: 'PH',
    name: 'pH',
    nameEn: 'pH',
    icon: '⚗️',
    unit: '',
    description: 'Deniz suyu pH değeri',
    colorscale: 'rainbow',
    minValue: 7.6,
    maxValue: 8.4,
  },
  {
    id: 'TEMPERATURE',
    name: 'Su Sıcaklığı',
    nameEn: 'Sea Temperature',
    icon: '🌡️',
    unit: '°C',
    description: 'Deniz yüzey sıcaklığı',
    colorscale: 'rainbow',
    minValue: -2,
    maxValue: 32,
  },
  {
    id: 'SALINITY',
    name: 'Tuzluluk',
    nameEn: 'Salinity',
    icon: '🧂',
    unit: 'PSU',
    description: 'Deniz yüzey tuzluluğu',
    colorscale: 'rainbow',
    minValue: 0,
    maxValue: 40,
  },
];

/**
 * Get CMEMS layer info by ID
 */
export function getCMEMSLayerInfo(layerId: CMEMSLayerType): CMEMSLayerInfo | undefined {
  return CMEMS_LAYERS.find((l) => l.id === layerId);
}

/**
 * Get legend information for a CMEMS layer
 */
export function getCMEMSLegend(layer: CMEMSLayerType): { color: string; label: string }[] {
  const legends: Record<CMEMSLayerType, { color: string; label: string }[]> = {
    DISSOLVED_OXYGEN: [
      { color: 'rgb(68, 1, 84)', label: '< 100 mmol/m³ (Düşük)' },
      { color: 'rgb(59, 82, 139)', label: '100-150 mmol/m³' },
      { color: 'rgb(33, 145, 140)', label: '150-200 mmol/m³' },
      { color: 'rgb(94, 201, 98)', label: '200-250 mmol/m³' },
      { color: 'rgb(253, 231, 37)', label: '> 250 mmol/m³ (Normal)' },
    ],
    CHLOROPHYLL: [
      { color: 'rgb(0, 77, 64)', label: '< 0.5 mg/m³ (Düşük)' },
      { color: 'rgb(0, 150, 136)', label: '0.5-2 mg/m³' },
      { color: 'rgb(76, 175, 80)', label: '2-5 mg/m³' },
      { color: 'rgb(255, 235, 59)', label: '5-10 mg/m³' },
      { color: 'rgb(244, 67, 54)', label: '> 10 mg/m³ (Bloom)' },
    ],
    NITRATE: [
      { color: 'rgb(49, 54, 149)', label: '< 5 mmol/m³ (Düşük)' },
      { color: 'rgb(69, 117, 180)', label: '5-15 mmol/m³' },
      { color: 'rgb(116, 173, 209)', label: '15-25 mmol/m³' },
      { color: 'rgb(244, 109, 67)', label: '25-35 mmol/m³' },
      { color: 'rgb(165, 0, 38)', label: '> 35 mmol/m³ (Yüksek)' },
    ],
    PHOSPHATE: [
      { color: 'rgb(68, 1, 84)', label: '< 0.5 mmol/m³' },
      { color: 'rgb(59, 82, 139)', label: '0.5-1 mmol/m³' },
      { color: 'rgb(33, 145, 140)', label: '1-2 mmol/m³' },
      { color: 'rgb(94, 201, 98)', label: '2-2.5 mmol/m³' },
      { color: 'rgb(253, 231, 37)', label: '> 2.5 mmol/m³' },
    ],
    PH: [
      { color: 'rgb(165, 0, 38)', label: '< 7.8 (Asidik)' },
      { color: 'rgb(244, 109, 67)', label: '7.8-8.0' },
      { color: 'rgb(255, 255, 191)', label: '8.0-8.2 (Normal)' },
      { color: 'rgb(116, 173, 209)', label: '8.2-8.4' },
      { color: 'rgb(49, 54, 149)', label: '> 8.4 (Bazik)' },
    ],
    TEMPERATURE: [
      { color: 'rgb(49, 54, 149)', label: '< 10°C (Soğuk)' },
      { color: 'rgb(69, 117, 180)', label: '10-15°C' },
      { color: 'rgb(116, 173, 209)', label: '15-20°C' },
      { color: 'rgb(254, 224, 144)', label: '20-25°C' },
      { color: 'rgb(244, 109, 67)', label: '25-30°C' },
      { color: 'rgb(165, 0, 38)', label: '> 30°C (Sıcak)' },
    ],
    SALINITY: [
      { color: 'rgb(69, 117, 180)', label: '< 33 PSU (Düşük)' },
      { color: 'rgb(116, 173, 209)', label: '33-35 PSU' },
      { color: 'rgb(171, 217, 233)', label: '35-37 PSU (Normal)' },
      { color: 'rgb(254, 224, 144)', label: '37-38 PSU' },
      { color: 'rgb(244, 109, 67)', label: '> 38 PSU (Yüksek)' },
    ],
  };

  return legends[layer] || [];
}

/**
 * Convert DO from mmol/m³ to mg/L (common unit in aquaculture)
 * 1 mmol O2 = 32 mg
 * 1 m³ = 1000 L
 * So: mmol/m³ * 32 / 1000 = mg/L
 * Simplified: mmol/m³ * 0.032 = mg/L
 */
export function convertDOToMgL(mmolPerM3: number): number {
  return mmolPerM3 * 0.032;
}

/**
 * Convert mg/L back to mmol/m³
 */
export function convertDOToMmolM3(mgPerL: number): number {
  return mgPerL / 0.032;
}

/**
 * Check if CMEMS data is likely available for a given date
 * CMEMS model data is typically available with 1-2 day delay
 */
export function isCMEMSDataAvailable(date: Date): boolean {
  const now = new Date();
  const twoDaysAgo = new Date(now);
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

  return date <= twoDaysAgo;
}

/**
 * Get the most recent date with likely available data
 */
export function getLatestCMEMSDate(): Date {
  const date = new Date();
  date.setDate(date.getDate() - 2);
  date.setHours(0, 0, 0, 0);
  return date;
}

/**
 * All available layers combining Sentinel and CMEMS
 */
export const ALL_WATER_QUALITY_LAYERS = {
  // Satellite-based (Sentinel-2)
  satellite: [
    'CHLOROPHYLL',
    'TURBIDITY',
    'TSS',
    'CDOM',
    'CYANOBACTERIA',
    'NDWI',
    'SECCHI',
  ],
  // Model-based (CMEMS)
  model: [
    'DISSOLVED_OXYGEN',
    'NITRATE',
    'PHOSPHATE',
    'PH',
    'TEMPERATURE',
    'SALINITY',
  ],
};

/**
 * Helper to determine data source for a parameter
 */
export function getDataSource(
  layer: string
): 'SENTINEL' | 'CMEMS' | 'SENSOR' | 'UNKNOWN' {
  if (ALL_WATER_QUALITY_LAYERS.satellite.includes(layer)) {
    return 'SENTINEL';
  }
  if (ALL_WATER_QUALITY_LAYERS.model.includes(layer)) {
    return 'CMEMS';
  }
  return 'UNKNOWN';
}

/**
 * Check if coordinates are within European seas coverage
 * Covers: Mediterranean, Baltic, North Sea, Norwegian Sea, Barents Sea
 * (Rough bounding box for data availability check)
 *
 * Note: Using GLOBAL products, so this is mainly for UI guidance.
 * Data is available globally over ocean areas.
 */
export function isInMediterranean(lat: number, lng: number): boolean {
  // European seas approximate bounds (expanded for global coverage)
  // Mediterranean: 30-46°N, -6°E to 36.5°E
  // Baltic Sea: 53-66°N, 10-30°E
  // North Sea: 51-62°N, -5°E to 12°E
  // Norwegian Sea: 62-75°N, -10°E to 30°E
  // Combined bounds for European aquaculture regions
  const bounds = {
    minLat: 30,   // Southern Mediterranean
    maxLat: 75,   // Northern Norway / Barents Sea
    minLng: -15,  // Atlantic coast
    maxLng: 45,   // Black Sea / Eastern Mediterranean
  };

  return (
    lat >= bounds.minLat &&
    lat <= bounds.maxLat &&
    lng >= bounds.minLng &&
    lng <= bounds.maxLng
  );
}

/**
 * Check if coordinates are within global ocean coverage
 * Returns true for any ocean location (CMEMS global products)
 */
export function isInCMEMSCoverage(lat: number, lng: number): boolean {
  // Global products cover all oceans between -80°S and 90°N
  return lat >= -80 && lat <= 90;
}
