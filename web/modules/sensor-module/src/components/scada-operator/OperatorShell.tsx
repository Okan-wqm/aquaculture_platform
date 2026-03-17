/**
 * OperatorShell — Main operator layout container for the SCADA HMI.
 *
 * Responsibilities:
 *  - Renders the full-viewport operator UI shell: header (top), sidenav
 *    (left), content area (center), alarm panel (bottom slide-up).
 *  - Wraps children in DataProviderRoot so all descendant widgets have
 *    access to the live/simulation data layer.
 *  - Manages kiosk mode (hideNavigation) with F11 keyboard shortcut.
 *  - Injects optional custom CSS from OperatorLayoutConfig at runtime.
 *  - Mounts ViewOverlayManager so dialog/card/iframe overlays can be
 *    opened from any widget in the tree.
 */

import React, {
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Bell, AlertTriangle, CheckCircle2 } from 'lucide-react';

import { useOperatorStore } from '../../store/scada/operatorStore';
import { DataProviderRoot } from '../../providers';
import type { DataProviderType } from '../../types/scada-runtime.types';

import { OperatorHeader } from './OperatorHeader';
import { OperatorSidenav } from './OperatorSidenav';
import { ViewOverlayManager } from './ViewOverlayManager';

// Forward-declare ViewOverlayManager for cases where it hasn't been created yet.
// The import above will resolve once the file exists.

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
}

/* ------------------------------------------------------------------ */
/*  Alarm severity badge helpers                                        */
/* ------------------------------------------------------------------ */

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-red-600 text-white',
  high: 'bg-orange-500 text-white',
  warning: 'bg-yellow-500 text-black',
  info: 'bg-blue-500 text-white',
};

