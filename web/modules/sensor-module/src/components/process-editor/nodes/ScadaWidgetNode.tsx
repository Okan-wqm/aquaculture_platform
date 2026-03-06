/**
 * ScadaWidgetNode - Generic ReactFlow node wrapper for ALL SCADA widgets.
 *
 * Every SCADA widget placed on the canvas is rendered through this single
 * node type.  The `widgetType` field inside `data` determines which
 * concrete renderer is loaded via `WidgetRenderer`.
 *
 * Features:
 * - Manual resize via corner/edge drag handles (selected state)
 * - Per-widget-type min/max size constraints
 * - connectable: false (SCADA widgets never participate in edges)
 * - Cyan selection border matching SCADA theme
 * - Widget-type badge shown in edit mode (top-left corner)
 */

import React, { memo, useState, useCallback, useRef, useEffect } from 'react';
import type { NodeProps } from 'reactflow';
import { WidgetRenderer } from '../../scada-builder/WidgetRenderer';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ScadaWidgetNodeData {
  widgetType: string;
  config: Record<string, any>;
  screenId: string;
  liveValue?: number | string | boolean;
  label?: string;
  tagName?: string;
  tagFqn?: string;
  width?: number;
  height?: number;
}

/* ------------------------------------------------------------------ */
/*  Size constraints per widget type                                   */
/* ------------------------------------------------------------------ */

interface SizeConstraints {
  minW: number;
  minH: number;
  maxW: number;
  maxH: number;
  defaultW: number;
  defaultH: number;
}

export const WIDGET_SIZE_CONSTRAINTS: Record<string, SizeConstraints> = {
  gauge:               { minW: 120, minH: 120, maxW: 400, maxH: 400, defaultW: 200, defaultH: 200 },
  numericDisplay:      { minW: 100, minH: 60,  maxW: 400, maxH: 200, defaultW: 180, defaultH: 100 },
  statusIndicator:     { minW: 80,  minH: 80,  maxW: 300, maxH: 200, defaultW: 140, defaultH: 100 },
  tankLevel:           { minW: 80,  minH: 120, maxW: 300, maxH: 500, defaultW: 140, defaultH: 260 },
  toggleSwitch:        { minW: 80,  minH: 50,  maxW: 250, maxH: 120, defaultW: 140, defaultH: 70 },
  slider:              { minW: 140, minH: 50,  maxW: 500, maxH: 120, defaultW: 240, defaultH: 70 },
  numericInput:        { minW: 100, minH: 50,  maxW: 350, maxH: 120, defaultW: 180, defaultH: 80 },
  pushButton:          { minW: 80,  minH: 60,  maxW: 300, maxH: 200, defaultW: 140, defaultH: 100 },
  emergencyStop:       { minW: 100, minH: 100, maxW: 300, maxH: 300, defaultW: 160, defaultH: 160 },
  trendChart:          { minW: 200, minH: 120, maxW: 800, maxH: 500, defaultW: 360, defaultH: 220 },
  alarmBanner:         { minW: 200, minH: 50,  maxW: 600, maxH: 120, defaultW: 320, defaultH: 70 },
  alarmList:           { minW: 200, minH: 140, maxW: 600, maxH: 500, defaultW: 320, defaultH: 240 },
  calibrationWizard:   { minW: 200, minH: 160, maxW: 500, maxH: 400, defaultW: 300, defaultH: 220 },
  calibrationHistory:  { minW: 200, minH: 140, maxW: 600, maxH: 500, defaultW: 320, defaultH: 220 },
  calibrationStatus:   { minW: 120, minH: 80,  maxW: 400, maxH: 200, defaultW: 200, defaultH: 120 },
  processView:         { minW: 200, minH: 160, maxW: 800, maxH: 600, defaultW: 400, defaultH: 300 },
};

const DEFAULT_CONSTRAINTS: SizeConstraints = {
  minW: 80, minH: 60, maxW: 600, maxH: 500, defaultW: 240, defaultH: 200,
};

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
        startW: size.width,
        startH: size.height,
      };
    },
    [size],
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
    dragRef.current = null;
  }, []);

  /* ---------- Determine edit mode --------------------------------- */
  const isEditing = true; // In the builder, always editing

  /* ---------- Render ---------------------------------------------- */
  return (
    <div
      style={{
        width: size.width,
        height: size.height,
        position: 'relative',
        zIndex: 500,
        borderRadius: 8,
        border: selected ? '2px solid #06b6d4' : '1px solid #e5e7eb',
        boxShadow: selected ? '0 0 0 2px rgba(6,182,212,0.35)' : '0 1px 3px rgba(0,0,0,0.1)',
        background: '#ffffff',
        overflow: 'hidden',
        userSelect: 'none',
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {/* Widget type badge (edit mode, top-left) */}
      {isEditing && (
        <span
          style={{
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
          }}
        >
          {data.widgetType}
        </span>
      )}

      {/* Widget content */}
      <div style={{ width: '100%', height: '100%' }}>
        <WidgetRenderer
          widgetType={data.widgetType}
          config={data.config}
          value={data.liveValue}
          width={size.width}
          height={size.height}
          isEditing={isEditing}
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
    </div>
  );
};

ScadaWidgetNode.displayName = 'ScadaWidgetNode';

export default memo(ScadaWidgetNode);
