/**
 * Point Query Service
 *
 * Unified service for querying water quality data at a specific point.
 * Routes queries to the appropriate data source (Sentinel or CMEMS)
 * based on the selected layer type.
 *
 * Data Source Mapping:
 * - Sentinel-2 (optical): CHLOROPHYLL, TURBIDITY, TSS, CDOM, CYANOBACTERIA, SECCHI, NDWI
 * - CMEMS (model): DISSOLVED_OXYGEN, NITRATE, PHOSPHATE, PH, TEMPERATURE, SALINITY
 */

import { LayerType } from './sentinelHubService';
import {
  CMEMSLayerType,} from './cmemsService';
import {
  fetchMarinePointValue,
  toMarineLayerId,
} from './marineDataService';

/**
 * Combined layer type (Sentinel + CMEMS)
 */
export type WaterQualityLayerType = LayerType | CMEMSLayerType;

/**
 * Data source types
 */
export type DataSourceType = 'SENTINEL' | 'CMEMS' | 'UNKNOWN';

/**
 * Point query result interface
 */
export interface PointQueryResult {
  /** Query coordinates */
  lat: number;
  lng: number;
  /** Query timestamp */
  queryTime: Date;
  /** Layer queried */
  layer: WaterQualityLayerType;
  /** Data source used */
  dataSource: DataSourceType;
  /** Retrieved value (null if no data) */
  value: number | null;
  /** Value unit */
  unit: string;
  /** Human-readable layer name */
  layerName: string;
  /** Layer icon */
  layerIcon: string;
  /** Data quality indicator */
  quality: 'good' | 'uncertain' | 'cloud' | 'land' | 'no_data';
  /** Quality description */
  qualityDescription: string;
  /** Data resolution (approximate) */
  resolution: string;
  /** Original data timestamp (if available) */
  dataTimestamp?: string;
  /** Error message (if any) */
  error?: string;
}

/**
 * Sentinel layer info for display
 */
const SENTINEL_LAYER_INFO: Record<LayerType, { name: string; icon: string; unit: string }> = {
  'TRUE-COLOR': { name: 'Gerçek Renk', icon: '🛰️', unit: '' },
  'CHLOROPHYLL': { name: 'Klorofil-a', icon: '🌿', unit: 'mg/m³' },
  'CYANOBACTERIA': { name: 'Siyanobakteri', icon: '🦠', unit: 'cells/mL' },
  'TURBIDITY': { name: 'Bulanıklık', icon: '🌫️', unit: 'NTU' },
  'CDOM': { name: 'CDOM', icon: '🟤', unit: 'index' },
  'TSS': { name: 'Askıda Katı', icon: '🔶', unit: 'mg/L' },
  'NDWI': { name: 'Su İndeksi', icon: '💧', unit: 'index' },
  'SECCHI': { name: 'Secchi Derinliği', icon: '👁️', unit: 'm' },
  'NDVI': { name: 'Bitki İndeksi', icon: '🌱', unit: 'index' },
  'MOISTURE': { name: 'Nem İndeksi', icon: '💦', unit: 'index' },
};

/**
 * CMEMS layer info for display
 */
const CMEMS_LAYER_INFO: Record<CMEMSLayerType, { name: string; icon: string; unit: string }> = {
  'DISSOLVED_OXYGEN': { name: 'Çözünmüş Oksijen', icon: '💨', unit: 'mmol/m³' },
  'CHLOROPHYLL': { name: 'Klorofil (Model)', icon: '🌿', unit: 'mg/m³' },
  'NITRATE': { name: 'Nitrat', icon: '🧪', unit: 'mmol/m³' },
  'PHOSPHATE': { name: 'Fosfat', icon: '🔬', unit: 'mmol/m³' },
  'PH': { name: 'pH', icon: '⚗️', unit: '' },
  'TEMPERATURE': { name: 'Su Sıcaklığı', icon: '🌡️', unit: '°C' },
  'SALINITY': { name: 'Tuzluluk', icon: '🧂', unit: 'PSU' },
};

/**
 * Get layer display info
 */
export function getLayerDisplayInfo(layer: WaterQualityLayerType): { name: string; icon: string; unit: string } {
  if (layer in SENTINEL_LAYER_INFO) {
    return SENTINEL_LAYER_INFO[layer as LayerType];
  }
  if (layer in CMEMS_LAYER_INFO) {
    return CMEMS_LAYER_INFO[layer as CMEMSLayerType];
  }
  return { name: layer, icon: '📊', unit: '' };
}

/**
 * Determine data source for a layer
 */
