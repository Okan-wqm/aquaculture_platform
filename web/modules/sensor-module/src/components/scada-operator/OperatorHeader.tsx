/**
 * OperatorHeader — Top navigation bar for the SCADA HMI operator shell.
 *
 * Layout (left → right):
 *   [Hamburger]  [Logo / Title]  |  [Header items]  |  [Alarms] [DateTime] [User/Role]
 *
 * Header items (from OperatorLayoutConfig.headerItems) can be:
 *   - button : clickable with optional text; fires WidgetEventBinding on click
 *   - label  : read-only display text; supports live tag binding via tagId
 *   - image  : img element with imageUrl
 *
 * The alarm badge reflects the worst-severity active count and toggles the
 * alarm panel in the shell when clicked.
 */

import React, { useState, useEffect, useCallback, memo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { HMI_ROLE_CODES } from '@platform/identity';
import {
  Menu,
  Bell,
  Clock,
  User,
  ChevronDown,
  AlertTriangle,
  Shield,
} from 'lucide-react';

import { useOperatorStore } from '../../store/scada/operatorStore';
import { useRealtimeData } from '../../hooks/useRealtimeData';
import type {
  OperatorLayoutConfig,
  OperatorHeaderItem,
  AlarmSeverity,
  HmiRole,
} from '../../types/scada-runtime.types';

/* ------------------------------------------------------------------ */
/*  Props                                                               */
/* ------------------------------------------------------------------ */

export interface OperatorHeaderProps {
  /** Full operator layout config (used for items, showDateTime, etc.). */
  config: OperatorLayoutConfig;
  /** Optional project / application name shown in the logo area. */
  projectName?: string;
}

/* ------------------------------------------------------------------ */
/*  Static lookup tables                                                */
/* ------------------------------------------------------------------ */

const SEVERITY_BADGE: Record<AlarmSeverity, string> = {
  critical: 'bg-red-600 text-white',
  high:     'bg-orange-500 text-white',
  warning:  'bg-yellow-500 text-black',
  info:     'bg-blue-500 text-white',
};

const ROLE_BADGE: Record<HmiRole, string> = {
  admin:      'bg-purple-700 text-purple-100',
  supervisor: 'bg-blue-700 text-blue-100',
  engineer:   'bg-cyan-700 text-cyan-100',
  operator:   'bg-green-700 text-green-100',
  viewer:     'bg-gray-600 text-gray-200',
};

const ALL_ROLES: readonly HmiRole[] = HMI_ROLE_CODES;

/* ------------------------------------------------------------------ */
/*  LiveClock — isolated so only this subtree re-renders on tick       */
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
    <div
      className="flex items-center gap-1.5 text-gray-300 select-none"
      aria-label={`Current date and time: ${date} ${time}`}
    >
      <Clock size={14} className="text-gray-400 shrink-0" aria-hidden="true" />
      <span className="text-xs font-mono tabular-nums">
        {date}
        <span className="mx-1 text-gray-600" aria-hidden="true">|</span>
        {time}
      </span>
    </div>
  );
});
LiveClock.displayName = 'LiveClock';

/* ------------------------------------------------------------------ */
/*  HeaderItemRenderer — renders one configured header item            */
/* ------------------------------------------------------------------ */

interface HeaderItemRendererProps {
  item: OperatorHeaderItem;
}

const HeaderItemRenderer = memo<HeaderItemRendererProps>(({ item }) => {
  // Subscribe to a tag value if the item has a tagId binding.
  const tagIds = item.tagId ? [item.tagId] : [];
  // useRealtimeData is safe to call with an empty array.
  const { values } = useRealtimeData(tagIds);

  const liveValue = item.tagId ? values[item.tagId]?.value : undefined;
  const displayText = liveValue !== undefined ? String(liveValue) : (item.text ?? '');

  const handleClick = useCallback(() => {
    if (!item.event) return;
    const params = item.event.params;
    if (params.type === 'openTab') {
      window.open(
        (params as { type: 'openTab'; url: string }).url,
        '_blank',
        'noopener,noreferrer',
      );
    }
    // navigate and other event types are handled at shell level
  }, [item.event]);

  if (item.type === 'image') {
    return (
      <img
        src={item.imageUrl}
        alt={item.text ?? 'Header image'}
        className="h-7 w-auto object-contain"
        aria-label={item.text}
      />
    );
  }

  if (item.type === 'label') {
    return (
      <span
        className="text-sm text-gray-200 font-medium px-2 select-none"
        aria-label={displayText}
      >
        {displayText}
      </span>
    );
  }

  // button type
  return (
    <button
      type="button"
      onClick={handleClick}
      className="
        flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium
        text-gray-200 bg-gray-700 hover:bg-gray-600 active:bg-gray-500
        border border-gray-600 transition-colors
        focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500
      "
      aria-label={displayText || 'Header button'}
    >
      {displayText}
    </button>
  );
});
HeaderItemRenderer.displayName = 'HeaderItemRenderer';

