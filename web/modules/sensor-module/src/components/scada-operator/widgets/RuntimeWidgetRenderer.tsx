/**
 * RuntimeWidgetRenderer — Master dispatcher for SCADA HMI operator mode.
 *
 * Responsibilities:
 *   1. Subscribe to tag values via useRealtimeData (rAF-batched)
 *   2. Check widget visibility/interaction permissions via useOperatorPermission
 *   3. Evaluate tag-driven visual actions via useWidgetActions
 *   4. Bind user interaction events via useWidgetEvents
 *   5. Apply action effects (hide, blink, color, rotate, translate) to a
 *      wrapper <div> that hosts every widget type
 *   6. Dispatch to the correct renderer:
 *        • Existing ScadaWidgetTypes → lazy-load from widget-renderers/ with
 *          isOperatorMode=true (passed as isEditing=false, operator props injected)
 *        • Runtime-only types (runtimeGauge, runtimeInput, runtimePipe,
 *          runtimeTable, runtimeVideo, runtimeScheduler) → the new Runtime* components
 *
 * Action effects applied to wrapper div:
 *   - hidden       → display:none
 *   - blink        → CSS @keyframes animation (style injected once per document)
 *   - color        → CSS variable for fill/stroke (passed to child via context
 *                    for SVG widgets, and as a border/bg tint on the wrapper)
 *   - rotate       → CSS transform: rotate()
 *   - translate    → CSS transform: translate()
 *   - (rotate AND translate are combined with CSS transform)
 *
 * Performance:
 *   - React.memo — stable identity; only re-renders when props or data change
 *   - All hooks return memoized results; no derived state is computed inline
 *   - CSS animations run entirely on the compositor thread
 */

import React, {
  memo,
  Suspense,
  useMemo,
  useCallback,
  Component,
  type ErrorInfo,
} from 'react';

import type {
  WidgetAction,
  WidgetEventBinding,
  WidgetPermission,
  TagValueChange,
} from '../../../types/scada-runtime.types';
import type { ScadaWidgetType } from '../../../types/scada-widget.types';

import { useRealtimeData } from '../../../hooks/useRealtimeData';
import { useOperatorPermission } from '../../../hooks/useOperatorPermission';
import { useWidgetActions }      from '../../../hooks/useWidgetActions';
import { useWidgetEvents }       from '../../../hooks/useWidgetEvents';

// Existing editor-mode renderers (delegated with isEditing=false)
import { WidgetRenderer }        from '../../scada-builder/WidgetRenderer';

// Runtime-only components (lazy-loaded for code splitting)
const RuntimeGauge     = React.lazy(() => import('./RuntimeGauge'));
const RuntimeInput     = React.lazy(() => import('./RuntimeInput'));
const RuntimePipe      = React.lazy(() => import('./RuntimePipe'));
const RuntimeTable     = React.lazy(() => import('./RuntimeTable'));
const RuntimeVideo     = React.lazy(() => import('./RuntimeVideo'));
const RuntimeScheduler = React.lazy(() => import('./RuntimeScheduler'));

/* ------------------------------------------------------------------ */
/*  CSS injection (blink keyframes — once per document)                */
/* ------------------------------------------------------------------ */

let runtimeStyleInjected = false;

function injectRuntimeStyles(): void {
  if (runtimeStyleInjected) return;
  const style = document.createElement('style');
  style.textContent = `
@keyframes scadaWidgetBlink {
  0%, 49% { opacity: 1; }
  50%, 100% { opacity: 0; }
}
`;
  document.head.appendChild(style);
  runtimeStyleInjected = true;
}

/* ------------------------------------------------------------------ */
/*  Runtime-only widget type union                                      */
/* ------------------------------------------------------------------ */

type RuntimeOnlyWidgetType =
  | 'runtimeGauge'
  | 'runtimeInput'
  | 'runtimePipe'
  | 'runtimeTable'
  | 'runtimeVideo'
  | 'runtimeScheduler';

type AnyWidgetType = ScadaWidgetType | RuntimeOnlyWidgetType;

/* ------------------------------------------------------------------ */
/*  Props                                                               */
/* ------------------------------------------------------------------ */

export interface RuntimeWidgetRendererProps {
  widgetType: AnyWidgetType;
  config: Record<string, unknown>;
  tagIds: string[];
  position: { x: number; y: number; w: number; h: number };
  permission?: WidgetPermission;
  actions?: WidgetAction[];
  events?: WidgetEventBinding[];
  /** Called when sidenav navigation is triggered by a widget event. */
  onNavigate?: (screenId: string) => void;
}

/* ------------------------------------------------------------------ */
/*  Fallback skeleton                                                   */
/* ------------------------------------------------------------------ */

