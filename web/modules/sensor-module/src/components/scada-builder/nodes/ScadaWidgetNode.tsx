/**
 * SCADA Builder ScadaWidgetNode - Generic ReactFlow node wrapper for ALL SCADA widgets.
 *
 * Every SCADA widget placed on the canvas is rendered through this single
 * node type.  The `widgetType` field inside `data` determines which
 * concrete renderer is loaded via `WidgetRenderer`.
 *
 * Features:
 * - Manual resize via corner/edge drag handles (selected state)
 * - Per-widget-type min/max size constraints
 * - Connection handles for equipment widgets (P&ID flow connections)
 * - Cyan selection border matching SCADA theme
 * - Widget-type badge shown in edit mode (top-left corner)
 */

import React, { memo, useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { NodeProps } from 'reactflow';
import { Handle, Position } from 'reactflow';
import { WidgetRenderer } from '../WidgetRenderer';
import type { ScadaWidgetNodeData } from '../../../types/scada-widget.types';
import type { EquipmentConnectionPoint } from '../../../types/scada-widget.types';
import { getWidgetPixelConstraints } from '../../../constants/scada-widget-sizes';
import { CONNECTION_POINTS, CONNECTION_POINT_COLORS, EQUIPMENT_VIEWBOX } from '../equipment-symbols/types';
export type { ScadaWidgetNodeData } from '../../../types/scada-widget.types';

/* ------------------------------------------------------------------ */
/*  Size constraints per widget type (from centralized constants)      */
/* ------------------------------------------------------------------ */

interface SizeConstraints {
  minW: number;
  minH: number;
  maxW: number;
  maxH: number;
  defaultW: number;
  defaultH: number;
}

export const WIDGET_SIZE_CONSTRAINTS: Record<string, SizeConstraints> = new Proxy(
  {} as Record<string, SizeConstraints>,
  {
    get(_target, prop: string) {
      return getWidgetPixelConstraints(prop);
    },
  },
);

const DEFAULT_CONSTRAINTS: SizeConstraints = getWidgetPixelConstraints('__default__');

/* ------------------------------------------------------------------ */
/*  Resize handle positions                                            */
/* ------------------------------------------------------------------ */

type HandleDir = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w';

const HANDLE_META: Record<HandleDir, { cursor: string; style: React.CSSProperties }> = {
  nw: { cursor: 'nwse-resize', style: { top: -5, left: -5 } },
  ne: { cursor: 'nesw-resize', style: { top: -5, right: -5 } },
  sw: { cursor: 'nesw-resize', style: { bottom: -5, left: -5 } },
  se: { cursor: 'nwse-resize', style: { bottom: -5, right: -5 } },
  n:  { cursor: 'ns-resize',   style: { top: -4, left: '50%', transform: 'translateX(-50%)' } },
  s:  { cursor: 'ns-resize',   style: { bottom: -4, left: '50%', transform: 'translateX(-50%)' } },
  e:  { cursor: 'ew-resize',   style: { right: -4, top: '50%', transform: 'translateY(-50%)' } },
  w:  { cursor: 'ew-resize',   style: { left: -4, top: '50%', transform: 'translateY(-50%)' } },
};

/* ------------------------------------------------------------------ */
/*  Static styles                                                      */
/* ------------------------------------------------------------------ */

const BADGE_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: 4,
  left: 4,
  zIndex: 10,
  fontSize: 9,
  fontWeight: 600,
  lineHeight: '14px',
  padding: '1px 5px',
  borderRadius: 4,
  background: '#0e7490',
  color: '#ecfeff',
  pointerEvents: 'none',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
};

const CONTENT_STYLE: React.CSSProperties = {
  width: '100%',
  height: '100%',
  overflow: 'hidden' as const,
};

/**
 * CSS for handle hover/pulse effects.
 * TODO: Inject this once at the canvas level (e.g. in ScreenCanvas) instead of
 * rendering a <style> tag inside every ScadaWidgetNode instance.
 */
