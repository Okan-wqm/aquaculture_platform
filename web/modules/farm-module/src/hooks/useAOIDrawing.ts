/**
 * useAOIDrawing Hook
 *
 * Manages Area of Interest (AOI) drawing and selection state.
 * Integrates with Leaflet-Geoman for polygon/circle/rectangle drawing.
 *
 * Features:
 * - Create/Edit/Delete AOIs
 * - Calculate area and bounding box
 * - Persist AOIs to localStorage
 * - High-resolution analysis for selected AOI
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import * as turf from '@turf/turf';
import type { Layer } from 'leaflet';
import { useAuth } from '@aquaculture/shared-ui';

// AOI Types
export type AOIType = 'polygon' | 'circle' | 'rectangle';

export interface AOI {
  id: string;
  name: string;
  type: AOIType;
  geometry: GeoJSON.Polygon | GeoJSON.Point;
  bbox: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
  area: number; // km²
  radius?: number; // For circles, in meters
  center?: [number, number]; // For circles [lat, lng]
  color: string;
  createdAt: Date;
}

export type DrawingMode = 'none' | 'polygon' | 'circle' | 'rectangle';

export interface UseAOIDrawingReturn {
  // State
  aois: AOI[];
  activeAOI: AOI | null;
  drawingMode: DrawingMode;
  isDrawing: boolean;

  // Actions
  setDrawingMode: (mode: DrawingMode) => void;
  addAOI: (aoi: Omit<AOI, 'id' | 'createdAt'>) => AOI;
  updateAOI: (id: string, updates: Partial<AOI>) => void;
  deleteAOI: (id: string) => void;
  selectAOI: (id: string | null) => void;
  clearAllAOIs: () => void;
  renameAOI: (id: string, name: string) => void;

  // Utilities
  getAOIBounds: (aoi: AOI) => [[number, number], [number, number]];
  createAOIFromLayer: (layer: Layer, type: AOIType) => Omit<AOI, 'id' | 'createdAt'> | null;
}

// AOI Colors for visual distinction
const AOI_COLORS = [
  '#3b82f6', // blue
  '#ef4444', // red
  '#22c55e', // green
  '#f59e0b', // amber
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#ec4899', // pink
  '#84cc16', // lime
];

// LocalStorage key prefix — scoped per tenant at runtime
const STORAGE_KEY_PREFIX = 'aquaculture-aois';

/**
 * Calculate area of a GeoJSON polygon in km²
 */
function calculateArea(geometry: GeoJSON.Polygon | GeoJSON.Point, radius?: number): number {
  if (geometry.type === 'Point' && radius) {
    // Circle area
    return Math.PI * Math.pow(radius / 1000, 2); // Convert m to km
  }
  if (geometry.type === 'Polygon') {
    const area = turf.area(turf.polygon(geometry.coordinates));
    return area / 1_000_000; // Convert m² to km²
  }
  return 0;
}

/**
 * Calculate bounding box from geometry
 */
function calculateBBox(
  geometry: GeoJSON.Polygon | GeoJSON.Point,
  radius?: number
): [number, number, number, number] {
  if (geometry.type === 'Point' && radius) {
    const [lng, lat] = geometry.coordinates as [number, number];
    const point = turf.point([lng, lat]);
    const buffered = turf.buffer(point, radius / 1000, { units: 'kilometers' });
    if (!buffered) {
      return [lng - 0.01, lat - 0.01, lng + 0.01, lat + 0.01];
    }
    return turf.bbox(buffered) as [number, number, number, number];
  }
  if (geometry.type === 'Polygon') {
    return turf.bbox(turf.polygon(geometry.coordinates)) as [number, number, number, number];
  }
  return [0, 0, 0, 0];
}

/**
 * Convert Leaflet layer to GeoJSON geometry
 */
function layerToGeometry(
  layer: any,
  type: AOIType
): { geometry: GeoJSON.Polygon | GeoJSON.Point; radius?: number; center?: [number, number] } | null {
  try {
    if (type === 'circle' && layer.getRadius && layer.getLatLng) {
      const center = layer.getLatLng();
      const radius = layer.getRadius();
      return {
        geometry: {
          type: 'Point',
          coordinates: [center.lng, center.lat],
        },
        radius,
        center: [center.lat, center.lng],
      };
    }

    if (layer.toGeoJSON) {
      const geojson = layer.toGeoJSON();
      if (geojson.geometry.type === 'Polygon') {
        return {
          geometry: geojson.geometry,
        };
      }
    }

    return null;
  } catch (error) {
    console.error('Failed to convert layer to geometry:', error);
    return null;
  }
}

/**
 * Type guard: validate that a parsed localStorage value is a valid AOI array.
 * Blocks prototype-pollution and type-confusion attacks.
 */
function isValidAOIArray(parsed: unknown): parsed is Omit<AOI, 'createdAt'>[] {
  if (!Array.isArray(parsed)) return false;
  return parsed.every(
    (item) =>
      item !== null &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      // Block prototype keys
      !Object.prototype.hasOwnProperty.call(item, '__proto__') &&
      !Object.prototype.hasOwnProperty.call(item, 'constructor') &&
      typeof (item as Record<string, unknown>).id === 'string' &&
      typeof (item as Record<string, unknown>).name === 'string',
  );
}