export function getLayerDataSource(layer: WaterQualityLayerType): DataSourceType {
  // CMEMS layers
  const cmemsLayers: CMEMSLayerType[] = [
    'DISSOLVED_OXYGEN',
    'NITRATE',
    'PHOSPHATE',
    'PH',
    'TEMPERATURE',
    'SALINITY',
  ];

  if (cmemsLayers.includes(layer as CMEMSLayerType)) {
    return 'CMEMS';
  }

  // Sentinel layers (water quality)
  const sentinelLayers: LayerType[] = [
    'TRUE-COLOR',
    'CHLOROPHYLL',
    'CYANOBACTERIA',
    'TURBIDITY',
    'CDOM',
    'TSS',
    'NDWI',
    'SECCHI',
    'NDVI',
    'MOISTURE',
  ];

  if (sentinelLayers.includes(layer as LayerType)) {
    return 'SENTINEL';
  }

  // CHLOROPHYLL exists in both - prefer Sentinel for optical
  if (layer === 'CHLOROPHYLL') {
    return 'SENTINEL';
  }

  return 'UNKNOWN';
}

/**
 * Get quality description in Turkish
 */
function getQualityDescription(
  quality: 'good' | 'uncertain' | 'cloud' | 'land' | 'no_data',
  dataSource: DataSourceType
): string {
  const descriptions = {
    good: dataSource === 'SENTINEL'
      ? 'Uydu verisi mevcut ve kaliteli'
      : 'Model verisi mevcut',
    uncertain: 'Veri mevcut ancak doğrulama önerilir',
    cloud: 'Bulut nedeniyle uydu görüntüsü alınamadı',
    land: 'Bu nokta kara üzerinde',
    no_data: 'Bu tarih/konum için veri mevcut değil',
  };

  return descriptions[quality];
}

/**
 * Get resolution description
 */
function getResolutionDescription(dataSource: DataSourceType): string {
  return dataSource === 'SENTINEL'
    ? '~10m (Sentinel-2 optik uydu)'
    : '~4km (CMEMS okyanografik model)';
}

/**
 * Query point data from appropriate data source
 *
 * @param lat - Latitude (WGS84)
 * @param lng - Longitude (WGS84)
 * @param layer - Layer type to query
 * @param date - Date for data (defaults to today for CMEMS, last 30 days for Sentinel)
 * @returns Point query result
 */
export async function queryPointData(
  lat: number,
  lng: number,
  layer: WaterQualityLayerType,
  date: Date = new Date()
): Promise<PointQueryResult> {
  const queryTime = new Date();
  const dataSource = getLayerDataSource(layer);
  const layerInfo = getLayerDisplayInfo(layer);

  // Base result template
  const baseResult: PointQueryResult = {
    lat,
    lng,
    queryTime,
    layer,
    dataSource,
    value: null,
    unit: layerInfo.unit,
    layerName: layerInfo.name,
    layerIcon: layerInfo.icon,
    quality: 'no_data',
    qualityDescription: '',
    resolution: getResolutionDescription(dataSource),
  };

  try {
    // Route to appropriate data source
    if (dataSource === 'CMEMS') {
      const marineLayerId = toMarineLayerId(layer);
      if (!marineLayerId) {
        return {
          ...baseResult,
          quality: 'no_data',
          qualityDescription: 'Bu katman marine veri sözleşmesinde desteklenmiyor',
          error: 'Desteklenmeyen katman',
        };
      }
      const result = await fetchMarinePointValue({
        lat,
        lng,
        layerId: marineLayerId,
        date,
      });

      if (!result) {
        return {
          ...baseResult,
          quality: 'no_data',
          qualityDescription: 'CMEMS sunucusundan veri alınamadı',
          error: 'Veri alınamadı',
        };
      }

      return {
        ...baseResult,
        value: result.value,
        unit: result.unit || layerInfo.unit,
        quality: result.value !== null ? 'good' : 'no_data',
        qualityDescription: result.value !== null
          ? 'Model verisi mevcut'
          : 'Bu konum için model verisi yok',
        dataTimestamp: result.timestamp,
      };
    }

    if (dataSource === 'SENTINEL') {
      const marineLayerId = toMarineLayerId(layer);
      if (!marineLayerId) {
        return {
          ...baseResult,
          quality: 'no_data',
          qualityDescription: 'Bu katman marine veri sözleşmesinde desteklenmiyor',
          error: 'Desteklenmeyen katman',
        };
      }
      const result = await fetchMarinePointValue({
        lat,
        lng,
        layerId: marineLayerId,
        date,
      });

      if (!result) {
        return {
          ...baseResult,
          quality: 'no_data',
          qualityDescription: 'Sentinel Hub sunucusundan veri alınamadı',
          error: 'Veri alınamadı',
        };
      }

      const quality = result.quality ?? 'uncertain';

      return {
        ...baseResult,
        value: result.value,
        quality,
        qualityDescription: getQualityDescription(quality, dataSource),
        dataTimestamp: result.timestamp,
      };
    }

    // Unknown data source
    return {
      ...baseResult,
      quality: 'no_data',
      qualityDescription: 'Bilinmeyen layer tipi',
      error: 'Bilinmeyen layer',
    };
  } catch (error) {
    return {
      ...baseResult,
      quality: 'no_data',
      qualityDescription: 'Veri sorgusu sırasında hata oluştu',
      error: error instanceof Error ? error.message : 'Bilinmeyen hata',
    };
  }
}