/* ------------------------------------------------------------------ */
/*  AlarmBadge                                                          */
/* ------------------------------------------------------------------ */

const AlarmBadge = memo(() => {
  const { toggleAlarmPanel, alarmPanelOpen } = useOperatorStore(
    useShallow((s) => ({
      toggleAlarmPanel: s.toggleAlarmPanel,
      alarmPanelOpen:   s.alarmPanelOpen,
    })),
  );

  // Read alarm summary from the store (alarmRuntimeSlice merged in).
  const summary = useOperatorStore(
    (s) =>
      (
        s as unknown as {
          alarmStatusSummary: { critical: number; high: number; warning: number; info: number } | null;
        }
      ).alarmStatusSummary,
  );

  const badge = (() => {
    if (!summary) return null;
    if (summary.critical > 0) return { count: summary.critical, severity: 'critical' as AlarmSeverity };
    if (summary.high     > 0) return { count: summary.high,     severity: 'high'     as AlarmSeverity };
    if (summary.warning  > 0) return { count: summary.warning,  severity: 'warning'  as AlarmSeverity };
    if (summary.info     > 0) return { count: summary.info,     severity: 'info'     as AlarmSeverity };
    return null;
  })();

  const handleClick = useCallback(() => toggleAlarmPanel(), [toggleAlarmPanel]);

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={
        badge
          ? `${badge.count} active ${badge.severity} alarm${badge.count !== 1 ? 's' : ''} — click to ${alarmPanelOpen ? 'close' : 'open'} alarm panel`
          : `No active alarms — click to ${alarmPanelOpen ? 'close' : 'open'} alarm panel`
      }
      aria-pressed={alarmPanelOpen}
      className={`
        relative flex items-center justify-center w-8 h-8 rounded transition-colors
        focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500
        ${alarmPanelOpen ? 'bg-gray-600 text-gray-100' : 'text-gray-400 hover:text-gray-100 hover:bg-gray-700'}
      `}
    >
      {badge ? (
        <AlertTriangle
          size={16}
          className={badge.severity === 'critical' ? 'text-red-400 animate-pulse' : 'text-yellow-400'}
          aria-hidden="true"
        />
      ) : (
        <Bell size={16} aria-hidden="true" />
      )}
      {badge && (
        <span
          className={`
            absolute -top-1 -right-1 min-w-[16px] h-4 px-0.5
            flex items-center justify-center rounded-full
            text-[10px] font-bold leading-none pointer-events-none
            ${SEVERITY_BADGE[badge.severity]}
          `}
          aria-hidden="true"
        >
          {badge.count > 99 ? '99+' : badge.count}
        </span>
      )}
    </button>
  );
});
AlarmBadge.displayName = 'AlarmBadge';

/* ------------------------------------------------------------------ */
/*  UserRoleMenu                                                        */
/* ------------------------------------------------------------------ */

