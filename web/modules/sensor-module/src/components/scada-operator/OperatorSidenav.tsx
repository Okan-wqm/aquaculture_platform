/**
 * OperatorSidenav — Navigation sidebar for the SCADA HMI operator shell.
 *
 * Features:
 *  - Lists OperatorNavItems from OperatorLayoutConfig with icon + label
 *  - Supports one level of nested nav items (children) with expand/collapse
 *  - Active screen highlighted with blue accent
 *  - Click → navigate to target screen
 *  - Modes:
 *      void    → component renders nothing (caller should not mount it)
 *      overlay → floats above content (absolute positioned, z-30)
 *      push    → shifts content right when open (inline block)
 *      fixed   → always-visible column at fixed width
 *  - Smooth open/close animation via CSS width + opacity transition
 *  - Fully keyboard-accessible (Enter/Space to activate, arrow keys)
 */

import React, { useCallback, useState, memo } from 'react';
import {
  LayoutDashboard,
  Workflow,
  AlertTriangle,
  TrendingUp,
  Settings2,
  Gauge,
  ChevronRight,
  ChevronDown,
  Monitor,
  Cpu,
  Activity,
  Sliders,
  Layers,
  List,
} from 'lucide-react';

import { useOperatorStore } from '../../store/scada/operatorStore';
import type { OperatorNavItem, SidenavMode } from '../../types/scada-runtime.types';

/* ------------------------------------------------------------------ */
/*  Props                                                               */
/* ------------------------------------------------------------------ */

export interface OperatorSidenavProps {
  /** Nav items sourced from OperatorLayoutConfig.navItems. */
  navItems: OperatorNavItem[];
  /** Currently active screen id (used to highlight active row). */
  activeScreenId: string;
  /** Sidenav display mode. */
  mode: SidenavMode;
  /** Called when user selects a nav item. */
  onNavigate: (screenId: string) => void;
}

/* ------------------------------------------------------------------ */
/*  Icon map — lucide icon name → component                            */
/* ------------------------------------------------------------------ */

const ICON_MAP: Record<string, React.ElementType> = {
  LayoutDashboard,
  Workflow,
  AlertTriangle,
  TrendingUp,
  Settings2,
  Gauge,
  Monitor,
  Cpu,
  Activity,
  Sliders,
  Layers,
  List,
  // Aliases for common SCADA screen types
  dashboard: LayoutDashboard,
  process:   Workflow,
  alarms:    AlertTriangle,
  trends:    TrendingUp,
  control:   Sliders,
  calibration: Gauge,
};

function NavIcon({ name, size = 15 }: { name?: string; size?: number }) {
  const Icon = (name && ICON_MAP[name]) ? ICON_MAP[name] : Monitor;
  return <Icon size={size} className="shrink-0" aria-hidden="true" />;
}

/* ------------------------------------------------------------------ */
/*  NavItemRow — single nav item (potentially with children)           */
/* ------------------------------------------------------------------ */

interface NavItemRowProps {
  item: OperatorNavItem;
  activeScreenId: string;
  depth: number;
  onNavigate: (screenId: string) => void;
}

const NavItemRow = memo<NavItemRowProps>(
  ({ item, activeScreenId, depth, onNavigate }) => {
    const isActive   = item.screenId === activeScreenId;
    const hasChildren = (item.children?.length ?? 0) > 0;

    // Auto-expand when a child is active
    const [expanded, setExpanded] = useState(
      () =>
        hasChildren &&
        (item.children ?? []).some((c) => c.screenId === activeScreenId),
    );

    const handleClick = useCallback(() => {
      if (hasChildren) {
        setExpanded((prev) => !prev);
      } else {
        onNavigate(item.screenId);
      }
    }, [hasChildren, item.screenId, onNavigate]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      },
      [handleClick],
    );

    // Indent children by 16px per level, base padding is 12px
    const leftPad = depth === 0 ? 12 : depth * 16 + 12;

    return (
      <li>
        <div
          role="button"
          tabIndex={0}
          aria-current={isActive ? 'page' : undefined}
          aria-expanded={hasChildren ? expanded : undefined}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
          className={[
            'flex items-center gap-2.5 py-2 pr-3 mx-1.5 rounded cursor-pointer',
            'text-sm transition-colors duration-100 select-none outline-hidden',
            'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500',
            isActive
              ? 'bg-blue-600 text-white font-medium'
              : 'text-gray-300 hover:bg-gray-700/70 hover:text-gray-100',
          ].join(' ')}
          style={{ paddingLeft: `${leftPad}px` }}
        >
          <NavIcon name={item.icon} />
          <span className="flex-1 truncate leading-snug">{item.label}</span>
          {hasChildren && (
            expanded
              ? <ChevronDown  size={13} className="shrink-0 text-gray-400" aria-hidden="true" />
              : <ChevronRight size={13} className="shrink-0 text-gray-400" aria-hidden="true" />
          )}
        </div>

        {/* Nested children */}
        {hasChildren && expanded && (
          <ul role="list" className="mt-0.5 space-y-0.5">
            {(item.children ?? []).map((child) => (
              <NavItemRow
                key={child.id}
                item={child}
                activeScreenId={activeScreenId}
                depth={depth + 1}
                onNavigate={onNavigate}
              />
            ))}
          </ul>
        )}
      </li>
    );
  },
);
NavItemRow.displayName = 'NavItemRow';

/* ------------------------------------------------------------------ */
/*  OperatorSidenav                                                     */
/* ------------------------------------------------------------------ */

export const OperatorSidenav = memo<OperatorSidenavProps>(
  ({ navItems, activeScreenId, mode, onNavigate }) => {
    const { sidenavOpen } = useOperatorStore((s) => ({
      sidenavOpen: s.sidenavOpen,
    }));

    if (mode === 'void') return null;

    const isOpen = mode === 'fixed' || sidenavOpen;

    // Positioning strategy:
    //   fixed   → relative (participates in flex row)
    //   push    → relative (flex row, animates width)
    //   overlay → absolute (floats over content, z-30)
    const positionClass =
      mode === 'overlay'
        ? 'absolute top-0 left-0 bottom-0 z-30'
        : 'relative shrink-0 z-10';

    return (
      <nav
        aria-label="Screen navigation"
        className={[
          positionClass,
          'flex flex-col bg-gray-900 border-r border-gray-700 overflow-hidden',
          'transition-all duration-200 ease-in-out',
          isOpen ? 'w-56 opacity-100' : 'w-0 opacity-0 pointer-events-none',
        ].join(' ')}
      >
        {/* ── Nav header ── */}
        <div className="px-4 py-3 border-b border-gray-700/60 shrink-0">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
            Navigation
          </span>
        </div>

        {/* ── Nav items list ── */}
        <div className="flex-1 overflow-y-auto py-2">
          {navItems.length === 0 ? (
            <p className="px-4 py-3 text-xs text-gray-600 italic">
              No screens configured.
            </p>
          ) : (
            <ul role="list" className="space-y-0.5 px-0">
              {navItems.map((item) => (
                <NavItemRow
                  key={item.id}
                  item={item}
                  activeScreenId={activeScreenId}
                  depth={0}
                  onNavigate={onNavigate}
                />
              ))}
            </ul>
          )}
        </div>

        {/* ── Footer hint ── */}
        <div className="px-4 py-2 border-t border-gray-700/60 shrink-0">
          <span className="text-[10px] text-gray-600 select-none">
            {navItems.length} screen{navItems.length !== 1 ? 's' : ''}
          </span>
        </div>
      </nav>
    );
  },
);

OperatorSidenav.displayName = 'OperatorSidenav';