export function useAOIDrawing(): UseAOIDrawingReturn {
  const { tenantId } = useAuth();
  // Scope key to tenant so users on shared browsers can't see each other's AOIs
  const storageKey = tenantId ? `${STORAGE_KEY_PREFIX}_${tenantId}` : STORAGE_KEY_PREFIX;

  // State
  const [aois, setAOIs] = useState<AOI[]>([]);
  const [activeAOIId, setActiveAOIId] = useState<string | null>(null);
  const [drawingMode, setDrawingMode] = useState<DrawingMode>('none');
  const colorIndexRef = useRef(0);
  const isFirstMountRef = useRef(true);

  // Derived state
  const activeAOI = aois.find((a) => a.id === activeAOIId) || null;
  const isDrawing = drawingMode !== 'none';

  /**
   * Load AOIs from localStorage when storageKey is ready (tenant available)
   */
  useEffect(() => {
    if (!storageKey) return;
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed: unknown = JSON.parse(stored);
        if (isValidAOIArray(parsed)) {
          const loadedAOIs = parsed.map((aoi) => ({
            ...aoi,
            createdAt: new Date((aoi as Record<string, unknown>).createdAt as string),
          }));
          setAOIs(loadedAOIs as AOI[]);
        }
      }
    } catch (error) {
      if (import.meta.env.DEV) console.error('Failed to load AOIs from storage:', error);
    }
  }, [storageKey]);

  /**
   * Save AOIs to localStorage when they change (skip initial mount write)
   */
  useEffect(() => {
    if (isFirstMountRef.current) {
      isFirstMountRef.current = false;
      return;
    }
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(aois));
    } catch (error) {
      if (import.meta.env.DEV) console.error('Failed to save AOIs to storage:', error);
    }
  }, [aois, storageKey]);

  /**
   * Get next color for new AOI
   */
  const getNextColor = useCallback(() => {
    const color = AOI_COLORS[colorIndexRef.current % AOI_COLORS.length];
    colorIndexRef.current += 1;
    return color;
  }, []);

  /**
   * Add a new AOI
   */
  const addAOI = useCallback(
    (aoiData: Omit<AOI, 'id' | 'createdAt'>): AOI => {
      const newAOI: AOI = {
        ...aoiData,
        id: crypto.randomUUID(),
        createdAt: new Date(),
        color: aoiData.color || getNextColor(),
      };
      setAOIs((prev) => [...prev, newAOI]);
      setActiveAOIId(newAOI.id);
      setDrawingMode('none');
      return newAOI;
    },
    [getNextColor]
  );

  /**
   * Update an existing AOI
   */
  const updateAOI = useCallback((id: string, updates: Partial<AOI>) => {
    setAOIs((prev) =>
      prev.map((aoi) => (aoi.id === id ? { ...aoi, ...updates } : aoi))
    );
  }, []);

  /**
   * Delete an AOI
   */
  const deleteAOI = useCallback((id: string) => {
    setAOIs((prev) => prev.filter((aoi) => aoi.id !== id));
    setActiveAOIId((current) => (current === id ? null : current));
  }, []);

  /**
   * Select an AOI
   */
  const selectAOI = useCallback((id: string | null) => {
    setActiveAOIId(id);
  }, []);

  /**
   * Clear all AOIs
   */
  const clearAllAOIs = useCallback(() => {
    setAOIs([]);
    setActiveAOIId(null);
  }, []);

  /**
   * Rename an AOI
   */
  const renameAOI = useCallback((id: string, name: string) => {
    updateAOI(id, { name });
  }, [updateAOI]);

  /**
   * Get bounds for an AOI (for map fitting)
   */
  const getAOIBounds = useCallback(
    (aoi: AOI): [[number, number], [number, number]] => {
      const [minLon, minLat, maxLon, maxLat] = aoi.bbox;
      return [
        [minLat, minLon],
        [maxLat, maxLon],
      ];
    },
    []
  );

  /**
   * Create AOI data from a Leaflet layer
   */
  const createAOIFromLayer = useCallback(
    (layer: Layer, type: AOIType): Omit<AOI, 'id' | 'createdAt'> | null => {
      const result = layerToGeometry(layer, type);
      if (!result) return null;

      const { geometry, radius, center } = result;
      const area = calculateArea(geometry, radius);
      const bbox = calculateBBox(geometry, radius);

      const typeNames: Record<AOIType, string> = {
        polygon: 'Poligon',
        circle: 'Daire',
        rectangle: 'Dikdörtgen',
      };

      return {
        name: `${typeNames[type]} ${aois.length + 1}`,
        type,
        geometry,
        bbox,
        area,
        radius,
        center,
        color: getNextColor(),
      };
    },
    [aois.length, getNextColor]
  );

  return {
    // State
    aois,
    activeAOI,
    drawingMode,
    isDrawing,

    // Actions
    setDrawingMode,
    addAOI,
    updateAOI,
    deleteAOI,
    selectAOI,
    clearAllAOIs,
    renameAOI,

    // Utilities
    getAOIBounds,
    createAOIFromLayer,
  };
}

export default useAOIDrawing;
