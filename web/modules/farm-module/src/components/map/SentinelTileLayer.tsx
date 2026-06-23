/**
 * SentinelTileLayer Component
 *
 * Renders Sentinel imagery through the backend-owned marine data contract.
 * The browser never receives Sentinel credentials, processing scripts, or provider URLs.
 */

import React, { useEffect, useMemo, useState, useCallback } from 'react';

import { type LayerType } from '../../services/sentinelHubService';
import { toMarineLayerId } from '../../services/marineDataService';

import { MarineAuthenticatedTileLayer } from './MarineAuthenticatedTileLayer';

interface SentinelTileLayerProps {
  /** Layer type to display */
  layer: LayerType;
  /** Date for satellite imagery */
  date: Date;
  /** Layer opacity (0-1) */
  opacity?: number;
  /** Minimum zoom level to show layer */
  minZoom?: number;
  /** Maximum zoom level */
  maxZoom?: number;
  /** Callback when loading state changes */
  onLoadingChange?: (isLoading: boolean) => void;
  /** Callback when an error occurs */
  onError?: (error: string) => void;
}

export const SentinelTileLayer: React.FC<SentinelTileLayerProps> = ({
  layer,
  date,
  opacity = 0.9,
  minZoom = 10,
  maxZoom = 16,
  onLoadingChange,
  onError,
}) => {
  const [key, setKey] = useState(0);
  const marineLayerId = useMemo(() => toMarineLayerId(layer), [layer]);

  // Force refresh when layer or date changes
  useEffect(() => {
    setKey((prev) => prev + 1);
  }, [layer, date, marineLayerId]);

  useEffect(() => {
    if (!marineLayerId) {
      onError?.(`${layer} katmanı marine veri sözleşmesinde desteklenmiyor`);
    }
  }, [layer, marineLayerId, onError]);

  if (!marineLayerId) {
    return null;
  }

  return (
    <MarineAuthenticatedTileLayer
      key={`sentinel-marine-${key}`}
      layerId={marineLayerId}
      date={date}
      opacity={opacity}
      minZoom={minZoom}
      maxZoom={maxZoom}
      className="sentinel-marine-layer"
      onLoadingChange={onLoadingChange}
      onError={onError}
    />
  );
};

/**
 * Hook for managing Sentinel tile layer state
 */
export function useSentinelTiles() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  const handleLoadingChange = useCallback((loading: boolean) => {
    setIsLoading(loading);
    if (!loading) setProgress(100);
  }, []);

  const handleError = useCallback((err: string) => {
    setError(err);
    setTimeout(() => setError(null), 5000);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    isLoading,
    error,
    progress,
    handleLoadingChange,
    handleError,
    clearError,
  };
}

/**
 * Zoom level indicator for Sentinel layers
 */
interface ZoomLevelIndicatorProps {
  currentZoom: number;
  minZoom: number;
}

export const ZoomLevelIndicator: React.FC<ZoomLevelIndicatorProps> = ({
  currentZoom,
  minZoom,
}) => {
  if (currentZoom >= minZoom) return null;

  return (
    <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-[1000] bg-white/90 rounded-lg shadow-lg px-6 py-4 text-center">
      <svg
        className="w-8 h-8 mx-auto mb-2 text-gray-400"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7"
        />
      </svg>
      <p className="text-sm font-medium text-gray-700">
        Uydu görüntüleri için yakınlaştırın
      </p>
      <p className="text-xs text-gray-500 mt-1">
        Mevcut: {Math.floor(currentZoom)} / Minimum: {minZoom}
      </p>
    </div>
  );
};

/**
 * Tile loading indicator with progress
 */
interface TileLoadingIndicatorProps {
  isLoading: boolean;
  progress?: number;
  layerName?: string;
}

export const TileLoadingIndicator: React.FC<TileLoadingIndicatorProps> = ({
  isLoading,
  progress,
  layerName,
}) => {
  if (!isLoading) return null;

  return (
    <div className="absolute bottom-4 left-4 z-[1000] bg-white/90 rounded-lg shadow px-3 py-2 flex items-center gap-2">
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
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
        />
      </svg>
      <span className="text-xs text-gray-600">
        {layerName ? `${layerName} yükleniyor...` : 'Yükleniyor...'}
      </span>
      {progress !== undefined && progress > 0 && progress < 100 && (
        <span className="text-xs text-gray-400">{progress}%</span>
      )}
    </div>
  );
};

/**
 * Error display component
 */
interface TileErrorDisplayProps {
  error: string | null;
  onDismiss?: () => void;
}

export const TileErrorDisplay: React.FC<TileErrorDisplayProps> = ({
  error,
  onDismiss,
}) => {
  if (!error) return null;

  return (
    <div className="absolute bottom-4 right-4 z-[1000] bg-red-50 border border-red-200 rounded-lg shadow px-4 py-3 flex items-center gap-3 max-w-sm">
      <svg
        className="w-5 h-5 text-red-500 flex-shrink-0"
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
      <span className="text-sm text-red-700">{error}</span>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="text-red-400 hover:text-red-600"
        >
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
            <path
              fillRule="evenodd"
              d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      )}
    </div>
  );
};

export default SentinelTileLayer;
