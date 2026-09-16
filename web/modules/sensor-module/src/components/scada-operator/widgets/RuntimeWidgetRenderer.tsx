/**
 * RuntimeWidgetRenderer — Master dispatcher for SCADA HMI operator mode.
 *
 * Responsibilities:
 *   1. Tag values: subscribes via useRealtimeData — OR runs CONTROLLED
 *      (T7a): when the parent (OperatorView bulk subscription) passes
 *      `tagValues` and `subscribe={false}`, the internal subscription is
 *      skipped so N widgets do not create N rAF timers.
 *   2. Permission check via useOperatorPermission (server-authoritative role)
 *   3. Tag-driven visual actions via useWidgetActions
 *   4. Interaction events via useWidgetEvents
 *   5. Action effects (hide, blink, color, rotate, translate) on the wrapper
 *   6. COMMAND ROUTER (T5): 'setValue' | 'toggle' | 'emergencyStop' |
 *      'vfd:start' | 'vfd:stop' | 'vfd:program' → permission-gated
 *      useTagWrite writes against the CANONICAL tag binding
 *      (getWidgetTagBinding + config.writeTagRef), with inline confirm UI
 *      (never window.confirm), server-side PIN elevation, and transient
 *      TAG_WRITE_ACK feedback.
 *   7. Per-tag staleness marking (T6): a tag whose newest sample is older
 *      than the staleness threshold renders with a visible stale indicator.
 *   8. Dispatch: builder types → WidgetRenderer (isEditing=false), with
 *      'trendChart' remapped to the uPlot RuntimeChart (T8); Runtime* types
 *      → the dedicated components.
 */

