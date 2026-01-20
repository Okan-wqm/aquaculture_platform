/**
 * CMEMSTileLayer Component
 *
 * Renders Copernicus Marine Service (CMEMS) data as a tile layer on the map.
 * Provides oceanographic model data that cannot be measured optically:
 * - Dissolved Oxygen
 * - Nitrate, Phosphate
 * - pH
 * - Temperature, Salinity
 *
 * Uses WMTS protocol for tile-based data access.
 */

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { TileLayer, useMap, Pane } from 'react-leaflet';
import {
  CMEMSLayerType,
  getCMEMSLayerInfo,
  getCMEMSWMTSTileUrl,
  isCMEMSDataAvailable,
  getLatestCMEMSDate,
} from '../../services/cmemsService';

interface CMEMSTileLayerProps {
  /** Layer type to display */
  layer: CMEMSLayerType;
  /** Date for model data */
  date: Date;
  /** Layer opacity (0-1) */
  opacity?: number;
  /** Minimum zoom level */
  minZoom?: number;
  /** Maximum zoom level */
  maxZoom?: number;
  /** Depth level in meters (0 = surface) */
  depth?: number;
  /** Enable land masking to hide data on land areas */
  enableLandMask?: boolean;
  /** Base layer type for land mask styling */
  baseLayerType?: 'osm' | 'satellite';
  /** Callback when loading state changes */
  onLoadingChange?: (isLoading: boolean) => void;
  /** Callback when an error occurs */
  onError?: (error: string) => void;
  /** Callback when data availability changes */
  onDataAvailability?: (available: boolean) => void;
}

/**
 * CMEMS WMTS Tile Layer
 */
// Land mask tile URL - CartoDB Positron (light gray land, minimal water)
const LAND_MASK_URL = 'https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png';

// Alternative: Esri World Terrain Reference (shows terrain, water is subtle)
const LAND_MASK_URL_TERRAIN = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Reference_Overlay/MapServer/tile/{z}/{y}/{x}';

export const CMEMSTileLayer: React.FC<CMEMSTileLayerProps> = ({
  layer,
  date,
  opacity = 0.7,
  minZoom = 5,
  maxZoom = 12, // CMEMS data is ~25km resolution for global products
  depth = 0,
  enableLandMask = true,
  baseLayerType = 'osm',
  onLoadingChange,
  onError,
  onDataAvailability,
}) => {
  const map = useMap();
  const [panesReady, setPanesReady] = useState(false);

  // Create custom panes for layering - must complete before rendering TileLayer
  useEffect(() => {
    // CMEMS data pane - below tile pane
    if (!map.getPane('cmemsDataPane')) {
      const cmemsPane = map.createPane('cmemsDataPane');
      cmemsPane.style.zIndex = '250';
      cmemsPane.style.pointerEvents = 'none';
    }
    // Land mask pane - above CMEMS, below overlays
    if (!map.getPane('landMaskPane')) {
      const landPane = map.createPane('landMaskPane');
      landPane.style.zIndex = '260';
      landPane.style.pointerEvents = 'none';
    }
    // Signal that panes are ready for rendering
    setPanesReady(true);
  }, [map]);

  // Get layer information (pure computation - no side effects)
  const layerInfo = useMemo(() => getCMEMSLayerInfo(layer), [layer]);

  // Check data availability (pure computation - no side effects)
  const dataAvailable = useMemo(() => isCMEMSDataAvailable(date), [date]);

  // Notify parent about data availability changes (side effect in useEffect)
  useEffect(() => {
    onDataAvailability?.(dataAvailable);
  }, [dataAvailable, onDataAvailability]);

  // Get the effective date (use latest if requested date not available)
  const effectiveDate = useMemo(() => {
    return dataAvailable ? date : getLatestCMEMSDate();
  }, [date, dataAvailable]);

  // Generate WMTS tile URL
  const tileUrl = useMemo(() => {
    return getCMEMSWMTSTileUrl(layer, effectiveDate, depth);
  }, [layer, effectiveDate, depth]);

  // Handle loading events
  const handleLoading = useCallback(() => {
    onLoadingChange?.(true);
  }, [onLoadingChange]);

  const handleLoad = useCallback(() => {
    onLoadingChange?.(false);
  }, [onLoadingChange]);

  const handleError = useCallback(
    (e: any) => {
      console.error('CMEMS WMTS error:', e);
      onError?.(`${layerInfo?.name || 'CMEMS'} verisi yüklenemedi`);
      onLoadingChange?.(false);
    },
    [layerInfo, onError, onLoadingChange]
  );

  // Guard clause: Don't render until panes are ready and we have valid layer info
  if (!panesReady) {
    return null; // Wait for panes to be created
  }

  if (!layerInfo) {
    console.warn(`CMEMS layer info not found for: ${layer}`);
    return null;
  }

  if (!tileUrl) {
    console.warn(`CMEMS tile URL could not be generated for: ${layer}`);
    onError?.(`${layerInfo.name} için URL oluşturulamadı`);
    return null;
  }

  // Log warning if using fallback date (data not available for requested date)
  if (!dataAvailable) {
    console.warn(
      `CMEMS data for ${date.toISOString().split('T')[0]} may not be available yet. Using latest available data.`
    );
  }

  return (
    <>
      {/* CMEMS Data Layer */}
      <TileLayer
        key={`cmems-${layer}`}
        url={tileUrl}
        opacity={opacity}
        minZoom={minZoom}
        maxZoom={maxZoom}
        pane="cmemsDataPane"
        className="cmems-wmts-layer"
        eventHandlers={{
          loading: handleLoading,
          load: handleLoad,
          tileerror: handleError,
        }}
      />

      {/* Land Mask Layer - covers CMEMS data on land areas */}
      {enableLandMask && (
        <TileLayer
          key={`landmask-${layer}`}
          url={LAND_MASK_URL}
          opacity={0.85}
          minZoom={minZoom}
          maxZoom={maxZoom}
          pane="landMaskPane"
          className="cmems-land-mask"
        />
      )}

      {/* CSS for blend mode - makes land mask blend better with CMEMS */}
      <style>{`
        .cmems-land-mask {
          mix-blend-mode: multiply;
        }
        .cmems-land-mask .leaflet-tile {
          filter: contrast(1.1) saturate(0.3);
        }
      `}</style>
    </>
  );
};