/**
 * Query multiple layers for a single point
 *
 * @param lat - Latitude (WGS84)
 * @param lng - Longitude (WGS84)
 * @param layers - Array of layers to query
 * @param date - Date for data
 * @returns Map of layer to query result
 */
export async function queryMultipleLayersAtPoint(
  lat: number,
  lng: number,
  layers: WaterQualityLayerType[],
  date: Date = new Date()
): Promise<Map<WaterQualityLayerType, PointQueryResult>> {
  const results = new Map<WaterQualityLayerType, PointQueryResult>();

  // Group layers by data source for efficient querying
  const cmemsLayers: CMEMSLayerType[] = [];
  const sentinelLayers: LayerType[] = [];

  for (const layer of layers) {
    const source = getLayerDataSource(layer);
    if (source === 'CMEMS') {
      cmemsLayers.push(layer as CMEMSLayerType);
    } else if (source === 'SENTINEL') {
      sentinelLayers.push(layer as LayerType);
    }
  }

  // Query CMEMS layers in parallel (no rate limiting)
  const cmemsPromises = cmemsLayers.map(async (layer) => {
    const result = await queryPointData(lat, lng, layer, date);
    results.set(layer, result);
  });

  // Query Sentinel layers sequentially (rate limited)
  const sentinelPromises = sentinelLayers.reduce(
    async (prevPromise, layer) => {
      await prevPromise;
      const result = await queryPointData(lat, lng, layer, date);
      results.set(layer, result);
    },
    Promise.resolve()
  );

  await Promise.all([
    Promise.all(cmemsPromises),
    sentinelPromises,
  ]);

  return results;
}

/**
 * Format value for display
 */
export function formatValue(value: number | null, unit: string, precision: number = 2): string {
  if (value === null) {
    return 'N/A';
  }

  // Handle very small or very large numbers
  if (Math.abs(value) < 0.01 && value !== 0) {
    return `${value.toExponential(precision)} ${unit}`.trim();
  }

  if (Math.abs(value) >= 10000) {
    return `${value.toExponential(precision)} ${unit}`.trim();
  }

  return `${value.toFixed(precision)} ${unit}`.trim();
}

/**
 * Format coordinates for display
 */
export function formatCoordinates(lat: number, lng: number): string {
  const latDir = lat >= 0 ? 'N' : 'S';
  const lngDir = lng >= 0 ? 'E' : 'W';

  return `${Math.abs(lat).toFixed(5)}°${latDir}, ${Math.abs(lng).toFixed(5)}°${lngDir}`;
}

/**
 * Check if a layer supports point queries
 */
export function supportsPointQuery(layer: WaterQualityLayerType): boolean {
  const unsupportedLayers: WaterQualityLayerType[] = [];
  return !unsupportedLayers.includes(layer);
}

/**
 * Get recommended layers for aquaculture monitoring
 */
export function getRecommendedLayers(): WaterQualityLayerType[] {
  return [
    'DISSOLVED_OXYGEN',
    'TEMPERATURE',
    'CHLOROPHYLL',
    'TURBIDITY',
    'PH',
    'SALINITY',
    'NITRATE',
  ];
}

/**
 * Get all available water quality layers
 */
export function getAllWaterQualityLayers(): WaterQualityLayerType[] {
  return [
    // CMEMS (model-based)
    'DISSOLVED_OXYGEN',
    'NITRATE',
    'PHOSPHATE',
    'PH',
    'TEMPERATURE',
    'SALINITY',
    // Sentinel (optical)
    'CHLOROPHYLL',
    'TURBIDITY',
    'TSS',
    'CDOM',
    'CYANOBACTERIA',
    'SECCHI',
    'NDWI',
  ];
}
