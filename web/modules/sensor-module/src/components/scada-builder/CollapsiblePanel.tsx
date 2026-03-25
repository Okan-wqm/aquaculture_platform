/**
 * CollapsiblePanel — Reusable wrapper that collapses a side panel into a 40px icon rail.
 *
 * When collapsed, shows a vertical strip of icon buttons (with tooltips) plus a
 * chevron toggle. When expanded, shows the full panel content with a toggle button
 * on the inner edge.
 *
 * Animations: CSS transition on width (200ms ease-in-out), opacity fade on
 * content (150ms delayed 50ms) and rail icons (150ms).
 */

import React, { useRef, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface RailIcon {
  id: string;
  icon: React.ReactNode;
  label: string;
  badge?: string | number;
}

export interface CollapsiblePanelProps {
  side: 'left' | 'right';
  collapsed: boolean;
  onToggle: () => void;
  width: number;
  railIcons: RailIcon[];
  activeRailIcon?: string;
  onRailIconClick?: (iconId: string) => void;
  children: React.ReactNode;
}

/* ------------------------------------------------------------------ */
/*  Tooltip                                                            */
/* ------------------------------------------------------------------ */

interface TooltipWrapperProps {
  label: string;
  side: 'left' | 'right';
  children: React.ReactNode;
}

const TooltipWrapper: React.FC<TooltipWrapperProps> = ({ label, side, children }) => {
  const [show, setShow] = useState(false);

  const tooltipPosition =
    side === 'left' ? 'left-full ml-2' : 'right-full mr-2';

  return (
    <div
      className="relative"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && (
        <div
          className={`absolute top-1/2 -translate-y-1/2 ${tooltipPosition} z-50 px-2 py-1 text-xs text-white bg-gray-800 rounded shadow-lg whitespace-nowrap pointer-events-none`}
        >
          {label}
        </div>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Icon Rail (collapsed state)                                        */
/* ------------------------------------------------------------------ */

interface IconRailProps {
  icons: RailIcon[];
  side: 'left' | 'right';
  activeIconId?: string;
  onIconClick?: (iconId: string) => void;
  visible: boolean;
}

const IconRail: React.FC<IconRailProps> = ({
  icons,
  side,
  activeIconId,
  onIconClick,
  visible,
}) => (
  <div
    className="flex flex-col items-center gap-1 pt-3"
    style={{
      opacity: visible ? 1 : 0,
      transition: 'opacity 150ms ease-in-out',
      pointerEvents: visible ? 'auto' : 'none',
    }}
  >
    {icons.map((item) => {
      const isActive = activeIconId === item.id;
      return (
        <TooltipWrapper key={item.id} label={item.label} side={side}>
          <button
            type="button"
            onClick={() => onIconClick?.(item.id)}
            className={`
              relative flex items-center justify-center w-8 h-8 rounded-md
              transition-colors duration-150
              ${isActive
                ? 'bg-cyan-100 text-cyan-700'
                : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700'
              }
            `}
            aria-label={item.label}
          >
            {item.icon}
            {item.badge !== undefined && item.badge !== '' && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-3.5 px-0.5 flex items-center justify-center text-[9px] font-medium leading-none text-white bg-cyan-600 rounded-full">
                {item.badge}
              </span>
            )}
          </button>
        </TooltipWrapper>
      );
    })}
  </div>
);

/* ------------------------------------------------------------------ */
/*  Toggle Button                                                      */
/* ------------------------------------------------------------------ */

interface ToggleButtonProps {
  side: 'left' | 'right';
  collapsed: boolean;
  onToggle: () => void;
}

const ToggleButton: React.FC<ToggleButtonProps> = ({ side, collapsed, onToggle }) => {
  // When expanded, the toggle sits on the panel's inner edge.
  // Left panel: toggle on right edge. Right panel: toggle on left edge.
  const positionClasses =
    side === 'left'
      ? '-right-3 top-1/2 -translate-y-1/2'
      : '-left-3 top-1/2 -translate-y-1/2';

  const Icon = getToggleIcon(side, collapsed);

  return (
    <button
      type="button"
      onClick={onToggle}
      className={`
        absolute ${positionClasses} z-10
        flex items-center justify-center w-6 h-6
        bg-white border border-gray-200 rounded-full shadow-sm
        text-gray-500 hover:text-gray-700 hover:bg-gray-50
        transition-colors duration-150
      `}
      aria-label={collapsed ? 'Expand panel' : 'Collapse panel'}
    >
      <Icon className="w-3.5 h-3.5" />
    </button>
  );
};

function getToggleIcon(
  side: 'left' | 'right',
  collapsed: boolean,
): React.FC<{ className?: string }> {
  if (side === 'left') {
    return collapsed ? ChevronRight : ChevronLeft;
  }
  return collapsed ? ChevronLeft : ChevronRight;
}

/* ------------------------------------------------------------------ */
/*  Main Component                                                     */
/* ------------------------------------------------------------------ */

const RAIL_WIDTH = 40; // px — w-10

export const CollapsiblePanel: React.FC<CollapsiblePanelProps> = ({
  side,
  collapsed,
  onToggle,
  width,
  railIcons,
  activeRailIcon,
  onRailIconClick,
  children,
}) => {
  const currentWidth = collapsed ? RAIL_WIDTH : width;
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentVisible, setContentVisible] = useState(!collapsed);

  // Manage content visibility with delay for smooth animation
  useEffect(() => {
    if (collapsed) {
      // Hide content immediately when collapsing
      setContentVisible(false);
    } else {
      // Show content after a 50ms delay when expanding (let width animate first)
      const timer = setTimeout(() => setContentVisible(true), 50);
      return () => clearTimeout(timer);
    }
  }, [collapsed]);

  const borderClass = side === 'left' ? 'border-r' : 'border-l';

  return (
    <div
      className={`relative flex-shrink-0 bg-white ${borderClass} border-gray-200 overflow-hidden`}
      style={{
        width: currentWidth,
        minWidth: currentWidth,
        transition: 'width 200ms ease-in-out, min-width 200ms ease-in-out',
      }}
    >
      {/* Toggle button */}
      <ToggleButton side={side} collapsed={collapsed} onToggle={onToggle} />

      {/* Collapsed: icon rail */}
      {collapsed && (
        <div className="h-full bg-gray-50">
          <IconRail
            icons={railIcons}
            side={side}
            activeIconId={activeRailIcon}
            onIconClick={(iconId) => {
              onRailIconClick?.(iconId);
              onToggle(); // expand the panel when an icon is clicked
            }}
            visible={collapsed}
          />
        </div>
      )}

      {/* Expanded: full panel content */}
      {!collapsed && (
        <div
          ref={contentRef}
          className="h-full flex flex-col overflow-hidden"
          style={{
            opacity: contentVisible ? 1 : 0,
            transition: 'opacity 150ms ease-in-out',
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
};
