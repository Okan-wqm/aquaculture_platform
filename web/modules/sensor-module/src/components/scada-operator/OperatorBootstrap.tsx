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
 *  - Loads the SCADA package from the store (keyed by packageId); tolerates
 *    packageId changes (kiosk deep links) by re-running the init effect
 *  - Initializes ScadaSocketService connection on mount; releases shared
 *    ownership on unmount (refcounted — the live data provider co-owns it)
 *  - Registers typed event listeners for:
 *      ALARM_STATUS   → alarmRuntimeSlice.updateAlarmStatus   (single dispatcher)
 *      SCRIPT_CONSOLE → scriptSlice.addConsoleOutput
 *      COMMAND_SET_VIEW / COMMAND_OPEN_CARD / COMMAND_TOAST → operatorSlice
 *      AUTH           → operatorSlice.setCurrentUserRole (server-authoritative)
 *  - Derives sidenav navItems from the package screens (T7h)
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
  type HmiRole,
  type OperatorNavItem,
} from '../../types/scada-runtime.types';
import { getScadaSocketService } from '../../services/ScadaSocketService';
import { useAlarmRuntime } from '../../hooks/useAlarmRuntime';
import { useScadaPackageStore } from '../../store/scada/createScadaStore';
import type { ScreenDef } from '../../store/scada/types';

/**
 * Server role strings → HmiRole. The AUTH handshake sends the JWT role verbatim
 * (backend Role enum: SUPER_ADMIN/TENANT_ADMIN/MODULE_MANAGER/MODULE_USER — see
 * libs/backend-common roles.decorator). Unknown roles degrade to 'viewer'
 * (least privilege).
 */
function toHmiRole(serverRole: string | undefined): HmiRole {
  const normalized = (serverRole ?? '').trim().toLowerCase();
  switch (normalized) {
    // Backend Role enum values (uppercase with underscores on the wire).
    case 'super_admin':
    case 'tenant_admin':
      return 'admin';
    case 'module_manager':
      return 'supervisor';
    case 'module_user':
      return 'operator';
    // Plain HmiRole passthrough (kept for any sender already using the
    // operator-domain vocabulary).
    case 'admin':
    case 'supervisor':
    case 'engineer':
    case 'operator':
    case 'viewer':
      return normalized;
    default:
      return 'viewer';
  }
}

/**
 * Derive sidenav navItems from the package's screens (T7h).
 * label = screen name; icon = configured icon or the screen type. Screen
 * hierarchy (parentId) is flattened one level deep — deep hierarchies are
 * rendered as a flat list until the sidenav grows tree support.
 */
