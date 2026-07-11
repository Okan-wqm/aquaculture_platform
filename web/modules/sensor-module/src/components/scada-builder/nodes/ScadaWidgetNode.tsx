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
 * - Connection handles for all widget types (P&ID flow connections)
 * - Cyan selection border matching SCADA theme
 * - Widget-type badge shown in edit mode (top-left corner)
 */

import React, { memo, useState, useCallback, useRef, useEffect, useMemo, useContext } from 'react';
import type { NodeProps } from '@xyflow/react';
import { Handle, Position, type Node } from '@xyflow/react';
import { Lock } from 'lucide-react';
import { WidgetRenderer } from '../WidgetRenderer';
import { WidgetTooltip } from '../WidgetTooltip';
import type {
  ConnectionPointKey,
  EquipmentConnectionPoint,
  ScadaWidgetNodeData,
} from '../../../types/scada-widget.types';
import { getWidgetPixelConstraints } from '../../../constants/scada-widget-sizes';
import {
  buildTransformCSS,
  buildTransformOrigin,
  DEFAULT_SVG_TRANSFORM,
} from '../../../types/scada-transform.types';
import type { SvgTransform } from '../../../types/scada-transform.types';
import { CONNECTION_POINTS, CONNECTION_POINT_COLORS, EQUIPMENT_VIEWBOX } from '../equipment-symbols/types';
import { useScadaPackageStore } from '../../../store/scada';
import type { SimTagValue } from '../../../store/scada/types';
// FIX: useScadaRuntime throw eder — doğrudan context kullanarak Rules of Hooks ihlalini önlüyoruz
// FIX: useScadaRuntime throws — use context directly to prevent Rules of Hooks violation
import { ScadaRuntimeContext } from '../../../engine/ScadaRuntime';
import { useAnimationState } from '../../../engine/animation/useAnimationState';
import { useWidgetEvents } from '../../../engine/events/useWidgetEvents';
import type { WidgetEventBus } from '../../../engine/events/WidgetEventBus';
import type { AnimationState } from '../../../engine/animation/types';
export type { ScadaWidgetNodeData } from '../../../types/scada-widget.types';

/* ------------------------------------------------------------------ */
/*  Noop event bus singleton: zero-import stub that satisfies the      */
/*  WidgetEventBus interface without importing the actual class.       */
/*  This avoids Vite code-split timing issues where the class          */
/*  reference is undefined during module evaluation (manifests as      */
/*  "Sn/qn is not a constructor" in minified production builds).       */
/*                                                                      */
/*  The WidgetEventBus API surface is: register(), dispatch(), clear() */
/*  In builder edit-mode, no events fire so all methods are no-ops.    */
/* ------------------------------------------------------------------ */
const NOOP_EVENT_BUS: WidgetEventBus = {
  register: () => () => {},
  dispatch: () => {},
  clear: () => {},
} as unknown as WidgetEventBus;

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
 * Handle hover CSS is now injected globally via AnimationStyles (injectAnimationStyles).
 * No longer rendered per-widget — prevents DOM bloat on 100+ widget canvases.
 *
 * Handle hover CSS artik AnimationStyles uzerinden global inject ediliyor.
 * Her widget icin ayri <style> tag'i render etmek yerine tek global injection kullanilir.
 *
 * @see /engine/animation/AnimationStyles.ts
 */

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

