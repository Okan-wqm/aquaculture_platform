/**
 * SuderraSidebar — the tenant console rail (FE-HIGH-313).
 *
 * WHAT: the deep-water rail production ran from PR #1569's tree: a 68 px icon
 * rail that opens to 264 px (pushing the content) while hovered, while focus
 * is inside it, or while pinned; grouped sections with uppercase labels;
 * accordion groups for the module menus. Below `md` it is the same off-canvas
 * overlay as `Sidebar`, opened by the shell's hamburger.
 *
 * WHY a second component and not a Sidebar theme: the SUPER_ADMIN console and
 * the standalone layouts keep `Sidebar`'s flat list; the rail's sections, open
 * model and pin are a different structure, not a different colour. What the
 * two share — access, the active item, the phone overlay — is one module
 * (`navShared.ts`), so only the presentation is duplicated.
 *
 * The rail is deep water in both themes: it paints from the `sd-rail-*`
 * tokens, which the dark theme does not re-assign.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Banknote,
  Bell,
  Blocks,
  Building2,
  Calendar,
  ChartColumn,
  ChartLine,
  ChevronDown,
  Clock,
  Contact,
  CreditCard,
  Cpu,
  Database,
  Droplets,
  FileText,
  FlaskConical,
  Gauge,
  HardDrive,
  LifeBuoy,
  Mail,
  Maximize,
  Megaphone,
  MessageCircle,
  MessagesSquare,
  Network,
  Pin,
  ScrollText,
  ShieldCheck,
  ShoppingBasket,
  Signal,
  SlidersHorizontal,
  SquareCheckBig,
  Thermometer,
  User,
  Users,
  Warehouse,
  Waves,
  Wheat,
  Workflow,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';

import type { NavigationItem, UserRole } from '../../types';
import { useI18n } from '../../i18n';
import { canSeeNavItem, hasActiveChild, isNavItemActive, useNavOverlay } from './navShared';

/** The rail's icon vocabulary; a nav item names one in `icon`. */
export const SUDERRA_RAIL_ICONS = {
  building: Building2,
  gauge: Gauge,
  chat: MessageCircle,
  users: Users,
  shield: ShieldCheck,
  blocks: Blocks,
  comms: MessagesSquare,
  mail: Mail,
  lifebuoy: LifeBuoy,
  megaphone: Megaphone,
  drive: HardDrive,
  database: Database,
  scroll: ScrollText,
  card: CreditCard,
  pulse: Activity,
  sliders: SlidersHorizontal,
  waves: Waves,
  wrench: Wrench,
  droplet: Droplets,
  wheat: Wheat,
  warehouse: Warehouse,
  checks: SquareCheckBig,
  basket: ShoppingBasket,
  bars: ChartColumn,
  signal: Signal,
  chip: Cpu,
  linechart: ChartLine,
  bell: Bell,
  workflow: Workflow,
  network: Network,
  contact: Contact,
  calendar: Calendar,
  clock: Clock,
  banknote: Banknote,
  thermo: Thermometer,
  ph: FlaskConical,
  report: FileText,
  expand: Maximize,
  user: User,
} as const satisfies Record<string, LucideIcon>;

export type SuderraRailIconName = keyof typeof SUDERRA_RAIL_ICONS;

function isRailIconName(name: string): name is SuderraRailIconName {
  return Object.prototype.hasOwnProperty.call(SUDERRA_RAIL_ICONS, name);
}

export interface SuderraNavSection {
  id: string;
  /** Section heading, shown while the rail is open and announced as the group's name */
  label: string;
  items: NavigationItem[];
}

export interface SuderraSidebarProps {
  sections: SuderraNavSection[];
  /** Active path: highlights the item and opens its group */
  activePath?: string;
  onNavigate: (path: string) => void;
  /** Roles for `requiredRoles` checks */
  userRoles?: UserRole[];
  /** Workspace name beside the logo mark */
  brandName: string;
  /** Caption under the workspace name */
  brandSub?: string;
  /** Logo mark, drawn on a light tile */
  logoSrc: string;
  /** Phone overlay open state — the same contract as `Sidebar` */
  mobileOpen: boolean;
  onMobileOpenChange: (open: boolean) => void;
  /** `id` of the aside, the target of the opener's `aria-controls` */
  id?: string;
  className?: string;
}

const RailIcon: React.FC<{ name?: string; size: number; className: string }> = ({
  name,
  size,
  className,
}) => {
  if (!name || !isRailIconName(name)) return null;
  const Icon = SUDERRA_RAIL_ICONS[name];
  return <Icon size={size} strokeWidth={1.7} aria-hidden="true" className={className} />;
};

