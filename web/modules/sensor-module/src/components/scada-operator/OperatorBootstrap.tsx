/**
 * OperatorBootstrap — Wraps the operator HMI with all required providers
 * and initializes runtime services (socket, subscriptions, alarm listener).
 *
 * Usage:
 *   <OperatorBootstrap packageId="..." dataProviderType="live">
 *     <OperatorShell>
 *       <OperatorView screen={...} />
 *     </OperatorShell>
 *   </OperatorBootstrap>
 *
 * Responsibilities:
 *  - Loads the SCADA package from the store (keyed by packageId)
 *  - Initializes ScadaSocketService connection on mount; disconnects on unmount
 *  - Registers typed event listeners for:
 *      ALARM_STATUS   → alarmRuntimeSlice.updateAlarmStatus
 *      SCRIPT_CONSOLE → scriptSlice.addConsoleOutput
 *      COMMAND_SET_VIEW / COMMAND_OPEN_CARD / COMMAND_TOAST → operatorSlice
 *  - Removes all listeners and disconnects socket on unmount
 *  - Wraps the subtree in an ErrorBoundary
 *  - Shows a loading indicator while the package is being resolved
 */

import React, {
  useEffect,
  useState,
  useCallback,
  useRef,
  type ReactNode,
  Component,
  type ErrorInfo,
} from 'react';

import {
  ScadaSocketEvent,
  type AlarmStatusSummary,
  type DataProviderType,
} from '../../types/scada-runtime.types';
import { getScadaSocketService } from '../../services/ScadaSocketService';
import { useScadaPackageStore } from '../../store/scada/createScadaStore';
import { useOperatorStore } from '../../store/scada/operatorStore';

/* ------------------------------------------------------------------ */
/*  Error Boundary                                                      */
/* ------------------------------------------------------------------ */

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class OperatorErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[OperatorBootstrap] Uncaught error in operator tree:', error, info);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          role="alert"
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh',
            background: '#0f172a',
            color: '#f87171',
            fontFamily: 'monospace',
            gap: '12px',
            padding: '32px',
          }}
        >
          <strong style={{ fontSize: '1.25rem' }}>Operator HMI error</strong>
          <pre style={{ fontSize: '0.8rem', color: '#fca5a5', maxWidth: '600px', whiteSpace: 'pre-wrap' }}>
            {this.state.error?.message ?? 'Unknown error'}
          </pre>
        </div>
      );
    }

    return this.props.children;
  }
}

/* ------------------------------------------------------------------ */
/*  Loading state                                                       */
/* ------------------------------------------------------------------ */

function BootstrapLoader(): React.ReactElement {
  return (
    <div
      aria-label="Loading operator interface"
      aria-busy="true"
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        background: '#0f172a',
        color: '#94a3b8',
        fontFamily: 'sans-serif',
        fontSize: '0.875rem',
        gap: '10px',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: '18px',
          height: '18px',
          border: '2px solid #334155',
          borderTopColor: '#38bdf8',
          borderRadius: '50%',
          display: 'inline-block',
          animation: 'spin 0.75s linear infinite',
        }}
      />
      Loading SCADA package…
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Props                                                               */
/* ------------------------------------------------------------------ */

export interface OperatorBootstrapProps {
  /**
   * The SCADA package ID to load.
   * When provided, the bootstrap sets the packageId on the store.
   */
  packageId: string;

  /**
   * Which data provider implementation to use for tag subscriptions.
   * Forwarded to OperatorShell / DataProviderRoot via children.
   * Stored here so OperatorBootstrap can gate socket init on live mode.
   */
  dataProviderType: DataProviderType;

  /**
   * The operator subtree — typically:
   *   <OperatorShell>
   *     <OperatorView screen={...} />
   *   </OperatorShell>
   */
  children: ReactNode;
}

/* ------------------------------------------------------------------ */
/*  OperatorBootstrap (inner — rendered once package is ready)         */
/* ------------------------------------------------------------------ */

/**
 * The inner bootstrap that runs effects once the package is confirmed ready.
 * Extracted so hooks are not called conditionally in the outer component.
 */