const UserRoleMenu = memo(() => {
  const { currentUserRole, setCurrentUserRole } = useOperatorStore(
    useShallow((s) => ({
      currentUserRole:    s.currentUserRole,
      setCurrentUserRole: s.setCurrentUserRole,
    })),
  );

  const [open, setOpen] = useState(false);
  const roleClass = ROLE_BADGE[currentUserRole] ?? ROLE_BADGE.viewer;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="
          flex items-center gap-1.5 px-2 py-1.5 rounded text-xs
          text-gray-300 hover:bg-gray-700 transition-colors
          focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500
        "
        aria-label="User role menu"
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <User size={14} className="text-gray-400 shrink-0" aria-hidden="true" />
        <span
          className={`px-1.5 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wide ${roleClass}`}
          title={`Current role: ${currentUserRole}`}
        >
          {currentUserRole}
        </span>
        <ChevronDown size={12} className="text-gray-500 shrink-0" aria-hidden="true" />
      </button>

      {open && (
        <>
          {/* Dismiss backdrop */}
          <div
            className="fixed inset-0 z-50"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <ul
            className="absolute right-0 top-full mt-1 w-44 bg-gray-800 border border-gray-700 rounded-lg shadow-2xl z-50 overflow-hidden py-1"
            role="listbox"
            aria-label="Switch HMI role"
          >
            <li className="px-3 pt-2 pb-1">
              <span className="text-[10px] text-gray-500 uppercase font-semibold tracking-wider">
                Switch Role
              </span>
            </li>
            {ALL_ROLES.map((role) => (
              <li key={role} role="option" aria-selected={role === currentUserRole}>
                <button
                  type="button"
                  onClick={() => {
                    setCurrentUserRole(role);
                    setOpen(false);
                  }}
                  className={`
                    w-full flex items-center gap-2 px-3 py-2 text-xs text-left transition-colors
                    ${role === currentUserRole
                      ? 'bg-gray-700 text-gray-100'
                      : 'text-gray-300 hover:bg-gray-700/60 hover:text-gray-100'}
                  `}
                >
                  <Shield
                    size={12}
                    className={`shrink-0 ${ROLE_BADGE[role].split(' ')[1] ?? 'text-gray-400'}`}
                    aria-hidden="true"
                  />
                  <span className="capitalize flex-1">{role}</span>
                  {role === currentUserRole && (
                    <span className="text-[10px] text-blue-400" aria-hidden="true">active</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
});
UserRoleMenu.displayName = 'UserRoleMenu';

/* ------------------------------------------------------------------ */
/*  OperatorHeader                                                      */
/* ------------------------------------------------------------------ */

export const OperatorHeader = memo<OperatorHeaderProps>(
  ({ config, projectName }) => {
    const { sidenavOpen, toggleSidenav, operatorLayout } = useOperatorStore(
      useShallow((s) => ({
        sidenavOpen:     s.sidenavOpen,
        toggleSidenav:   s.toggleSidenav,
        operatorLayout:  s.operatorLayout,
      })),
    );

    const showHamburger =
      operatorLayout.sidenavMode !== 'fixed' && operatorLayout.sidenavMode !== 'void';
    const showAlarmBadge = config.showAlarmBadge ?? true;
    const showDateTime   = config.showDateTime ?? true;

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
            aria-label={sidenavOpen ? 'Close navigation sidebar' : 'Open navigation sidebar'}
            aria-expanded={sidenavOpen}
            className="
              p-1.5 rounded shrink-0
              text-gray-400 hover:text-gray-100 hover:bg-gray-700
              transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-500
            "
          >
            <Menu size={18} aria-hidden="true" />
          </button>
        )}

        {/* ── Logo / title ── */}
        <div className="flex items-center gap-2 shrink-0 min-w-0">
          <div
            className="flex items-center justify-center w-7 h-7 rounded bg-blue-600 shrink-0"
            aria-hidden="true"
          >
            <span className="text-white text-xs font-bold leading-none select-none">SC</span>
          </div>
          {projectName && (
            <span
              className="text-gray-100 text-sm font-semibold truncate max-w-[180px]"
              title={projectName}
            >
              {projectName}
            </span>
          )}
        </div>

        {/* Vertical separator */}
        {config.headerItems.length > 0 && (
          <div className="w-px h-6 bg-gray-700 shrink-0" aria-hidden="true" />
        )}

        {/* ── Centre header items (from config) ── */}
        <nav
          className="flex items-center gap-2 flex-1 min-w-0 overflow-x-auto scrollbar-none"
          aria-label="Header navigation items"
        >
          {config.headerItems.map((item) => (
            <HeaderItemRenderer key={item.id} item={item} />
          ))}
        </nav>

        {/* ── Right-side controls ── */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Date / time */}
          {showDateTime && <LiveClock />}

          <div className="w-px h-5 bg-gray-700" aria-hidden="true" />

          {/* Alarm badge */}
          {showAlarmBadge && <AlarmBadge />}

          <div className="w-px h-5 bg-gray-700" aria-hidden="true" />

          {/* User / role */}
          <UserRoleMenu />
        </div>
      </header>
    );
  },
);

OperatorHeader.displayName = 'OperatorHeader';
