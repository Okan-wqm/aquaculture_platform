/**
 * SuderraSidebar — the SUDERRA Tenant Console rail.
 *
 * WHAT: dark deep-water rail with a hover-expand "push" behaviour (68px icon
 * rail → 264px drawer), grouped sections with uppercase labels, per-item
 * stroke icons, accordion module children, live-status footer. Ported 1:1
 * from the approved Tenant Console design mockup.
 *
 * WHY a second component instead of restyling Sidebar: the legacy Sidebar is
 * the SSoT chrome for the (not yet redesigned) admin panel and standalone
 * layouts; forking the presentation here lets the tenant console migrate
 * without touching them. Styles live in the shell's stylesheet (`sd-rail-*`
 * classes) next to the industrial-auth block — same pattern as the login.
 *
 * Open-state model (mockup parity): open = pinned || hovering. Hovering the
 * rail expands it in place (width transition pushes the content); the pin
 * button in the header keeps it open permanently.
 */
import React, { useCallback, useMemo, useState } from 'react';

import type { NavigationItem, UserRole } from '../../types';

export interface SuderraNavSection {
  id: string;
  label: string;
  items: NavigationItem[];
}

export interface SuderraSidebarProps {
  /** Grouped navigation (sections render their label only while expanded). */
  sections: SuderraNavSection[];
  /** Active path used to highlight items and auto-open their parent group. */
  activePath?: string;
  /** Navigation handler (router push). */
  onNavigate: (path: string) => void;
  /** User roles for requiredRoles access checks. */
  userRoles?: UserRole[];
  /** Brand block: workspace name shown under the logo mark. */
  brandName: string;
  /** Small caption under the brand name (e.g. "Tenant console"). */
  brandSub?: string;
  /** Logo mark image URL (rendered inside the white tile). */
  logoSrc?: string;
  /** Live-status caption in the rail footer. */
  statusText?: string;
  /** Extra content under the nav (above the status footer). */
  footer?: React.ReactNode;
  className?: string;
}

/**
 * Stroke icon registry from the mockup: name → up to 4 SVG path `d` values,
 * rendered 24x24, stroke 1.7, round caps (lucide idiom). Empty strings render
 * nothing so every icon is a single uniform <svg>.
 */