function OperatorBootstrapInner({
  packageId,
  dataProviderType,
  children,
}: OperatorBootstrapProps): React.ReactElement {
  // ── Slice actions ──────────────────────────────────────────────────
  const updateAlarmStatus = useScadaPackageStore((s) => s.updateAlarmStatus);
  const addConsoleOutput   = useScadaPackageStore((s) => s.addConsoleOutput);
  const setActiveScreen    = useScadaPackageStore((s) => s.setActiveScreen);
  const openOverlay        = useOperatorStore((s) => s.openOverlay);

  // ── Socket service (singleton) ─────────────────────────────────────
  const initSocket = useCallback((): (() => void) => {
    const socket = getScadaSocketService();

    // Connect (no-op if already connected)
    socket.connect();

    // --- ALARM_STATUS → alarmRuntimeSlice.updateAlarmStatus -----------
    // ALARM_STATUS is not in ScadaEventPayloadMap, so we cast to reach
    // the typed `on` surface via the raw event string.
    const onAlarmStatus = (payload: AlarmStatusSummary): void => {
      updateAlarmStatus(payload);
    };

    // --- SCRIPT_CONSOLE → scriptSlice.addConsoleOutput ----------------
    const onScriptConsole = (payload: { scriptId: string; message: string }): void => {
      addConsoleOutput(payload.scriptId, payload.message);
    };

    // --- COMMAND_SET_VIEW → operatorSlice.setActiveScreen -------------
    const onSetView = (payload: { screenId: string }): void => {
      setActiveScreen(payload.screenId);
    };

    // --- COMMAND_OPEN_CARD → operatorSlice.openOverlay ----------------
    const onOpenCard = (payload: { screenId: string; x?: number; y?: number }): void => {
      openOverlay({
        type: 'card',
        screenId: payload.screenId,
        position: { x: payload.x ?? 100, y: payload.y ?? 100 },
      });
    };

    // --- COMMAND_TOAST → operatorSlice.openOverlay (dialog variant) ---
    // Toast commands are surfaced as a transient overlay that the
    // ViewOverlayManager (or a toast renderer) can consume.
    const onToast = (payload: { message: string; type?: string }): void => {
      // Dispatch as a dialog-type overlay so the overlay manager can
      // render it. The overlay title carries the type for styling.
      openOverlay({
        type: 'dialog',
        title: payload.type ?? 'info',
        position: { x: 0, y: 0 },
        // screenId deliberately omitted — toast content comes from title
      });
      // Also log to console for debugging
      console.info(`[OperatorBootstrap] TOAST (${payload.type ?? 'info'}): ${payload.message}`);
    };

    // Register listeners — cast through unknown for events not in the
    // typed ScadaEventPayloadMap (ALARM_STATUS, SCRIPT_CONSOLE).
    const socketAny = socket as unknown as {
      on(event: string, cb: (payload: unknown) => void): void;
      off(event: string, cb: (payload: unknown) => void): void;
    };

    socketAny.on(ScadaSocketEvent.ALARM_STATUS, onAlarmStatus as (p: unknown) => void);
    socketAny.on(ScadaSocketEvent.SCRIPT_CONSOLE, onScriptConsole as (p: unknown) => void);

    socket.on(ScadaSocketEvent.COMMAND_SET_VIEW, onSetView);
    socket.on(ScadaSocketEvent.COMMAND_OPEN_CARD, onOpenCard);
    socket.on(ScadaSocketEvent.COMMAND_TOAST, onToast);

    // Cleanup: remove listeners and disconnect socket
    return () => {
      socketAny.off(ScadaSocketEvent.ALARM_STATUS, onAlarmStatus as (p: unknown) => void);
      socketAny.off(ScadaSocketEvent.SCRIPT_CONSOLE, onScriptConsole as (p: unknown) => void);
      socket.off(ScadaSocketEvent.COMMAND_SET_VIEW, onSetView);
      socket.off(ScadaSocketEvent.COMMAND_OPEN_CARD, onOpenCard);
      socket.off(ScadaSocketEvent.COMMAND_TOAST, onToast);
      socket.disconnect();
    };
  }, [
    updateAlarmStatus,
    addConsoleOutput,
    setActiveScreen,
    openOverlay,
  ]);

  // Only connect the live socket when not in simulation mode
  useEffect(() => {
    if (dataProviderType === 'simulation') {
      // Simulation mode: no socket needed; return early with no-op cleanup
      return undefined;
    }
    const cleanup = initSocket();
    return cleanup;
  }, [dataProviderType, initSocket]);

  // Mark operator mode active for the duration this component is mounted
  const setOperatorMode = useScadaPackageStore((s) => s.setOperatorMode);
  useEffect(() => {
    setOperatorMode(true);
    return () => {
      setOperatorMode(false);
    };
  }, [setOperatorMode]);

  return <>{children}</>;
}

/* ------------------------------------------------------------------ */
/*  OperatorBootstrap (outer — handles package loading gate)           */
/* ------------------------------------------------------------------ */

/**
 * OperatorBootstrap — Top-level integration bootstrap for the SCADA HMI.
 *
 * Wraps children in an ErrorBoundary and a loading gate, then wires up
 * the socket connection and event listeners once the package is ready.
 */
export const OperatorBootstrap: React.FC<OperatorBootstrapProps> = ({
  packageId,
  dataProviderType,
  children,
}) => {
  const [ready, setReady] = useState(false);

  // Store actions for package loading
  const storePackageId  = useScadaPackageStore((s) => s.packageId);
  const setStorePackageId = useScadaPackageStore((s) => s.setPackageId);
  const setOperatorLayout = useScadaPackageStore((s) => s.setOperatorLayout);
  const operatorLayout    = useScadaPackageStore((s) => s.operatorLayout);

  // Use a ref to capture the layout at the time of initialization,
  // preventing the re-render loop caused by operatorLayout being both
  // read and written in the same effect's dependency array.
  const layoutSnapshotRef = useRef(operatorLayout);
  layoutSnapshotRef.current = operatorLayout;
  const hasInitializedRef = useRef(false);

  useEffect(() => {
    if (!packageId) return;

    // If the store already has this package loaded, skip re-init.
    if (storePackageId === packageId) {
      setReady(true);
      return;
    }

    // Guard against re-initialization across renders
    if (hasInitializedRef.current) return;
    hasInitializedRef.current = true;

    // Set the package ID in the store, then mark ready.
    // Real apps would fetch package JSON from an API and call loadFromJSON;
    // the bootstrap only wires the ID here — the caller may pre-load the
    // package JSON before rendering OperatorBootstrap.
    setStorePackageId(packageId);

    // Activate operator mode layout defaults using the ref snapshot
    // to avoid including operatorLayout in the dependency array.
    setOperatorLayout({
      ...layoutSnapshotRef.current,
    });

    setReady(true);
  }, [packageId, storePackageId, setStorePackageId, setOperatorLayout]);

  if (!ready) {
    return <BootstrapLoader />;
  }

  return (
    <OperatorErrorBoundary>
      <OperatorBootstrapInner
        packageId={packageId}
        dataProviderType={dataProviderType}
      >
        {children}
      </OperatorBootstrapInner>
    </OperatorErrorBoundary>
  );
};

OperatorBootstrap.displayName = 'OperatorBootstrap';
