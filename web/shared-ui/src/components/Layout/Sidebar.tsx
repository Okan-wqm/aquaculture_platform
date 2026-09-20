/**
 * Sidebar Component
 * Application side navigation — menu items, module access
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';

import type { NavigationItem, UserRole } from '../../types';
import { useI18n } from '../../i18n';
import { useDialogBehavior } from '../Modal/useDialogBehavior';
import { ChevronDown, ChevronsLeft, X } from 'lucide-react';

import { DESKTOP_MEDIA_QUERY, resolveNavIcon } from './navIcons';

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
  items: NavItem[];
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
  /**
   * Below Tailwind's `md` (768 px) the sidebar is off-canvas: nothing until
   * `mobileOpen`, then a fixed overlay over a backdrop that closes on Escape,
   * on the backdrop, on the close button, on navigation and when the viewport
   * grows past `md`. Above `md` it is the in-flow column and this prop has no
   * visual effect. Required, so every consumer wires a way to open it — a
   * sidebar that is hidden on a phone with no opener is the type error.
   */
  mobileOpen: boolean;
  /** Overlay open-state change handler; `false` from the backdrop, Escape, the close button and navigation */
  onMobileOpenChange: (open: boolean) => void;
  /** `id` of the aside, the target of the opener's `aria-controls` */
  id?: string;
  className?: string;
}

// ============================================================================
// Icon Components
// ============================================================================

/**
 * Resolve an icon name to a rendered node at this component's size.
 *
 * The name→icon table is `navIcons.ts`, shared with the SUDERRA rail; only the
 * SIZE is Sidebar's, because that is the part that differs between the two
 * consumers. A consumer-supplied node still takes precedence, so admin-panel
 * and friends keep injecting their own SVGs without forking this component.
 */
const resolveIcon = (
  icon: string | undefined,
  customIcons: Record<string, React.ReactNode> | undefined,
): React.ReactNode => {
  if (!icon) return null;
  if (customIcons && icon in customIcons) {
    return customIcons[icon] ?? null;
  }
  const Icon = resolveNavIcon(icon);
  return Icon ? <Icon className="w-5 h-5" aria-hidden="true" /> : null;
};

// ============================================================================
// Sub-components
// ============================================================================

/**
 * Theme colour classes
 */