const ICON_PATHS: Record<string, readonly [string, string, string, string]> = {
  building: [
    'M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z',
    'M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2',
    'M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2',
    'M10 6h4M10 10h4M10 14h4M10 18h4',
  ],
  gauge: ['M3.34 19a10 10 0 1 1 17.32 0', 'm12 14 4-4', 'M12 18h.01', ''],
  chat: ['M7.9 20A9 9 0 1 0 4 16.1L2 22Z', 'M8 12h.01M12 12h.01M16 12h.01', '', ''],
  users: [
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2',
    'M9 7a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
    'M22 21v-2a4 4 0 0 0-3-3.87',
    'M16 3.13a4 4 0 0 1 0 7.75',
  ],
  shield: [
    'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1Z',
    'm9 12 2 2 4-4',
    '',
    '',
  ],
  blocks: ['M10 3H3v7h7Z', 'M21 3h-7v7h7Z', 'M21 14h-7v7h7Z', 'M10 14H3v7h7Z'],
  comms: [
    'M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2Z',
    'M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1',
    '',
    '',
  ],
  mail: [
    'M22 7.5V18a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2Z',
    'm2 7 10 7 10-7',
    '',
    '',
  ],
  lifebuoy: [
    'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z',
    'M16 12a4 4 0 1 0-8 0 4 4 0 0 0 8 0Z',
    'm4.93 4.93 4.24 4.24m5.66 5.66 4.24 4.24',
    'm14.83 9.17 4.24-4.24M4.93 19.07l4.24-4.24',
  ],
  megaphone: ['m3 11 18-5v12L3 14v-3Z', 'M11.6 16.8a3 3 0 1 1-5.8-1.6', '', ''],
  drive: [
    'M22 12H2',
    'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z',
    'M6 16h.01M10 16h.01',
    '',
  ],
  database: [
    'M12 8c4.97 0 9-1.34 9-3s-4.03-3-9-3-9 1.34-9 3 4.03 3 9 3Z',
    'M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5',
    'M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3',
    '',
  ],
  scroll: [
    'M8 21h12a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H8',
    'M2 3h6v16a2 2 0 0 1-4 0V5a2 2 0 0 0-2-2Z',
    'M12 8h6M12 13h6',
    '',
  ],
  card: [
    'M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2Z',
    'M2 10h20',
    'M6 15h4',
    '',
  ],
  pulse: ['M22 12h-4l-3 9L9 3l-3 9H2', '', '', ''],
  sliders: ['M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3', 'M1 14h6M9 8h6M17 16h6', '', ''],
  waves: [
    'M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 1.3 0 1.9-.5 2.5-1',
    'M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 1.3 0 1.9-.5 2.5-1',
    'M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 1.3 0 1.9-.5 2.5-1',
    '',
  ],
  map: ['M9 3 3 6v15l6-3 6 3 6-3V3l-6 3-6-3Z', 'M9 3v15M15 6v15', '', ''],
  wrench: [
    'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z',
    '',
    '',
    '',
  ],
  droplet: [
    'M7 16.3c2.2 0 4-1.83 4-4.05 0-1.16-.57-2.26-1.71-3.19S7.29 6.75 7 5.3c-.29 1.45-1.14 2.84-2.29 3.76S3 11.1 3 12.25c0 2.22 1.8 4.05 4 4.05Z',
    'M12.56 6.6A10.97 10.97 0 0 0 14 3.02c.5 2.5 2 4.9 4 6.5s3 3.5 3 5.5a6.98 6.98 0 0 1-11.91 4.97',
    '',
    '',
  ],
  wheat: [
    'M2 22 16 8',
    'M3.47 12.53 5 11l1.53 1.53a3.5 3.5 0 0 1 0 4.94L5 19l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z',
    'M7.47 8.53 9 7l1.53 1.53a3.5 3.5 0 0 1 0 4.94L9 15l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z',
    'M11.47 4.53 13 3l1.53 1.53a3.5 3.5 0 0 1 0 4.94L13 11l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z',
  ],
  warehouse: [
    'M22 8.35V20a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8.35A2 2 0 0 1 3.26 6.5l8-3.2a2 2 0 0 1 1.48 0l8 3.2A2 2 0 0 1 22 8.35Z',
    'M6 18h12',
    'M6 14h12M6 10h12',
    '',
  ],
  checks: ['M11 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6', 'm9 11 3 3L22 4', '', ''],
  basket: [
    'M2 11h20',
    'm3.5 11 1.6 7.4a2 2 0 0 0 2 1.6h9.8a2 2 0 0 0 2-1.6l1.6-7.4',
    'm5 11 4-7M19 11l-4-7',
    'm9 15 .5 3M15 15l-.5 3',
  ],
  bars: ['M3 3v18h18', 'M18 17V9M13 17V5M8 17v-3', '', ''],
  signal: ['M2 20h.01', 'M7 20v-4M12 20v-8M17 20V8M22 20V4', '', ''],
  chip: [
    'M4 4h16v16H4Z',
    'M9 9h6v6H9Z',
    'M9 2v2M15 2v2M9 20v2M15 20v2',
    'M2 9h2M2 15h2M20 9h2M20 15h2',
  ],
  linechart: ['M3 3v16a2 2 0 0 0 2 2h16', 'm19 9-5 5-4-4-3 3', '', ''],
  bell: [
    'M10.268 21a2 2 0 0 0 3.464 0',
    'M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326',
    '',
    '',
  ],
  workflow: ['M4 4h6v6H4Z', 'M14 14h6v6h-6Z', 'M10 7h4a2 2 0 0 1 2 2v3', ''],
  network: [
    'M9 2h6v6H9Z',
    'M2 16h6v6H2Z',
    'M16 16h6v6h-6Z',
    'M12 8v4M5 16v-2a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2',
  ],
  contact: [
    'M4 4h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z',
    'M16 2v2M8 2v2',
    'M12 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
    'M8 17a4 4 0 0 1 8 0',
  ],
  calendar: [
    'M3 6h18v16H3Z',
    'M8 2v4M16 2v4M3 10h18',
    'M8 14h.01M12 14h.01M16 14h.01',
    'M8 18h.01M12 18h.01M16 18h.01',
  ],
  clock: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z', 'M12 6v6l4 2', '', ''],
  banknote: ['M2 6h20v12H2Z', 'M14 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z', 'M6 12h.01M18 12h.01', ''],
  thermo: ['M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0Z', '', '', ''],
  ph: ['M4 20h16', 'M6 16V9a3 3 0 0 1 6 0v7M14 16v-4a2 2 0 0 1 4 0v4', '', ''],
  report: [
    'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z',
    'M14 2v6h6',
    'M8 13h8M8 17h5',
    '',
  ],
  repeat2: [
    'm17 2 4 4-4 4',
    'M3 11V9a4 4 0 0 1 4-4h14',
    'm7 22-4-4 4-4',
    'M21 13v2a4 4 0 0 1-4 4H3',
  ],
  alert: [
    'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z',
    'M12 9v4M12 17h.01',
    '',
    '',
  ],
  expand: [
    'M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4',
    'm4 4 5 5M20 4l-5 5M4 20l5-5M20 20l-5-5',
    '',
    '',
  ],
  user: ['M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2', 'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z', '', ''],
};

