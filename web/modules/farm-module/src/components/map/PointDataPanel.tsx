/**
 * PointDataPanel Component
 *
 * Bottom panel that displays detailed water quality data for a clicked point.
 * Shows comprehensive information including coordinates, data source details,
 * and quality indicators.
 */

import React, { useState } from 'react';
import {
  PointQueryResult,
  formatValue,
  formatCoordinates,
} from '../../services/pointQueryService';

interface PointDataPanelProps {
  /** Query result data */
  data: PointQueryResult | null;
  /** Loading state */
  isLoading: boolean;
  /** Close handler */
  onClose: () => void;
  /** Refresh handler */
  onRefresh?: () => void;
  /** Show/hide state */
  isVisible?: boolean;
}

/**
 * InfoRow component for displaying label-value pairs
 */
const InfoRow: React.FC<{
  label: string;
  value: React.ReactNode;
  icon?: React.ReactNode;
}> = ({ label, value, icon }) => (
  <div className="flex items-start gap-2 py-1.5">
    {icon && <span className="text-gray-400 mt-0.5">{icon}</span>}
    <div className="flex-1">
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="text-sm text-gray-800 font-medium">{value}</dd>
    </div>
  </div>
);

/**
 * Quality indicator with color coding
 */
const QualityIndicator: React.FC<{
  quality: PointQueryResult['quality'];
  description: string;
}> = ({ quality, description }) => {
  const getQualityConfig = () => {
    switch (quality) {
      case 'good':
        return {
          color: 'bg-green-500',
          bgColor: 'bg-green-50',
          textColor: 'text-green-700',
          icon: '✓',
          label: 'Kaliteli',
        };
      case 'uncertain':
        return {
          color: 'bg-yellow-500',
          bgColor: 'bg-yellow-50',
          textColor: 'text-yellow-700',
          icon: '?',
          label: 'Belirsiz',
        };
      case 'cloud':
        return {
          color: 'bg-gray-400',
          bgColor: 'bg-gray-50',
          textColor: 'text-gray-600',
          icon: '☁️',
          label: 'Bulutlu',
        };
      case 'land':
        return {
          color: 'bg-amber-500',
          bgColor: 'bg-amber-50',
          textColor: 'text-amber-700',
          icon: '🏔️',
          label: 'Kara',
        };
      case 'no_data':
      default:
        return {
          color: 'bg-red-500',
          bgColor: 'bg-red-50',
          textColor: 'text-red-600',
          icon: '✕',
          label: 'Veri Yok',
        };
    }
  };

  const config = getQualityConfig();

  return (
    <div className={`p-3 rounded-lg ${config.bgColor}`}>
      <div className="flex items-center gap-2 mb-1">
        <span
          className={`w-2 h-2 rounded-full ${config.color}`}
        />
        <span className={`text-sm font-medium ${config.textColor}`}>
          {config.label}
        </span>
      </div>
      <p className={`text-xs ${config.textColor} opacity-80`}>{description}</p>
    </div>
  );
};

/**
 * Data source info card
 */
const DataSourceCard: React.FC<{
  dataSource: PointQueryResult['dataSource'];
  resolution: string;
}> = ({ dataSource, resolution }) => {
  const isCmems = dataSource === 'CMEMS';

  return (
    <div
      className={`p-3 rounded-lg border ${
        isCmems ? 'bg-blue-50 border-blue-100' : 'bg-green-50 border-green-100'
      }`}
    >
      <div className="flex items-center gap-2 mb-1">
        {isCmems ? (
          <svg
            className="w-4 h-4 text-blue-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
            />
          </svg>
        ) : (
          <svg
            className="w-4 h-4 text-green-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z"
            />
          </svg>
        )}
        <span
          className={`text-sm font-medium ${
            isCmems ? 'text-blue-700' : 'text-green-700'
          }`}
        >
          {isCmems ? 'CMEMS Okyanografik Model' : 'Sentinel-2 Uydu Verisi'}
        </span>
      </div>
      <p className={`text-xs ${isCmems ? 'text-blue-600' : 'text-green-600'}`}>
        {resolution}
      </p>
    </div>
  );
};