const themeClasses = {
  default: {
    active: 'bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300',
    hover: 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700',
    badge: 'bg-primary-100 dark:bg-primary-900/40 text-primary-700 dark:text-primary-300',
  },
  admin: {
    active: 'bg-accent-50 dark:bg-accent-900/20 text-accent-700 dark:text-accent-300',
    hover: 'text-gray-700 dark:text-gray-300 hover:bg-accent-50',
    badge: 'bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300',
  },
  tenant: {
    active: 'bg-secondary-50 dark:bg-secondary-900/20 text-secondary-700 dark:text-secondary-300',
    hover: 'text-gray-700 dark:text-gray-300 hover:bg-secondary-50',
    badge: 'bg-secondary-100 dark:bg-secondary-900/40 text-secondary-700 dark:text-secondary-300',
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
}> = ({
  item,
  activePath,
  collapsed,
  depth = 0,
  onNavigate,
  userRoles = [],
  theme = 'default',
  customIcons,
}) => {
  const hasChildren = !!item.children?.length;
  const childItems = item.children ?? [];

  // Access check — computed as a boolean (no useCallback overhead for a sync value)
  const hasAccess =
    !item.requiredRoles?.length || item.requiredRoles.some((role) => userRoles.includes(role));

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
      setIsExpanded((prev) => !prev);
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
    ${isActive || isChildActive ? colors.active : colors.hover}
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
        {!collapsed && <span className="truncate">{item.label}</span>}
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
            <ChevronDown
              className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
              aria-hidden="true"
            />
          )}
        </div>
      )}
    </>
  );

  return (
    <div>
      {isInert ? (
        <span
          className={`${baseClasses} cursor-default`}
          aria-disabled="true"
          title={collapsed ? item.label : undefined}
        >
          {itemContent}
        </span>
      ) : (
        <button
          onClick={handleClick}
          className={baseClasses}
          title={collapsed ? item.label : undefined}
          aria-current={isActive ? 'page' : undefined}
          aria-expanded={hasChildren ? isExpanded : undefined}
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
    bg: 'bg-white dark:bg-gray-900',
    border: 'border-gray-200 dark:border-gray-700',
    toggleHover: 'hover:bg-gray-100 dark:hover:bg-gray-700',
  },
  admin: {
    bg: 'bg-slate-50',
    border: 'border-accent-100 dark:border-accent-800',
    toggleHover: 'hover:bg-accent-100 dark:hover:bg-accent-900/50',
  },
  tenant: {
    bg: 'bg-slate-50',
    border: 'border-secondary-100 dark:border-secondary-800',
    toggleHover: 'hover:bg-secondary-100 dark:hover:bg-secondary-900/50',
  },
};

/** Tailwind's `md`: above it the sidebar is an in-flow column, below it an off-canvas overlay. */

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
  mobileOpen,
  onMobileOpenChange,
  id,
  className = '',
}) => {
  const themeStyle = sidebarThemeStyles[theme];
  const asideRef = useRef<HTMLElement>(null);
  const { t } = useI18n();

  const closeOverlay = useCallback(() => onMobileOpenChange(false), [onMobileOpenChange]);

  // Escape, focus into the panel, focus back to the opener on close and the
  // body scroll lock come from the hook Modal and Drawer share — one open-
  // surface behaviour, not a third copy.
  useDialogBehavior({
    isOpen: mobileOpen,
    onClose: closeOverlay,
    closeOnEscape: true,
    containerRef: asideRef,
  });

  // The overlay is a phone-width surface. Once the viewport grows past `md`
  // the in-flow column is on screen again, so an open overlay would show the
  // navigation twice; it closes itself on that crossing.
  useEffect(() => {
    if (!mobileOpen) return undefined;
    const desktop = window.matchMedia(DESKTOP_MEDIA_QUERY);
    const settle = (): void => {
      if (desktop.matches) closeOverlay();
    };
    settle();
    desktop.addEventListener('change', settle);
    return () => desktop.removeEventListener('change', settle);
  }, [mobileOpen, closeOverlay]);

  // Choosing a destination closes the overlay; the in-flow column stays put.
  const handleNavigate = useCallback(
    (path: string) => {
      onNavigate(path);
      if (mobileOpen) closeOverlay();
    },
    [onNavigate, mobileOpen, closeOverlay],
  );

  // `collapsed` is the desktop column's rail mode; the overlay always shows labels.
  const rail = collapsed && !mobileOpen;
  const desktopWidth = collapsed ? 'md:w-16' : 'md:w-64';
  const placement = mobileOpen
    ? `flex fixed inset-y-0 left-0 z-50 w-64 md:static md:inset-auto md:z-auto ${desktopWidth}`
    : `hidden md:flex ${desktopWidth}`;

  return (
    <>
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={closeOverlay}
          aria-hidden="true"
          data-testid="sidebar-backdrop"
        />
      )}
      <aside
        ref={asideRef}
        id={id}
        tabIndex={-1}
        aria-label={t('sidebar.mainNavigation')}
        className={`
          flex-col ${placement}
          md:h-screen ${themeStyle.bg} border-r ${themeStyle.border}
          transition-all duration-300 focus:outline-hidden
          ${className}
        `}
      >
        {/* Logo, the overlay's close button and the column's collapse button */}
        <div
          className={`h-16 flex items-center ${rail ? 'justify-center' : 'justify-between px-4'} border-b ${themeStyle.border}`}
        >
          {!rail && logo}
          <div className="flex items-center">
            <button
              type="button"
              onClick={closeOverlay}
              className={`md:hidden p-2 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-100 ${themeStyle.toggleHover} rounded-lg`}
              aria-label={t('header.closeNavigation')}
            >
              <X className="w-5 h-5" aria-hidden="true" />
            </button>
            {onCollapsedChange && (
              <button
                type="button"
                onClick={() => onCollapsedChange(!collapsed)}
                className={`hidden md:inline-flex p-2 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-100 ${themeStyle.toggleHover} rounded-lg`}
                title={collapsed ? 'Expand' : 'Collapse'}
                aria-label={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
              >
                <ChevronsLeft
                  className={`w-5 h-5 transition-transform ${collapsed ? 'rotate-180' : ''}`}
                  aria-hidden="true"
                />
              </button>
            )}
          </div>
        </div>

        {/* Navigation menu */}
        <nav className="flex-1 overflow-y-auto p-4 space-y-1">
          {items.map((item) => (
            <MenuItem
              key={item.id}
              item={item}
              activePath={activePath}
              collapsed={rail}
              onNavigate={handleNavigate}
              userRoles={userRoles}
              theme={theme}
              customIcons={customIcons}
            />
          ))}
        </nav>

        {/* Footer content */}
        {footer && (
          <div className={`p-4 border-t ${themeStyle.border} ${rail ? 'hidden' : ''}`}>
            {footer}
          </div>
        )}
      </aside>
    </>
  );
};

export default Sidebar;
