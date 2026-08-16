/**
 * Sidebar Component
 * Application side navigation — menu items, module access
 */

import React, { useState, useCallback, useEffect } from 'react';

import type { NavigationItem, UserRole } from '../../types';

// Alias for backward compatibility
type NavItem = NavigationItem;

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Theme types — different colour schemes per role
 */
export type SidebarTheme = 'default' | 'admin' | 'tenant';

export interface SidebarProps {
  /** Navigation items */
  items: readonly NavItem[];
  /** Active path */
  activePath?: string;
  /** Navigation handler */
  onNavigate: (path: string) => void;
  /** User roles (for access checks) */
  userRoles?: UserRole[];
  /** Logo element */
  logo?: React.ReactNode;
  /** Collapsed state */
  collapsed?: boolean;
  /** Collapsed state change handler */
  onCollapsedChange?: (collapsed: boolean) => void;
  /** Footer content */
  footer?: React.ReactNode;
  /** Theme (admin=indigo, tenant=emerald, default=blue) */
  theme?: SidebarTheme;
  /**
   * Consumer-supplied icon map. Keys override / extend the built-in
   * `defaultIcons` set so admin-panel, tenant-admin, and other
   * consumers can inject module-specific icons (analytics, billing,
   * security, …) without forking this component or pushing every
   * custom icon back into shared-ui.
   *
   * Resolution order: if an `item.icon` key exists in `customIcons`
   * it wins; otherwise the built-in `defaultIcons` is consulted.
   */
  customIcons?: Record<string, React.ReactNode>;
  className?: string;
}

// ============================================================================
// Icon Components
// ============================================================================

/**
 * Default icons (keyed by icon name string)
 */
const defaultIcons: Record<string, React.ReactNode> = {
  dashboard: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
    </svg>
  ),
  farm: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
    </svg>
  ),
  sensor: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
    </svg>
  ),
  alert: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
    </svg>
  ),
  process: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
    </svg>
  ),
  admin: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  ),
  users: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
    </svg>
  ),
  billing: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
    </svg>
  ),
  reports: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  ),
  // Additional icons for Admin Panel
  analytics: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
    </svg>
  ),
  tenants: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
    </svg>
  ),
  building: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
    </svg>
  ),
  support: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 5.636l-3.536 3.536m0 5.656l3.536 3.536M9.172 9.172L5.636 5.636m3.536 9.192l-3.536 3.536M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-5 0a4 4 0 11-8 0 4 4 0 018 0z" />
    </svg>
  ),
  security: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
    </svg>
  ),
  shield: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
    </svg>
  ),
  system: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  ),
  database: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
    </svg>
  ),
  modules: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
    </svg>
  ),
  grid: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
    </svg>
  ),
  audit: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
    </svg>
  ),
  clipboard: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
    </svg>
  ),
  settings: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
    </svg>
  ),
  messages: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
    </svg>
  ),
  sprout: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 22V12M12 12C12 12 8 8 4 8c0 4 4 8 8 8zM12 12c0 0 4-4 8-4c0 4-4 8-8 8z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c0-2-1-4-4-6c0 3 1 5 4 6zM12 8c0-2 1-4 4-6c0 3-1 5-4 6z" />
    </svg>
  ),
  activity: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  ),
  cpu: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <rect x="4" y="4" width="16" height="16" rx="2" strokeWidth={2} />
      <rect x="9" y="9" width="6" height="6" strokeWidth={2} />
      <path strokeLinecap="round" strokeWidth={2} d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 15h3M1 9h3M1 15h3" />
    </svg>
  ),
  calendar: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <rect x="3" y="4" width="18" height="18" rx="2" strokeWidth={2} />
      <path strokeLinecap="round" strokeWidth={2} d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  ),
};

/**
 * Resolve an icon name string to a React node. A consumer-supplied
 * icon map takes precedence over the built-in `defaultIcons` so
 * admin-panel and similar surfaces can inject their own SVGs without
 * forking the Sidebar component.
 */
