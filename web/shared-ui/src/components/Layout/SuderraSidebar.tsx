/**
 * SuderraSidebar — the SUDERRA tenant-console rail.
 *
 * WHAT: a dark deep-water rail that hover-expands in place (68px icon rail →
 * 264px drawer, the width transition pushing the content), grouped sections
 * with uppercase labels, accordion module children and a live-status footer.
 * Open = pinned || hovering; the pin in the header keeps it open.
 *
 * WHY a second component rather than a mode on `Sidebar`: `Sidebar` is the SSoT
 * chrome for the admin panel and the standalone layouts, which are not on this
 * design. Forking the PRESENTATION lets the tenant console move without
 * touching them.
 *
 * What is NOT forked, and this is the point: the icon vocabulary and the
 * primitives. The design-mockup version of this file carried its own registry
 * of 42 icons as hand-transcribed SVG path data, its own `<button>` with a
 * hand-painted `aria-pressed`, and its labels as English literals. Each of
 * those is a thing the design system already owns, and each has a ratchet
 * counting how much of it is left in `web/` — so a 1:1 port would have raised
 * three of them to bring a component in. Icons come from `navIcons.ts` (shared
 * with `Sidebar`), the pin is a `ToggleButton` (FE-HIGH-159, so its state is
 * announced rather than only painted), and every visible string goes through
 * `t()` (FE-HIGH-089). Styles are the `sd-rail-*` classes, whose colours are
 * `--color-sd-*` theme tokens rather than the mockup's raw hex.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Pin, X } from 'lucide-react';

import type { NavigationItem, UserRole } from '../../types';
import { useI18n } from '../../i18n';
import { Button } from '../Button';
import { ToggleButton } from '../ToggleButton';
import { useDialogBehavior } from '../Modal/useDialogBehavior';

import { DESKTOP_MEDIA_QUERY, resolveNavIcon } from './navIcons';

export interface SuderraNavSection {
  id: string;
  label: string;
  items: NavigationItem[];
}

export interface SuderraSidebarProps {
  /** Grouped navigation (section labels render only while expanded). */
  sections: SuderraNavSection[];
  /** Active path used to highlight items and auto-open their parent group. */
  activePath?: string;
  /** Navigation handler (router push). */
  onNavigate: (path: string) => void;
  /** User roles for `requiredRoles` access checks. */
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
  /**
   * Phone-width overlay state, driven by the shell's hamburger — the same
   * contract `Sidebar` takes (FE-HIGH-088).
   *
   * The rail expands on HOVER, and a touch screen has no hover: left as a
   * desktop-only component it would strand a tenant on a phone with a 68px
   * icon strip and no way to open it, which is the exact defect FE-HIGH-088
   * fixed for the other nav. So below `md` the rail is an overlay instead: a
   * full-width drawer, always expanded, over a backdrop.
   */
  mobileOpen?: boolean;
  onMobileOpenChange?: (open: boolean) => void;
  className?: string;
}

/** Sizes the shared nav icon for the rail and applies its state classes. */
const RailIcon: React.FC<{
  icon?: string;
  size?: number;
  active?: boolean;
  child?: boolean;
}> = ({ icon, size = 18, active, child }) => {
  const Icon = resolveNavIcon(icon);
  if (!Icon) return null;
  return (
    <Icon
      size={size}
      strokeWidth={1.7}
      aria-hidden="true"
      className={`sd-rail-icon${active ? ' sd-rail-icon--active' : ''}${child ? ' sd-rail-icon--child' : ''}`}
    />
  );
};

const hasAccessTo = (item: NavigationItem, userRoles: UserRole[]): boolean =>
  !item.requiredRoles?.length || item.requiredRoles.some((role) => userRoles.includes(role));

const RailChild: React.FC<{
  item: NavigationItem;
  activePath?: string;
  onNavigate: (path: string) => void;
  userRoles: UserRole[];
}> = ({ item, activePath, onNavigate, userRoles }) => {
  const handleClick = useCallback(() => {
    if (item.path) onNavigate(item.path);
  }, [item.path, onNavigate]);

  if (!hasAccessTo(item, userRoles)) return null;
  const isActive = !!item.path && item.path === activePath;

  return (
    <button
      type="button"
      onClick={handleClick}
      title={item.label}
      aria-current={isActive ? 'page' : undefined}
      className={`sd-rail-child${isActive ? ' sd-rail-child--active' : ''}`}
    >
      <RailIcon icon={item.icon} size={15} active={isActive} child />
      <span className="sd-rail-child-label">{item.label}</span>
    </button>
  );
};

interface RailItemProps {
  item: NavigationItem;
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
  const { t } = useI18n();
  const childItems = item.children ?? [];
  const hasChildren = childItems.length > 0;

  const isActive = ((): boolean => {
    if (!item.path || !activePath) return false;
    if (item.path === activePath) return true;
    return hasChildren && activePath.startsWith(`${item.path}/`);
  })();
  const childActive = childItems.some((child) => child.path === activePath);
  const on = isActive || childActive;

