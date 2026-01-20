/**
 * WaterQualityLegend Component
 *
 * Harita üzerindeki su kalitesi layer'ları için detaylı legend gösterimi.
 * Sentinel (optik) ve CMEMS (model) layer'ları için farklı stiller.
 */

import React, { useState, useMemo } from 'react';
import { getLayerLegend, type LayerType, SENTINEL_LAYERS } from '../../services/sentinelHubService';
import { getCMEMSLegend, getCMEMSLayerInfo, type CMEMSLayerType, CMEMS_LAYERS } from '../../services/cmemsService';

type WaterQualityLayerType = LayerType | CMEMSLayerType;

interface WaterQualityLegendProps {
  /** Active layer */
  layer: WaterQualityLayerType;
  /** Position on map */
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  /** Initially collapsed */
  collapsed?: boolean;
  /** Show data source badge */
  showDataSource?: boolean;
}

/**
 * Determine if layer is from CMEMS
 */
function isCMEMSLayer(layer: WaterQualityLayerType): boolean {
  return CMEMS_LAYERS.some((l) => l.id === layer);
}

/**
 * Get layer info
 */
function getLayerInfo(layer: WaterQualityLayerType) {
  const sentinelLayer = SENTINEL_LAYERS.find((l) => l.id === layer);
  if (sentinelLayer) {
    return {
      name: sentinelLayer.name,
      icon: sentinelLayer.icon,
      description: sentinelLayer.description,
      dataSource: 'SENTINEL' as const,
    };
  }

  const cmemsLayer = getCMEMSLayerInfo(layer as CMEMSLayerType);
  if (cmemsLayer) {
    return {
      name: cmemsLayer.name,
      icon: cmemsLayer.icon,
      description: `${cmemsLayer.description} (${cmemsLayer.unit})`,
      unit: cmemsLayer.unit,
      dataSource: 'CMEMS' as const,
    };
  }

  return null;
}