interface RailItemProps {
  item: NavigationItem;
  open: boolean;
  expanded: boolean;
  activePath?: string;
  userRoles: UserRole[];
  onToggleGroup: (id: string, openNow: boolean) => void;
  onNavigate: (path: string) => void;
}

const RailItem: React.FC<RailItemProps> = ({
  item,
  open,
  expanded,
  activePath,
  userRoles,
  onToggleGroup,
  onNavigate,
}) => {
  const children = (item.children ?? []).filter((child) => canSeeNavItem(child, userRoles));
  const isGroup = children.length > 0;
  const isActive = isNavItemActive(item, activePath);
  const lit = isActive || hasActiveChild(item, activePath);

  const handleClick = useCallback(() => {
    if (isGroup) {
      onToggleGroup(item.id, !expanded);
    } else if (item.path) {
      if (item.isExternal) {
        window.open(item.path, '_blank', 'noopener,noreferrer');
      } else {
        onNavigate(item.path);
      }
    }
  }, [isGroup, onToggleGroup, item.id, item.path, item.isExternal, expanded, onNavigate]);

  if (!canSeeNavItem(item, userRoles)) return null;

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        aria-current={isActive ? 'page' : undefined}
        aria-expanded={isGroup ? expanded : undefined}
        className={`flex w-full items-center gap-2 rounded-[9px] px-[11px] py-[9px] text-left text-sm transition-colors focus-visible:ring-sd-mint focus-visible:ring-offset-sd-rail-mid ${
          open ? 'justify-between' : 'justify-center'
        } ${
          lit
            ? 'bg-sd-mint/15 font-semibold text-sd-mint-soft'
            : 'font-medium text-sd-rail-item hover:bg-sd-rail-bright/10'
        }`}
      >
        <span className="flex min-w-0 items-center gap-3">
          <RailIcon
            name={item.icon}
            size={18}
            className={`shrink-0 ${lit ? 'text-sd-mint' : 'text-sd-rail-icon'}`}
          />
          <span className={open ? 'truncate' : 'sr-only'}>{item.label}</span>
        </span>
        {open && item.badge !== undefined && (
          <span className="shrink-0 rounded-full border border-sd-mint/25 bg-sd-mint/15 px-2 text-xs font-semibold text-sd-mint-soft">
            {item.badge}
          </span>
        )}
        {open && item.badge === undefined && isGroup && (
          <ChevronDown
            size={15}
            aria-hidden="true"
            className={`shrink-0 text-sd-rail-icon transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
        )}
      </button>

      {isGroup && expanded && open && (
        <div className="mb-[7px] ml-4 mt-[3px] flex flex-col gap-0.5 border-l border-sd-rail-bright/10 pl-3.5">
          {children.map((child) => {
            const childActive = !!child.path && child.path === activePath;
            return (
              <button
                key={child.id}
                type="button"
                onClick={() => child.path && onNavigate(child.path)}
                aria-current={childActive ? 'page' : undefined}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left text-[13.5px] transition-colors focus-visible:ring-sd-mint focus-visible:ring-offset-sd-rail-mid ${
                  childActive
                    ? 'bg-sd-mint/12 font-semibold text-sd-mint-soft'
                    : 'text-sd-rail-child hover:bg-sd-rail-bright/10 hover:text-sd-rail-bright'
                }`}
              >
                <RailIcon
                  name={child.icon}
                  size={15}
                  className={`shrink-0 ${childActive ? 'text-sd-mint' : 'text-sd-rail-child-icon'}`}
                />
                <span className="truncate">{child.label}</span>
              </button>
            );
          })}
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
  logoSrc,
  mobileOpen,
  onMobileOpenChange,
  id,
  className = '',
}) => {
  const { t } = useI18n();
  const asideRef = useRef<HTMLElement>(null);
  const [pinned, setPinned] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  // Focus that a pointer press caused must not hold the rail open after the
  // pointer leaves; only keyboard focus does (what :focus-visible means).
  const pointerPressed = useRef(false);
  // A group's explicit choice; otherwise it is open while one of its children is the page.
  const [groupChoice, setGroupChoice] = useState<Record<string, boolean>>({});

  const { closeOverlay, handleNavigate } = useNavOverlay({
    mobileOpen,
    onMobileOpenChange,
    onNavigate,
    containerRef: asideRef,
  });

  // The overlay always shows labels; the desktop rail opens on hover, focus or pin.
  const open = mobileOpen || pinned || hovering || focusInside;

  const handleToggleGroup = useCallback((groupId: string, openNow: boolean) => {
    setGroupChoice((prev) => ({ ...prev, [groupId]: openNow }));
  }, []);

  // Focus moves on press, before release, so the press flag is cleared on
  // release — anywhere in the document (a press that ends outside the rail) and
  // on pointercancel (a touch that turned into a scroll) — or a press that moved
  // no focus would swallow the next keyboard focus.
  useEffect(() => {
    const release = (): void => {
      pointerPressed.current = false;
    };
    document.addEventListener('pointerup', release);
    document.addEventListener('pointercancel', release);
    return () => {
      document.removeEventListener('pointerup', release);
      document.removeEventListener('pointercancel', release);
    };
  }, []);

  const handleFocus = useCallback(() => {
    if (!pointerPressed.current) setFocusInside(true);
  }, []);

  const handleBlur = useCallback((event: React.FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !event.currentTarget.contains(next)) setFocusInside(false);
  }, []);

  const visibleSections = useMemo(
    () =>
      sections
        .map((section) => ({
          ...section,
          items: section.items.filter((item) => canSeeNavItem(item, userRoles)),
        }))
        .filter((section) => section.items.length > 0),
    [sections, userRoles],
  );

  const placement = mobileOpen
    ? 'flex fixed inset-y-0 left-0 z-50 w-[264px] md:static md:inset-auto md:z-auto'
    : `hidden md:flex ${open ? 'md:w-[264px]' : 'md:w-[68px]'}`;

  return (
    <>
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-sd-rail-bottom/60 md:hidden"
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
        data-open={open ? 'true' : 'false'}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        onPointerDown={() => {
          pointerPressed.current = true;
        }}
        onFocus={handleFocus}
        onBlur={handleBlur}
        className={`shrink-0 flex-col transition-[width] duration-200 ease-out motion-reduce:transition-none focus:outline-hidden ${placement} ${className}`}
      >
        <div className="sticky top-0 flex h-screen w-full flex-col overflow-hidden border-r border-sd-rail-bright/10 bg-linear-to-b from-sd-rail-top via-sd-rail-mid to-sd-rail-bottom">
          <div className="flex h-16 shrink-0 items-center gap-3 border-b border-sd-rail-bright/10 px-4">
            <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-sd-rail-bright shadow-sm">
              <img src={logoSrc} alt="" className="size-7 object-contain" />
            </span>
            <span className={open ? 'flex min-w-0 flex-1 flex-col leading-none' : 'sr-only'}>
              <span className="truncate text-[15px] font-semibold text-sd-rail-bright">
                {brandName}
              </span>
              {brandSub && (
                <span className="mt-1 truncate text-xs font-medium text-sd-rail-accent">
                  {brandSub}
                </span>
              )}
            </span>
            {open && (
              <>
                <button
                  type="button"
                  onClick={() => setPinned((value) => !value)}
                  aria-pressed={pinned}
                  aria-label={pinned ? t('sidebar.unpin') : t('sidebar.keepOpen')}
                  title={pinned ? t('sidebar.unpin') : t('sidebar.keepOpen')}
                  className={`hidden shrink-0 rounded-[7px] p-1.5 transition md:flex focus-visible:ring-sd-mint focus-visible:ring-offset-sd-rail-mid ${
                    pinned ? 'bg-sd-mint/15 text-sd-mint' : 'rotate-[35deg] text-sd-rail-icon'
                  }`}
                >
                  <Pin size={15} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={closeOverlay}
                  aria-label={t('header.closeNavigation')}
                  className="shrink-0 rounded-[7px] p-1.5 text-sd-rail-icon md:hidden"
                >
                  <X size={18} aria-hidden="true" />
                </button>
              </>
            )}
          </div>

          <nav className="flex-1 overflow-y-auto overflow-x-hidden px-3 pb-3 pt-3.5">
            {visibleSections.map((section) => (
              <div key={section.id} role="group" aria-label={section.label} className="mb-[18px]">
                {open ? (
                  <div
                    aria-hidden="true"
                    className="whitespace-nowrap px-2 pb-[9px] text-xs font-semibold uppercase tracking-[0.1em] text-sd-rail-child"
                  >
                    {section.label}
                  </div>
                ) : (
                  <div aria-hidden="true" className="mx-1.5 mb-[11px] h-px bg-sd-rail-bright/10" />
                )}
                {section.items.map((item) => (
                  <RailItem
                    key={item.id}
                    item={item}
                    open={open}
                    expanded={groupChoice[item.id] ?? hasActiveChild(item, activePath)}
                    activePath={activePath}
                    userRoles={userRoles}
                    onToggleGroup={handleToggleGroup}
                    onNavigate={handleNavigate}
                  />
                ))}
              </div>
            ))}
          </nav>
        </div>
      </aside>
    </>
  );
};

export default SuderraSidebar;
