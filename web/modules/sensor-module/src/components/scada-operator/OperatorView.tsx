/**
 * OperatorView — Runtime view renderer for a SCADA screen.
 *
 * Given a Screen object, OperatorView:
 *  1. Collects all tag IDs referenced in widget configs.
 *  2. Subscribes to live values via ONE bulk useRealtimeData subscription
 *     and passes the values DOWN to every widget (controlled mode, T7a) —
 *     N widgets must not create N rAF/timer loops.
 *  3. Renders each widget via RuntimeWidgetRenderer (the WIDGET_REGISTRY +
 *    FallbackWidget dispatch is deleted) at its grid-defined position,
 *     with builder parity (T7f): visible!==false filter, zIndex 500+z,
 *     config.transform applied.
 *  4. Adapts builder-side widget config (permissions/events/animations)
 *     through the explicit adapters in ./adapters (T7c).
 *  5. Widget commands are routed by RuntimeWidgetRenderer's command router
 *     (T5) — the old "command:tagId" string protocol is deleted.
 *  6. Dispatches navigation/overlay events via useWidgetEvents.
 *  7. Applies a configurable viewRenderDelay to prevent flicker on
 *     screen transitions.
 *
 * Grid mapping:
 *   px = col  * GRID_CELL_W
 *   py = row  * GRID_CELL_H
 *   w  = w    * GRID_CELL_W
 *   h  = h    * GRID_CELL_H
 *
 * (Constants match those used by the SCADA builder: 40×40 px cells.)
 */

import React, {
  useMemo,
  useState,
  useEffect,
  memo,
} from 'react';

import { useRealtimeData } from '../../hooks/useRealtimeData';
import { getWidgetTagBinding, localTagFromBindingValue } from '../../engine/tags';
import { RuntimeWidgetRenderer, type AnyWidgetType } from './widgets/RuntimeWidgetRenderer';
import {
  adaptWidgetPermissions,
  adaptWidgetEvents,
  adaptAnimationRules,
  logAdapterWarnings,
} from './adapters';
import type { Screen, ScreenWidget } from '../../types/scada-package.types';
import type { TagValueChange } from '../../types/scada-runtime.types';

/* ------------------------------------------------------------------ */
/*  Grid cell dimensions (mirrors scada-widget-sizes constants)        */
/* ------------------------------------------------------------------ */

const GRID_CELL_W = 40; // px per grid column
const GRID_CELL_H = 40; // px per grid row

/** Base z-index for the widget layer (builder parity, T7f). */
const WIDGET_Z_BASE = 500;

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Extract tag IDs referenced in a widget's config (best-effort). */
function extractTagIds(config: Record<string, unknown>): string[] {
  const ids: string[] = [];

  function walk(obj: unknown): void {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      obj.forEach(walk);
      return;
    }
    const record = obj as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const val = record[key];
      // Heuristic: any string property whose key is a known binding key
      // (canonical tagRef + legacy tagName/tag/tagId variants) is a tag
      // reference. Full `deviceCode/localName` refs reduce to the local
      // segment because the runtime subscribes by device-local names.
      if (
        (key === 'tagRef' ||
          key === 'tagName' ||
          key === 'tagId' ||
          key.endsWith('TagId') ||
          key === 'tag') &&
        typeof val === 'string' &&
        val.trim()
      ) {
        ids.push(localTagFromBindingValue(val.trim()));
      }
      // Also recurse into nested objects / arrays (e.g. chart lines, alarm rules).
      if (val && typeof val === 'object') {
        walk(val);
      }
    }
  }

  walk(config);
  return [...new Set(ids)];
}

/* ------------------------------------------------------------------ */
/*  RuntimeWidget — adapts builder widget + renders RuntimeWidgetRenderer */
/* ------------------------------------------------------------------ */

interface RuntimeWidgetProps {
  widget: ScreenWidget;
  /** Bulk tag values from OperatorView's single subscription (controlled). */
  tagValues: Record<string, TagValueChange>;
  onNavigate?: (screenId: string) => void;
}