  const handleClick = useCallback(() => {
    if (hasChildren) {
      onToggleGroup(item.id, childActive);
      return;
    }
    if (!item.path) return;
    if (item.isExternal) {
      window.open(item.path, '_blank', 'noopener,noreferrer');
    } else {
      onNavigate(item.path);
    }
  }, [hasChildren, onToggleGroup, item.id, item.path, item.isExternal, childActive, onNavigate]);

  if (!hasAccessTo(item, userRoles)) return null;

  return (
    <div className="sd-rail-itemwrap">
      <button
        type="button"
        onClick={handleClick}
        title={item.label}
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
          <span className="sd-rail-toggle">
            {expanded ? (
              <ChevronDown size={14} aria-label={t('sidebar.collapseGroup')} />
            ) : (
              <ChevronRight size={14} aria-label={t('sidebar.expandGroup')} />
            )}
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
  mobileOpen = false,
  onMobileOpenChange,
  className = '',
}) => {
  const { t } = useI18n();
  const asideRef = useRef<HTMLElement>(null);
  const [pinned, setPinned] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  // The overlay always shows labels: it is not a rail, and hover cannot open it.
  const open = mobileOpen || pinned || hovering;

  const closeOverlay = useCallback(() => onMobileOpenChange?.(false), [onMobileOpenChange]);

  // Escape, focus into the panel, focus back to the opener and the body scroll
  // lock come from the hook Modal, Drawer and Sidebar share.
  useDialogBehavior({
    isOpen: mobileOpen,
    onClose: closeOverlay,
    closeOnEscape: true,
    containerRef: asideRef,
  });

  // Past `md` the in-flow rail is on screen again, so an open overlay would
  // show the navigation twice; it closes itself on that crossing.
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

  // Choosing a destination closes the overlay; the desktop rail stays put.
  const handleNavigate = useCallback(
    (path: string) => {
      onNavigate(path);
      if (mobileOpen) closeOverlay();
    },
    [onNavigate, mobileOpen, closeOverlay],
  );

  const isGroupOpen = useCallback(
    (item: NavigationItem): boolean =>
      expandedGroups[item.id] ?? !!item.children?.some((child) => child.path === activePath),
    [expandedGroups, activePath],
  );

  const handleToggleGroup = useCallback((id: string, defaultOpen: boolean) => {
    setExpandedGroups((prev) => ({ ...prev, [id]: !(prev[id] ?? defaultOpen) }));
  }, []);

  const visibleSections = useMemo(
    () => sections.filter((section) => section.items.length > 0),
    [sections],
  );

  const pinLabel = pinned ? t('sidebar.unpin') : t('sidebar.pin');

  return (
    <>
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={closeOverlay}
          aria-hidden="true"
          data-testid="suderra-rail-backdrop"
        />
      )}
      <aside
        ref={asideRef}
        tabIndex={-1}
        aria-label={t('sidebar.mainNavigation')}
        data-open={open ? 'true' : 'false'}
        data-overlay={mobileOpen ? 'true' : 'false'}
        className={`sd-rail${mobileOpen ? ' sd-rail--overlay' : ''}${className ? ` ${className}` : ''}`}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        <div className="sd-rail-drawer">
          <div className="sd-rail-header">
            <span className="sd-rail-logo">
              <img src={logoSrc} alt="" />
            </span>
            {open && (
              <>
                <span className="sd-rail-brand">
                  <span className="sd-rail-brand-name">{brandName}</span>
                  {brandSub && <span className="sd-rail-brand-sub">{brandSub}</span>}
                </span>
                {mobileOpen ? (
                  // The overlay cannot be pinned — it is not a rail — so the
                  // header slot carries the thing it does need: a way out that
                  // is not the backdrop.
                  <Button
                    variant="ghost"
                    size="xs"
                    type="button"
                    onClick={closeOverlay}
                    aria-label={t('sidebar.collapse')}
                    className="sd-rail-pin"
                  >
                    <X size={15} strokeWidth={1.8} aria-hidden="true" />
                  </Button>
                ) : (
                  <ToggleButton
                    pressed={pinned}
                    onPressedChange={setPinned}
                    title={pinLabel}
                    aria-label={pinLabel}
                    className="sd-rail-pin"
                    pressedClassName="sd-rail-pin--pinned"
                  >
                    <Pin size={15} strokeWidth={1.8} aria-hidden="true" />
                  </ToggleButton>
                )}
              </>
            )}
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
                    onNavigate={handleNavigate}
                    userRoles={userRoles}
                  />
                ))}
              </div>
            ))}
          </nav>

          {footer && <div className="sd-rail-footer-slot">{footer}</div>}

          <div className="sd-rail-footer">
            <span className="sd-rail-status-dot" aria-hidden="true" />
            {open && (
              <span className="sd-rail-status-text">{statusText ?? t('sidebar.statusLive')}</span>
            )}
          </div>
        </div>
      </aside>
    </>
  );
};

export default SuderraSidebar;
