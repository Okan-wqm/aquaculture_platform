/**
 * PointDataPopup Component
 *
 * Leaflet popup that displays water quality data at a clicked point.
 * Shows the value, unit, data source, and quality information.
 */

import React from 'react';
import { Popup } from 'react-leaflet';
import {
  PointQueryResult,
  formatValue,
  formatCoordinates,
} from '../../services/pointQueryService';

interface PointDataPopupProps {
  /** Position for the popup [lat, lng] */
  position: [number, number];
  /** Query result data */
  data: PointQueryResult | null;
  /** Loading state */
  isLoading: boolean;
  /** Close handler */
  onClose: () => void;
  /** Refresh handler */
  onRefresh?: () => void;
}

/**
 * Quality badge component
 */
const QualityBadge: React.FC<{
  quality: PointQueryResult['quality'];
  dataSource: PointQueryResult['dataSource'];
}> = ({ quality, dataSource }) => {
  const getQualityStyle = () => {
    switch (quality) {
      case 'good':
        return 'bg-green-100 text-green-700 border-green-200';
      case 'uncertain':
        return 'bg-yellow-100 text-yellow-700 border-yellow-200';
      case 'cloud':
        return 'bg-gray-100 text-gray-600 border-gray-200';
      case 'land':
        return 'bg-amber-100 text-amber-700 border-amber-200';
      case 'no_data':
      default:
        return 'bg-red-100 text-red-600 border-red-200';
    }
  };

  const getQualityIcon = () => {
    switch (quality) {
      case 'good':
        return '✓';
      case 'uncertain':
        return '?';
      case 'cloud':
        return '☁️';
      case 'land':
        return '🏔️';
      case 'no_data':
      default:
        return '✕';
    }
  };

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border ${getQualityStyle()}`}
    >
      <span>{getQualityIcon()}</span>
      <span>{quality === 'good' ? (dataSource === 'SENTINEL' ? 'Uydu' : 'Model') : quality}</span>
    </span>
  );
};

/**
 * Data source badge component
 */
const DataSourceBadge: React.FC<{ dataSource: PointQueryResult['dataSource'] }> = ({
  dataSource,
}) => {
  const isCmems = dataSource === 'CMEMS';

  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded ${
        isCmems ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'
      }`}
    >
      {isCmems ? 'Model' : 'Uydu'}
    </span>
  );
};

/**
 * Loading spinner component
 */
const LoadingSpinner: React.FC = () => (
  <div className="flex items-center justify-center py-4">
    <svg
      className="w-6 h-6 animate-spin text-primary-600"
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
    <span className="ml-2 text-sm text-gray-600">Veri yükleniyor...</span>
  </div>
);

/**
 * PointDataPopup Component
 */
export const PointDataPopup: React.FC<PointDataPopupProps> = ({
  position,
  data,
  isLoading,
  onClose,
  onRefresh,
}) => {
  // Don't render if no position
  if (!position) return null;

  return (
    <Popup
      position={position}
      closeButton={true}
      autoPan={true}
      className="point-data-popup"
      eventHandlers={{
        remove: onClose,
      }}
    >
      <div className="min-w-[220px] max-w-[280px]">
        {/* Loading State */}
        {isLoading && <LoadingSpinner />}

        {/* Data Display */}
        {!isLoading && data && (
          <>
            {/* Header */}
            <div className="flex items-center justify-between mb-2 pb-2 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <span className="text-lg">{data.layerIcon}</span>
                <span className="font-medium text-gray-800 text-sm">{data.layerName}</span>
              </div>
              <DataSourceBadge dataSource={data.dataSource} />
            </div>

            {/* Value Display */}
            <div className="text-center py-2">
              {data.value !== null ? (
                <>
                  <div className="text-2xl font-bold text-primary-700">
                    {formatValue(data.value, '', 2)}
                  </div>
                  <div className="text-sm text-gray-500">{data.unit}</div>
                </>
              ) : (
                <div className="text-gray-500 text-sm py-2">
                  <span className="text-lg block mb-1">📭</span>
                  Veri mevcut değil
                </div>
              )}
            </div>

            {/* Quality Badge */}
            <div className="flex justify-center mb-2">
              <QualityBadge quality={data.quality} dataSource={data.dataSource} />
            </div>

            {/* Coordinates */}
            <div className="text-[11px] text-gray-500 text-center border-t border-gray-100 pt-2 mt-2">
              <div className="flex items-center justify-center gap-1">
                <svg
                  className="w-3 h-3"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                </svg>
                <span>{formatCoordinates(data.lat, data.lng)}</span>
              </div>
            </div>

            {/* Resolution Info */}
            <div className="text-[10px] text-gray-400 text-center mt-1">
              {data.resolution}
            </div>

            {/* Refresh Button */}
            {onRefresh && (
              <div className="mt-2 pt-2 border-t border-gray-100">
                <button
                  onClick={onRefresh}
                  className="w-full text-xs text-primary-600 hover:text-primary-700 hover:bg-primary-50 rounded py-1 transition-colors flex items-center justify-center gap-1"
                >
                  <svg
                    className="w-3 h-3"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                    />
                  </svg>
                  Yenile
                </button>
              </div>
            )}

            {/* Error Message */}
            {data.error && (
              <div className="mt-2 p-2 bg-red-50 rounded text-xs text-red-600 text-center">
                {data.error}
              </div>
            )}
          </>
        )}

        {/* No Data State */}
        {!isLoading && !data && (
          <div className="text-center py-4 text-gray-500 text-sm">
            <span className="text-2xl block mb-2">🔍</span>
            Veri bulunamadı
          </div>
        )}
      </div>
    </Popup>
  );
};

/**
 * Compact version of the popup for mobile/smaller screens
 */
export const PointDataPopupCompact: React.FC<PointDataPopupProps> = ({
  position,
  data,
  isLoading,
  onClose,
}) => {
  if (!position) return null;

  return (
    <Popup
      position={position}
      closeButton={true}
      autoPan={true}
      className="point-data-popup-compact"
      eventHandlers={{
        remove: onClose,
      }}
    >
      <div className="min-w-[160px]">
        {isLoading ? (
          <div className="flex items-center gap-2 py-2">
            <svg
              className="w-4 h-4 animate-spin text-primary-600"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            <span className="text-xs text-gray-600">Yükleniyor...</span>
          </div>
        ) : data ? (
          <div className="flex items-center gap-2">
            <span>{data.layerIcon}</span>
            <div>
              <div className="font-medium text-sm">
                {data.value !== null ? formatValue(data.value, data.unit, 2) : 'N/A'}
              </div>
              <div className="text-[10px] text-gray-500">{data.layerName}</div>
            </div>
          </div>
        ) : (
          <div className="text-xs text-gray-500 py-2">Veri yok</div>
        )}
      </div>
    </Popup>
  );
};

/**
 * Marker component for clicked point (without popup)
 */
export const ClickedPointMarker: React.FC<{
  position: [number, number];
  isLoading: boolean;
}> = ({ position, isLoading }) => {
  // This could render a custom marker if needed
  // For now, we rely on the popup marker
  return null;
};

export default PointDataPopup;