const resolveIcon = (
  icon: string | undefined,
  customIcons: Record<string, React.ReactNode> | undefined,
): React.ReactNode => {
  if (!icon) return null;
  if (customIcons && icon in customIcons) {
    return customIcons[icon] ?? null;
  }
  return defaultIcons[icon] || null;
};

// ============================================================================
// Sub-components
// ============================================================================

/**
 * Theme colour classes
 */
const themeClasses = {
  default: {
    active: 'bg-blue-50 text-blue-700',
    hover: 'text-gray-700 hover:bg-gray-100',
    badge: 'bg-blue-100 text-blue-700',
  },
  admin: {
    active: 'bg-indigo-50 text-indigo-700',
    hover: 'text-gray-700 hover:bg-indigo-50',
    badge: 'bg-indigo-100 text-indigo-700',
  },
  tenant: {
    active: 'bg-emerald-50 text-emerald-700',
    hover: 'text-gray-700 hover:bg-emerald-50',
    badge: 'bg-emerald-100 text-emerald-700',
  },
};

/**
 * Menu item component
 */
const MenuItem: React.FC<{
  item: NavItem;
  activePath?: string;
  collapsed: boolean;
  depth?: number;
  onNavigate: (path: string) => void;
  userRoles?: UserRole[];
  theme?: SidebarTheme;
  customIcons?: Record<string, React.ReactNode>;
}> = ({ item, activePath, collapsed, depth = 0, onNavigate, userRoles = [], theme = 'default', customIcons }) => {
  const hasChildren = !!item.children?.length;
  const childItems = item.children ?? [];

  // Access check — computed as a boolean (no useCallback overhead for a sync value)
  const hasAccess = !item.requiredRoles?.length ||
    item.requiredRoles.some((role) => userRoles.includes(role));

  const pathMatches = (path?: string): boolean => {
    if (!path || !activePath) return false;
    if (path === activePath) return true;
    return hasChildren && activePath.startsWith(path + '/');
  };

  const isActive = pathMatches(item.path);
  const isChildActive = item.children?.some((child) => child.path === activePath) ?? false;

  // BUG-1 FIX: Auto-expand parent when a child is active
  const [isExpanded, setIsExpanded] = useState(!!isChildActive);

  useEffect(() => {
    if (isChildActive) setIsExpanded(true);
  }, [isChildActive]);

  const handleClick = useCallback(() => {
    if (hasChildren) {
      setIsExpanded(prev => !prev);
    } else if (item.path) {
      if (item.isExternal) {
        window.open(item.path, '_blank', 'noopener,noreferrer');
      } else {
        onNavigate(item.path);
      }
    }
  }, [hasChildren, item.path, item.isExternal, onNavigate]);

  if (!hasAccess) return null;

  // BUG-020: If no path and no children, item is inert — render as span to avoid
  // misleading interactive affordance (a button with no action)
  const isInert = !hasChildren && !item.path;

  const colors = themeClasses[theme];
  const baseClasses = `
    w-full flex items-center
    ${collapsed && depth === 0 ? 'justify-center' : 'justify-between'}
    px-3 py-2 rounded-lg
    text-sm font-medium
    transition-colors duration-200
    ${
      isActive || isChildActive
        ? colors.active
        : colors.hover
    }
    ${depth > 0 ? 'ml-4' : ''}
  `;

  const itemContent = (
    <>
      <div className="flex items-center min-w-0">
        {/* Icon */}
        {item.icon && (
          <span className={`flex-shrink-0 ${!collapsed ? 'mr-3' : ''}`}>
            {resolveIcon(item.icon, customIcons)}
          </span>
        )}
        {/* Label */}
        {!collapsed && (
          <span className="truncate">{item.label}</span>
        )}
      </div>

      {/* Badge and chevron */}
      {!collapsed && (
        <div className="flex items-center space-x-2">
          {item.badge !== undefined && (
            <span className={`px-2 py-0.5 text-xs font-semibold ${colors.badge} rounded-full`}>
              {item.badge}
            </span>
          )}
          {hasChildren && (
            <svg
              className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          )}
        </div>
      )}
    </>
  );

  return (
    <div>
      {isInert ? (
        <span className={`${baseClasses} cursor-default`} aria-disabled="true" title={collapsed ? item.label : undefined}>
          {itemContent}
        </span>
      ) : (
      <button
        onClick={handleClick}
        className={baseClasses}
        title={collapsed ? item.label : undefined}
      >
        {itemContent}
      </button>
      )}

      {/* Sub-menu */}
      {hasChildren && isExpanded && !collapsed && (
        <div className="mt-1 space-y-1">
          {childItems.map((child) => (
            <MenuItem
              key={child.id}
              item={child}
              activePath={activePath}
              collapsed={collapsed}
              depth={depth + 1}
              onNavigate={onNavigate}
              userRoles={userRoles}
              theme={theme}
              customIcons={customIcons}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Sidebar Component
// ============================================================================

/**
 * Sidebar component
 *
 * @example
 * <Sidebar
 *   items={navigationItems}
 *   activePath={location.pathname}
 *   onNavigate={(path) => navigate(path)}
 *   userRoles={user.roles}
 *   logo={<Logo />}
 * />
 */
/**
 * Sidebar theme styles
 */
const sidebarThemeStyles = {
  default: {
    bg: 'bg-white',
    border: 'border-gray-200',
    toggleHover: 'hover:bg-gray-100',
  },
  admin: {
    bg: 'bg-slate-50',
    border: 'border-indigo-100',
    toggleHover: 'hover:bg-indigo-100',
  },
  tenant: {
    bg: 'bg-slate-50',
    border: 'border-emerald-100',
    toggleHover: 'hover:bg-emerald-100',
  },
};

export const Sidebar: React.FC<SidebarProps> = ({
  items,
  activePath,
  onNavigate,
  userRoles = [],
  logo,
  collapsed = false,
  onCollapsedChange,
  footer,
  theme = 'default',
  customIcons,
  className = '',
}) => {
  const themeStyle = sidebarThemeStyles[theme];

  return (
    <aside
      aria-label="Main navigation"
      className={`
        flex flex-col
        ${collapsed ? 'w-16' : 'w-64'}
        h-screen ${themeStyle.bg} border-r ${themeStyle.border}
        transition-all duration-300
        ${className}
      `}
    >
      {/* Logo and collapse button */}
      <div className={`h-16 flex items-center ${collapsed ? 'justify-center' : 'justify-between px-4'} border-b ${themeStyle.border}`}>
        {!collapsed && logo}
        {onCollapsedChange && (
          <button
            onClick={() => onCollapsedChange(!collapsed)}
            className={`p-2 text-gray-500 hover:text-gray-700 ${themeStyle.toggleHover} rounded-lg`}
            title={collapsed ? 'Expand' : 'Collapse'}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <svg
              className={`w-5 h-5 transition-transform ${collapsed ? 'rotate-180' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
            </svg>
          </button>
        )}
      </div>

      {/* Navigation menu */}
      <nav className="flex-1 overflow-y-auto p-4 space-y-1">
        {items.map((item) => (
          <MenuItem
            key={item.id}
            item={item}
            activePath={activePath}
            collapsed={collapsed}
            onNavigate={onNavigate}
            userRoles={userRoles}
            theme={theme}
            customIcons={customIcons}
          />
        ))}
      </nav>

      {/* Footer content */}
      {footer && (
        <div className={`p-4 border-t ${themeStyle.border} ${collapsed ? 'hidden' : ''}`}>
          {footer}
        </div>
      )}
    </aside>
  );
};

export default Sidebar;