const RuntimeSkeleton = memo<{ w: number; h: number }>(({ w, h }) => (
  <div
    className="flex items-center justify-center bg-gray-100 rounded"
    style={{ width: w, height: h }}
    aria-hidden="true"
  >
    <div className="w-5 h-5 border-2 border-gray-300 border-t-blue-400 rounded-full animate-spin" />
  </div>
));
RuntimeSkeleton.displayName = 'RuntimeSkeleton';

/* ------------------------------------------------------------------ */
/*  Error boundary                                                      */
/* ------------------------------------------------------------------ */

class RuntimeErrorBoundary extends Component<
  { children: React.ReactNode; widgetType: string; w: number; h: number },
  { hasError: boolean; message: string }
> {
  state = { hasError: false, message: '' };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, message: error.message };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[SCADA Runtime] Widget "${this.props.widgetType}" error:`, error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          className="flex flex-col items-center justify-center bg-red-50 text-red-700 text-xs rounded gap-1 p-2 text-center"
          style={{ width: this.props.w, height: this.props.h }}
          role="alert"
          aria-label={`Widget error: ${this.props.widgetType}`}
        >
          <span className="text-base">⚠</span>
          <span>{this.props.widgetType}</span>
          <span className="text-[10px] text-red-400 truncate max-w-full">{this.state.message}</span>
        </div>
      );
    }
    return this.props.children;
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * True for widget types that are handled by the new Runtime* components.
 * Everything else falls through to WidgetRenderer (existing builder renderers).
 */
function isRuntimeOnlyType(t: AnyWidgetType): t is RuntimeOnlyWidgetType {
  return (
    t === 'runtimeGauge'     ||
    t === 'runtimeInput'     ||
    t === 'runtimePipe'      ||
    t === 'runtimeTable'     ||
    t === 'runtimeVideo'     ||
    t === 'runtimeScheduler'
  );
}

/**
 * Build the CSS transform string from rotation + translation.
 * Returns undefined when both are at identity to avoid redundant style prop.
 */
function buildTransform(
  rotation: number,
  translation: { x: number; y: number } | null,
): string | undefined {
  const parts: string[] = [];
  if (translation) parts.push(`translate(${translation.x}px, ${translation.y}px)`);
  if (rotation !== 0) parts.push(`rotate(${rotation}deg)`);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/* ------------------------------------------------------------------ */
/*  Inner runtime-only renderer                                         */
/* ------------------------------------------------------------------ */

/**
 * Renders the correct Runtime* component.
 * All props come from the outer RuntimeWidgetRenderer.
 */
const RuntimeOnlyRenderer = memo<{
  widgetType: RuntimeOnlyWidgetType;
  config: Record<string, unknown>;
  tagIds: string[];
  tagValues: Record<string, TagValueChange>;
  primaryValue: unknown;
  primaryTimestamp: number;
  primaryQuality: TagValueChange['quality'];
  isEnabled: boolean;
  isVisible: boolean;
  actions: WidgetAction[];
  events: WidgetEventBinding[];
  onCommand: ((command: string, value?: unknown) => void) | undefined;
  w: number;
  h: number;
}>(({
  widgetType,
  config,
  tagIds,
  tagValues,
  primaryValue,
  primaryTimestamp,
  primaryQuality,
  isEnabled,
  isVisible,
  actions,
  events,
  onCommand,
  w,
  h,
}) => {
  // Base props shared by all Runtime* components (matches RuntimeWidgetProps)
  const sharedProps = {
    value:          primaryValue,
    timestamp:      primaryTimestamp,
    quality:        primaryQuality,
    config,
    isOperatorMode: true,
    isVisible,
    isEnabled,
    onCommand,
    actions,
    events,
    tagValues,
    width:  w,
    height: h,
  };

  switch (widgetType) {
    case 'runtimeGauge':
      return <RuntimeGauge {...sharedProps} />;
    case 'runtimeInput':
      return <RuntimeInput {...sharedProps} />;
    case 'runtimePipe':
      return <RuntimePipe {...sharedProps} />;
    case 'runtimeTable':
      // RuntimeTable accepts the extra tagIds prop for history-mode queries
      return <RuntimeTable {...sharedProps} tagIds={tagIds} />;
    case 'runtimeVideo':
      return <RuntimeVideo {...sharedProps} />;
    case 'runtimeScheduler':
      return <RuntimeScheduler {...sharedProps} />;
    default:
      return (
        <div className="flex items-center justify-center text-xs text-gray-400" style={{ width: w, height: h }}>
          Unknown runtime widget: {widgetType}
        </div>
      );
  }
});
RuntimeOnlyRenderer.displayName = 'RuntimeOnlyRenderer';

/* ------------------------------------------------------------------ */
/*  RuntimeWidgetRenderer                                               */
/* ------------------------------------------------------------------ */

export const RuntimeWidgetRenderer = memo<RuntimeWidgetRendererProps>(
  ({
    widgetType,
    config,
    tagIds,
    position,
    permission,
    actions,
    events,
    onNavigate,
  }) => {
    // Inject blink CSS once
    React.useEffect(injectRuntimeStyles, []);

    const { w, h } = position;

    /* ---- 1. Real-time data subscription ---- */
    const { values: tagValues } = useRealtimeData(tagIds);

    /* ---- 2. Permission check ---- */
    const { visible, enabled } = useOperatorPermission(permission);

    /* ---- 3. Widget actions evaluation ---- */
    const {
      isHidden,
      isBlinking,
      currentColor,
      rotation,
      translation,
    } = useWidgetActions(actions, tagValues);

    /* ---- 4. Widget event bindings ---- */
    const { handleEvent } = useWidgetEvents(events, onNavigate);

    /* ---- 5. onCommand callback (stable, used by all widgets) ---- */
    const handleCommand = useCallback(
      (_command: string, _value?: unknown) => {
        // Propagate generic interaction to the event system.
        // Widget-specific writes (setValue, toggleValue) are handled directly
        // by Runtime* components via useTagWrite; we fire the click event
        // here so any navigate/openDialog event bindings on 'click' also run.
        handleEvent('click');
      },
      [handleEvent],
    );

    /* ---- 6. Primary tag value (first tagId drives the main value) ---- */
    const primaryTagId = tagIds[0] ?? '';
    const primaryChange: TagValueChange | undefined = tagValues[primaryTagId];
    const primaryValue    = primaryChange?.value     ?? null;
    const primaryTs       = primaryChange?.timestamp ?? 0;
    const primaryQuality  = primaryChange?.quality   ?? 'good';

    /* ---- 7. Wrapper styles from action effects ---- */
    const wrapperStyle = useMemo<React.CSSProperties>(() => {
      const style: React.CSSProperties = {
        position:  'absolute',
        left:      position.x,
        top:       position.y,
        width:     w,
        height:    h,
        overflow:  'hidden',
      };

      // Hide
      if (!visible || isHidden) {
        style.display = 'none';
        return style;
      }

      // Blink via CSS animation
      if (isBlinking) {
        style.animation = `scadaWidgetBlink 1s step-end infinite`;
      }

      // Color override: tint the wrapper background/border
      if (currentColor?.fill) {
        style.outlineColor = currentColor.fill;
        style.outline = `2px solid ${currentColor.fill}`;
      }

      // Rotation + translation
      const transform = buildTransform(rotation, translation);
      if (transform) {
        style.transform = transform;
        style.transformOrigin = 'center center';
      }

      // Disabled visual feedback
      if (!enabled) {
        style.opacity = 0.5;
        style.pointerEvents = 'none';
        style.cursor = 'not-allowed';
      }

      return style;
    }, [
      position.x,
      position.y,
      w, h,
      visible,
      isHidden,
      isBlinking,
      currentColor,
      rotation,
      translation,
      enabled,
    ]);

    /* ---- Early-exit: hidden (permission or action) ---- */
    if (!visible) return null;

    /* ---- 8. Dispatch to renderer ---- */
    const content = isRuntimeOnlyType(widgetType) ? (
      <Suspense fallback={<RuntimeSkeleton w={w} h={h} />}>
        <RuntimeOnlyRenderer
          widgetType={widgetType}
          config={config}
          tagIds={tagIds}
          tagValues={tagValues}
          primaryValue={primaryValue}
          primaryTimestamp={primaryTs}
          primaryQuality={primaryQuality}
          isEnabled={enabled}
          isVisible={!isHidden}
          actions={actions ?? []}
          events={events ?? []}
          onCommand={handleCommand}
          w={w}
          h={h}
        />
      </Suspense>
    ) : (
      /* Delegate to existing editor-mode renderer with isEditing=false */
      <WidgetRenderer
        widgetType={widgetType as string}
        config={config}
        value={
          typeof primaryValue === 'number' ||
          typeof primaryValue === 'string' ||
          typeof primaryValue === 'boolean'
            ? primaryValue
            : undefined
        }
        width={w}
        height={h}
        isEditing={false}
        onCommand={handleCommand}
      />
    );

    return (
      <div
        style={wrapperStyle}
        aria-hidden={isHidden || !visible}
        data-widget-type={widgetType}
        onClick={() => handleEvent('click')}
        onDoubleClick={() => handleEvent('dblclick')}
        onMouseDown={() => handleEvent('mousedown')}
        onMouseUp={() => handleEvent('mouseup')}
        onMouseEnter={() => handleEvent('mouseover')}
        onMouseLeave={() => handleEvent('mouseout')}
      >
        <RuntimeErrorBoundary widgetType={widgetType} w={w} h={h}>
          {content}
        </RuntimeErrorBoundary>
      </div>
    );
  },
);

RuntimeWidgetRenderer.displayName = 'RuntimeWidgetRenderer';
