/**
 * OperatorSidenav — Navigation sidebar for the SCADA HMI operator shell.
 *
 * Features:
 *  - Lists all OperatorNavItems from the layout config
 *  - Supports nested nav items (one level of children)
 *  - Highlights the currently active screen
 *  - Click navigates to the target screen
 *  - Modes: void (hidden), overlay (above content), push (shifts content), fixed
 *  - Animated open/close (CSS transition)
 *  - Keyboard-accessible
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
} from 'lucide-react';
import { useOperatorStore } from '../../store/scada/operatorStore';
import type { OperatorNavItem, SidenavMode } from '../../types/scada-runtime.types';

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

export interface OperatorSidenavProps {
  navItems: OperatorNavItem[];
  activeScreenId: string;
  mode: SidenavMode;
  onNavigate: (screenId: string) => void;
}

/* ------------------------------------------------------------------ */
/*  Icon map — screen-type icon names → lucide components              */
/* ------------------------------------------------------------------ */

const ICON_MAP: Record<string, React.ElementType> = {
  LayoutDashboard,
  Workflow,
  AlertTriangle,
  TrendingUp,
  Settings2,
  Gauge,
  Monitor,
};

function NavIcon({ name }: { name?: string }) {
  const Icon = (name && ICON_MAP[name]) ? ICON_MAP[name] : Monitor;
  return <Icon size={15} className="shrink-0" aria-hidden="true" />;
}

/* ------------------------------------------------------------------ */
/*  NavItemRow                                                          */
/* ------------------------------------------------------------------ */

interface NavItemRowProps {
  item: OperatorNavItem;
  activeScreenId: string;
  depth: number;
  onNavigate: (screenId: string) => void;
}

const NavItemRow = memo(({ item, activeScreenId, depth, onNavigate }: NavItemRowProps) => {
  const isActive = item.screenId === activeScreenId;
  const hasChildren = (item.children?.length ?? 0) > 0;
  const [expanded, setExpanded] = useState(
    // auto-expand parent if one of its children is active
    () => hasChildren && (item.children ?? []).some((c) => c.screenId === activeScreenId),
  );

  const handleClick = useCallback(() => {
    if (hasChildren) {
      setExpanded((p) => !p);
    } else {
      onNavigate(item.screenId);
    }
  }, [hasChildren, item.screenId, onNavigate]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleClick();
      }
    },
    [handleClick],
  );

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        aria-current={isActive ? 'page' : undefined}
        aria-expanded={hasChildren ? expanded : undefined}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        className={`
          flex items-center gap-2.5 px-3 py-2 rounded mx-1.5 cursor-pointer
          text-sm transition-colors select-none
          focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-inset
          ${isActive
            ? 'bg-blue-600 text-white font-medium'
            : 'text-gray-300 hover:bg-gray-700 hover:text-gray-100'}
          ${depth > 0 ? 'pl-7' : ''}
        `}
        style={{ paddingLeft: depth > 0 ? `${depth * 16 + 12}px` : undefined }}
      >
        <NavIcon name={item.icon} />
        <span className="flex-1 truncate">{item.label}</span>
        {hasChildren && (
          expanded
            ? <ChevronDown size={13} className="shrink-0 text-gray-400" />
            : <ChevronRight size={13} className="shrink-0 text-gray-400" />
        )}
      </div>

      {/* Children */}
      {hasChildren && expanded && (
        <ul className="mt-0.5" role="list">
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
});
NavItemRow.displayName = 'NavItemRow';

/* ------------------------------------------------------------------ */
/*  OperatorSidenav                                                     */
/* ------------------------------------------------------------------ */

export const OperatorSidenav = memo(
  ({ navItems, activeScreenId, mode, onNavigate }: OperatorSidenavProps) => {
    const { sidenavOpen, setSidenavOpen } = useOperatorStore((s) => ({
      sidenavOpen:    s.sidenavOpen,
      setSidenavOpen: s.setSidenavOpen,
    }));

    if (mode === 'void') return null;

    const isVisible = mode === 'fixed' || sidenavOpen;

    const handleBackdropClick = () => {
      if (mode === 'overlay') setSidenavOpen(false);
    };

    return (
      <>
        {/* Backdrop for overlay mode */}
        {mode === 'overlay' && isVisible && (
          <div
            className="fixed inset-0 bg-black/40 z-20"
            aria-hidden="true"
            onClick={handleBackdropClick}
          />
        )}

        {/* The nav panel */}
        <nav
          aria-label="Screen navigation"
          className={`
            flex flex-col bg-gray-850 border-r border-gray-700
            transition-all duration-200 ease-in-out overflow-hidden
            ${mode === 'overlay' || mode === 'push'
              ? 'absolute top-0 left-0 bottom-0 z-30'
              : 'relative z-10 shrink-0'}
            ${isVisible ? 'w-56 opacity-100' : 'w-0 opacity-0'}
          `}
          style={{
            /* Keep dark industrial look consistent */
            backgroundColor: '#111827',
          }}
        >
          {/* Header */}
          <div className="px-4 py-3 border-b border-gray-700 shrink-0">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-gray-500">
              Navigation
            </span>
          </div>

          {/* Nav items */}
          <div className="flex-1 overflow-y-auto py-2">
            {navItems.length === 0 ? (
              <p className="px-4 py-3 text-xs text-gray-600 italic">
                No screens configured.
              </p>
            ) : (
              <ul role="list" className="space-y-0.5">
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
        </nav>
      </>
    );
  },
);

OperatorSidenav.displayName = 'OperatorSidenav';
