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
 * Data source: CMEMS (Copernicus Marine Environment Monitoring Service)
 * API: WMS/WMTS
 *
 * Datasets used:
 * - GLOBAL_ANALYSISFORECAST_BGC_001_028: Bio-geochemical (DO, Chl, NO3, PO4, pH)
 * - GLOBAL_ANALYSISFORECAST_PHY_001_024: Physical (Temperature, Salinity)
 *
 * Resolution: ~25km (1/4 degree)
 * Update frequency: Daily
 */

// CMEMS WMTS Base URL - Marine Data Store endpoint (public access)
// Note: CMEMS uses WMTS protocol (not WMS) for tile serving
const CMEMS_WMTS_BASE_URL = 'https://wmts.marine.copernicus.eu/teroWmts';

// Product IDs - Using GLOBAL products for worldwide coverage
// Global products cover all seas including Mediterranean, Baltic, North Sea, Norwegian Sea
const CMEMS_GLOBAL_BGC_PRODUCT = 'GLOBAL_ANALYSISFORECAST_BGC_001_028';
const CMEMS_GLOBAL_PHY_PRODUCT = 'GLOBAL_ANALYSISFORECAST_PHY_001_024';

// Legacy Mediterranean-only products (kept for reference)
const CMEMS_MED_BGC_PRODUCT = 'MEDSEA_ANALYSISFORECAST_BGC_006_014';
const CMEMS_MED_PHY_PRODUCT = 'MEDSEA_ANALYSISFORECAST_PHY_006_013';

// Tile size
export const CMEMS_TILE_SIZE = 256;

// Export WMTS base URL for components
export const CMEMS_WMTS_URL = CMEMS_WMTS_BASE_URL;

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
  product: string;   // Product ID (e.g., MEDSEA_ANALYSISFORECAST_BGC_006_014)
  dataset: string;   // Dataset ID including version (e.g., cmems_mod_med_bgc-nut_anfc_4.2km_P1D-m_202511)
  variable: string;  // Variable name (e.g., no3)
  colorscale: string;
  minValue: number;
  maxValue: number;
}

/**
 * CMEMS Layer Definitions
 * Based on CMEMS Marine Data Store catalog
 *
 * Mediterranean Sea uses MEDSEA_ANALYSISFORECAST datasets (~4.2km resolution)
 * These datasets are accessible via WMTS without authentication
 *
 * WMTS URL format:
 * https://wmts.marine.copernicus.eu/teroWmts?SERVICE=WMTS&REQUEST=GetTile
 *   &LAYER={product}/{dataset}/{variable}
 *   &TILEMATRIXSET=EPSG:3857&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}
 *   &FORMAT=image/png&TIME={date}&ELEVATION={depth}
 */
