/**
 * SatelliteLayerControl Component
 *
 * Harita katman seçici - OSM, Esri Satellite, Sentinel Hub ve CMEMS katmanları
 *
 * Katman Kaynakları:
 * - Base: OpenStreetMap, Esri Satellite
 * - Sentinel-2 (optik): TRUE-COLOR, CHLOROPHYLL, TURBIDITY, TSS, CDOM, CYANOBACTERIA, NDWI, SECCHI, NDVI, MOISTURE
 * - CMEMS (model): DISSOLVED_OXYGEN, NITRATE, PHOSPHATE, PH, TEMPERATURE, SALINITY
 */

import React, { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { TileLayer, ImageOverlay } from 'react-leaflet';
import {
  SENTINEL_LAYERS,
  getLayerLegend,
  type LayerType,
  type LayerInfo,
} from '../../services/sentinelHubService';
import {
  CMEMS_LAYERS,
  getCMEMSLegend,
  type CMEMSLayerType,
  type CMEMSLayerInfo,
} from '../../services/cmemsService';

// Base layers (non-satellite)
const BASE_LAYERS = [
  { id: 'osm', name: 'OpenStreetMap', icon: '🗺️', category: 'base' as const },
  { id: 'satellite', name: 'Uydu (Esri)', icon: '🛰️', category: 'base' as const },
];

// Combined layer type
export type MapLayerType = 'osm' | 'satellite' | LayerType | CMEMSLayerType;

// Data source indicator
export type DataSource = 'SENTINEL' | 'CMEMS' | 'BASE';

interface SatelliteLayerControlProps {
  activeLayer: MapLayerType;
  onLayerChange: (layer: MapLayerType) => void;
  isConfigured: boolean;
  isLoading?: boolean;
  /** Show CMEMS layers (model-based ocean data) */
  showCMEMSLayers?: boolean;
}

/**
 * Get data source for a layer
 */
function getDataSource(layer: MapLayerType): DataSource {
  if (layer === 'osm' || layer === 'satellite') return 'BASE';
  if (CMEMS_LAYERS.some((l) => l.id === layer)) return 'CMEMS';
  return 'SENTINEL';
}

export const SatelliteLayerControl: React.FC<SatelliteLayerControlProps> = ({
  activeLayer,
  onLayerChange,
  isConfigured,
  isLoading = false,
  showCMEMSLayers = true,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showLegend, setShowLegend] = useState(false);

  // Get current layer info
  const currentLayer = useMemo(() => {
    const baseLayer = BASE_LAYERS.find((l) => l.id === activeLayer);
    if (baseLayer) return baseLayer;

    const sentinelLayer = SENTINEL_LAYERS.find((l) => l.id === activeLayer);
    if (sentinelLayer) return sentinelLayer;

    const cmemsLayer = CMEMS_LAYERS.find((l) => l.id === activeLayer);
    if (cmemsLayer)
      return { ...cmemsLayer, icon: cmemsLayer.icon, name: cmemsLayer.name };

    return null;
  }, [activeLayer]);

  // Get data source
  const dataSource = getDataSource(activeLayer);

  // Check if current layer is a Sentinel layer
  const isSentinelLayer = SENTINEL_LAYERS.some((l) => l.id === activeLayer);
  const isCMEMSLayer = CMEMS_LAYERS.some((l) => l.id === activeLayer);

  // Get legend for current layer
  const legend = useMemo(() => {
    if (isSentinelLayer) {
      return getLayerLegend(activeLayer as LayerType);
    }
    if (isCMEMSLayer) {
      return getCMEMSLegend(activeLayer as CMEMSLayerType);
    }
    return [];
  }, [activeLayer, isSentinelLayer, isCMEMSLayer]);

  // Group Sentinel layers by category
  const waterLayers = SENTINEL_LAYERS.filter((l) => l.category === 'water');
  const analysisLayers = SENTINEL_LAYERS.filter((l) => l.category === 'analysis');
  const baseSentinelLayers = SENTINEL_LAYERS.filter((l) => l.category === 'base');

  return (
    <div className="absolute top-4 right-4 z-[1000]">
      {/* Main Button */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-2 px-3 py-2 bg-white rounded-lg shadow-lg hover:bg-gray-50 transition-colors"
      >
        <span>{currentLayer?.icon || '🗺️'}</span>
        <span className="text-sm font-medium text-gray-700">
          {currentLayer?.name || 'Katman'}
        </span>
        {/* Data source badge */}
        {dataSource !== 'BASE' && (
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded ${
              dataSource === 'SENTINEL'
                ? 'bg-green-100 text-green-700'
                : 'bg-blue-100 text-blue-700'
            }`}
          >
            {dataSource === 'SENTINEL' ? 'Uydu' : 'Model'}
          </span>
        )}
        {isLoading && (
          <svg className="w-4 h-4 animate-spin text-primary-600" viewBox="0 0 24 24">
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
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
        )}
        <svg
          className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {/* Dropdown Panel */}
      {isExpanded && (
        <div className="mt-2 bg-white rounded-lg shadow-lg overflow-hidden w-72 max-h-[70vh] overflow-y-auto">
          {/* Base Layers */}
          <div className="p-2 border-b">
            <div className="text-xs font-medium text-gray-500 mb-2 px-2">
              Temel Katmanlar
            </div>
            {BASE_LAYERS.map((layer) => (
              <LayerButton
                key={layer.id}
                layer={layer}
                isActive={activeLayer === layer.id}
                onClick={() => {
                  onLayerChange(layer.id as MapLayerType);
                  setIsExpanded(false);
                }}
              />
            ))}
          </div>

          {/* Sentinel Hub Layers */}
          {isConfigured ? (
            <>
              {/* Sentinel Base */}
              <div className="p-2 border-b">
                <div className="flex items-center gap-2 mb-2 px-2">
                  <span className="text-xs font-medium text-gray-500">Sentinel-2</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-700">
                    Uydu
                  </span>
                </div>
                {baseSentinelLayers.map((layer) => (
                  <LayerButton
                    key={layer.id}
                    layer={layer}
                    isActive={activeLayer === layer.id}
                    onClick={() => {
                      onLayerChange(layer.id as MapLayerType);
                      setIsExpanded(false);
                    }}
                  />
                ))}
              </div>

              {/* Water Quality - Satellite */}
              <div className="p-2 border-b">
                <div className="flex items-center gap-2 mb-2 px-2">
                  <span className="text-xs font-medium text-gray-500">
                    Su Kalitesi (Optik)
                  </span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-700">
                    10m
                  </span>
                </div>
                {waterLayers.map((layer) => (
                  <LayerButton
                    key={layer.id}
                    layer={layer}
                    isActive={activeLayer === layer.id}
                    onClick={() => {
                      onLayerChange(layer.id as MapLayerType);
                      setIsExpanded(false);
                    }}
                  />
                ))}
              </div>

              {/* Analysis */}
              <div className="p-2 border-b">
                <div className="text-xs font-medium text-gray-500 mb-2 px-2">
                  Diğer Analizler
                </div>
                {analysisLayers.map((layer) => (
                  <LayerButton
                    key={layer.id}
                    layer={layer}
                    isActive={activeLayer === layer.id}
                    onClick={() => {
                      onLayerChange(layer.id as MapLayerType);
                      setIsExpanded(false);
                    }}
                  />
                ))}
              </div>
            </>
          ) : (
            <div className="p-4 text-center border-b">
              <p className="text-sm text-gray-500 mb-2">
                Sentinel Hub yapılandırılmamış
              </p>
              <Link
                to="/sites/settings/sentinel-hub"
                className="text-sm text-primary-600 hover:underline"
              >
                Ayarları yapılandır →
              </Link>
            </div>
          )}

          {/* CMEMS Layers - Model Based */}
          {showCMEMSLayers && (
            <div className="p-2 border-b bg-blue-50/50">
              <div className="flex items-center gap-2 mb-2 px-2">
                <span className="text-xs font-medium text-gray-500">
                  Okyanus Modeli (CMEMS)
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">
                  ~25km
                </span>
              </div>
              {CMEMS_LAYERS.map((layer) => (
                <LayerButton
                  key={layer.id}
                  layer={{
                    id: layer.id,
                    name: layer.name,
                    icon: layer.icon,
                    description: `${layer.description} (${layer.unit})`,
                  }}
                  isActive={activeLayer === layer.id}
                  onClick={() => {
                    onLayerChange(layer.id as MapLayerType);
                    setIsExpanded(false);
                  }}
                  badge={layer.unit}
                />
              ))}
              <div className="mt-2 px-2">
                <p className="text-[10px] text-gray-500">
                  💡 CMEMS: Model tabanlı oceanografik veri. DO, Nitrat, pH gibi
                  optik olarak ölçülemeyen parametreler.
                </p>
              </div>
            </div>
          )}

          {/* Settings Footer */}
          <div className="p-2 bg-gray-50">
            <Link
              to="/sites/settings/sentinel-hub"
              className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-md transition-colors"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                />
              </svg>
              <span>Sentinel Hub Ayarları</span>
            </Link>
          </div>
        </div>
      )}

      {/* Legend Panel */}
      {(isSentinelLayer || isCMEMSLayer) && legend.length > 0 && (
        <div className="mt-2">
          <button
            onClick={() => setShowLegend(!showLegend)}
            className="w-full flex items-center justify-between px-3 py-2 bg-white rounded-lg shadow-lg hover:bg-gray-50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-700">Lejant</span>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded ${
                  isSentinelLayer
                    ? 'bg-green-100 text-green-700'
                    : 'bg-blue-100 text-blue-700'
                }`}
              >
                {isSentinelLayer ? 'Uydu' : 'Model'}
              </span>
            </div>
            <svg
              className={`w-4 h-4 transition-transform ${showLegend ? 'rotate-180' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>

          {showLegend && (
            <div className="mt-1 bg-white rounded-lg shadow-lg p-3">
              <div className="text-xs font-medium text-gray-600 mb-2">
                {currentLayer?.name}
              </div>
              <div className="space-y-1">
                {legend.map((item, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <span
                      className="w-4 h-4 rounded flex-shrink-0"
                      style={{ backgroundColor: item.color }}
                    />
                    <span className="text-xs text-gray-600">{item.label}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Layer Button Component
 */
interface LayerButtonProps {
  layer: { id: string; name: string; icon: string; description?: string };
  isActive: boolean;
  onClick: () => void;
  badge?: string;
}

const LayerButton: React.FC<LayerButtonProps> = ({
  layer,
  isActive,
  onClick,
  badge,
}) => (
  <button
    onClick={onClick}
    className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors ${
      isActive
        ? 'bg-primary-100 text-primary-700'
        : 'hover:bg-gray-100 text-gray-700'
    }`}
    title={layer.description}
  >
    <span>{layer.icon}</span>
    <span className="truncate flex-1 text-left">{layer.name}</span>
    {badge && (
      <span className="text-[10px] text-gray-400 flex-shrink-0">{badge}</span>
    )}
  </button>
);

/**
 * BaseLayer Component - Renders the base tile layer
 */
interface BaseLayerProps {
  layer: MapLayerType;
}

export const BaseLayer: React.FC<BaseLayerProps> = ({ layer }) => {
  if (layer === 'satellite') {
    return (
      <TileLayer
        attribution="Esri, Maxar, Earthstar Geographics"
        url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
      />
    );
  }

  // Default: OpenStreetMap
  return (
    <TileLayer
      attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
      url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
    />
  );
};

/**
 * SentinelOverlay Component - Renders the Sentinel Hub image overlay
 */
interface SentinelOverlayProps {
  imageUrl: string | null;
  bounds: [[number, number], [number, number]] | null;
  opacity?: number;
}

export const SentinelOverlay: React.FC<SentinelOverlayProps> = ({
  imageUrl,
  bounds,
  opacity = 0.85,
}) => {
  if (!imageUrl || !bounds) return null;

  return <ImageOverlay url={imageUrl} bounds={bounds} opacity={opacity} />;
};

export { getDataSource };
export default SatelliteLayerControl;
