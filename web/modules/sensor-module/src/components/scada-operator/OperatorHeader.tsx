/**
 * OperatorHeader — Top navigation bar for the SCADA HMI operator shell.
 *
 * Renders:
 *  - Logo / title area (left)
 *  - Configurable header items (center): button | label | image
 *  - Hamburger menu (left, when sidenav is not fixed)
 *  - Alarm badge with unacknowledged count (right)
 *  - Live date / time display (right)
 *  - Current user info + role badge (right)
 */

import React, { useState, useEffect, useCallback, memo } from 'react';
import {
  Menu,
  Bell,
  Clock,
  User,
  ChevronDown,
  AlertTriangle,
} from 'lucide-react';
import { useOperatorStore } from '../../store/scada/operatorStore';
import type {
  OperatorLayoutConfig,
  OperatorHeaderItem,
  AlarmSeverity,
} from '../../types/scada-runtime.types';

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

export interface OperatorHeaderProps {
  config: OperatorLayoutConfig;
  projectName?: string;
}

/* ------------------------------------------------------------------ */
/*  Alarm severity → badge colour mapping                              */
/* ------------------------------------------------------------------ */

const SEVERITY_CLASSES: Record<AlarmSeverity, string> = {
  critical: 'bg-red-600 text-white',
  high: 'bg-orange-500 text-white',
  warning: 'bg-yellow-500 text-black',
  info: 'bg-blue-500 text-white',
};

/* ------------------------------------------------------------------ */
/*  Clock — isolated so only it re-renders on tick                     */
/* ------------------------------------------------------------------ */

const LiveClock = memo(() => {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const date = now.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });
  const time = now.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return (
    <div className="flex items-center gap-1.5 text-gray-300 text-sm tabular-nums select-none">
      <Clock size={14} className="text-gray-400 shrink-0" />
      <span>{date}</span>
      <span className="text-gray-500">|</span>
      <span className="font-mono">{time}</span>
    </div>
  );
});
LiveClock.displayName = 'LiveClock';

/* ------------------------------------------------------------------ */
/*  Header item renderer                                               */
/* ------------------------------------------------------------------ */

const HeaderItemRenderer = memo(
  ({ item }: { item: OperatorHeaderItem }) => {
    if (item.type === 'image' && item.imageUrl) {
      return (
        <img
          src={item.imageUrl}
          alt={item.text ?? 'header image'}
          className="h-8 w-auto object-contain"
          aria-label={item.text}
        />
      );
    }

    if (item.type === 'label') {
      return (
        <span
          className="text-gray-200 text-sm font-medium px-2"
          aria-label={item.text}
        >
          {item.text}
        </span>
      );
    }

    if (item.type === 'button') {
      return (
        <button
          type="button"
          className="
            flex items-center gap-1.5 px-3 py-1.5 rounded
            text-sm font-medium text-gray-200
            bg-gray-700 hover:bg-gray-600 active:bg-gray-500
            border border-gray-600
            transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500
          "
          aria-label={item.text}
        >
          {item.text}
        </button>
      );
    }

    return null;
  },
);
HeaderItemRenderer.displayName = 'HeaderItemRenderer';

/* ------------------------------------------------------------------ */
/*  Role badge                                                          */
/* ------------------------------------------------------------------ */

const ROLE_BADGE_CLASSES: Record<string, string> = {
  admin:      'bg-purple-700 text-purple-100',
  supervisor: 'bg-blue-700 text-blue-100',
  engineer:   'bg-cyan-700 text-cyan-100',
  operator:   'bg-green-700 text-green-100',
  viewer:     'bg-gray-600 text-gray-200',
};

/* ------------------------------------------------------------------ */
/*  OperatorHeader                                                      */
/* ------------------------------------------------------------------ */