import React, {
  memo,
  Suspense,
  useMemo,
  useCallback,
  useEffect,
  useRef,
  useState,
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
import { useTagWrite }           from '../../../hooks/useTagWrite';
import { getWidgetTagBinding }   from '../../../engine/tags/widgetBinding';

import { getScadaSocketService } from '../../../services/ScadaSocketService';
import { ScadaSocketEvent } from '../../../types/scada-runtime.types';
import { useScadaPackageStore } from '../../../store/scada/createScadaStore';

// Existing editor-mode renderers (delegated with isEditing=false)
import { WidgetRenderer }        from '../../scada-builder/WidgetRenderer';

// Runtime-only components (lazy-loaded for code splitting)
const RuntimeGauge     = React.lazy(() => import('./RuntimeGauge'));
const RuntimeInput     = React.lazy(() => import('./RuntimeInput'));
const RuntimePipe      = React.lazy(() => import('./RuntimePipe'));
const RuntimeTable     = React.lazy(() => import('./RuntimeTable'));
const RuntimeVideo     = React.lazy(() => import('./RuntimeVideo'));
const RuntimeScheduler = React.lazy(() => import('./RuntimeScheduler'));
const RuntimeChart     = React.lazy(() => import('./RuntimeChart'));

/* ------------------------------------------------------------------ */
/*  CSS injection (blink + staleness keyframes — once per document)     */
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
.scada-tag-stale { outline: 1px dashed rgba(234, 179, 8, 0.9); outline-offset: -1px; }
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
  | 'runtimeScheduler'
  | 'runtimeChart';

/** All renderable widget types (persisted builder docs use open strings —
 *  unknown types degrade through the error boundary, never crash). */
export type AnyWidgetType = ScadaWidgetType | RuntimeOnlyWidgetType;

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

  /* ---- Controlled mode (T7a) ---- */
  /**
   * Tag values supplied by the parent (OperatorView's single bulk
   * subscription). When provided together with subscribe={false} the
   * widget skips its internal useRealtimeData hook entirely.
   */
  tagValues?: Record<string, TagValueChange>;
  /** Set false when the parent supplies tagValues. Default true. */
  subscribe?: boolean;

  /* ---- Widget layer parity (T7f) — applied to the positioning wrapper ---- */
  /** Stacking order within the screen (builder stores sparse indices). */
  zIndex?: number;
  /** Free-form CSS transform string from builder widget config. */
  transform?: string;
  /** DOM id for the wrapper element (builder widget id). */
  widgetId?: string;
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
 * True for widget types that are handled by the Runtime* components.
 * Everything else falls through to WidgetRenderer (existing builder renderers).
 */
function isRuntimeOnlyType(t: AnyWidgetType): t is RuntimeOnlyWidgetType {
  return (
    t === 'runtimeGauge'     ||
    t === 'runtimeInput'     ||
    t === 'runtimePipe'      ||
    t === 'runtimeTable'     ||
    t === 'runtimeVideo'     ||
    t === 'runtimeScheduler' ||
    t === 'runtimeChart'
  );
}

/** Builder 'trendChart' widgets render as the uPlot RuntimeChart at runtime (T8). */
function isTrendChartType(t: AnyWidgetType): boolean {
  return t === 'trendChart';
}

/** Adapt builder trendChart config (tags / pens) to RuntimeChart series. */
function buildTrendChartConfig(config: Record<string, unknown>): Record<string, unknown> {
  const pens = (config.pens ?? config.lines ?? config.tags ?? config.trendTags) as
    | Array<Record<string, unknown>>
    | string[]
    | undefined;

  let series: Array<{ tagId: string; label: string; color?: string }> | undefined;

  if (Array.isArray(pens)) {
    series = pens
      .map((pen, i) =>
        typeof pen === 'string'
          ? { tagId: pen, label: pen }
          : {
              tagId: String(pen.tagId ?? pen.tagRef ?? pen.tagName ?? pen.tag ?? ''),
              label: String(pen.label ?? pen.tagId ?? pen.tagRef ?? pen.tagName ?? pen.tag ?? `Series ${i + 1}`),
              color: typeof pen.color === 'string' ? pen.color : undefined,
            },
      )
      .filter((s) => s.tagId.length > 0);
  }

  return {
    ...config,
    ...(series ? { series } : {}),
    title: config.label ?? config.title ?? '',
  };
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

/** Default per-tag staleness threshold (T6). */
const DEFAULT_STALE_AFTER_MS = 60_000;

/** A tag is stale at sampleInterval × this factor (whichever bound applies). */
const STALENESS_FACTOR = 3;

/* ------------------------------------------------------------------ */
/*  Inline confirm dialog (T5 — NOT window.confirm)                    */
/* ------------------------------------------------------------------ */

interface ConfirmDialogProps {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

const InlineConfirmDialog = memo<ConfirmDialogProps>(({ message, onConfirm, onCancel }) => (
  <div
    className="absolute inset-0 z-20 flex items-center justify-center bg-black/50 p-2"
    role="alertdialog"
    aria-label="Confirm command"
  >
    <div className="bg-white rounded-lg shadow-xl p-3 max-w-[90%] flex flex-col gap-2">
      <p className="text-xs text-gray-800 font-medium">{message}</p>
      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="px-2 py-1 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="px-2 py-1 text-xs rounded bg-red-600 text-white hover:bg-red-700"
        >
          Confirm
        </button>
      </div>
    </div>
  </div>
));
InlineConfirmDialog.displayName = 'InlineConfirmDialog';

/* ------------------------------------------------------------------ */
/*  PIN dialog (T5 — server-side verification via ScadaSocketService)  */
/* ------------------------------------------------------------------ */

interface PinDialogProps {
  onVerified: () => void;
  onCancel: () => void;
}

const PinDialog = memo<PinDialogProps>(({ onVerified, onCancel }) => {
  const packageId = useScadaPackageStore((s) => s.packageId);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  const handleConfirm = useCallback(() => {
    if (!packageId || verifying) return;
    setVerifying(true);
    setError(null);
    getScadaSocketService()
      .verifyPin(packageId, pin)
      .then((result) => {
        if (result.valid) {
          onVerified();
        } else {
          setPin('');
          setError(
            result.lockedUntil
              ? 'Too many attempts — PIN entry is temporarily locked'
              : 'Incorrect PIN',
          );
        }
      })
      .catch(() => setError('PIN verification unavailable — not connected'))
      .finally(() => setVerifying(false));
  }, [packageId, pin, verifying, onVerified]);

  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-black/50 p-2"
      role="dialog"
      aria-label="Enter PIN"
      aria-modal="true"
    >
      <div className="bg-white rounded-lg shadow-xl p-3 w-56 flex flex-col gap-2">
        <h3 className="text-xs font-semibold text-gray-800">PIN required</h3>
        <input
          type="password"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleConfirm()}
          placeholder="PIN"
          autoFocus
          aria-label="PIN"
          className="px-2 py-1 border border-gray-300 rounded text-sm focus:outline-hidden focus:ring-2 focus:ring-blue-400"
        />
        {error && (
          <p className="text-xs text-red-600" role="alert">{error}</p>
        )}
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="px-2 py-1 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={verifying}
            className="px-2 py-1 text-xs rounded bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50"
          >
            {verifying ? 'Verifying…' : 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
});
PinDialog.displayName = 'PinDialog';

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
    case 'runtimeChart':
      return <RuntimeChart {...sharedProps} />;
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

/** Transient write-ack feedback shown on the widget frame (T5). */
type WriteAckState = 'ok' | 'fail' | null;

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
    tagValues: controlledTagValues,
    subscribe = true,
    zIndex,
    transform,
    widgetId,
  }) => {
    // Inject blink/staleness CSS once
    React.useEffect(injectRuntimeStyles, []);

    const { w, h } = position;

    /* ---- 1. Real-time data (controlled mode skips the hook, T7a) ---- */
    const shouldSubscribe = subscribe && !controlledTagValues;
    const liveResult = useRealtimeData(shouldSubscribe ? tagIds : []);
    const tagValues = shouldSubscribe
      ? liveResult.values
      : (controlledTagValues ?? {});

    /* ---- 2. Permission check ---- */
    const permissionResult = useOperatorPermission(permission);
    const { visible, enabled } = permissionResult;

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

    /* ---- 5. Command router (T5) ---- */
    const { writeTag, toggleTag } = useTagWrite();
    const controlPermissions = useScadaPackageStore((s) => s.controlPermissions);
    const packageId = useScadaPackageStore((s) => s.packageId);

    const [pendingConfirm, setPendingConfirm] = useState<{
      command: string;
      value?: unknown;
    } | null>(null);
    const [pendingPin, setPendingPin] = useState<{ command: string; value?: unknown } | null>(null);
    const [writeAck, setWriteAck] = useState<WriteAckState>(null);
    const [eStopLatched, setEStopLatched] = useState(false);
    const writeAckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
      return () => {
        if (writeAckTimerRef.current) clearTimeout(writeAckTimerRef.current);
      };
    }, []);

    /**
     * Resolve the CANONICAL target tag: config.writeTagRef wins (explicit
     * write target), then the shared binding accessor (tagRef → legacy keys),
     * finally the first subscribed tag id.
     */
    const resolveTargetTag = useCallback((): string | undefined => {
      const writeRef = config.writeTagRef;
      if (typeof writeRef === 'string' && writeRef.trim()) return writeRef.trim();
      return getWidgetTagBinding(config) ?? tagIds[0];
    }, [config, tagIds]);

    /** Flash a write-ack outcome on the widget frame for ~2 s. */
    const flashWriteAck = useCallback((state: Exclude<WriteAckState, null>) => {
      if (writeAckTimerRef.current) clearTimeout(writeAckTimerRef.current);
      setWriteAck(state);
      writeAckTimerRef.current = setTimeout(() => setWriteAck(null), 2_000);
    }, []);

    // TAG_WRITE_ACK → transient widget state (T5).
    useEffect(() => {
      const socket = getScadaSocketService();
      const targetTag = resolveTargetTag();
      const handler = (payload: { tagId: string; success: boolean; error?: string }): void => {
        if (!targetTag || payload.tagId !== targetTag) return;
        flashWriteAck(payload.success ? 'ok' : 'fail');
        if (!payload.success) {
          console.warn(`[RuntimeWidgetRenderer] write to ${payload.tagId} rejected: ${payload.error ?? 'unknown error'}`);
        }
      };
      socket.on(ScadaSocketEvent.TAG_WRITE_ACK, handler);
      return () => {
        socket.off(ScadaSocketEvent.TAG_WRITE_ACK, handler);
      };
    }, [resolveTargetTag, flashWriteAck]);

    /**
     * E-STOP runtime side (T3): write every affectedTag to its safe value
     * (0 / de-energized — ControlPermissionsDef carries no per-tag safe
     * value, so the de-energized convention applies), latch the state, and
     * audit the activation.
     */
    const executeEmergencyStop = useCallback(async () => {
      const eStop = controlPermissions?.emergencyStop;
      const affected = eStop?.affectedTags ?? [];
      setEStopLatched(true);
      // Audit entry — TODO(backend): a dedicated scada audit event is not yet
      // in the socket contract; logged structurally client-side until then.
      console.warn(
        `[E-STOP] ACTIVATED ${new Date().toISOString()} package=${packageId ?? '?'} affectedTags=[${affected.join(', ')}]`,
      );
      for (const tag of affected) {
        try {
          await writeTag(tag, 0); // safe (de-energized) value
        } catch (err) {
          console.error(`[E-STOP] failed to write safe value to ${tag}:`, err);
        }
      }
    }, [controlPermissions, packageId, writeTag]);

    /**
     * E-STOP reset (A3/Plan 2): release the latch. The reset does NOT write
     * tag values — re-energizing equipment is a deliberate operator action
     * through the normal controls; this only re-enables them. Audited like
     * the activation.
     */
    const doResetEStop = useCallback(() => {
      setEStopLatched(false);
      console.warn(
        `[E-STOP] RESET ${new Date().toISOString()} package=${packageId ?? '?'}`,
      );
    }, [packageId]);

    /**
     * Reset request routing (A3): when the package demands
     * `resetRequiresPin`, the latch may only be released after server-side
     * PIN elevation; otherwise reset directly.
     */
    const requestEStopReset = useCallback(() => {
      if (controlPermissions?.emergencyStop?.resetRequiresPin) {
        setPendingPin({ command: 'eStopReset' });
        return;
      }
      doResetEStop();
    }, [controlPermissions, doResetEStop]);

    /** Perform the actual write for a routed command (post confirm/PIN). */
    const performWrite = useCallback(
      async (command: string, value?: unknown) => {
        // E-stop latch release has no tag target — handle before the
        // binding resolution guard below.
        if (command === 'eStopReset') {
          doResetEStop();
          return;
        }
        // E-STOP writes its AFFECTED TAGS (package-level config), not the
        // widget's own binding — it must fire even on an unbound widget.
        if (command === 'emergencyStop') {
          await executeEmergencyStop();
          return;
        }
        const targetTag = resolveTargetTag();
        if (!targetTag) {
          console.warn(`[RuntimeWidgetRenderer] command "${command}" has no target tag binding`);
          return;
        }
        try {
          switch (command) {
            case 'toggle':
              await toggleTag(targetTag);
              break;
            case 'emergencyStop':
              await executeEmergencyStop();
              break;
            case 'vfd:start':
              await writeTag(targetTag, value ?? 1);
              break;
            case 'vfd:stop':
              await writeTag(targetTag, value ?? 0);
              break;
            case 'vfd:program':
              await writeTag(targetTag, value);
              break;
            case 'setValue':
            default:
              await writeTag(targetTag, value);
              break;
          }
        } catch {
          // useTagWrite surfaces the error; the write-ack handler flashes fail.
        }
      },
      [resolveTargetTag, toggleTag, writeTag, executeEmergencyStop, doResetEStop],
    );

    /**
     * Route a widget command. Order of gates:
     *   enabled → confirm (inline UI) → PIN (server verify) → write.
     */
    const handleCommand = useCallback(
      (command: string, value?: unknown) => {
        // Propagate generic interaction to the event system first so any
        // navigate/openDialog event bindings on 'click' also run.
        handleEvent('click');

        if (!enabled) return;

        const requiresConfirm =
          command === 'emergencyStop' ||
          Boolean(config.requiresConfirm) ||
          permissionResult.requiresConfirm;

        if (requiresConfirm) {
          setPendingConfirm({ command, value });
          return;
        }

        if (permissionResult.requiresPin || config.requiresPin === true) {
          setPendingPin({ command, value });
          return;
        }

        void performWrite(command, value);
      },
      [enabled, config.requiresConfirm, config.requiresPin, permissionResult, performWrite, handleEvent],
    );

    const handleConfirmAccept = useCallback(() => {
      const pending = pendingConfirm;
      setPendingConfirm(null);
      if (!pending) return;
      if (permissionResult.requiresPin || config.requiresPin === true) {
        setPendingPin(pending);
        return;
      }
      void performWrite(pending.command, pending.value);
    }, [pendingConfirm, permissionResult.requiresPin, config.requiresPin, performWrite]);

    /* ---- 6. Primary tag value — CANONICAL binding, not tagIds[0] (T7b) ---- */
    const primaryTagId = getWidgetTagBinding(config) ?? tagIds[0] ?? '';
    const primaryChange: TagValueChange | undefined = tagValues[primaryTagId];
    const primaryValue    = primaryChange?.value     ?? null;
    const primaryTs       = primaryChange?.timestamp ?? 0;
    // T5: absent data is UNCERTAIN, never 'good' — a missing sample must not
    // render as healthy telemetry.
    const primaryQuality  = primaryChange?.quality   ?? 'uncertain';

    /* ---- 6b. Per-tag staleness (T6) ---- */
    // Threshold precedence: widget config.staleAfterSec → package
    // trendConfig.sampleIntervalSec × STALENESS_FACTOR → 60 s default.
    // (trendConfig state lives in the alarm/trend slice of the store.)
    const trendSampleIntervalSec = useScadaPackageStore((s) => s.trendConfig?.sampleIntervalSec);
    const staleAfterMs = useMemo(() => {
      const cfg = Number(config.staleAfterSec);
      if (Number.isFinite(cfg) && cfg > 0) return cfg * 1000;
      if (
        trendSampleIntervalSec != null &&
        Number.isFinite(trendSampleIntervalSec) &&
        trendSampleIntervalSec > 0
      ) {
        return trendSampleIntervalSec * 1000 * STALENESS_FACTOR;
      }
      return DEFAULT_STALE_AFTER_MS;
    }, [config.staleAfterSec, trendSampleIntervalSec]);

    const isPrimaryStale = useMemo(() => {
      if (!primaryChange) return false;
      return Date.now() - primaryChange.timestamp > staleAfterMs;
    }, [primaryChange, staleAfterMs]);

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

      // Stacking order (T7f) — builder stores sparse z indices.
      if (zIndex !== undefined) {
        style.zIndex = zIndex;
      }

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

      // Rotation + translation (+ builder free-form transform, T7f)
      const actionTransform = buildTransform(rotation, translation);
      if (actionTransform && transform) {
        style.transform = `${transform} ${actionTransform}`;
      } else {
        style.transform = actionTransform ?? transform;
      }
      if (style.transform) {
        style.transformOrigin = 'center center';
      }

      // Disabled visual feedback
      if (!enabled) {
        style.opacity = 0.5;
        style.pointerEvents = 'none';
        style.cursor = 'not-allowed';
      }

      // Stale data marking (T6)
      if (isPrimaryStale) {
        style.outline = '1px dashed rgba(234, 179, 8, 0.9)';
        style.outlineOffset = -1;
      }

      // Write-ack flash (T5)
      if (writeAck === 'ok') {
        style.outline = '2px solid rgb(34, 197, 94)';
      } else if (writeAck === 'fail') {
        style.outline = '2px solid rgb(220, 38, 38)';
      }

      // Latched E-STOP (T3)
      if (eStopLatched) {
        style.outline = '3px solid rgb(153, 27, 27)';
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
      isPrimaryStale,
      writeAck,
      eStopLatched,
      zIndex,
      transform,
    ]);

    /* ---- Early-exit: hidden (permission or action) ---- */
    if (!visible) return null;

    /* ---- 8. Dispatch to renderer ---- */
    const chartConfig = isTrendChartType(widgetType)
      ? buildTrendChartConfig(config)
      : config;

    const content = isRuntimeOnlyType(widgetType) || isTrendChartType(widgetType) ? (
      <Suspense fallback={<RuntimeSkeleton w={w} h={h} />}>
        <RuntimeOnlyRenderer
          widgetType={isTrendChartType(widgetType) ? 'runtimeChart' : widgetType as RuntimeOnlyWidgetType}
          config={chartConfig}
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
        className={isPrimaryStale ? 'scada-tag-stale' : undefined}
        data-widget-type={widgetType}
        data-widget-id={widgetId}
        aria-hidden={isHidden || !visible}
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

        {/* Latched E-STOP reset affordance (A3) — gates on resetRequiresPin */}
        {eStopLatched && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              requestEStopReset();
            }}
            className="absolute top-1 right-1 z-10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide rounded bg-red-900 text-white hover:bg-red-700"
            title={
              controlPermissions?.emergencyStop?.resetRequiresPin
                ? 'Reset E-Stop (PIN required)'
                : 'Reset E-Stop'
            }
          >
            Reset E-Stop
          </button>
        )}

        {/* Inline confirm (T5) — never window.confirm */}
        {pendingConfirm && (
          <InlineConfirmDialog
            message={
              pendingConfirm.command === 'emergencyStop'
                ? 'EMERGENCY STOP: all affected tags will be driven to their safe values. Activate?'
                : `Confirm command "${pendingConfirm.command}"${
                    pendingConfirm.value !== undefined ? ` (${String(pendingConfirm.value)})` : ''
                  }?`
            }
            onConfirm={handleConfirmAccept}
            onCancel={() => setPendingConfirm(null)}
          />
        )}

        {/* PIN elevation (T5) — server-side verification */}
        {pendingPin && (
          <PinDialog
            onVerified={() => {
              const pending = pendingPin;
              setPendingPin(null);
              if (pending) void performWrite(pending.command, pending.value);
            }}
            onCancel={() => setPendingPin(null)}
          />
        )}
      </div>
    );
  },
);

RuntimeWidgetRenderer.displayName = 'RuntimeWidgetRenderer';
