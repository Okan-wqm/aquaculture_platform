/**
 * useMapPointQuery Hook
 *
 * React hook for querying water quality data at map click positions.
 * Handles state management, loading states, and error handling.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import {
  queryPointData,
  PointQueryResult,
  WaterQualityLayerType,
  getLayerDataSource,
} from '../services/pointQueryService';

/**
 * Point position interface
 */
export interface ClickedPoint {
  lat: number;
  lng: number;
}

/**
 * Hook state interface
 */
export interface MapPointQueryState {
  /** Currently clicked point coordinates */
  clickedPoint: ClickedPoint | null;
  /** Query result data */
  pointData: PointQueryResult | null;
  /** Loading state */
  isLoading: boolean;
  /** Error message */
  error: string | null;
  /** Last query time */
  lastQueryTime: Date | null;
}

/**
 * Hook return interface
 */
export interface UseMapPointQueryReturn extends MapPointQueryState {
  /** Handle map click event */
  handleMapClick: (
    lat: number,
    lng: number,
    layer: WaterQualityLayerType,
    date: Date
  ) => Promise<void>;
  /** Clear current point and data */
  clearPoint: () => void;
  /** Refresh data for current point */
  refreshPoint: () => Promise<void>;
  /** Clear error */
  clearError: () => void;
  /** Check if query is supported for layer */
  isQuerySupported: (layer: WaterQualityLayerType) => boolean;
}

/**
 * Hook options interface
 */
export interface UseMapPointQueryOptions {
  /** Debounce delay in ms (default: 300) */
  debounceMs?: number;
  /** Auto-clear error after ms (default: 5000, 0 to disable) */
  errorAutoClearMs?: number;
  /** Callback when query completes */
  onQueryComplete?: (result: PointQueryResult) => void;
  /** Callback when query fails */
  onQueryError?: (error: string) => void;
}

/**
 * Layers that don't support point queries
 * (e.g., base layers like osm, satellite)
 */
const UNSUPPORTED_LAYERS = ['osm', 'satellite', 'TRUE-COLOR'];

/**
 * useMapPointQuery Hook
 *
 * Manages map click-based water quality data queries.
 *
 * @example
 * ```tsx
 * const {
 *   clickedPoint,
 *   pointData,
 *   isLoading,
 *   handleMapClick,
 *   clearPoint
 * } = useMapPointQuery();
 *
 * // In MapContainer
 * <MapContainer onClick={(e) => handleMapClick(e.latlng.lat, e.latlng.lng, activeLayer, selectedDate)}>
 *   {clickedPoint && pointData && (
 *     <PointDataPopup position={[clickedPoint.lat, clickedPoint.lng]} data={pointData} />
 *   )}
 * </MapContainer>
 * ```
 */
