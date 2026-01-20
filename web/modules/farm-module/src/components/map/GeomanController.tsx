/**
 * GeomanController Component
 *
 * This component MUST be placed INSIDE MapContainer.
 * It handles Leaflet-Geoman initialization and drawing events.
 *
 * The UI controls (buttons, AOI list) are in AOIDrawingControls.tsx
 * which renders OUTSIDE MapContainer.
 */

import { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import type { Layer } from 'leaflet';
import '@geoman-io/leaflet-geoman-free';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';
import type { DrawingMode, AOIType } from '../../hooks/useAOIDrawing';

interface GeomanControllerProps {
  drawingMode: DrawingMode;
  onAOICreated: (layer: Layer, type: AOIType) => void;
}

export const GeomanController: React.FC<GeomanControllerProps> = ({
  drawingMode,
  onAOICreated,
}) => {
  const map = useMap();
  const initializedRef = useRef(false);
  const previousModeRef = useRef<DrawingMode>('none');

  // Initialize Geoman once
  useEffect(() => {
    if (!map || initializedRef.current) return;

    // Hide default Geoman controls (we use our own UI)
    map.pm.addControls({
      position: 'topleft',
      drawMarker: false,
      drawPolyline: false,
      drawRectangle: false,
      drawPolygon: false,
      drawCircle: false,
      drawCircleMarker: false,
      drawText: false,
      editMode: false,
      dragMode: false,
      cutPolygon: false,
      removalMode: false,
      rotateMode: false,
    });

    // Remove the control container completely
    const controlContainer = document.querySelector('.leaflet-pm-toolbar');
    if (controlContainer) {
      controlContainer.remove();
    }

    // Set global options for drawing
    map.pm.setGlobalOptions({
      snappable: true,
      snapDistance: 20,
      allowSelfIntersection: false,
      templineStyle: {
        color: '#3b82f6',
        weight: 2,
        dashArray: '5, 5',
      },
      hintlineStyle: {
        color: '#3b82f6',
        weight: 2,
        dashArray: '5, 5',
      },
      pathOptions: {
        color: '#3b82f6',
        fillColor: '#3b82f6',
        fillOpacity: 0.2,
        weight: 2,
      },
    });

    initializedRef.current = true;
  }, [map]);

  // Handle pm:create event
  useEffect(() => {
    if (!map) return;

    const handleCreate = (e: any) => {
      const { layer, shape } = e;

      // Map Geoman shape names to our AOI types
      const shapeToType: Record<string, AOIType> = {
        Polygon: 'polygon',
        Rectangle: 'rectangle',
        Circle: 'circle',
      };

      const aoiType = shapeToType[shape];
      if (aoiType) {
        // Remove the drawn layer from map (we'll render it via AOILayer)
        map.removeLayer(layer);

        // Notify parent about the new AOI
        onAOICreated(layer, aoiType);
      }

      // Disable drawing mode after creation
      map.pm.disableDraw();
    };

    map.on('pm:create', handleCreate);

    return () => {
      map.off('pm:create', handleCreate);
    };
  }, [map, onAOICreated]);

  // Handle drawing mode changes
  useEffect(() => {
    if (!map || !initializedRef.current) return;

    // Only act if mode actually changed
    if (previousModeRef.current === drawingMode) return;
    previousModeRef.current = drawingMode;

    // First disable any active drawing
    map.pm.disableDraw();

    // Enable the appropriate drawing mode
    const modeToGeoman: Record<DrawingMode, string | null> = {
      none: null,
      polygon: 'Polygon',
      circle: 'Circle',
      rectangle: 'Rectangle',
    };

    const geomanMode = modeToGeoman[drawingMode];
    if (geomanMode) {
      map.pm.enableDraw(geomanMode, {
        snappable: true,
        snapDistance: 20,
        allowSelfIntersection: false,
        templineStyle: {
          color: '#3b82f6',
          weight: 2,
          dashArray: '5, 5',
        },
        hintlineStyle: {
          color: '#3b82f6',
          weight: 2,
          dashArray: '5, 5',
        },
        pathOptions: {
          color: '#3b82f6',
          fillColor: '#3b82f6',
          fillOpacity: 0.2,
          weight: 2,
        },
      });
    }
  }, [map, drawingMode]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (map && initializedRef.current) {
        map.pm.disableDraw();
      }
    };
  }, [map]);

  // This component doesn't render anything
  return null;
};

export default GeomanController;
