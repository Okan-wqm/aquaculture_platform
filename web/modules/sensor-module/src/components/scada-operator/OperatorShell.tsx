/**
 * OperatorShell — Main operator layout container for the SCADA HMI.
 *
 * Responsibilities:
 *  - Renders the full-viewport operator UI shell: header (top), sidenav
 *    (left), content area (center), alarm summary bar + slide-up alarm
 *    panel (bottom).
 *  - Wraps children in DataProviderRoot so all descendant widgets have
 *    access to the live/simulation data layer.
 *  - Manages kiosk mode (hideNavigation) with F11 keyboard shortcut.
 *  - Injects optional custom CSS from OperatorLayoutConfig at runtime.
 *  - Mounts ViewOverlayManager so dialog/card/iframe/toast overlays can be
 *    opened from any widget in the tree.
 *  - Renders a full-width COMMS LOST banner whenever the SCADA socket is
 *    disconnected / in error (T6) — an operator must never silently stare
 *    at stale values.
 */

import React, {
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from 'react';
import { useShallow } from 'zustand/react/shallow';
import { WifiOff } from 'lucide-react';

import { useScadaPackageStore } from '../../store/scada/createScadaStore';
import { DataProviderRoot } from '../../providers';
import { useScadaConnectionState } from '../../hooks/useScadaConnectionState';
import type { DataProviderType } from '../../types/scada-runtime.types';

import { OperatorHeader } from './OperatorHeader';
import { OperatorSidenav } from './OperatorSidenav';
import { ViewOverlayManager } from './ViewOverlayManager';
import { AlarmSummaryBar } from './AlarmSummaryBar';
import { AlarmPanel } from './AlarmPanel';

/* ------------------------------------------------------------------ */
/*  Props                                                               */
/* ------------------------------------------------------------------ */

export interface OperatorShellProps {
  /**
   * The active screen content rendered in the centre content area.
   * Typically an <OperatorView> but can be any node.
   */
  children: ReactNode;
  /**
   * Which data provider implementation to mount.
   * Defaults to 'live' (WebSocket-driven).
   */
  dataProviderType?: DataProviderType;
  /**
   * Optional callback invoked when the active screen should change.
   * The shell calls this when sidenav navigation triggers a change.
   */
  onNavigate?: (screenId: string) => void;
  /** Currently active screen id (controlled externally). */
  activeScreenId?: string;
  /** Optional project/application name shown in the header logo area. */
  projectName?: string;
}

/* ------------------------------------------------------------------ */
/*  COMMS LOST banner (T6)                                             */
/* ------------------------------------------------------------------ */

let flashStyleInjected = false;

function injectFlashStyle(): void {
  if (flashStyleInjected || typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.textContent = `
@keyframes scada-alarm-flash { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0.15; } }
.scada-alarm-flash { animation: scada-alarm-flash 0.75s step-end infinite; }
`;
  document.head.appendChild(style);
  flashStyleInjected = true;
}

/**
 * Full-width banner while the /scada socket is not connected. Rendered for
 * 'disconnected' AND 'error' (heartbeat lapse) — both mean live values have
 * stopped flowing and everything on screen may be stale.
 */
const CommsLostBanner = React.memo(() => {
  const connectionState = useScadaConnectionState();

  useEffect(() => {
    injectFlashStyle();
  }, []);

  if (connectionState === 'connected' || connectionState === 'connecting') {
    return null;
  }

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex w-full items-center justify-center gap-2 bg-red-600 px-4 py-1.5 text-white text-xs font-semibold select-none"
    >
      <WifiOff size={14} aria-hidden="true" />
      <span className="uppercase tracking-wide">
        COMMS LOST — live data unavailable, displayed values may be stale
      </span>
      <span aria-hidden="true" className="scada-alarm-flash">
        ●
      </span>
    </div>
  );
});
CommsLostBanner.displayName = 'CommsLostBanner';

/* ------------------------------------------------------------------ */
/*  AlarmPanelTray — bottom slide-up tray hosting the real AlarmPanel   */
/* ------------------------------------------------------------------ */

/**
 * T1d: the shell previously embedded a private, read-only inline panel that
 * read alarms through a cast against a store that never contained them
 * (always empty). It is replaced by the REAL AlarmPanel (full alarm
 * management: filters, ACK over the socket, history) plus the AlarmSummaryBar
 * (previously referenced by nothing).
 */
const AlarmPanelTray = React.memo(() => {
  const { alarmPanelOpen, toggleAlarmPanel } = useScadaPackageStore(
    useShallow((s) => ({
      alarmPanelOpen: s.alarmPanelOpen,
      toggleAlarmPanel: s.toggleAlarmPanel,
    })),
  );

  if (!alarmPanelOpen) return null;

  return (
    <div
      className="flex flex-col bg-gray-900 border-t border-gray-700 shadow-2xl z-40 p-2 overflow-auto shrink-0"
      style={{ maxHeight: '60vh' }}
      role="region"
      aria-label="Alarm panel"
    >
      <div className="flex justify-end">
        <button
          type="button"
          onClick={toggleAlarmPanel}
          className="text-gray-400 hover:text-gray-100 text-xs px-2 py-1 rounded hover:bg-gray-700 transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-400"
          aria-label="Close alarm panel"
        >
          Close
        </button>
      </div>
      <AlarmPanel className="w-full border-0 shadow-none" />
    </div>
  );
});
AlarmPanelTray.displayName = 'AlarmPanelTray';

/* ------------------------------------------------------------------ */
/*  Custom CSS injector                                                 */
/* ------------------------------------------------------------------ */

function useCustomCss(css: string | undefined) {
  const styleRef = useRef<HTMLStyleElement | null>(null);

  useEffect(() => {
    if (!css) {
      styleRef.current?.remove();
      styleRef.current = null;
      return;
    }

    if (!styleRef.current) {
      styleRef.current = document.createElement('style');
      styleRef.current.setAttribute('data-scada-custom', '');
      document.head.appendChild(styleRef.current);
    }
    styleRef.current.textContent = css;

    return () => {
      styleRef.current?.remove();
      styleRef.current = null;
    };
  }, [css]);
}

/* ------------------------------------------------------------------ */
/*  OperatorShell                                                       */
/* ------------------------------------------------------------------ */

export const OperatorShell = React.memo<OperatorShellProps>(
  ({ children, dataProviderType = 'live', onNavigate, activeScreenId, projectName }) => {
    const {
      operatorLayout,
      sidenavOpen,
      kioskMode,
      setKioskMode,
      toggleSidenav,
    } = useScadaPackageStore(
      useShallow((s) => ({
        operatorLayout: s.operatorLayout,
        sidenavOpen:    s.sidenavOpen,
        kioskMode:      s.kioskMode,
        setKioskMode:   s.setKioskMode,
        toggleSidenav:  s.toggleSidenav,
      })),
    );

    const { hideNavigation, sidenavMode, customCss, navItems } = operatorLayout;

    // Inject optional custom CSS
    useCustomCss(customCss);

    // F11 → toggle kiosk mode
    const handleKeyDown = useCallback(
      (e: KeyboardEvent) => {
        if (e.key === 'F11') {
          e.preventDefault();
          setKioskMode(!kioskMode);
        }
      },
      [kioskMode, setKioskMode],
    );

    useEffect(() => {
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }, [handleKeyDown]);

    // Computed visibility flags
    const isKiosk    = kioskMode || hideNavigation;
    const showHeader = !isKiosk;
    const showSidenav = !isKiosk && sidenavMode !== 'void';

    const sidenavIsFixed   = sidenavMode === 'fixed';
    const sidenavIsOverlay = sidenavMode === 'overlay';
    const sidenavIsPush    = sidenavMode === 'push';

    // Safe navigate callback — guard against undefined
    const handleNavigate = useCallback(
      (screenId: string) => onNavigate?.(screenId),
      [onNavigate],
    );

    return (
      <DataProviderRoot type={dataProviderType}>
        {/* Root shell — full viewport */}
        <div
          className="relative flex flex-col w-screen h-screen overflow-hidden bg-gray-950 text-gray-100"
          role="application"
          aria-label="SCADA operator interface"
        >
          {/* ── COMMS LOST banner (full width, above everything) ── */}
          <CommsLostBanner />

          {/* ── Top header ── */}
          {showHeader && (
            <OperatorHeader
              config={operatorLayout}
              projectName={projectName}
            />
          )}

          {/* ── Middle row: sidenav + content area ── */}
          <div className="relative flex flex-1 min-h-0 overflow-hidden">

            {/* Fixed sidenav — always visible, takes its own column */}
            {showSidenav && sidenavIsFixed && (
              <OperatorSidenav
                navItems={navItems}
                activeScreenId={activeScreenId ?? ''}
                mode="fixed"
                onNavigate={handleNavigate}
              />
            )}

            {/* Push sidenav — shifts content right when open */}
            {showSidenav && sidenavIsPush && (
              <OperatorSidenav
                navItems={navItems}
                activeScreenId={activeScreenId ?? ''}
                mode="push"
                onNavigate={handleNavigate}
              />
            )}

            {/* Overlay sidenav — floats above content, with backdrop */}
            {showSidenav && sidenavIsOverlay && sidenavOpen && (
              <>
                <div
                  className="absolute inset-0 bg-black/50 z-20"
                  onClick={toggleSidenav}
                  aria-hidden="true"
                />
                <OperatorSidenav
                  navItems={navItems}
                  activeScreenId={activeScreenId ?? ''}
                  mode="overlay"
                  onNavigate={handleNavigate}
                />
              </>
            )}

            {/* Main content area */}
            <main
              className="flex-1 relative min-w-0 overflow-hidden"
              aria-label="Screen content"
            >
              {children}
            </main>
          </div>

          {/* ── Alarm summary bar + slide-up alarm panel (real AlarmPanel, T1d) ── */}
          <AlarmSummaryBar />
          <AlarmPanelTray />

          {/* ── View overlay manager (dialogs, cards, iframes, toasts) ── */}
          <ViewOverlayManager />
        </div>
      </DataProviderRoot>
    );
  },
);
OperatorShell.displayName = 'OperatorShell';