function AlarmBadgeCount({ count, severity }: { count: number; severity: string }) {
  if (count === 0) return null;
  const colorClass = SEVERITY_COLORS[severity] ?? 'bg-gray-500 text-white';
  return (
    <span
      className={`inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full text-[10px] font-bold px-1 ${colorClass}`}
      aria-label={`${count} ${severity} alarm${count !== 1 ? 's' : ''}`}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  AlarmPanel — bottom slide-up tray                                  */
/* ------------------------------------------------------------------ */

const AlarmPanel = React.memo(() => {
  const { alarmPanelOpen, toggleAlarmPanel } = useOperatorStore(
    useShallow((s) => ({
      alarmPanelOpen: s.alarmPanelOpen,
      toggleAlarmPanel: s.toggleAlarmPanel,
    })),
  );

  // Lazily import the store slice that holds runtime alarms to avoid
  // a circular dep at module-load time.
  const activeAlarms = useOperatorStore((s) =>
    // alarmRuntimeSlice is merged into the same store in production builds;
    // we access it through the raw store state safely.
    (s as unknown as { activeAlarms: unknown[] }).activeAlarms ?? [],
  );

  const criticalCount = activeAlarms.filter(
    (a: unknown) => (a as { severity: string }).severity === 'critical',
  ).length;
  const highCount = activeAlarms.filter(
    (a: unknown) => (a as { severity: string }).severity === 'high',
  ).length;
  const warningCount = activeAlarms.filter(
    (a: unknown) => (a as { severity: string }).severity === 'warning',
  ).length;

  if (!alarmPanelOpen) return null;

  return (
    <div
      className="absolute bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-700 shadow-2xl z-40 transition-transform duration-300"
      style={{ maxHeight: '40vh' }}
      role="region"
      aria-label="Alarm panel"
    >
      {/* Panel header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-700">
        <div className="flex items-center gap-3">
          <Bell size={16} className="text-yellow-400" aria-hidden="true" />
          <span className="text-sm font-semibold text-gray-100">Active Alarms</span>
          <div className="flex items-center gap-1">
            <AlarmBadgeCount count={criticalCount} severity="critical" />
            <AlarmBadgeCount count={highCount} severity="high" />
            <AlarmBadgeCount count={warningCount} severity="warning" />
          </div>
        </div>
        <button
          onClick={toggleAlarmPanel}
          className="text-gray-400 hover:text-gray-100 text-xs px-2 py-1 rounded hover:bg-gray-700 transition-colors"
          aria-label="Close alarm panel"
        >
          Close
        </button>
      </div>

      {/* Alarm list */}
      <div className="overflow-y-auto" style={{ maxHeight: 'calc(40vh - 40px)' }}>
        {activeAlarms.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-8 text-gray-400">
            <CheckCircle2 size={20} aria-hidden="true" />
            <span className="text-sm">No active alarms</span>
          </div>
        ) : (
          <ul className="divide-y divide-gray-800" role="list">
            {(activeAlarms as Array<{
              id: string;
              severity: string;
              message: string;
              ruleName: string;
              onTime: number;
              status: string;
            }>).map((alarm) => (
              <li
                key={alarm.id}
                className="flex items-center gap-3 px-4 py-2 hover:bg-gray-800 transition-colors"
              >
                <AlertTriangle
                  size={14}
                  className={
                    alarm.severity === 'critical'
                      ? 'text-red-500'
                      : alarm.severity === 'high'
                      ? 'text-orange-400'
                      : alarm.severity === 'warning'
                      ? 'text-yellow-400'
                      : 'text-blue-400'
                  }
                  aria-hidden="true"
                />
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-medium text-gray-100 truncate block">
                    {alarm.ruleName}
                  </span>
                  <span className="text-xs text-gray-400 truncate block">
                    {alarm.message}
                  </span>
                </div>
                <span className="text-[10px] text-gray-500 whitespace-nowrap">
                  {new Date(alarm.onTime).toLocaleTimeString()}
                </span>
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded uppercase font-semibold ${SEVERITY_COLORS[alarm.severity] ?? 'bg-gray-600 text-white'}`}
                >
                  {alarm.severity}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
});
AlarmPanel.displayName = 'AlarmPanel';

/* ------------------------------------------------------------------ */
/*  Custom CSS injector                                                 */
/* ------------------------------------------------------------------ */

function useCustomCss(css: string | undefined) {
  const styleRef = useRef<HTMLStyleElement | null>(null);

  useEffect(() => {
    if (!css) {
      if (styleRef.current) {
        styleRef.current.remove();
        styleRef.current = null;
      }
      return;
    }

    if (!styleRef.current) {
      styleRef.current = document.createElement('style');
      styleRef.current.setAttribute('data-scada-custom', '');
      document.head.appendChild(styleRef.current);
    }
    styleRef.current.textContent = css;

    return () => {
      if (styleRef.current) {
        styleRef.current.remove();
        styleRef.current = null;
      }
    };
  }, [css]);
}

/* ------------------------------------------------------------------ */
/*  OperatorShell                                                       */
/* ------------------------------------------------------------------ */

export const OperatorShell = React.memo<OperatorShellProps>(
  ({ children, dataProviderType = 'live', onNavigate, activeScreenId }) => {
    const {
      operatorLayout,
      sidenavOpen,
      kioskMode,
      setKioskMode,
      toggleSidenav,
    } = useOperatorStore(
      useShallow((s) => ({
        operatorLayout: s.operatorLayout,
        sidenavOpen: s.sidenavOpen,
        kioskMode: s.kioskMode,
        setKioskMode: s.setKioskMode,
        toggleSidenav: s.toggleSidenav,
      })),
    );

    const {
      hideNavigation,
      sidenavMode,
      customCss,
    } = operatorLayout;

    // Inject custom CSS
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
    const isKiosk = kioskMode || hideNavigation;
    const showHeader = !isKiosk;
    const showSidenav = !isKiosk && sidenavMode !== 'void';

    // For 'push' mode, we shift content area; for 'overlay' and 'fixed' we
    // handle it via absolute positioning or fixed width.
    const sidenavIsPush = sidenavMode === 'push' && sidenavOpen;
    const sidenavIsFixed = sidenavMode === 'fixed';
    const sidenavVisible = showSidenav && (sidenavIsFixed || sidenavOpen);

    return (
      <DataProviderRoot type={dataProviderType}>
        {/* Root shell — full viewport */}
        <div
          className="relative flex flex-col w-screen h-screen overflow-hidden bg-gray-950 text-gray-100"
          role="application"
          aria-label="SCADA operator interface"
        >
          {/* Top header bar */}
          {showHeader && (
            <OperatorHeader
              onMenuClick={toggleSidenav}
              onNavigate={onNavigate}
              showMenuButton={sidenavMode !== 'fixed' && sidenavMode !== 'void'}
            />
          )}

          {/* Middle row: sidenav + content */}
          <div className="relative flex flex-1 overflow-hidden">
            {/* Sidenav — fixed always visible */}
            {showSidenav && sidenavIsFixed && (
              <OperatorSidenav
                activeScreenId={activeScreenId}
                onNavigate={onNavigate}
                mode="fixed"
                open
              />
            )}

            {/* Sidenav — push mode (shifts content) */}
            {showSidenav && sidenavMode === 'push' && (
              <OperatorSidenav
                activeScreenId={activeScreenId}
                onNavigate={onNavigate}
                mode="push"
                open={sidenavOpen}
              />
            )}

            {/* Sidenav — overlay mode (floats above content) */}
            {showSidenav && sidenavMode === 'overlay' && sidenavOpen && (
              <>
                {/* Backdrop */}
                <div
                  className="absolute inset-0 bg-black/40 z-30"
                  onClick={toggleSidenav}
                  aria-hidden="true"
                />
                <OperatorSidenav
                  activeScreenId={activeScreenId}
                  onNavigate={onNavigate}
                  mode="overlay"
                  open={sidenavOpen}
                />
              </>
            )}

            {/* Content area */}
            <main
              className={[
                'flex-1 relative overflow-hidden transition-all duration-200',
                sidenavIsPush ? 'ml-0' : '',
              ]
                .join(' ')
                .trim()}
              aria-label="Screen content"
            >
              {children}
            </main>
          </div>

          {/* Alarm panel — bottom slide-up */}
          <AlarmPanel />

          {/* Overlay manager — dialogs, cards, iframes */}
          <ViewOverlayManager />
        </div>
      </DataProviderRoot>
    );
  },
);
OperatorShell.displayName = 'OperatorShell';
