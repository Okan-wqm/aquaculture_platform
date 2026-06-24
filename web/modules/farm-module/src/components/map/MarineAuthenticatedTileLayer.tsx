import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import { useMap } from 'react-leaflet';
import {
  fetchMarineTileBlob,
  TILE_SIZE,
  type MarineLayerId,
} from '../../services/marineDataService';

interface MarineAuthenticatedTileLayerProps {
  layerId: MarineLayerId;
  date: Date;
  depth?: number;
  opacity?: number;
  minZoom?: number;
  maxZoom?: number;
  pane?: string;
  className?: string;
  onLoadingChange?: (isLoading: boolean) => void;
  onError?: (error: string) => void;
}

export const MarineAuthenticatedTileLayer: React.FC<MarineAuthenticatedTileLayerProps> = ({
  layerId,
  date,
  depth,
  opacity = 0.8,
  minZoom = 5,
  maxZoom = 16,
  pane,
  className = 'marine-authenticated-layer',
  onLoadingChange,
  onError,
}) => {
  const map = useMap();
  const layerRef = useRef<L.GridLayer | null>(null);
  const objectUrlsRef = useRef<Set<string>>(new Set());
  const loadingCountRef = useRef(0);

  useEffect(() => {
    const objectUrls = objectUrlsRef.current;

    const setTileDone = (
      done: (error?: Error | null, tile?: HTMLElement) => void,
      tile: HTMLImageElement,
      error?: Error,
    ) => {
      loadingCountRef.current = Math.max(0, loadingCountRef.current - 1);
      if (loadingCountRef.current === 0) {
        onLoadingChange?.(false);
      }
      done(error ?? undefined, tile);
    };

    const AuthenticatedGridLayer = L.GridLayer.extend({
      createTile(coords: L.Coords, done: (error?: Error | null, tile?: HTMLElement) => void) {
        const tile = document.createElement('img');
        tile.alt = '';
        tile.setAttribute('role', 'presentation');
        tile.style.width = `${TILE_SIZE}px`;
        tile.style.height = `${TILE_SIZE}px`;

        loadingCountRef.current += 1;
        onLoadingChange?.(true);

        fetchMarineTileBlob({
          layerId,
          z: coords.z,
          x: coords.x,
          y: coords.y,
          date,
          depth,
        })
          .then((blob) => {
            const objectUrl = URL.createObjectURL(blob);
            objectUrls.add(objectUrl);
            tile.onload = () => setTileDone(done, tile);
            tile.onerror = () => {
              objectUrls.delete(objectUrl);
              URL.revokeObjectURL(objectUrl);
              onError?.('Marine tile image could not be decoded');
              setTileDone(done, tile, new Error('Marine tile image could not be decoded'));
            };
            tile.src = objectUrl;
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : 'Marine tile request failed';
            onError?.(message);
            setTileDone(done, tile, error instanceof Error ? error : new Error(message));
          });

        return tile;
      },
    });

    const gridLayer = new AuthenticatedGridLayer();
    L.setOptions(gridLayer, {
      tileSize: TILE_SIZE,
      minZoom,
      maxZoom,
      opacity,
      pane,
      className,
    });

    gridLayer.addTo(map);
    layerRef.current = gridLayer;

    return () => {
      if (layerRef.current) {
        map.removeLayer(layerRef.current);
        layerRef.current = null;
      }
      loadingCountRef.current = 0;
      onLoadingChange?.(false);
      for (const objectUrl of objectUrls) {
        URL.revokeObjectURL(objectUrl);
      }
      objectUrls.clear();
    };
  }, [
    map,
    layerId,
    date,
    depth,
    opacity,
    minZoom,
    maxZoom,
    pane,
    className,
    onLoadingChange,
    onError,
  ]);

  useEffect(() => {
    layerRef.current?.setOpacity(opacity);
  }, [opacity]);

  return null;
};

export default MarineAuthenticatedTileLayer;
