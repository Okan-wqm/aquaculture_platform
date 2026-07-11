/**
 * OperatorView — Runtime view renderer for a SCADA screen.
 *
 * Given a Screen object, OperatorView:
 *  1. Collects all tag IDs referenced in widget configs.
 *  2. Subscribes to live values via useRealtimeData (bulk subscription).
 *  3. Renders each widget at its grid-defined position using absolute
 *     pixel placement (grid col/row × cell sizes).
 *  4. Evaluates per-widget permission (useOperatorPermission) to
 *     determine visibility and interactability.
 *  5. Routes widget onCommand callbacks → useTagWrite.
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
  useCallback,
  memo,
} from 'react';

import { useRealtimeData } from '../../hooks/useRealtimeData';
import { useTagWrite } from '../../hooks/useTagWrite';
import { useWidgetEvents } from '../../hooks/useWidgetEvents';
import { useOperatorPermission } from '../../hooks/useOperatorPermission';
import { getWidgetTagBinding, localTagFromBindingValue } from '../../engine/tags';
import type { Screen, ScreenWidget } from '../../types/scada-package.types';
import type {
  WidgetPermission,
  WidgetEventBinding,
  WidgetAction,
  TagValueChange,
} from '../../types/scada-runtime.types';

/* ------------------------------------------------------------------ */
/*  Grid cell dimensions (mirrors scada-widget-sizes constants)        */
/* ------------------------------------------------------------------ */

const GRID_CELL_W = 40; // px per grid column
const GRID_CELL_H = 40; // px per grid row

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
/*  Widget registry                                                     */
/*                                                                      */
/*  Components must be registered here so OperatorView can look them   */
/*  up by widgetType string.  Missing types render a fallback.         */
/*                                                                      */
/*  The registry is lazily populated: each widget module calls         */
/*  registerOperatorWidget() on import.  We keep a Map to avoid        */
/*  rebuilding it on every render.                                     */
/* ------------------------------------------------------------------ */

type OperatorWidgetComponent = React.ComponentType<OperatorWidgetProps>;

const WIDGET_REGISTRY = new Map<string, OperatorWidgetComponent>();

export function registerOperatorWidget(
  type: string,
  component: OperatorWidgetComponent,
): void {
  WIDGET_REGISTRY.set(type, component);
}

/* ------------------------------------------------------------------ */
/*  OperatorWidgetProps — passed to every runtime widget               */
/* ------------------------------------------------------------------ */

export interface OperatorWidgetProps {
  /** Widget config from Screen. */
  config: Record<string, unknown>;
  /** Current primary tag value (from config.tagId). */
  value: unknown;
  /** Timestamp of last update. */
  timestamp: number;
  /** Data quality flag for the primary tag. */
  quality: 'good' | 'bad' | 'uncertain';
  /** All tag values subscribed by this widget. */
  tagValues: Record<string, TagValueChange>;
  /** Operator mode = true (read-only in editor would be false). */
  isOperatorMode: boolean;
  /** Widget is visible (permission check). */
  isVisible: boolean;
  /** Widget is interactable (permission check). */
  isEnabled: boolean;
  /** Tag-value-driven visual actions. */
  actions?: WidgetAction[];
  /** Event bindings. */
  events?: WidgetEventBinding[];
  /** Pixel width of the widget cell. */
  width: number;
  /** Pixel height of the widget cell. */
  height: number;
  /** Dispatch a command from the widget (e.g. 'setValue', 'toggle'). */
  onCommand?: (command: string, value?: unknown) => void;
}

/* ------------------------------------------------------------------ */
/*  FallbackWidget — rendered when widgetType is not registered        */
/* ------------------------------------------------------------------ */