/**
 * Hook for managing CMEMS tile layer state
 */
export function useCMEMSTiles() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dataAvailable, setDataAvailable] = useState(true);

  const handleLoadingChange = useCallback((loading: boolean) => {
    setIsLoading(loading);
  }, []);

  const handleError = useCallback((err: string) => {
    setError(err);
    setTimeout(() => setError(null), 5000);
  }, []);

  const handleDataAvailability = useCallback((available: boolean) => {
    setDataAvailable(available);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    isLoading,
    error,
    dataAvailable,
    handleLoadingChange,
    handleError,
    handleDataAvailability,
    clearError,
  };
}

/**
 * Data availability warning component
 */
interface DataAvailabilityWarningProps {
  isVisible: boolean;
  requestedDate: Date;
  latestDate: Date;
}

export const DataAvailabilityWarning: React.FC<DataAvailabilityWarningProps> = ({
  isVisible,
  requestedDate,
  latestDate,
}) => {
  if (!isVisible) return null;

  return (
    <div className="absolute top-4 left-1/2 transform -translate-x-1/2 z-[1000] bg-amber-50 border border-amber-200 rounded-lg shadow px-4 py-2 flex items-center gap-2 max-w-md">
      <svg
        className="w-5 h-5 text-amber-500 flex-shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
        />
      </svg>
      <div className="text-sm">
        <p className="font-medium text-amber-700">Veri Gecikmesi</p>
        <p className="text-amber-600 text-xs">
          {requestedDate.toLocaleDateString('tr-TR')} için veri henüz mevcut
          değil. En son veri ({latestDate.toLocaleDateString('tr-TR')})
          gösteriliyor.
        </p>
      </div>
    </div>
  );
};

/**
 * CMEMS Loading indicator
 */
interface CMEMSLoadingIndicatorProps {
  isLoading: boolean;
  layerName?: string;
}

export const CMEMSLoadingIndicator: React.FC<CMEMSLoadingIndicatorProps> = ({
  isLoading,
  layerName,
}) => {
  if (!isLoading) return null;

  return (
    <div className="absolute bottom-4 left-4 z-[1000] bg-blue-50 rounded-lg shadow px-3 py-2 flex items-center gap-2">
      <svg className="w-4 h-4 animate-spin text-blue-600" viewBox="0 0 24 24">
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
          fill="none"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
        />
      </svg>
      <span className="text-xs text-blue-600">
        {layerName ? `${layerName} yükleniyor...` : 'CMEMS verisi yükleniyor...'}
      </span>
    </div>
  );
};

/**
 * Resolution warning for high zoom levels
 */
interface ResolutionWarningProps {
  currentZoom: number;
  maxEffectiveZoom: number;
}

export const ResolutionWarning: React.FC<ResolutionWarningProps> = ({
  currentZoom,
  maxEffectiveZoom,
}) => {
  if (currentZoom <= maxEffectiveZoom) return null;

  return (
    <div className="absolute bottom-4 right-4 z-[1000] bg-gray-100 rounded-lg shadow px-3 py-2">
      <p className="text-xs text-gray-600">
        <span className="font-medium">Düşük çözünürlük:</span> CMEMS verisi
        ~4km grid. Yakınlaştırma detay artırmaz.
      </p>
    </div>
  );
};

export default CMEMSTileLayer;