/** Legacy Sidebar icon-name aliases so existing nav data renders unchanged. */
const ICON_ALIASES: Record<string, string> = {
  dashboard: 'gauge',
  message: 'chat',
  messages: 'comms',
  settings: 'sliders',
  security: 'shield',
  activity: 'pulse',
  farm: 'waves',
  sensor: 'signal',
  tenants: 'building',
  analytics: 'linechart',
  reports: 'report',
  support: 'lifebuoy',
  system: 'sliders',
  audit: 'scroll',
  sprout: 'wheat',
  cpu: 'chip',
  'bar-chart': 'bars',
  'calendar-off': 'calendar',
  'graduation-cap': 'contact',
  monitor: 'expand',
  server: 'chip',
};

const resolveIconPaths = (name?: string): readonly [string, string, string, string] | null => {
  if (!name) return null;
  const key = ICON_PATHS[name] ? name : ICON_ALIASES[name];
  return key ? ICON_PATHS[key] : null;
};

const RailIcon: React.FC<{ icon?: string; size?: number; active?: boolean; child?: boolean }> = ({
  icon,
  size = 18,
  active,
  child,
}) => {
  const paths = resolveIconPaths(icon);
  if (!paths) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`sd-rail-icon${active ? ' sd-rail-icon--active' : ''}${child ? ' sd-rail-icon--child' : ''}`}
    >
      {paths.map((d, i) => (d ? <path key={i} d={d} /> : null))}
    </svg>
  );
};

interface RailItemProps {
  item: NavigationItem;
  depth?: number;
  open: boolean;
  activePath?: string;
  expanded: boolean;
  onToggleGroup: (id: string, defaultOpen: boolean) => void;
  onNavigate: (path: string) => void;
  userRoles: UserRole[];
}