const RuntimeWidget = memo<RuntimeWidgetProps>(
  ({ widget, tagValues, onNavigate }) => {
    const { position, config, widgetType } = widget;

    // Pixel geometry
    const px = position.col * GRID_CELL_W;
    const py = position.row * GRID_CELL_H;
    const pw = position.w  * GRID_CELL_W;
    const ph = position.h  * GRID_CELL_H;

    // ── Adapters (T7c): builder shapes → runtime shapes ─────────────────
    // NOTE: permission is passed ONLY when the builder defined one —
    // useOperatorPermission treats an absent definition as fully open
    // (no confirm/PIN); an always-present empty object would gate every
    // widget below supervisor.
    const permission = useMemo(() => {
      if (!widget.permissions) return undefined;
      const adapted = adaptWidgetPermissions(widget.permissions);
      logAdapterWarnings(`widget ${widget.id} permissions`, adapted.warnings);
      return adapted.permission;
    }, [widget.permissions, widget.id]);

    const events = useMemo(() => {
      const adapted = adaptWidgetEvents(widget.events);
      logAdapterWarnings(`widget ${widget.id} events`, adapted.warnings);
      return adapted.events;
    }, [widget.events, widget.id]);

    const actions = useMemo(() => {
      const adapted = adaptAnimationRules(widget.animations);
      logAdapterWarnings(`widget ${widget.id} animations`, adapted.warnings);
      return adapted.actions;
    }, [widget.animations, widget.id]);

    // Tag ids for multi-tag widgets (charts, tables) — canonical binding
    // first, then every string-tag reference found in the config.
    const tagIds = useMemo(() => {
      const primary = getWidgetTagBinding(config);
      const extracted = extractTagIds(config);
      return primary ? [primary, ...extracted.filter((id) => id !== primary)] : extracted;
    }, [config]);

    // Builder parity (T7f): zIndex 500+z; visible defaults to true (the
    // filter below drops visible === false only).
    const zIndex = WIDGET_Z_BASE + (widget.zIndex ?? 0);

    const transform = typeof config.transform === 'string' ? config.transform : undefined;

    return (
      <RuntimeWidgetRenderer
        widgetId={widget.id}
        // Persisted docs carry open widget-type strings; unknown values
        // degrade inside the renderer (error boundary), so the widening is safe.
        widgetType={widgetType as AnyWidgetType}
        config={config}
        tagIds={tagIds}
        position={{ x: px, y: py, w: pw, h: ph }}
        permission={permission}
        actions={actions}
        events={events}
        onNavigate={onNavigate}
        tagValues={tagValues}
        subscribe={false}
        zIndex={zIndex}
        {...(transform ? { transform } : {})}
      />
    );
  },
);
RuntimeWidget.displayName = 'RuntimeWidget';

/* ------------------------------------------------------------------ */
/*  Props                                                               */
/* ------------------------------------------------------------------ */

export interface OperatorViewProps {
  /** The screen to render. */
  screen: Screen;
  /** Called when a widget triggers a navigation event. */
  onNavigate?: (screenId: string) => void;
  /**
   * Delay in ms before the view is shown after a screen transition.
   * Prevents a single-frame flicker of unpopulated widgets.
   * Defaults to the value from OperatorLayoutConfig if not passed directly.
   */
  renderDelay?: number;
}

/* ------------------------------------------------------------------ */
/*  OperatorView                                                        */
/* ------------------------------------------------------------------ */

export const OperatorView = memo<OperatorViewProps>(
  ({ screen, onNavigate, renderDelay = 0 }) => {
    // Collect all tag IDs needed by this screen's widgets.
    const tagIds = useMemo(
      () =>
        screen.widgets.flatMap((w) => extractTagIds(w.config)),
      [screen.widgets],
    );

    // SINGLE bulk subscription (T7a) — widgets run controlled (subscribe={false}).
    const { values: tagValues } = useRealtimeData(tagIds);

    // Render-delay: hide content briefly to prevent flicker on screen
    // transitions while the DataProvider populates initial values.
    const [ready, setReady] = useState(renderDelay === 0);

    useEffect(() => {
      setReady(false);
      if (renderDelay <= 0) {
        setReady(true);
        return;
      }
      const timer = setTimeout(() => setReady(true), renderDelay);
      return () => clearTimeout(timer);
    }, [screen.id, renderDelay]);

    // Canvas dimensions: grid cols × rows × cell size
    const canvasWidth  = screen.layout.cols * GRID_CELL_W;
    const canvasHeight = screen.layout.rows * GRID_CELL_H;

    return (
      <div
        className="relative w-full h-full overflow-auto bg-gray-950"
        role="region"
        aria-label={`Screen: ${screen.name}`}
      >
        {/* Inner canvas — absolute-positioned widget layer */}
        <div
          className={[
            'relative transition-opacity duration-150',
            ready ? 'opacity-100' : 'opacity-0',
          ].join(' ')}
          style={{
            width:     canvasWidth,
            height:    canvasHeight,
            minWidth:  '100%',
            minHeight: '100%',
          }}
          aria-hidden={!ready}
        >
          {/* T7f parity: visible===false widgets are dropped from the DOM
              entirely (matches the builder canvas + runtime contract). */}
          {screen.widgets
            .filter((widget) => widget.visible !== false)
            .map((widget) => (
              <RuntimeWidget
                key={widget.id}
                widget={widget}
                tagValues={tagValues}
                onNavigate={onNavigate}
              />
            ))}
        </div>

        {/* Loading placeholder: shown during render delay */}
        {!ready && (
          <div
            className="absolute inset-0 flex items-center justify-center pointer-events-none"
            aria-live="polite"
            aria-label="Loading screen"
          >
            <div className="flex flex-col items-center gap-2 text-gray-500">
              <div className="w-6 h-6 border-2 border-gray-600 border-t-blue-500 rounded-full animate-spin" />
              <span className="text-xs">{screen.name}</span>
            </div>
          </div>
        )}
      </div>
    );
  },
);
OperatorView.displayName = 'OperatorView';
