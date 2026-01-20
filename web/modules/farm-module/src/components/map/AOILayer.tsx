/**
 * AOILayer Component
 *
 * Renders AOIs (Areas of Interest) on the map as Leaflet layers.
 * Handles polygon, circle, and rectangle shapes.
 */

import React from 'react';
import { Polygon, Circle, useMap } from 'react-leaflet';
import type { AOI } from '../../hooks/useAOIDrawing';

interface AOILayerProps {
  aois: AOI[];
  activeAOI: AOI | null;
  onSelectAOI: (id: string) => void;
}

export const AOILayer: React.FC<AOILayerProps> = ({
  aois,
  activeAOI,
  onSelectAOI,
}) => {
  const map = useMap();

  return (
    <>
      {aois.map((aoi) => {
        const isActive = activeAOI?.id === aoi.id;
        const pathOptions = {
          color: aoi.color,
          fillColor: aoi.color,
          fillOpacity: isActive ? 0.3 : 0.15,
          weight: isActive ? 3 : 2,
          dashArray: isActive ? undefined : '5, 5',
        };

        const eventHandlers = {
          click: () => {
            onSelectAOI(aoi.id);
          },
        };

        // Render circle
        if (aoi.type === 'circle' && aoi.center && aoi.radius) {
          return (
            <Circle
              key={aoi.id}
              center={aoi.center}
              radius={aoi.radius}
              pathOptions={pathOptions}
              eventHandlers={eventHandlers}
            />
          );
        }

        // Render polygon/rectangle
        if (aoi.geometry.type === 'Polygon') {
          // Convert GeoJSON coordinates to Leaflet format (lat, lng)
          const positions = aoi.geometry.coordinates[0].map(
            (coord: number[]) => [coord[1], coord[0]] as [number, number]
          );

          return (
            <Polygon
              key={aoi.id}
              positions={positions}
              pathOptions={pathOptions}
              eventHandlers={eventHandlers}
            />
          );
        }

        return null;
      })}
    </>
  );
};

export default AOILayer;