export const HANDLE_HOVER_CSS = `
  .react-flow__handle:hover {
    transform: scale(1.5);
    box-shadow: 0 0 6px 2px rgba(6, 182, 212, 0.5);
    transition: transform 0.15s ease, box-shadow 0.15s ease;
  }
  .react-flow__handle.connecting {
    animation: handle-pulse 1s ease-in-out infinite;
  }
  @keyframes handle-pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(6, 182, 212, 0.4); }
    50% { box-shadow: 0 0 0 6px rgba(6, 182, 212, 0); }
  }
`;

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

const ScadaWidgetNode: React.FC<NodeProps<ScadaWidgetNodeData>> = ({ data, selected }) => {
  const constraints = WIDGET_SIZE_CONSTRAINTS[data.widgetType] || DEFAULT_CONSTRAINTS;

  const [size, setSize] = useState({
    width: data.width ?? constraints.defaultW,
    height: data.height ?? constraints.defaultH,
  });

  // Sync if parent pushes new dimensions via data
  useEffect(() => {
    if (data.width != null) setSize((s) => ({ ...s, width: data.width! }));
    if (data.height != null) setSize((s) => ({ ...s, height: data.height! }));
  }, [data.width, data.height]);

  /* ---------- Resize logic ---------------------------------------- */
  const dragRef = useRef<{
    dir: HandleDir;
    startX: number;
    startY: number;
    startW: number;
    startH: number;
  } | null>(null);

  const sizeRef = useRef(size);
  useEffect(() => { sizeRef.current = size; }, [size]);

  const clamp = useCallback(
    (w: number, h: number) => ({
      width: Math.max(constraints.minW, Math.min(constraints.maxW, w)),
      height: Math.max(constraints.minH, Math.min(constraints.maxH, h)),
    }),
    [constraints],
  );

  const onPointerDown = useCallback(
    (dir: HandleDir) => (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = {
        dir,
        startX: e.clientX,
        startY: e.clientY,
        startW: sizeRef.current.width,
        startH: sizeRef.current.height,
      };
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragRef.current) return;
      const { dir, startX, startY, startW, startH } = dragRef.current;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      let w = startW;
      let h = startH;
      if (dir.includes('e')) w = startW + dx;
      if (dir.includes('w')) w = startW - dx;
      if (dir.includes('s')) h = startH + dy;
      if (dir.includes('n')) h = startH - dy;

      setSize(clamp(w, h));
    },
    [clamp],
  );

  const onPointerUp = useCallback(() => {
    if (dragRef.current) {
      dragRef.current = null;
      // Notify parent of final size
      if (data.onResize) {
        data.onResize(data.widgetType, sizeRef.current.width, sizeRef.current.height);
      }
    }
  }, [data]);

  /* ---------- Memoized styles ------------------------------------- */
  const isEquipment = data.widgetType === 'equipment';

  const containerStyle = useMemo(() => ({
    width: size.width,
    height: size.height,
    position: 'relative' as const,
    zIndex: 500,
    borderRadius: isEquipment ? 4 : 8,
    border: selected
      ? '2px solid #06b6d4'
      : isEquipment ? '1px solid transparent' : '1px solid #e5e7eb',
    boxShadow: selected
      ? '0 0 0 2px rgba(6,182,212,0.35)'
      : isEquipment ? 'none' : '0 1px 3px rgba(0,0,0,0.1)',
    background: isEquipment ? 'transparent' : '#ffffff',
    overflow: 'visible' as const,
    userSelect: 'none' as const,
  }), [size.width, size.height, selected, isEquipment]);

  /* ---------- Connection handles for equipment widgets ------------- */
  const connectionHandles = useMemo(() => {
    if (data.widgetType !== 'equipment') return null;
    const subType = (data.config.equipmentSubType as string) || '';
    const points = CONNECTION_POINTS[subType];
    if (!points || points.length === 0) return null;
    return points;
  }, [data.widgetType, data.config.equipmentSubType]);

  /* ---------- SVG render rect for handle alignment --------------- */
  const svgRect = useMemo(() => {
    if (data.widgetType !== 'equipment') return null;
    const subType = (data.config.equipmentSubType as string) || '';
    const vb = EQUIPMENT_VIEWBOX[subType];
    if (!vb) return null;
    const containerW = size.width;
    const containerH = size.height;
    const containerAR = containerW / containerH;
    const svgAR = vb.width / vb.height;
    let renderW: number, renderH: number;
    if (containerAR > svgAR) {
      renderH = containerH; renderW = containerH * svgAR;
    } else {
      renderW = containerW; renderH = containerW / svgAR;
    }
    return {
      x: (containerW - renderW) / 2,
      y: (containerH - renderH) / 2,
      width: renderW,
      height: renderH,
    };
  }, [data.widgetType, data.config.equipmentSubType, size.width, size.height]);

  /* ---------- Render ---------------------------------------------- */
  return (
    <div
      style={containerStyle}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {/* TODO: Move this to canvas level so it's injected once, not per node */}
      <style>{HANDLE_HOVER_CSS}</style>

      {/* Widget type badge (edit mode, top-left) */}
      <span style={BADGE_STYLE}>
        {(data.config.label as string) || (data.widgetType === 'equipment'
          ? (data.config.equipmentSubType as string) || 'equipment'
          : data.widgetType)}
      </span>

      {/* Widget content - overflow hidden here to clip widget internals */}
      <div style={CONTENT_STYLE}>
        <WidgetRenderer
          widgetType={data.widgetType}
          config={data.config}
          value={data.liveValue}
          width={size.width}
          height={size.height}
          isEditing
        />
      </div>

      {/* Resize handles (only when selected) */}
      {selected &&
        (Object.entries(HANDLE_META) as [HandleDir, typeof HANDLE_META[HandleDir]][]).map(
          ([dir, meta]) => {
            const isCorner = dir.length === 2;
            return (
              <div
                key={dir}
                onPointerDown={onPointerDown(dir)}
                style={{
                  position: 'absolute',
                  width: isCorner ? 10 : 6,
                  height: isCorner ? 10 : 6,
                  background: '#06b6d4',
                  border: '2px solid white',
                  borderRadius: isCorner ? 3 : 2,
                  cursor: meta.cursor,
                  zIndex: 100,
                  pointerEvents: 'all',
                  ...meta.style,
                }}
              />
            );
          },
        )}

      {/* Connection handles for equipment widgets */}
      {connectionHandles && connectionHandles.map((pt) => {
        const posMap: Record<string, Position> = {
          top: Position.Top,
          right: Position.Right,
          bottom: Position.Bottom,
          left: Position.Left,
        };
        const position = posMap[pt.side] || Position.Left;

        // Calculate offset — use SVG render rect for proper alignment
        const posStyle: React.CSSProperties = {};
        if (svgRect) {
          if (pt.side === 'top' || pt.side === 'bottom') {
            posStyle.left = `${((svgRect.x + pt.offset * svgRect.width) / size.width) * 100}%`;
          } else {
            posStyle.top = `${((svgRect.y + pt.offset * svgRect.height) / size.height) * 100}%`;
          }
        } else {
          if (pt.side === 'top' || pt.side === 'bottom') {
            posStyle.left = `${pt.offset * 100}%`;
          } else {
            posStyle.top = `${pt.offset * 100}%`;
          }
        }

        const color = CONNECTION_POINT_COLORS[pt.direction];
        const handleStyle: React.CSSProperties = {
          width: 10,
          height: 10,
          background: color,
          border: '2px solid white',
          borderRadius: '50%',
          ...posStyle,
        };

        if (pt.direction === 'inout') {
          // Render both source and target handles at same position
          // Use distinct IDs so ReactFlow can distinguish them
          return [
            <Handle
              key={`${pt.id}-source`}
              id={`${pt.id}-out`}
              type="source"
              position={position}
              style={handleStyle}
              title={pt.label}
            />,
            <Handle
              key={`${pt.id}-target`}
              id={`${pt.id}-in`}
              type="target"
              position={position}
              style={{ ...handleStyle, opacity: 0, pointerEvents: 'all' as const }}
              title={pt.label}
            />,
          ];
        }

        return (
          <Handle
            key={pt.id}
            id={pt.id}
            type={pt.direction === 'out' ? 'source' : 'target'}
            position={position}
            style={handleStyle}
            title={pt.label}
          />
        );
      })}
    </div>
  );
};

ScadaWidgetNode.displayName = 'ScadaWidgetNode';

export default memo(ScadaWidgetNode);