/**
 * PointDataPanel Component
 */
export const PointDataPanel: React.FC<PointDataPanelProps> = ({
  data,
  isLoading,
  onClose,
  onRefresh,
  isVisible = true,
}) => {
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Don't render if not visible or no data and not loading
  if (!isVisible || (!data && !isLoading)) return null;

  return (
    <div
      className={`fixed bottom-0 left-0 right-0 z-[1000] transform transition-transform duration-300 ${
        isCollapsed ? 'translate-y-[calc(100%-40px)]' : 'translate-y-0'
      }`}
    >
      {/* Collapse Toggle */}
      <button
        onClick={() => setIsCollapsed(!isCollapsed)}
        className="absolute -top-8 left-1/2 transform -translate-x-1/2 bg-white rounded-t-lg px-4 py-1 shadow-md border border-b-0 border-gray-200 hover:bg-gray-50 transition-colors"
      >
        <svg
          className={`w-4 h-4 text-gray-500 transform transition-transform ${
            isCollapsed ? 'rotate-180' : ''
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

      {/* Panel Content */}
      <div className="bg-white border-t border-gray-200 shadow-lg">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100 bg-gray-50">
          <div className="flex items-center gap-3">
            <svg
              className="w-5 h-5 text-primary-600"
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
            <h3 className="font-semibold text-gray-800">Nokta Verisi</h3>
            {data && (
              <span className="text-xs text-gray-500">
                {formatCoordinates(data.lat, data.lng)}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* Refresh Button */}
            {onRefresh && (
              <button
                onClick={onRefresh}
                disabled={isLoading}
                className="p-1.5 text-gray-500 hover:text-primary-600 hover:bg-primary-50 rounded transition-colors disabled:opacity-50"
                title="Yenile"
              >
                <svg
                  className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`}
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
              </button>
            )}

            {/* Close Button */}
            <button
              onClick={onClose}
              className="p-1.5 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
              title="Kapat"
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
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-4 max-h-[300px] overflow-y-auto">
          {/* Loading State */}
          {isLoading && (
            <div className="flex items-center justify-center py-8">
              <svg
                className="w-8 h-8 animate-spin text-primary-600"
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
              <span className="ml-3 text-gray-600">Veri yükleniyor...</span>
            </div>
          )}

          {/* Data Display */}
          {!isLoading && data && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Main Value Card */}
              <div className="bg-gradient-to-br from-primary-50 to-primary-100 rounded-xl p-4 text-center">
                <div className="text-3xl mb-2">{data.layerIcon}</div>
                <div className="text-lg font-medium text-gray-700 mb-1">
                  {data.layerName}
                </div>
                {data.value !== null ? (
                  <>
                    <div className="text-3xl font-bold text-primary-700">
                      {formatValue(data.value, '', 2)}
                    </div>
                    <div className="text-sm text-primary-600">{data.unit}</div>
                  </>
                ) : (
                  <div className="text-xl text-gray-500 py-2">N/A</div>
                )}
              </div>

              {/* Details */}
              <div className="space-y-3">
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Detaylar
                </h4>

                <dl className="space-y-1">
                  <InfoRow
                    label="Koordinatlar"
                    value={formatCoordinates(data.lat, data.lng)}
                    icon={
                      <svg
                        className="w-3.5 h-3.5"
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
                      </svg>
                    }
                  />

                  {data.dataTimestamp && (
                    <InfoRow
                      label="Veri Tarihi"
                      value={new Date(data.dataTimestamp).toLocaleDateString('tr-TR', {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                      })}
                      icon={
                        <svg
                          className="w-3.5 h-3.5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                          />
                        </svg>
                      }
                    />
                  )}

                  <InfoRow
                    label="Sorgu Zamanı"
                    value={data.queryTime.toLocaleTimeString('tr-TR')}
                    icon={
                      <svg
                        className="w-3.5 h-3.5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                        />
                      </svg>
                    }
                  />
                </dl>
              </div>

              {/* Quality & Source */}
              <div className="space-y-3">
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  Kalite & Kaynak
                </h4>

                <QualityIndicator
                  quality={data.quality}
                  description={data.qualityDescription}
                />

                <DataSourceCard
                  dataSource={data.dataSource}
                  resolution={data.resolution}
                />
              </div>
            </div>
          )}

          {/* Error State */}
          {!isLoading && data?.error && (
            <div className="mt-4 p-3 bg-red-50 border border-red-100 rounded-lg">
              <div className="flex items-start gap-2">
                <svg
                  className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5"
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
                <div>
                  <p className="text-sm font-medium text-red-800">Hata</p>
                  <p className="text-xs text-red-600">{data.error}</p>
                </div>
              </div>
            </div>
          )}

          {/* No Data State */}
          {!isLoading && !data && (
            <div className="text-center py-8 text-gray-500">
              <svg
                className="w-12 h-12 mx-auto mb-3 text-gray-300"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              <p className="text-sm">Veri bulunamadı</p>
              <p className="text-xs text-gray-400 mt-1">
                Haritada bir noktaya tıklayın
              </p>
            </div>
          )}
        </div>

        {/* Footer with info */}
        {data && (
          <div className="px-4 py-2 bg-gray-50 border-t border-gray-100 text-xs text-gray-500 text-center">
            {data.dataSource === 'CMEMS'
              ? 'Bu veri Copernicus Marine Service okyanografik modelinden alınmıştır.'
              : 'Bu veri Sentinel-2 uydusunun optik görüntülerinden hesaplanmıştır.'}
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * Floating version of the panel (for side placement)
 */
export const PointDataPanelFloating: React.FC<PointDataPanelProps> = ({
  data,
  isLoading,
  onClose,
  onRefresh,
  isVisible = true,
}) => {
  if (!isVisible || (!data && !isLoading)) return null;

  return (
    <div className="absolute bottom-4 right-4 z-[1000] w-80 bg-white rounded-lg shadow-xl border border-gray-200 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-100">
        <div className="flex items-center gap-2">
          {data && <span className="text-lg">{data.layerIcon}</span>}
          <span className="font-medium text-sm text-gray-800">
            {data?.layerName || 'Nokta Verisi'}
          </span>
        </div>
        <button
          onClick={onClose}
          className="p-1 text-gray-400 hover:text-gray-600 rounded"
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
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="p-3">
        {isLoading ? (
          <div className="flex items-center justify-center py-4">
            <svg
              className="w-5 h-5 animate-spin text-primary-600"
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
            <span className="ml-2 text-sm text-gray-600">Yükleniyor...</span>
          </div>
        ) : data ? (
          <div className="space-y-3">
            {/* Value */}
            <div className="text-center py-2 bg-primary-50 rounded-lg">
              {data.value !== null ? (
                <>
                  <div className="text-2xl font-bold text-primary-700">
                    {formatValue(data.value, '', 2)}
                  </div>
                  <div className="text-sm text-primary-600">{data.unit}</div>
                </>
              ) : (
                <div className="text-gray-500">Veri mevcut değil</div>
              )}
            </div>

            {/* Details */}
            <div className="text-xs space-y-1 text-gray-600">
              <div className="flex justify-between">
                <span>Konum:</span>
                <span className="font-medium">
                  {formatCoordinates(data.lat, data.lng)}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Kaynak:</span>
                <span className="font-medium">
                  {data.dataSource === 'CMEMS' ? 'Model' : 'Uydu'}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Kalite:</span>
                <span className="font-medium capitalize">{data.quality}</span>
              </div>
            </div>

            {/* Refresh */}
            {onRefresh && (
              <button
                onClick={onRefresh}
                className="w-full text-xs text-primary-600 hover:text-primary-700 py-1.5 border border-primary-200 rounded hover:bg-primary-50 transition-colors"
              >
                Yenile
              </button>
            )}
          </div>
        ) : (
          <div className="text-center py-4 text-gray-500 text-sm">
            Veri bulunamadı
          </div>
        )}
      </div>
    </div>
  );
};

export default PointDataPanel;