export function useMapPointQuery(options: UseMapPointQueryOptions = {}): UseMapPointQueryReturn {
  const {
    debounceMs = 300,
    errorAutoClearMs = 5000,
    onQueryComplete,
    onQueryError,
  } = options;

  // State
  const [clickedPoint, setClickedPoint] = useState<ClickedPoint | null>(null);
  const [pointData, setPointData] = useState<PointQueryResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastQueryTime, setLastQueryTime] = useState<Date | null>(null);

  // Refs for tracking current query and debounce
  const currentQueryRef = useRef<{ layer: WaterQualityLayerType; date: Date } | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Auto-clear error
  useEffect(() => {
    if (error && errorAutoClearMs > 0) {
      const timer = setTimeout(() => {
        setError(null);
      }, errorAutoClearMs);

      return () => clearTimeout(timer);
    }
  }, [error, errorAutoClearMs]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  /**
   * Check if query is supported for a layer
   */
  const isQuerySupported = useCallback((layer: WaterQualityLayerType): boolean => {
    return !UNSUPPORTED_LAYERS.includes(layer as string);
  }, []);

  /**
   * Execute the point query
   */
  const executeQuery = useCallback(
    async (lat: number, lng: number, layer: WaterQualityLayerType, date: Date) => {
      // Abort any existing request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      // Create new abort controller
      abortControllerRef.current = new AbortController();

      // Store current query params for refresh
      currentQueryRef.current = { layer, date };

      setIsLoading(true);
      setError(null);

      try {
        const result = await queryPointData(lat, lng, layer, date);

        // Check if request was aborted
        if (abortControllerRef.current?.signal.aborted) {
          return;
        }

        setPointData(result);
        setLastQueryTime(new Date());

        if (result.error) {
          setError(result.error);
          onQueryError?.(result.error);
        } else {
          onQueryComplete?.(result);
        }
      } catch (err) {
        // Check if request was aborted
        if (abortControllerRef.current?.signal.aborted) {
          return;
        }

        const errorMessage = err instanceof Error ? err.message : 'Veri sorgusu başarısız';
        setError(errorMessage);
        onQueryError?.(errorMessage);
      } finally {
        if (!abortControllerRef.current?.signal.aborted) {
          setIsLoading(false);
        }
      }
    },
    [onQueryComplete, onQueryError]
  );

  /**
   * Handle map click event
   */
  const handleMapClick = useCallback(
    async (lat: number, lng: number, layer: WaterQualityLayerType, date: Date) => {
      // Check if layer supports point queries
      if (!isQuerySupported(layer)) {
        setError(`${layer} katmanı için nokta sorgusu desteklenmiyor. Su kalitesi katmanı seçin.`);
        return;
      }

      // Clear any pending debounce
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      // Set clicked point immediately for visual feedback
      setClickedPoint({ lat, lng });

      // Debounce the actual query
      if (debounceMs > 0) {
        debounceTimerRef.current = setTimeout(() => {
          executeQuery(lat, lng, layer, date);
        }, debounceMs);
      } else {
        await executeQuery(lat, lng, layer, date);
      }
    },
    [debounceMs, executeQuery, isQuerySupported]
  );

  /**
   * Clear current point and data
   */
  const clearPoint = useCallback(() => {
    // Cancel any pending operations
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Reset state
    setClickedPoint(null);
    setPointData(null);
    setError(null);
    setIsLoading(false);
    currentQueryRef.current = null;
  }, []);

  /**
   * Refresh data for current point
   */
  const refreshPoint = useCallback(async () => {
    if (!clickedPoint || !currentQueryRef.current) {
      return;
    }

    const { layer, date } = currentQueryRef.current;
    await executeQuery(clickedPoint.lat, clickedPoint.lng, layer, date);
  }, [clickedPoint, executeQuery]);

  /**
   * Clear error
   */
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    clickedPoint,
    pointData,
    isLoading,
    error,
    lastQueryTime,
    handleMapClick,
    clearPoint,
    refreshPoint,
    clearError,
    isQuerySupported,
  };
}

/**
 * Hook for managing multiple simultaneous point queries
 * (e.g., for comparing values across locations)
 */
export interface MultiPointState {
  points: Array<{
    id: string;
    position: ClickedPoint;
    data: PointQueryResult | null;
    isLoading: boolean;
  }>;
  activePointId: string | null;
}

export function useMultiPointQuery(maxPoints: number = 5) {
  const [points, setPoints] = useState<MultiPointState['points']>([]);
  const [activePointId, setActivePointId] = useState<string | null>(null);

  const addPoint = useCallback(
    async (lat: number, lng: number, layer: WaterQualityLayerType, date: Date) => {
      const id = `point-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      // Add point in loading state
      setPoints((prev) => {
        const newPoints = [
          ...prev,
          { id, position: { lat, lng }, data: null, isLoading: true },
        ];
        // Enforce max points
        if (newPoints.length > maxPoints) {
          return newPoints.slice(-maxPoints);
        }
        return newPoints;
      });

      setActivePointId(id);

      // Execute query
      try {
        const result = await queryPointData(lat, lng, layer, date);
        setPoints((prev) =>
          prev.map((p) => (p.id === id ? { ...p, data: result, isLoading: false } : p))
        );
      } catch {
        setPoints((prev) => prev.map((p) => (p.id === id ? { ...p, isLoading: false } : p)));
      }

      return id;
    },
    [maxPoints]
  );

  const removePoint = useCallback((id: string) => {
    setPoints((prev) => prev.filter((p) => p.id !== id));
    setActivePointId((prev) => (prev === id ? null : prev));
  }, []);

  const clearAllPoints = useCallback(() => {
    setPoints([]);
    setActivePointId(null);
  }, []);

  const setActivePoint = useCallback((id: string | null) => {
    setActivePointId(id);
  }, []);

  return {
    points,
    activePointId,
    addPoint,
    removePoint,
    clearAllPoints,
    setActivePoint,
  };
}

export default useMapPointQuery;