const FallbackWidget = memo<Pick<OperatorWidgetProps, 'config' | 'width' | 'height'>>(
  ({ config, width, height }) => (
    <div
      className="flex items-center justify-center bg-gray-800/60 border border-dashed border-gray-600 rounded text-[10px] text-gray-500 overflow-hidden"
      style={{ width, height }}
      title={`Unknown widget type: ${String(config.widgetType ?? '')}`}
      aria-label={`Unregistered widget: ${String(config.widgetType ?? 'unknown')}`}
    >
      <span className="truncate px-1">{String(config.widgetType ?? '?')}</span>
    </div>
  ),
);
FallbackWidget.displayName = 'FallbackWidget';

/* ------------------------------------------------------------------ */
/*  RuntimeWidget — renders a single widget with permission + data     */
/* ------------------------------------------------------------------ */

interface RuntimeWidgetProps {
  widget: ScreenWidget;
  tagValues: Record<string, TagValueChange>;
  onCommand: (widgetId: string, command: string, value?: unknown) => void;
  onNavigate?: (screenId: string) => void;
}

const RuntimeWidget = memo<RuntimeWidgetProps>(
  ({ widget, tagValues, onCommand, onNavigate }) => {
    const { position, config, widgetType } = widget;

    // Pixel geometry
    const px = position.col * GRID_CELL_W;
    const py = position.row * GRID_CELL_H;
    const pw = position.w  * GRID_CELL_W;
    const ph = position.h  * GRID_CELL_H;

    // Permission check
    const permission = config.permission as WidgetPermission | undefined;
    const { visible, enabled } = useOperatorPermission(permission);

    // Primary tag value — shared binding accessor (config.tagRef → legacy
    // keys), the same resolution the builder/preview uses.
    const primaryTagId = getWidgetTagBinding(config) ?? '';
    const primaryTagChange = primaryTagId ? tagValues[primaryTagId] : undefined;
    const primaryValue    = primaryTagChange?.value ?? null;
    const primaryTs       = primaryTagChange?.timestamp ?? 0;
    const primaryQuality  = primaryTagChange?.quality ?? 'uncertain';

    // Event bindings
    const events  = config.events  as WidgetEventBinding[] | undefined;
    const actions = config.actions as WidgetAction[]        | undefined;

    const { handleEvent } = useWidgetEvents(events, onNavigate);

    // Command handler → tag writes
    const handleCommand = useCallback(
      (command: string, value?: unknown) => {
        onCommand(widget.id, command, value);
      },
      [widget.id, onCommand],
    );

    if (!visible) return null;

    const Component = WIDGET_REGISTRY.get(widgetType);

    return (
      <div
        className="absolute"
        style={{ left: px, top: py, width: pw, height: ph }}
        data-widget-id={widget.id}
        data-widget-type={widgetType}
      >
        {Component ? (
          <Component
            config={config}
            value={primaryValue}
            timestamp={primaryTs}
            quality={primaryQuality}
            tagValues={tagValues}
            isOperatorMode
            isVisible={visible}
            isEnabled={enabled}
            actions={actions}
            events={events}
            width={pw}
            height={ph}
            onCommand={handleCommand}
          />
        ) : (
          <FallbackWidget config={config} width={pw} height={ph} />
        )}
      </div>
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
    const { writeTag, toggleTag } = useTagWrite();

    // Collect all tag IDs needed by this screen's widgets.
    const tagIds = useMemo(
      () =>
        screen.widgets.flatMap((w) => extractTagIds(w.config)),
      [screen.widgets],
    );

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

    // Global command handler: routes widget commands to tag writes.
    const handleCommand = useCallback(
      (_widgetId: string, command: string, value?: unknown) => {
        // Determine target tagId from the command string or value.
        // Commands are in the form "setValue:tagId" or "toggle:tagId".
        const [action, tagId] = command.split(':');
        if (!tagId) return;

        if (action === 'toggle') {
          void toggleTag(tagId);
        } else {
          // setValue, add, remove — use writeTag with the provided value
          void writeTag(tagId, value);
        }
      },
      [writeTag, toggleTag],
    );

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
          {screen.widgets.map((widget) => (
            <RuntimeWidget
              key={widget.id}
              widget={widget}
              tagValues={tagValues}
              onCommand={handleCommand}
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