export const CMEMS_LAYERS: CMEMSLayerInfo[] = [
  {
    id: 'DISSOLVED_OXYGEN',
    name: 'Çözünmüş Oksijen',
    nameEn: 'Dissolved Oxygen',
    icon: '💨',
    unit: 'mmol/m³',
    description: 'Suda çözünmüş oksijen konsantrasyonu',
    product: 'GLOBAL_ANALYSISFORECAST_BGC_001_028',
    dataset: 'cmems_mod_glo_bgc-bio_anfc_0.25deg_P1D-m_202311',
    variable: 'o2',
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
    product: 'GLOBAL_ANALYSISFORECAST_BGC_001_028',
    dataset: 'cmems_mod_glo_bgc-pft_anfc_0.25deg_P1D-m_202311',
    variable: 'chl',
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
    product: 'GLOBAL_ANALYSISFORECAST_BGC_001_028',
    dataset: 'cmems_mod_glo_bgc-nut_anfc_0.25deg_P1D-m_202311',
    variable: 'no3',
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
    product: 'GLOBAL_ANALYSISFORECAST_BGC_001_028',
    dataset: 'cmems_mod_glo_bgc-nut_anfc_0.25deg_P1D-m_202311',
    variable: 'po4',
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
    product: 'GLOBAL_ANALYSISFORECAST_BGC_001_028',
    dataset: 'cmems_mod_glo_bgc-car_anfc_0.25deg_P1D-m_202311',
    variable: 'ph',
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
    product: 'GLOBAL_ANALYSISFORECAST_PHY_001_024',
    dataset: 'cmems_mod_glo_phy_anfc_0.083deg_P1D-m_202406',
    variable: 'thetao',
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
    product: 'GLOBAL_ANALYSISFORECAST_PHY_001_024',
    dataset: 'cmems_mod_glo_phy_anfc_0.083deg_P1D-m_202406',
    variable: 'so',
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
 * Generate CMEMS WMTS tile URL template for Leaflet TileLayer
 *
 * @param layer - CMEMS layer type
 * @param date - Date for data
 * @param depth - Depth level in meters (default: 0 = surface)
 * @returns URL template for Leaflet TileLayer with {z}/{x}/{y} placeholders
 */
export function getCMEMSWMTSTileUrl(
  layer: CMEMSLayerType,
  date: Date,
  depth: number = 0
): string | null {
  const layerInfo = getCMEMSLayerInfo(layer);
  if (!layerInfo) return null;

  // Format date as YYYY-MM-DD
  const dateStr = date.toISOString().split('T')[0];

  // WMTS layer name format: product/dataset/variable
  const wmtsLayer = `${layerInfo.product}/${layerInfo.dataset}/${layerInfo.variable}`;

  // Build WMTS URL template
  // Note: {z}, {x}, {y} are Leaflet placeholders
  const params = new URLSearchParams({
    SERVICE: 'WMTS',
    REQUEST: 'GetTile',
    VERSION: '1.0.0',
    LAYER: wmtsLayer,
    TILEMATRIXSET: 'EPSG:3857',
    FORMAT: 'image/png',
    TIME: dateStr,
    ELEVATION: String(depth),
  });

  // Return URL with tile coordinate placeholders
  return `${CMEMS_WMTS_BASE_URL}?${params.toString()}&TILEMATRIX={z}&TILECOL={x}&TILEROW={y}`;
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

// ============================================================================
// POINT QUERY FUNCTIONS
// ============================================================================

/**
 * CMEMS Point Query Result
 */
export interface CMEMSPointQueryResult {
  lat: number;
  lng: number;
  value: number | null;
  unit: string;
  variableId: string;
  datasetId: string;
  timestamp?: string;
}

/**
 * Convert latitude/longitude to Web Mercator (EPSG:3857) coordinates
 */
function latLngToWebMercator(lat: number, lng: number): { x: number; y: number } {
  const x = lng * 20037508.34 / 180;
  const y = Math.log(Math.tan((90 + lat) * Math.PI / 360)) / (Math.PI / 180);
  return {
    x,
    y: y * 20037508.34 / 180,
  };
}

/**
 * Calculate WMTS tile coordinates for a given lat/lng at a zoom level
 * Uses EPSG:3857 (Web Mercator) tile matrix
 */
function calculateTileCoords(
  lat: number,
  lng: number,
  zoom: number
): { tileCol: number; tileRow: number; pixelI: number; pixelJ: number } {
  const n = Math.pow(2, zoom);
  const tileSize = CMEMS_TILE_SIZE;

  // Convert to tile coordinates
  const x = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;

  const tileCol = Math.floor(x);
  const tileRow = Math.floor(y);

  // Calculate pixel position within tile
  const pixelI = Math.floor((x - tileCol) * tileSize);
  const pixelJ = Math.floor((y - tileRow) * tileSize);

  return { tileCol, tileRow, pixelI, pixelJ };
}

/**
 * Get point value from CMEMS WMTS GetFeatureInfo
 *
 * @param lat - Latitude (WGS84)
 * @param lng - Longitude (WGS84)
 * @param layer - CMEMS layer type
 * @param date - Optional date (defaults to latest available)
 * @param zoom - Tile zoom level (default: 8 for ~4km resolution)
 * @returns Point query result or null if request fails
 */
export async function getCMEMSPointValue(
  lat: number,
  lng: number,
  layer: CMEMSLayerType,
  date?: Date,
  zoom: number = 8
): Promise<CMEMSPointQueryResult | null> {
  const layerInfo = getCMEMSLayerInfo(layer);
  if (!layerInfo) {
    console.error(`Unknown CMEMS layer: ${layer}`);
    return null;
  }

  // Calculate tile coordinates
  const { tileCol, tileRow, pixelI, pixelJ } = calculateTileCoords(lat, lng, zoom);

  // Build WMTS GetFeatureInfo URL
  // Layer format: product/dataset/variable
  const wmtsLayer = `${layerInfo.product}/${layerInfo.dataset}/${layerInfo.variable}`;
  const params = new URLSearchParams({
    SERVICE: 'WMTS',
    REQUEST: 'GetFeatureInfo',
    VERSION: '1.0.0',
    LAYER: wmtsLayer,
    TILEMATRIXSET: 'EPSG:3857',
    TILEMATRIX: String(zoom),
    TILEROW: String(tileRow),
    TILECOL: String(tileCol),
    I: String(pixelI),
    J: String(pixelJ),
    INFOFORMAT: 'application/json',
  });

  // Add time parameter if provided
  if (date) {
    params.append('TIME', date.toISOString().split('T')[0]);
  }

  const url = `${CMEMS_WMTS_BASE_URL}?${params.toString()}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      console.error(`CMEMS GetFeatureInfo failed: ${response.status}`);
      return null;
    }

    const data = await response.json();

    // Parse GeoJSON FeatureCollection response
    if (data.type === 'FeatureCollection' && data.features?.length > 0) {
      const feature = data.features[0];
      const props = feature.properties;

      return {
        lat: props.lat ?? lat,
        lng: props.lon ?? lng,
        value: props.value,
        unit: props.units ?? layerInfo.unit,
        variableId: props.variableId ?? layerInfo.variable,
        datasetId: props.datasetId ?? layerInfo.dataset,
        timestamp: date?.toISOString(),
      };
    }

    return null;
  } catch (error) {
    console.error('CMEMS GetFeatureInfo error:', error);
    return null;
  }
}

/**
 * Get multiple CMEMS parameters for a single point
 *
 * @param lat - Latitude (WGS84)
 * @param lng - Longitude (WGS84)
 * @param layers - Array of CMEMS layer types to query
 * @param date - Optional date (defaults to latest available)
 * @returns Map of layer type to query result
 */
export async function getCMEMSMultiPointValue(
  lat: number,
  lng: number,
  layers: CMEMSLayerType[],
  date?: Date
): Promise<Map<CMEMSLayerType, CMEMSPointQueryResult | null>> {
  const results = new Map<CMEMSLayerType, CMEMSPointQueryResult | null>();

  // Query all layers in parallel
  const promises = layers.map(async (layer) => {
    const result = await getCMEMSPointValue(lat, lng, layer, date);
    results.set(layer, result);
  });

  await Promise.all(promises);

  return results;
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