export const WaterQualityLegend: React.FC<WaterQualityLegendProps> = ({
  layer,
  position = 'bottom-left',
  collapsed = false,
  showDataSource = true,
}) => {
  const [isCollapsed, setIsCollapsed] = useState(collapsed);

  // Get legend data
  const legend = useMemo(() => {
    if (isCMEMSLayer(layer)) {
      return getCMEMSLegend(layer as CMEMSLayerType);
    }
    return getLayerLegend(layer as LayerType);
  }, [layer]);

  // Get layer info
  const layerInfo = useMemo(() => getLayerInfo(layer), [layer]);

  // Position classes
  const positionClasses = {
    'top-left': 'top-4 left-4',
    'top-right': 'top-4 right-4',
    'bottom-left': 'bottom-4 left-4',
    'bottom-right': 'bottom-4 right-4',
  };

  // Don't render if no legend data
  if (!legend.length || !layerInfo) return null;

  const isCmems = layerInfo.dataSource === 'CMEMS';

  return (
    <div className={`absolute ${positionClasses[position]} z-[1000]`}>
      <div
        className={`bg-white rounded-lg shadow-lg overflow-hidden ${
          isCollapsed ? 'w-auto' : 'w-64'
        }`}
      >
        {/* Header */}
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="w-full flex items-center justify-between px-3 py-2 bg-gray-50 hover:bg-gray-100 transition-colors"
        >
          <div className="flex items-center gap-2">
            <span>{layerInfo.icon}</span>
            <span className="text-sm font-medium text-gray-700">
              {isCollapsed ? 'Lejant' : layerInfo.name}
            </span>
            {showDataSource && (
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded ${
                  isCmems
                    ? 'bg-blue-100 text-blue-700'
                    : 'bg-green-100 text-green-700'
                }`}
              >
                {isCmems ? 'Model' : 'Uydu'}
              </span>
            )}
          </div>
          <svg
            className={`w-4 h-4 text-gray-400 transition-transform ${
              isCollapsed ? '' : 'rotate-180'
            }`}
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

        {/* Legend Content */}
        {!isCollapsed && (
          <div className="p-3">
            {/* Description */}
            <p className="text-[11px] text-gray-500 mb-3">{layerInfo.description}</p>

            {/* Color Scale */}
            <div className="space-y-1.5">
              {legend.map((item, index) => (
                <div key={index} className="flex items-center gap-2">
                  <span
                    className="w-5 h-3 rounded-sm flex-shrink-0 border border-gray-200"
                    style={{ backgroundColor: item.color }}
                  />
                  <span className="text-xs text-gray-600 flex-1">
                    {item.label}
                  </span>
                </div>
              ))}
            </div>

            {/* Data Source Info */}
            <div className="mt-3 pt-3 border-t border-gray-100">
              <div className="flex items-center gap-2 text-[10px] text-gray-400">
                {isCmems ? (
                  <>
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                    </svg>
                    <span>CMEMS oceanografik model (~25km)</span>
                  </>
                ) : (
                  <>
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
                    </svg>
                    <span>Sentinel-2 optik uydu (10m)</span>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * Gradient Legend - For continuous color scales
 */
interface GradientLegendProps {
  title: string;
  min: number;
  max: number;
  unit: string;
  colors: string[];
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
}

export const GradientLegend: React.FC<GradientLegendProps> = ({
  title,
  min,
  max,
  unit,
  colors,
  position = 'bottom-left',
}) => {
  const positionClasses = {
    'top-left': 'top-4 left-4',
    'top-right': 'top-4 right-4',
    'bottom-left': 'bottom-4 left-4',
    'bottom-right': 'bottom-4 right-4',
  };

  const gradient = `linear-gradient(to right, ${colors.join(', ')})`;

  return (
    <div className={`absolute ${positionClasses[position]} z-[1000]`}>
      <div className="bg-white rounded-lg shadow-lg p-3 w-48">
        <div className="text-xs font-medium text-gray-700 mb-2">{title}</div>

        {/* Gradient bar */}
        <div
          className="h-3 rounded-sm mb-1"
          style={{ background: gradient }}
        />

        {/* Min/Max labels */}
        <div className="flex justify-between text-[10px] text-gray-500">
          <span>
            {min} {unit}
          </span>
          <span>
            {max} {unit}
          </span>
        </div>
      </div>
    </div>
  );
};

/**
 * Multi-Layer Legend - Shows legends for multiple active layers
 */
interface MultiLayerLegendProps {
  layers: WaterQualityLayerType[];
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
}

export const MultiLayerLegend: React.FC<MultiLayerLegendProps> = ({
  layers,
  position = 'bottom-left',
}) => {
  const [expandedLayers, setExpandedLayers] = useState<Set<string>>(new Set());

  const toggleLayer = (layer: string) => {
    setExpandedLayers((prev) => {
      const next = new Set(prev);
      if (next.has(layer)) {
        next.delete(layer);
      } else {
        next.add(layer);
      }
      return next;
    });
  };

  const positionClasses = {
    'top-left': 'top-4 left-4',
    'top-right': 'top-4 right-4',
    'bottom-left': 'bottom-4 left-4',
    'bottom-right': 'bottom-4 right-4',
  };

  if (!layers.length) return null;

  return (
    <div className={`absolute ${positionClasses[position]} z-[1000]`}>
      <div className="bg-white rounded-lg shadow-lg overflow-hidden w-64">
        <div className="px-3 py-2 bg-gray-50 text-sm font-medium text-gray-700 border-b">
          Aktif Katmanlar ({layers.length})
        </div>

        <div className="max-h-80 overflow-y-auto">
          {layers.map((layer) => {
            const layerInfo = getLayerInfo(layer);
            if (!layerInfo) return null;

            const legend = isCMEMSLayer(layer)
              ? getCMEMSLegend(layer as CMEMSLayerType)
              : getLayerLegend(layer as LayerType);

            const isExpanded = expandedLayers.has(layer);
            const isCmems = layerInfo.dataSource === 'CMEMS';

            return (
              <div key={layer} className="border-b last:border-b-0">
                <button
                  onClick={() => toggleLayer(layer)}
                  className="w-full flex items-center justify-between px-3 py-2 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span>{layerInfo.icon}</span>
                    <span className="text-sm text-gray-700">{layerInfo.name}</span>
                    <span
                      className={`text-[9px] px-1 py-0.5 rounded ${
                        isCmems
                          ? 'bg-blue-100 text-blue-600'
                          : 'bg-green-100 text-green-600'
                      }`}
                    >
                      {isCmems ? 'M' : 'S'}
                    </span>
                  </div>
                  <svg
                    className={`w-4 h-4 text-gray-400 transition-transform ${
                      isExpanded ? 'rotate-180' : ''
                    }`}
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

                {isExpanded && legend.length > 0 && (
                  <div className="px-3 pb-2 space-y-1">
                    {legend.map((item, index) => (
                      <div key={index} className="flex items-center gap-2">
                        <span
                          className="w-4 h-2.5 rounded-sm flex-shrink-0"
                          style={{ backgroundColor: item.color }}
                        />
                        <span className="text-[11px] text-gray-500">
                          {item.label}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default WaterQualityLegend;
