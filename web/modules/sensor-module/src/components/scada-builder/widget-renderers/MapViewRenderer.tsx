/**
 * MapViewRenderer - SVG-based device map widget
 *
 * Renders device markers at configurable x,y coordinates (0-100% range)
 * on a simple grid. Marker colors indicate device status:
 *   green = online, red = offline, gray = unknown
 *
 * No external dependencies - pure SVG rendering.
 */

import React, { memo, useState, useCallback } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface DeviceMarker {
  id: string;
  label: string;
  x: number; // 0-100 percentage
  y: number; // 0-100 percentage
  status: 'online' | 'offline' | 'unknown';
  tagName?: string;
}

type DeviceStatus = DeviceMarker['status'];

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const STATUS_COLORS: Record<DeviceStatus, string> = {
  online: '#22c55e',
  offline: '#ef4444',
  unknown: '#9ca3af',
};

const HEADER_HEIGHT = 24;
const MARKER_RADIUS = 7;
const MARKER_HOVER_RADIUS = 10;
const GRID_DIVISIONS = 5;
const TOOLTIP_WIDTH = 100;
const TOOLTIP_HEIGHT = 22;
const TOOLTIP_OFFSET = 30;
const LABEL_OFFSET = 12;
const PULSE_DURATION = '2s';

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

const GridLines: React.FC<{ mapWidth: number; mapHeight: number }> = ({ mapWidth, mapHeight }) => (
  <>
    {Array.from({ length: GRID_DIVISIONS - 1 }, (_, i) => {
      const xPos = (mapWidth / GRID_DIVISIONS) * (i + 1);
      const yPos = (mapHeight / GRID_DIVISIONS) * (i + 1);
      return (
        <g key={`grid-${i}`} opacity={0.15}>
          <line x1={xPos} y1={0} x2={xPos} y2={mapHeight} stroke="#fff" strokeWidth={0.5} />
          <line x1={0} y1={yPos} x2={mapWidth} y2={yPos} stroke="#fff" strokeWidth={0.5} />
        </g>
      );
    })}
  </>
);

GridLines.displayName = 'GridLines';

const PulseRing: React.FC<{ cx: number; cy: number; color: string }> = ({ cx, cy, color }) => (
  <circle cx={cx} cy={cy} r={12} fill="none" stroke={color} strokeWidth={1.5} opacity={0.3}>
    <animate attributeName="r" from="8" to="16" dur={PULSE_DURATION} repeatCount="indefinite" />
    <animate attributeName="opacity" from="0.4" to="0" dur={PULSE_DURATION} repeatCount="indefinite" />
  </circle>
);

PulseRing.displayName = 'PulseRing';

const MarkerTooltip: React.FC<{ cx: number; cy: number; r: number; marker: DeviceMarker }> = ({
  cx, cy, r, marker,
}) => {
  const tooltipX = cx - TOOLTIP_WIDTH / 2;
  const tooltipY = cy - r - TOOLTIP_OFFSET;
  const textX = cx;
  const textY = cy - r - TOOLTIP_OFFSET + TOOLTIP_HEIGHT / 2 + 3;
  const tooltipText = marker.tagName
    ? `${marker.label} [${marker.tagName}]`
    : `${marker.label} (${marker.status})`;

  return (
    <g>
      <rect
        x={tooltipX}
        y={tooltipY}
        width={TOOLTIP_WIDTH}
        height={TOOLTIP_HEIGHT}
        rx={4}
        fill="rgba(0,0,0,0.85)"
      />
      <text
        x={textX}
        y={textY}
        textAnchor="middle"
        fontSize={9}
        fill="#fff"
        fontFamily="sans-serif"
      >
        {tooltipText}
      </text>
    </g>
  );
};

MarkerTooltip.displayName = 'MarkerTooltip';

/* ------------------------------------------------------------------ */
/*  Main renderer                                                      */
/* ------------------------------------------------------------------ */

const MapViewRenderer: React.FC<WidgetRendererProps> = ({ config, width, height }) => {
  const markers = (config.markers ?? []) as DeviceMarker[];
  const bgColor = (config.bgColor ?? '#0c4a6e') as string;
  const showGrid = (config.showGrid ?? true) as boolean;
  const title = (config.title ?? 'Site Map') as string;

  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const handleMouseEnter = useCallback((id: string) => {
    setHoveredId(id);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setHoveredId(null);
  }, []);

  const mapHeight = height - HEADER_HEIGHT;

  return (
    <div style={{ width, height, borderRadius: 4, overflow: 'hidden', background: bgColor }}>
      {/* Header */}
      <div
        style={{
          height: HEADER_HEIGHT,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(0,0,0,0.3)',
          color: '#fff',
          fontSize: 10,
          fontWeight: 600,
        }}
      >
        {title}
      </div>

      {/* Map area */}
      <svg width={width} height={mapHeight} viewBox={`0 0 ${width} ${mapHeight}`}>
        {/* Grid lines */}
        {showGrid && <GridLines mapWidth={width} mapHeight={mapHeight} />}

        {/* Device markers */}
        {markers.map((marker) => {
          const cx = (marker.x / 100) * width;
          const cy = (marker.y / 100) * mapHeight;
          const color = STATUS_COLORS[marker.status] ?? STATUS_COLORS.unknown;
          const isHovered = hoveredId === marker.id;
          const r = isHovered ? MARKER_HOVER_RADIUS : MARKER_RADIUS;

          return (
            <g
              key={marker.id}
              onMouseEnter={() => handleMouseEnter(marker.id)}
              onMouseLeave={handleMouseLeave}
              style={{ cursor: 'pointer' }}
            >
              {/* Pulse ring for online devices */}
              {marker.status === 'online' && (
                <PulseRing cx={cx} cy={cy} color={color} />
              )}

              {/* Marker circle */}
              <circle
                cx={cx}
                cy={cy}
                r={r}
                fill={color}
                stroke="#fff"
                strokeWidth={2}
                style={{ transition: 'r 0.15s ease' }}
              />

              {/* Label */}
              <text
                x={cx}
                y={cy + r + LABEL_OFFSET}
                textAnchor="middle"
                fontSize={9}
                fill="#fff"
                fontFamily="sans-serif"
                opacity={0.9}
              >
                {marker.label}
              </text>

              {/* Hover tooltip */}
              {isHovered && (
                <MarkerTooltip cx={cx} cy={cy} r={r} marker={marker} />
              )}
            </g>
          );
        })}

        {/* Empty state */}
        {markers.length === 0 && (
          <text
            x={width / 2}
            y={mapHeight / 2}
            textAnchor="middle"
            fontSize={11}
            fill="#fff"
            fontFamily="sans-serif"
            opacity={0.5}
          >
            No markers configured
          </text>
        )}
      </svg>
    </div>
  );
};

MapViewRenderer.displayName = 'MapViewRenderer';
export default memo(MapViewRenderer);