const RailItem: React.FC<RailItemProps> = ({
  item,
  open,
  activePath,
  expanded,
  onToggleGroup,
  onNavigate,
  userRoles,
}) => {
  const hasChildren = !!item.children?.length;
  const childItems = item.children ?? [];

  const hasAccess =
    !item.requiredRoles?.length || item.requiredRoles.some((role) => userRoles.includes(role));

  const pathMatches = (path?: string): boolean => {
    if (!path || !activePath) return false;
    if (path === activePath) return true;
    return hasChildren && activePath.startsWith(path + '/');
  };

  const isActive = pathMatches(item.path);
  const childActive = childItems.some((child) => child.path === activePath) || false;
  const on = isActive || childActive;

  const handleClick = useCallback(() => {
    if (hasChildren) {
      onToggleGroup(item.id, childActive);
    } else if (item.path) {
      if (item.isExternal) {
        window.open(item.path, '_blank', 'noopener,noreferrer');
      } else {
        onNavigate(item.path);
      }
    }
  }, [hasChildren, onToggleGroup, item.id, item.path, item.isExternal, childActive, onNavigate]);

  if (!hasAccess) return null;

  return (
    <div className="sd-rail-itemwrap">
      <button
        type="button"
        onClick={handleClick}
        title={open ? item.label : item.label}
        aria-current={isActive ? 'page' : undefined}
        aria-expanded={hasChildren ? expanded : undefined}
        className={`sd-rail-item${on ? ' sd-rail-item--active' : ''}`}
      >
        <span className="sd-rail-item-main">
          <RailIcon icon={item.icon} active={on} />
          {open && <span className="sd-rail-item-label">{item.label}</span>}
        </span>
        {open && item.badge !== undefined && <span className="sd-rail-meta">{item.badge}</span>}
        {open && item.badge === undefined && hasChildren && (
          <span className="sd-rail-toggle" aria-hidden="true">
            {expanded ? '–' : '+'}
          </span>
        )}
      </button>

      {hasChildren && expanded && open && (
        <div className="sd-rail-children">
          {childItems.map((child) => (
            <RailChild
              key={child.id}
              item={child}
              activePath={activePath}
              onNavigate={onNavigate}
              userRoles={userRoles}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const RailChild: React.FC<{
  item: NavigationItem;
  activePath?: string;
  onNavigate: (path: string) => void;
  userRoles: UserRole[];
}> = ({ item, activePath, onNavigate, userRoles }) => {
  const hasAccess =
    !item.requiredRoles?.length || item.requiredRoles.some((role) => userRoles.includes(role));
  if (!hasAccess) return null;
  const isActive = !!item.path && item.path === activePath;
  return (
    <button
      type="button"
      onClick={() => item.path && onNavigate(item.path)}
      title={item.label}
      aria-current={isActive ? 'page' : undefined}
      className={`sd-rail-child${isActive ? ' sd-rail-child--active' : ''}`}
    >
      <RailIcon icon={item.icon} size={15} active={isActive} child />
      <span className="sd-rail-child-label">{item.label}</span>
    </button>
  );
};

export const SuderraSidebar: React.FC<SuderraSidebarProps> = ({
  sections,
  activePath,
  onNavigate,
  userRoles = [],
  brandName,
  brandSub,
  logoSrc = '/logo4-mark.png',
  statusText,
  footer,
  className = '',
}) => {
  const [pinned, setPinned] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const open = pinned || hovering;

  const isGroupOpen = useCallback(
    (item: NavigationItem): boolean => {
      if (expandedGroups[item.id] !== undefined) return expandedGroups[item.id];
      return !!item.children?.some((child) => child.path === activePath);
    },
    [expandedGroups, activePath],
  );

  const handleToggleGroup = useCallback((id: string, defaultOpen: boolean) => {
    setExpandedGroups((prev) => ({
      ...prev,
      [id]: !(prev[id] !== undefined ? prev[id] : defaultOpen),
    }));
  }, []);

  const visibleSections = useMemo(
    () =>
      sections
        .map((section) => ({ ...section, items: section.items.filter(Boolean) }))
        .filter((section) => section.items.length > 0),
    [sections],
  );

  return (
    <aside
      aria-label="Main navigation"
      data-open={open ? 'true' : 'false'}
      className={`sd-rail${className ? ` ${className}` : ''}`}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <div className="sd-rail-drawer">
        <div className="sd-rail-header">
          <span className="sd-rail-logo">
            <img src={logoSrc} alt="" />
          </span>
          {open ? (
            <>
              <span className="sd-rail-brand">
                <span className="sd-rail-brand-name">{brandName}</span>
                {brandSub && <span className="sd-rail-brand-sub">{brandSub}</span>}
              </span>
              <button
                type="button"
                onClick={() => setPinned((p) => !p)}
                title={pinned ? 'Unpin sidebar' : 'Keep sidebar open'}
                aria-label={pinned ? 'Unpin sidebar' : 'Keep sidebar open'}
                aria-pressed={pinned}
                className={`sd-rail-pin${pinned ? ' sd-rail-pin--pinned' : ''}`}
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.8}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M9 4v6l-2 4v2h10v-2l-2-4V4" />
                  <path d="M12 16v5" />
                  <path d="M8 4h8" />
                </svg>
              </button>
            </>
          ) : null}
        </div>

        <nav className="sd-rail-nav" aria-label={brandName}>
          {visibleSections.map((section) => (
            <div key={section.id} className="sd-rail-section">
              {open ? (
                <div className="sd-rail-section-label">{section.label}</div>
              ) : (
                <div className="sd-rail-hairline" aria-hidden="true" />
              )}
              {section.items.map((item) => (
                <RailItem
                  key={item.id}
                  item={item}
                  open={open}
                  activePath={activePath}
                  expanded={isGroupOpen(item)}
                  onToggleGroup={handleToggleGroup}
                  onNavigate={onNavigate}
                  userRoles={userRoles}
                />
              ))}
            </div>
          ))}
        </nav>

        {footer && <div className="sd-rail-footer-slot">{footer}</div>}

        <div className="sd-rail-footer">
          <span className="sd-rail-status-dot" aria-hidden="true" />
          {open && <span className="sd-rail-status-text">{statusText ?? 'Live'}</span>}
        </div>
      </div>
    </aside>
  );
};

export default SuderraSidebar;