export const OperatorHeader = memo(({ config, projectName }: OperatorHeaderProps) => {
  const {
    sidenavOpen,
    toggleSidenav,
    toggleAlarmPanel,
    alarmPanelOpen,
    currentUserRole,
    alarmStatusSummary,
    operatorLayout,
  } = useOperatorStore((s) => ({
    sidenavOpen:         s.sidenavOpen,
    toggleSidenav:       s.toggleSidenav,
    toggleAlarmPanel:    s.toggleAlarmPanel,
    alarmPanelOpen:      s.alarmPanelOpen,
    currentUserRole:     s.currentUserRole,
    alarmStatusSummary:  (s as unknown as { alarmStatusSummary: unknown }).alarmStatusSummary as {
      critical: number; high: number; warning: number; info: number;
    } | null,
    operatorLayout:      s.operatorLayout,
  }));

  /* Highest-severity alarm count for badge colour */
  const alarmBadge = (() => {
    if (!alarmStatusSummary) return null;
    if (alarmStatusSummary.critical > 0)
      return { count: alarmStatusSummary.critical, severity: 'critical' as AlarmSeverity };
    if (alarmStatusSummary.high > 0)
      return { count: alarmStatusSummary.high, severity: 'high' as AlarmSeverity };
    if (alarmStatusSummary.warning > 0)
      return { count: alarmStatusSummary.warning, severity: 'warning' as AlarmSeverity };
    if (alarmStatusSummary.info > 0)
      return { count: alarmStatusSummary.info, severity: 'info' as AlarmSeverity };
    return null;
  })();

  const showHamburger = operatorLayout.sidenavMode !== 'fixed' && operatorLayout.sidenavMode !== 'void';
  const showAlarmBadge = config.showAlarmBadge ?? true;
  const showDateTime   = config.showDateTime ?? true;

  const handleAlarmClick = useCallback(() => {
    toggleAlarmPanel();
  }, [toggleAlarmPanel]);

  return (
    <header
      className="
        flex items-center h-12 px-3 gap-3
        bg-gray-900 border-b border-gray-700
        select-none shrink-0 z-30
      "
      role="banner"
      aria-label="Operator shell header"
    >
      {/* ── Hamburger ── */}
      {showHamburger && (
        <button
          type="button"
          onClick={toggleSidenav}
          aria-label={sidenavOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={sidenavOpen}
          className="
            p-1.5 rounded text-gray-400 hover:text-gray-100 hover:bg-gray-700
            transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500
            shrink-0
          "
        >
          <Menu size={18} />
        </button>
      )}

      {/* ── Logo / title ── */}
      <div className="flex items-center gap-2 shrink-0 min-w-0">
        <div className="flex items-center justify-center w-7 h-7 rounded bg-blue-600 shrink-0">
          <span className="text-white text-xs font-bold leading-none">SC</span>
        </div>
        {projectName && (
          <span className="text-gray-100 text-sm font-semibold truncate max-w-[160px]" title={projectName}>
            {projectName}
          </span>
        )}
      </div>

      {/* ── Divider ── */}
      {projectName && <div className="w-px h-6 bg-gray-700 shrink-0" />}

      {/* ── Centre header items ── */}
      <div className="flex items-center gap-2 flex-1 min-w-0 overflow-hidden">
        {config.headerItems.map((item) => (
          <HeaderItemRenderer key={item.id} item={item} />
        ))}
      </div>

      {/* ── Right-side controls ── */}
      <div className="flex items-center gap-3 shrink-0">

        {/* Date / time */}
        {showDateTime && <LiveClock />}

        {/* Alarm badge */}
        {showAlarmBadge && (
          <button
            type="button"
            onClick={handleAlarmClick}
            aria-label={
              alarmBadge
                ? `${alarmBadge.count} active ${alarmBadge.severity} alarm${alarmBadge.count !== 1 ? 's' : ''} — click to open alarm panel`
                : 'No active alarms — click to open alarm panel'
            }
            aria-pressed={alarmPanelOpen}
            className={`
              relative flex items-center justify-center w-8 h-8 rounded
              transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500
              ${alarmPanelOpen
                ? 'bg-gray-600 text-gray-100'
                : 'text-gray-400 hover:text-gray-100 hover:bg-gray-700'}
            `}
          >
            {alarmBadge ? (
              <AlertTriangle size={16} className="text-yellow-400" />
            ) : (
              <Bell size={16} />
            )}
            {alarmBadge && (
              <span
                className={`
                  absolute -top-1 -right-1 min-w-[16px] h-4 px-1
                  flex items-center justify-center rounded-full
                  text-[10px] font-bold leading-none
                  ${SEVERITY_CLASSES[alarmBadge.severity]}
                `}
                aria-hidden="true"
              >
                {alarmBadge.count > 99 ? '99+' : alarmBadge.count}
              </span>
            )}
          </button>
        )}

        {/* Vertical separator */}
        <div className="w-px h-6 bg-gray-700" />

        {/* User / role */}
        <div className="flex items-center gap-2" aria-label="Current user">
          <User size={14} className="text-gray-400 shrink-0" />
          <span
            className={`
              px-1.5 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wide
              ${ROLE_BADGE_CLASSES[currentUserRole] ?? ROLE_BADGE_CLASSES.viewer}
            `}
            title={`Role: ${currentUserRole}`}
          >
            {currentUserRole}
          </span>
        </div>
      </div>
    </header>
  );
});

OperatorHeader.displayName = 'OperatorHeader';