const ScadaWidgetNode: React.FC<NodeProps<Node<ScadaWidgetNodeData>>> = ({ id, data, selected }) => {
  const constraints = WIDGET_SIZE_CONSTRAINTS[data.widgetType] || DEFAULT_CONSTRAINTS;

  /* ---------- Locked state from store -------------------------------- */
  const locked = useScadaPackageStore((s) => {
    const screen = s.screens.find((scr) => scr.id === data.screenId);
    return screen?.widgets.find((w) => w.id === id)?.locked ?? false;
  });

  /* ---------- Highlight state from layers panel hover --------------- */
  /**
   * Highlight border shown when a widget is hovered in the Layers panel.
   * Uses a non-interactive CSS outline (not border, to avoid layout shift)
   * with a distinct color from the selection highlight.
   */
  const isHighlighted = useScadaPackageStore((s) => s.highlightedWidgetId === id);

  /* ---------- Grid position from store (for tooltip) -------------------- */
  const gridPosition = useScadaPackageStore((s) => {
    const screen = s.screens.find((scr) => scr.id === data.screenId);
    const w = screen?.widgets.find((wgt) => wgt.id === id);
    return w?.position ?? { col: 0, row: 0, w: 1, h: 1 };
  });

  /* ---------- Animation + Event engine hooks --------------------------- */
  const widgetAnimations = useScadaPackageStore((s) => {
    const screen = s.screens.find((scr) => scr.id === data.screenId);
    return screen?.widgets.find((wgt) => wgt.id === id)?.animations;
  });
  const widgetEvents = useScadaPackageStore((s) => {
    const screen = s.screens.find((scr) => scr.id === data.screenId);
    return screen?.widgets.find((wgt) => wgt.id === id)?.events;
  });

  // ---------- CRITICAL FIX: React Hook kuralları ihlalini düzeltme ----------
  // BEFORE: useScadaRuntime() try/catch icinde cagriliyordu. Throw ettiginde
  //   useAnimationState ve useWidgetEvents atlaniyordu → hook sayisi degisiyor → crash.
  // AFTER: useContext dogrudan kullaniliyor — null doner, throw etmez.
  //   Tum hook'lar her render'da kosulsuz olarak cagrilir (Rules of Hooks).
  //
  // CRITICAL FIX: Prevent Rules of Hooks violation
  // BEFORE: useScadaRuntime() was called inside try/catch. When it threw,
  //   useAnimationState and useWidgetEvents were skipped → hook count changes → crash.
  // AFTER: useContext returns null (never throws). All hooks are called
  //   unconditionally on every render (Rules of Hooks compliance).
  // -------------------------------------------------------------------------
  const runtimeCtx = useContext(ScadaRuntimeContext);
  const runtimeAvailable = runtimeCtx !== null;

  // Runtime varsa gercek tag snapshot'ini al, yoksa bos obje kullan
  // If runtime exists use real tag snapshot, otherwise use empty object
  const tagSnapshot = useMemo(
    () => (runtimeCtx ? runtimeCtx.tagBus.getSnapshot() : {}),
    [runtimeCtx],
  );

  // Hook'lar her zaman cagrilir — runtime yoksa bos kurallar/eventler gonderilir
  // Hooks are always called — when no runtime, empty rules/events are passed
  const safeAnimationRules = runtimeCtx ? widgetAnimations : undefined;
  const animationState = useAnimationState(safeAnimationRules, tagSnapshot);

  // useWidgetEvents bir WidgetEventBus instance'i gerektirir — noop stub kullan
  // useWidgetEvents requires a WidgetEventBus instance — noop stub when absent
  const safeEventBus = runtimeCtx ? runtimeCtx.eventBus : NOOP_EVENT_BUS;
  const safeWidgetEvents = runtimeCtx ? widgetEvents : undefined;
  const eventHandlers = useWidgetEvents(id, data.screenId, safeWidgetEvents, safeEventBus);

  /* ---------- Runtime command dispatch -------------------------------- */
  const tagName = (data.config?.tagName || data.config?.tag) as string | undefined;
  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear press timer on unmount
  useEffect(() => {
    return () => {
      if (pressTimerRef.current) clearTimeout(pressTimerRef.current);
    };
  }, []);

  const handleCommand = useCallback((command: string, value?: unknown) => {
    if (command === 'navigate' && typeof value === 'string') {
      useScadaPackageStore.getState().setActiveScreen(value);
      return;
    }

    // Simulation mode commands: toggle, press, writeTag
    const store = useScadaPackageStore.getState();
    if (store.simulationMode && tagName) {
      if (command === 'toggle') {
        store.setSimTagValue(tagName, !store.simTagValues[tagName]);
      } else if (command === 'press') {
        store.setSimTagValue(tagName, true);
        if (pressTimerRef.current) clearTimeout(pressTimerRef.current);
        pressTimerRef.current = setTimeout(() => {
          pressTimerRef.current = null;
          useScadaPackageStore.getState().setSimTagValue(tagName, false);
        }, 200);
      } else if (command === 'writeTag' && value !== undefined && value !== null) {
        store.setSimTagValue(tagName, value as SimTagValue);
      }
    }
  }, [tagName]);

  /* ---------- SVG Transform (applied on container div) ------------- */
  // Compute CSS transform from widget config — allows rotation, scale, skew
  // on any widget type without modifying individual renderers.
  const widgetTransform: SvgTransform = (data.config?.transform as SvgTransform) ?? DEFAULT_SVG_TRANSFORM;
  const svgTransformCSS = useMemo(() => buildTransformCSS(widgetTransform), [widgetTransform]);
  const svgTransformOrigin = useMemo(() => buildTransformOrigin(widgetTransform), [widgetTransform]);

  /* ---------- Equipment aspect ratio ------------------------------ */
  const isEquipment = data.widgetType === 'equipment';

  /** SVG viewBox aspect ratio — used to lock equipment resize to avoid letterboxing */
  const svgAspectRatio = useMemo(() => {
    if (!isEquipment) return 0;
    const subType = (data.config.equipmentSubType as string) || '';
    const vb = EQUIPMENT_VIEWBOX[subType];
    if (!vb) return 0;
    return vb.width / vb.height;
  }, [isEquipment, data.config.equipmentSubType]);

  const [size, setSize] = useState({
    width: data.width ?? constraints.defaultW,
    height: data.height ?? constraints.defaultH,
  });

  // Sync if parent pushes new dimensions via data (equipment: maintain aspect ratio)
  useEffect(() => {
    if (data.width != null && data.height != null) {
      if (isEquipment && svgAspectRatio > 0) {
        // Maintain aspect ratio from the width
        setSize({ width: data.width, height: Math.round(data.width / svgAspectRatio) });
      } else {
        setSize({ width: data.width, height: data.height });
      }
    } else if (data.width != null) {
      setSize((s) => ({ ...s, width: data.width! }));
    } else if (data.height != null) {
      setSize((s) => ({ ...s, height: data.height! }));
    }
  }, [data.width, data.height, isEquipment, svgAspectRatio]);

  /* ---------- Resize logic ---------------------------------------- */
  const dragRef = useRef<{
    dir: HandleDir;
    startX: number;
    startY: number;
    startW: number;
    startH: number;
  } | null>(null);

  /* ---------- Tooltip hover state ------------------------------------ */
  const [isHovered, setIsHovered] = useState(false);
  const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 });
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tooltipVisible, setTooltipVisible] = useState(false);

  const onMouseEnterNode = useCallback(() => {
    // Don't show tooltip while resizing (dragRef active)
    if (dragRef.current) return;
    setIsHovered(true);
    hoverTimerRef.current = setTimeout(() => {
      setTooltipVisible(true);
    }, 300);
  }, []);

  const onMouseMoveNode = useCallback((e: React.MouseEvent) => {
    setHoverPos({ x: e.clientX, y: e.clientY });
  }, []);

  const onMouseLeaveNode = useCallback(() => {
    setIsHovered(false);
    setTooltipVisible(false);
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  // Clear tooltip timer on unmount
  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  const sizeRef = useRef(size);
  useEffect(() => { sizeRef.current = size; }, [size]);

  const clamp = useCallback(
    (w: number, h: number, dir?: HandleDir) => {
      let cw = Math.max(constraints.minW, Math.min(constraints.maxW, w));
      let ch = Math.max(constraints.minH, Math.min(constraints.maxH, h));

      // Equipment widgets: lock aspect ratio to viewBox so SVG never letterboxes
      if (isEquipment && svgAspectRatio > 0) {
        const isHorizontalDrag = dir && (dir.includes('e') || dir.includes('w')) && !dir.includes('n') && !dir.includes('s');
        const isVerticalDrag = dir && (dir.includes('n') || dir.includes('s')) && !dir.includes('e') && !dir.includes('w');

        if (isHorizontalDrag) {
          ch = Math.round(cw / svgAspectRatio);
        } else if (isVerticalDrag) {
          cw = Math.round(ch * svgAspectRatio);
        } else {
          // Corner drag: constrain to whichever dimension is smaller relative to ratio
          const newAR = cw / ch;
          if (newAR > svgAspectRatio) {
            cw = Math.round(ch * svgAspectRatio);
          } else {
            ch = Math.round(cw / svgAspectRatio);
          }
        }

        // Re-clamp after ratio adjustment
        cw = Math.max(constraints.minW, Math.min(constraints.maxW, cw));
        ch = Math.max(constraints.minH, Math.min(constraints.maxH, ch));
      }

      return { width: cw, height: ch };
    },
    [constraints, isEquipment, svgAspectRatio],
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
      // Hide tooltip immediately when resize starts
      setTooltipVisible(false);
      setIsHovered(false);
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
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

      setSize(clamp(w, h, dragRef.current.dir));
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
  /**
   * Z-index applied from the widget's stored layer order.
   * ReactFlow nodes have a base z-index from selection state;
   * we add the widget's z-index on top to maintain layer ordering
   * independent of selection.
   */
  const widgetZIndex = data.zIndex ?? 0;

  /**
   * Visual group indicator: derive a stable hue from the groupId hash
   * so each group gets a distinctive color. Only shown when the widget
   * is part of a group AND is either selected or highlighted.
   */
  const groupColor = useMemo(() => {
    const gid = data.groupId;
    if (!gid) return undefined;
    // Simple hash: sum char codes modulo 360 for hue
    let hash = 0;
    for (let i = 0; i < gid.length; i++) {
      hash = (hash + gid.charCodeAt(i) * 37) % 360;
    }
    return `hsl(${hash}, 70%, 55%)`;
  }, [data.groupId]);

  const showGroupIndicator = !!data.groupId && (selected || isHighlighted);

  const containerStyle = useMemo(() => ({
    width: size.width,
    height: size.height,
    position: 'relative' as const,
    zIndex: 500 + widgetZIndex,
    borderRadius: 4,
    border: selected
      ? '2px solid #06b6d4'
      : '1px solid transparent',
    boxShadow: selected
      ? '0 0 0 2px rgba(6,182,212,0.35)'
      : 'none',
    // Highlight outline from Layers panel hover -- uses outline instead of border
    // to avoid layout shift when hovering layer rows
    outline: isHighlighted && !selected
      ? '2px dashed #3b82f6'
      : undefined,
    outlineOffset: isHighlighted && !selected ? 2 : undefined,
    background: 'transparent',
    overflow: 'visible' as const,
    userSelect: 'none' as const,
    // Group indicator: colored left border stripe when group is active
    borderLeft: showGroupIndicator && groupColor
      ? `4px solid ${groupColor}`
      : undefined,
    // SVG transform applied at container level -- benefits all widget types
    // without touching individual renderers
    transform: svgTransformCSS || undefined,
    transformOrigin: svgTransformOrigin,
  }), [size.width, size.height, selected, isHighlighted, widgetZIndex, svgTransformCSS, svgTransformOrigin, showGroupIndicator, groupColor]);

  const animatedContainerStyle = useMemo(() => {
    // No animations applied without runtime — preserves default appearance
    if (!runtimeAvailable) return containerStyle;
    const style = { ...containerStyle } as Record<string, unknown>;

    if (!animationState.visible) {
      style.opacity = 0;
      style.pointerEvents = 'none';
    }
    if (animationState.rotating) {
      style.animation = `scada-rotate-${animationState.rotationDirection} ${animationState.rotationSpeed}ms linear infinite`;
      style.transformOrigin = 'center center';
    }
    if (animationState.blinking) {
      style.animation = `scada-blink ${animationState.blinkInterval}ms ease-in-out infinite`;
    }
    if (animationState.translateX || animationState.translateY) {
      // Compose SVG transform with animation translate so both apply simultaneously
      const translatePart = `translate(${animationState.translateX}px, ${animationState.translateY}px)`;
      style.transform = svgTransformCSS
        ? `${svgTransformCSS} ${translatePart}`
        : translatePart;
      style.transition = `transform ${animationState.transitionDuration}ms ease`;
    }

    // valueMappedRotation — static angle proportional to tag value.
    // Appends to any existing transform (SVG transform, translate, etc.)
    if (animationState.mappedRotation !== undefined) {
      const existing = typeof style.transform === 'string' ? style.transform : '';
      style.transform = `${existing} rotate(${animationState.mappedRotation}deg)`.trim();
    }

    // piston — vertical oscillation via CSS keyframe animation.
    // Sets CSS custom property for the keyframe's translateY distance.
    if (animationState.pistoning) {
      style.animation = `scada-piston ${animationState.pistonDuration}ms ease-in-out infinite`;
      style['--piston-distance'] = `${-(animationState.pistonDistance ?? 20)}px`;
    }

    // recursiveColor — CSS custom properties that cascade to SVG children.
    // Widgets use var(--scada-fill) and var(--scada-stroke) internally.
    if (animationState.cssVariables) {
      Object.assign(style, animationState.cssVariables);
    }

    // scale — proportional scaling from tag value.
    // Appends to any existing transform chain.
    if (animationState.mappedScale !== undefined) {
      const existing = typeof style.transform === 'string' ? style.transform : '';
      style.transform = `${existing} scale(${animationState.mappedScale})`.trim();
    }

    return style as React.CSSProperties;
  }, [containerStyle, animationState, runtimeAvailable, svgTransformCSS]);

  /* ---------- Connection handles for all widget types --------------- */
  const connectionHandles = useMemo(() => {
    const lookupKey = data.widgetType === 'equipment'
      ? (data.config.equipmentSubType as string) || ''
      : data.widgetType;
    const points =
      lookupKey in CONNECTION_POINTS
        ? CONNECTION_POINTS[lookupKey as ConnectionPointKey]
        : undefined;
    if (!points || points.length === 0) return null;
    return points;
  }, [data.widgetType, data.config.equipmentSubType]);

  /* ---------- SVG render rect removed (ADR-010) -------------------- */
  // Equipment widgets now maintain their viewBox aspect ratio via the clamp
  // function, so the SVG never letterboxes and handles can use simple
  // percentage offsets without compensation.

  /* ---------- Derived tooltip flag --------------------------------- */
  const showTooltip = tooltipVisible && isHovered && !data.isPreview && !dragRef.current;

  /* ---------- Render ---------------------------------------------- */
  return (
    <div
      style={animatedContainerStyle}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onMouseEnter={onMouseEnterNode}
      onMouseMove={onMouseMoveNode}
      onMouseLeave={onMouseLeaveNode}
      onClick={(e) => { eventHandlers.onClick?.(e); }}
      onDoubleClick={(e) => { eventHandlers.onDoubleClick?.(e); }}
    >
      {/* Handle hover CSS is now injected globally via AnimationStyles — no per-widget <style> needed */}

      {/* Widget type badge (edit mode only, top-left) */}
      {!data.isPreview && (
        <span style={BADGE_STYLE}>
          {(data.config.label as string) || (data.widgetType === 'equipment'
            ? (data.config.equipmentSubType as string) || 'equipment'
            : data.widgetType)}
        </span>
      )}

      {/* Lock indicator (top-right, only when locked) */}
      {locked && (
        <div
          style={{
            position: 'absolute',
            top: 4,
            right: 4,
            zIndex: 10,
            background: 'rgba(31, 41, 55, 0.6)',
            borderRadius: 4,
            padding: 2,
            lineHeight: 0,
          }}
          title="Kilitli"
        >
          <Lock style={{ width: 12, height: 12, color: '#ffffff' }} />
        </div>
      )}

      {/* Widget content - overflow hidden here to clip widget internals */}
      <div style={CONTENT_STYLE}>
        <WidgetRenderer
          widgetType={data.widgetType}
          config={data.config}
          value={data.liveValue}
          width={size.width}
          height={size.height}
          isEditing={!data.isPreview}
          onCommand={handleCommand}
          animationState={animationState}
        />
      </div>

      {/* Resize handles (only when selected and not locked) */}
      {selected && !locked &&
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

      {/* Connection handles for all widget types */}
      {connectionHandles && connectionHandles.map((pt) => {
        const posMap: Record<string, Position> = {
          top: Position.Top,
          right: Position.Right,
          bottom: Position.Bottom,
          left: Position.Left,
        };
        const position = posMap[pt.side] || Position.Left;

        // Simple percentage offset — equipment widgets maintain their aspect
        // ratio via clamp so SVG never letterboxes; no compensation needed.
        const posStyle: React.CSSProperties = {};
        if (pt.side === 'top' || pt.side === 'bottom') {
          posStyle.left = `${pt.offset * 100}%`;
        } else {
          posStyle.top = `${pt.offset * 100}%`;
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

      {/* Hover tooltip (edit mode only, with 300ms delay) */}
      <WidgetTooltip
        visible={showTooltip}
        widgetType={data.widgetType}
        label={data.label}
        tagName={data.tagName}
        position={gridPosition}
        locked={locked}
        groupId={data.groupId}
        x={hoverPos.x}
        y={hoverPos.y}
      />
    </div>
  );
};

ScadaWidgetNode.displayName = 'ScadaWidgetNode';

export default memo(ScadaWidgetNode);