export function deriveNavItems(screens: ScreenDef[]): OperatorNavItem[] {
  const rootScreens = screens
    .filter((s) => s.parentId == null)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));

  return rootScreens.map((screen) => ({
    id: `nav-${screen.id}`,
    screenId: screen.id,
    label: screen.name,
    icon: screen.icon || screen.screenType,
    children: screens
      .filter((s) => s.parentId === screen.id)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name))
      .map((child) => ({
        id: `nav-${child.id}`,
        screenId: child.id,
        label: child.name,
        icon: child.icon || child.screenType,
      })),
  }));
}

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
  // ── Slice actions (unified package store) ───────────────────────────
  const updateAlarmStatus = useScadaPackageStore((s) => s.updateAlarmStatus);
  const addConsoleOutput  = useScadaPackageStore((s) => s.addConsoleOutput);
  const setActiveScreen   = useScadaPackageStore((s) => s.setActiveScreen);
  const openOverlay       = useScadaPackageStore((s) => s.openViewOverlay);
  const setCurrentUserRole = useScadaPackageStore((s) => s.setCurrentUserRole);

  // ── Alarm actions (A2/Plan 2): SINGLE consumer of pendingActions ────
  // The server's alarm engine queues toast/popup/setView commands in the
  // store (pendingActions). Only this mount drains the queue — passive
  // consumers (AlarmPanel, AlarmSummaryBar) mount useAlarmRuntime WITHOUT
  // processActions so they can never swallow the commands again.
  useAlarmRuntime({
    processActions: true,
    callbacks: {
      onToast: (message, type) => {
        openOverlay({
          type: 'toast',
          title: 'Alarm',
          message,
          severity: type,
          position: { x: 0, y: 0 },
        });
      },
      onPopup: (message) => {
        openOverlay({
          type: 'dialog',
          title: 'Alarm',
          message,
          position: { x: 120, y: 120 },
        });
      },
      onSetView: (viewId) => {
        setActiveScreen(viewId);
      },
    },
  });

  // ── Socket service (singleton) ─────────────────────────────────────
  const initSocket = useCallback((): (() => void) => {
    const socket = getScadaSocketService();

    // Connect (no-op if already connected). Persistent: the operator route
    // must keep retrying through a full outage and self-heal (T6).
    socket.connect({ persistent: true });

    // T6: claim shared ownership; cleanup releases it (refcounted).
    socket.acquire();

    // --- ALARM_STATUS → alarmRuntimeSlice.updateAlarmStatus -----------
    // Single dispatcher: useAlarmRuntime reads the store; registering the
    // listener here (and only here) avoids double-enqueued pendingActions.
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

    // --- COMMAND_OPEN_CARD → operatorSlice.openViewOverlay ------------
    const onOpenCard = (payload: { screenId: string; x?: number; y?: number }): void => {
      openOverlay({
        type: 'card',
        screenId: payload.screenId,
        position: { x: payload.x ?? 100, y: payload.y ?? 100 },
      });
    };

    // --- COMMAND_TOAST → operatorSlice.openViewOverlay (toast variant) ---
    // T7i: the toast overlay carries the ACTUAL message text; severity only
    // styles it (the old flow put the type string in the dialog title and
    // dropped the message entirely).
    const onToast = (payload: { message: string; type?: string }): void => {
      const severity = payload.type ?? 'info';
      openOverlay({
        type: 'toast',
        title: 'Notification',
        message: payload.message,
        severity,
        position: { x: 0, y: 0 },
      });
      console.info(`[OperatorBootstrap] TOAST (${severity}): ${payload.message}`);
    };

    // --- AUTH → operatorSlice.setCurrentUserRole (T4) ------------------
    // Server-authoritative role: whatever the JWT granted on the handshake
    // IS the operator role. There is no client-side role switching.
    // Backend payload: { status: 'authenticated', userId, tenantId, role }.
    const onAuth = (payload: { status: string; role: string }): void => {
      if (payload.status === 'authenticated') {
        setCurrentUserRole(toHmiRole(payload.role));
      }
    };

    socket.on(ScadaSocketEvent.ALARM_STATUS, onAlarmStatus);
    socket.on(ScadaSocketEvent.SCRIPT_CONSOLE, onScriptConsole);
    socket.on(ScadaSocketEvent.COMMAND_SET_VIEW, onSetView);
    socket.on(ScadaSocketEvent.COMMAND_OPEN_CARD, onOpenCard);
    socket.on(ScadaSocketEvent.COMMAND_TOAST, onToast);
    socket.on(ScadaSocketEvent.AUTH, onAuth);

    // Cleanup: remove listeners and release shared socket ownership
    return () => {
      socket.off(ScadaSocketEvent.ALARM_STATUS, onAlarmStatus);
      socket.off(ScadaSocketEvent.SCRIPT_CONSOLE, onScriptConsole);
      socket.off(ScadaSocketEvent.COMMAND_SET_VIEW, onSetView);
      socket.off(ScadaSocketEvent.COMMAND_OPEN_CARD, onOpenCard);
      socket.off(ScadaSocketEvent.COMMAND_TOAST, onToast);
      socket.off(ScadaSocketEvent.AUTH, onAuth);
      socket.release();
    };
  }, [
    updateAlarmStatus,
    addConsoleOutput,
    setActiveScreen,
    openOverlay,
    setCurrentUserRole,
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

  // ── navItems derived from screens (T7h) ─────────────────────────────
  // Keyed on the screens array identity (changes on package hydration);
  // writes into the package store's operatorLayout via setOperatorLayout.
  const screens = useScadaPackageStore((s) => s.screens);
  const setOperatorLayout = useScadaPackageStore((s) => s.setOperatorLayout);
  const operatorLayoutRef = useRef(useScadaPackageStore.getState().operatorLayout);
  useEffect(() => {
    operatorLayoutRef.current = useScadaPackageStore.getState().operatorLayout;
  }, [setOperatorLayout]);

  useEffect(() => {
    const navItems = deriveNavItems(screens);
    setOperatorLayout({
      ...operatorLayoutRef.current,
      navItems,
    });
  }, [screens, setOperatorLayout]);

  return <>{children}</>;
}

/* ------------------------------------------------------------------ */
/*  OperatorBootstrap (outer — handles package loading gate)           */
/* ------------------------------------------------------------------ */

/**
 * OperatorBootstrap — Top-level integration bootstrap for the SCADA HMI.
 *
 * Wraps children in an ErrorBoundary and a loading gate, then wires up the
 * socket connection and event listeners once the package is ready.
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

  // Use a ref to capture the layout at the time of initialization,
  // preventing the re-render loop caused by operatorLayout being both
  // read and written in the same effect's dependency array.
  const layoutSnapshotRef = useRef(useScadaPackageStore.getState().operatorLayout);

  // T7j: tolerate packageId CHANGES (kiosk deep links) — the old
  // hasInitializedRef guard made the bootstrap ignore a new id forever.
  // The effect now re-runs whenever the store's packageId no longer matches
  // the requested one; the page is responsible for rehydrating the store.
  useEffect(() => {
    if (!packageId) return;

    // If the store already has this package loaded, skip re-init.
    if (storePackageId === packageId) {
      setReady(true);
      return;
    }

    // Point the store at the requested package; the caller pre-loads the
    // package JSON (loadFromJSON) before/while rendering OperatorBootstrap.
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

  // key on packageId: a deep-link switch remounts the whole operator tree
  // (socket listeners rebind, screens re-derive) instead of half-mutating.
  return (
    <OperatorErrorBoundary key={packageId}>
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
