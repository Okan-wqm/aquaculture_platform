/**
 * ScadaViewport -- Read-only, lightweight renderer for a ScreenDef.
 *
 * Positions widgets using absolute CSS based on grid coordinates,
 * avoiding the cost of a full ReactFlow canvas.  Designed to be
 * embedded inside PopupCard / ModalDialog overlays.
 *
 * Pure presentational component -- no store access.  The caller
 * supplies tagValues and variableMap from the store.
 */
import React, { memo, useMemo } from 'react';
import type { ScreenDef } from '../../store/scada/types';
import type { AnimationRule } from '../animation/types';
import { WidgetRenderer } from '../../components/scada-builder/WidgetRenderer';
import { GRID_CELL_W, GRID_CELL_H } from '../../constants/scada-widget-sizes';
import { getWidgetTagBinding } from '../tags';

/* ------------------------------------------------------------------ */
/*  Variable resolution helpers                                        */
/* ------------------------------------------------------------------ */

/**
 * Resolves placeholder tag names in a widget config using variableMap.
 * Returns a shallow copy with `tagName` and `tag` fields substituted
 * when a matching mapping exists.
 */
function resolveConfig(
  config: Record<string, unknown>,
  variableMap: Record<string, string> | undefined,
): Record<string, unknown> {
  if (!variableMap || Object.keys(variableMap).length === 0) return config;
  const resolved = { ...config };
  if (typeof resolved.tagName === 'string' && variableMap[resolved.tagName]) {
    resolved.tagName = variableMap[resolved.tagName];
  }
  if (typeof resolved.tag === 'string' && variableMap[resolved.tag]) {
    resolved.tag = variableMap[resolved.tag];
  }
  return resolved;
}

/**
 * Resolves placeholder tagName fields in animation rules using variableMap.
 * Returns a new array with substituted tagNames where mappings exist.
 */
function resolveAnimations(
  animations: AnimationRule[] | undefined,
  variableMap: Record<string, string> | undefined,
): AnimationRule[] | undefined {
  if (!animations || !variableMap || Object.keys(variableMap).length === 0) return animations;
  return animations.map((rule) => {
    if (variableMap[rule.tagName]) {
      return { ...rule, tagName: variableMap[rule.tagName] };
    }
    return rule;
  });
}

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface ScadaViewportProps {
  screen: ScreenDef;
  /** Scale factor for fitting the canvas into the overlay (0-1). */
  scale?: number;
  /** Live tag values for widget data display. */
  tagValues?: Record<string, unknown>;
  /** Variable mapping: replaces placeholder tags with real tags. */
  variableMap?: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

const ScadaViewport: React.FC<ScadaViewportProps> = ({
  screen,
  scale = 1,
  tagValues = {},
  variableMap,
}) => {
  const canvasWidth = screen.layout.cols * GRID_CELL_W;
  const canvasHeight = screen.layout.rows * GRID_CELL_H;

  // Pre-compute the outer wrapper size once.  When scale < 1 we use
  // CSS transform to shrink the canvas visually but keep the child
  // layout at 1:1 pixel coordinates.  The wrapper must reflect the
  // *scaled* size so the parent can size around it correctly.
  const wrapperStyle = useMemo<React.CSSProperties>(
    () => ({
      position: 'relative',
      width: canvasWidth * scale,
      height: canvasHeight * scale,
      overflow: 'hidden',
    }),
    [canvasWidth, canvasHeight, scale],
  );

  const innerStyle = useMemo<React.CSSProperties>(
    () => ({
      position: 'absolute' as const,
      top: 0,
      left: 0,
      width: canvasWidth,
      height: canvasHeight,
      transform: scale !== 1 ? `scale(${scale})` : undefined,
      transformOrigin: 'top left',
    }),
    [canvasWidth, canvasHeight, scale],
  );

  return (
    <div style={wrapperStyle}>
      <div style={innerStyle}>
        {screen.widgets.map((widget) => {
          // Resolve config tags via variable mapping, then read the binding
          // through the shared accessor (config.tagRef → legacy keys).
          const resolvedCfg = resolveConfig(widget.config, variableMap);
          const tagName = getWidgetTagBinding(resolvedCfg);
          const liveValue = tagName ? tagValues[tagName] : undefined;

          // Resolve animation rule tagNames via variable mapping
          const resolvedAnims = resolveAnimations(widget.animations, variableMap);
          // Suppress unused-variable lint: resolvedAnims is available for
          // future animation evaluation; currently we pass it as data attribute.
          void resolvedAnims;

          // Convert grid position to pixels
          const left = widget.position.col * GRID_CELL_W;
          const top = widget.position.row * GRID_CELL_H;
          const width = widget.position.w * GRID_CELL_W;
          const height = widget.position.h * GRID_CELL_H;

          return (
            <div
              key={widget.id}
              style={{
                position: 'absolute',
                left,
                top,
                width,
                height,
                pointerEvents: 'none',
              }}
            >
              <WidgetRenderer
                widgetType={widget.widgetType}
                config={resolvedCfg}
                value={liveValue as number | string | boolean | undefined}
                width={width}
                height={height}
                isEditing={false}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default memo(ScadaViewport);
