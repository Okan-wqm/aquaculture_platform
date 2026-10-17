/**
 * IndustrialRail — the tenant console rail in the Industry language (design
 * handoff §7.2, §8; digest shell-rail.md).
 *
 * WHAT: a full-height sticky column under a 4 px accent line — the header
 * (logo plate and workspace name, opening the workspace menu), the active
 * workspace's navigation, and a device band at the foot. 296 px it is a
 * labelled accordion (area → group → page → the current page's tabs); 110 px
 * it is a column of icon tiles. Below `md` it is the off-canvas overlay the
 * shell's hamburger opens, always labelled.
 *
 * Semantics: the whole rail — header, workspace navigation and device band —
 * is one navigation landmark, "Main navigation"; as the phone overlay it is a
 * modal dialog of that name instead (navShared's `landmarkProps`). The area
 * list inside is not a second landmark: the header already names the
 * workspace it lists.
 *
 * WHY presentational: what the viewer may see (modules, role, permissions),
 * where they are (route → entry), the badge and device counts, and the
 * collapse preference are the shell's (buildConsoleNav, findActivePage, the
 * console data hooks, tenant-scoped storage). The rail draws them and reports
 * intent — navigate, hover, switch workspace, collapse — so it carries no
 * fetch, no route knowledge and no persistence of its own. What it shares with
 * Sidebar (the phone overlay) comes from navShared.ts.
 *
 * Colour: the rail sits beside the `.sd-content` column, outside its scope,
 * so it paints from the `sd-*` tokens directly — they follow the theme and
 * the workspace (`data-ws` on <html>/<body>).
 */
import { useCallback, useEffect, useRef, type ReactElement, type ReactNode } from 'react';

import { useI18n } from '../../../i18n';
import { useNavOverlay } from '../navShared';

import { RailAreaList } from './RailAreaList';
import { RailAreaTiles } from './RailAreaTiles';
import { RailDeviceBand } from './RailDeviceBand';
import { RailHeader } from './RailHeader';
import type { ConsoleDeviceCounts } from './headerTypes';
import type { ConsoleWorkspaceId, RailActive, RailBadgeCounts, RailWorkspace } from './railTypes';
import { useAreaDisclosure } from './useAreaDisclosure';
import { useRailCollapsed } from './useRailCollapsed';

export interface IndustrialRailProps {
  /** The workspaces the viewer may use, in switcher order, built and localized by the shell. */
  readonly workspaces: readonly RailWorkspace[];
  readonly activeWorkspaceId: ConsoleWorkspaceId | undefined;
  readonly onWorkspaceSelect: (id: ConsoleWorkspaceId) => void;
  /** A workspace's alarm counts in the menu (the shell's preview of ALERT-MEDIUM-010 today). */
  readonly renderWorkspaceAlarms?: (id: ConsoleWorkspaceId) => ReactNode;
  /** The entry the current location lights; none on a page outside the nav. */
  readonly active?: RailActive;
  /** Counts per badge source; an absent source draws no badge. */
  readonly badgeCounts?: RailBadgeCounts;
  readonly onNavigate: (path: string) => void;
  /** Pointer entered a link, with its destination — the shell preloads the route chunk. */
  readonly onItemHover?: (path: string) => void;
  /** The session's tenant name; null while the session names none (no tenant line is drawn). */
  readonly tenantName: string | null;
  readonly logoSrc: string;
  /** The reader's choice; null leaves it to the window (collapsed below 1100 px). */
  readonly collapsed: boolean | null;
  readonly onCollapsedChange: (collapsed: boolean) => void;
  /** The foot band's device count; anything but `ready` hides the band. */
  readonly devices?: ConsoleDeviceCounts;
  /** Phone overlay open state — the same contract as Sidebar. */
  readonly mobileOpen: boolean;
  readonly onMobileOpenChange: (open: boolean) => void;
  /** `id` of the rail, the target of the hamburger's `aria-controls`. */
  readonly id?: string;
}

const NO_BADGES: RailBadgeCounts = {};

/** The control to focus once the layout has switched, by its data attribute. */
interface FocusTarget {
  readonly attribute: 'data-rail-focus' | 'data-rail-area';
  readonly value: string;
}

export function IndustrialRail({
  workspaces,
  activeWorkspaceId,
  onWorkspaceSelect,
  renderWorkspaceAlarms,
  active,
  badgeCounts = NO_BADGES,
  onNavigate,
  onItemHover,
  tenantName,
  logoSrc,
  collapsed: preference,
  onCollapsedChange,
  devices,
  mobileOpen,
  onMobileOpenChange,
  id,
}: IndustrialRailProps): ReactElement {
  const { t } = useI18n();
  const railRef = useRef<HTMLDivElement>(null);
  const { closeOverlay, handleNavigate, landmarkProps } = useNavOverlay({
    mobileOpen,
    onMobileOpenChange,
    onNavigate,
    containerRef: railRef,
  });

  const workspace = workspaces.find((candidate) => candidate.id === activeWorkspaceId);
  const disclosure = useAreaDisclosure(
    activeWorkspaceId,
    active === undefined ? undefined : active.areaId,
  );
  // The overlay always shows labels: on a phone there is no column to keep narrow.
  const collapsed = useRailCollapsed(preference) && !mobileOpen;

  // A layout switch replaces the control that had focus (the tile, the
  // collapse or expand button); the reader lands on its counterpart instead
  // of on <body>. The target is named by its data attribute's value.
  const focusAfterSwitch = useRef<FocusTarget | null>(null);
  useEffect(() => {
    const target = focusAfterSwitch.current;
    focusAfterSwitch.current = null;
    const rail = railRef.current;
    if (target === null || rail === null) return;
    const element = [...rail.querySelectorAll<HTMLElement>(`[${target.attribute}]`)].find(
      (candidate) => candidate.getAttribute(target.attribute) === target.value,
    );
    if (element !== undefined) element.focus();
  }, [collapsed]);

  const collapse = useCallback(() => {
    focusAfterSwitch.current = { attribute: 'data-rail-focus', value: 'expand' };
    onCollapsedChange(true);
  }, [onCollapsedChange]);
  const expand = useCallback(() => {
    focusAfterSwitch.current = { attribute: 'data-rail-focus', value: 'collapse' };
    onCollapsedChange(false);
  }, [onCollapsedChange]);
  const { open: openArea } = disclosure;
  const expandArea = useCallback(
    (areaId: string) => {
      focusAfterSwitch.current = { attribute: 'data-rail-area', value: areaId };
      openArea(areaId);
      onCollapsedChange(false);
    },
    [openArea, onCollapsedChange],
  );

  const placement = mobileOpen
    ? 'flex fixed inset-y-0 left-0 z-50 w-[296px] max-w-[calc(100vw-3rem)] md:static md:inset-auto md:z-auto'
    : `hidden md:sticky md:top-0 md:z-40 md:flex md:h-screen ${collapsed ? 'md:w-[110px]' : 'md:w-[296px]'}`;

  return (
    <>
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-sd-scrim/60 md:hidden"
          onClick={closeOverlay}
          aria-hidden="true"
          data-testid="sidebar-backdrop"
        />
      )}
      <div
        ref={railRef}
        id={id}
        tabIndex={-1}
        {...landmarkProps}
        aria-label={t('sidebar.mainNavigation')}
        data-collapsed={collapsed ? 'true' : 'false'}
        className={`shrink-0 flex-col border-r border-sd-rule bg-sd-parchment font-body-sd text-sd-ink shadow-[inset_0_4px_0_var(--color-sd-accent)] tabular-nums transition-[width] duration-200 ease-out focus:outline-hidden motion-reduce:transition-none print:hidden ${placement}`}
      >
        <RailHeader
          tenantName={tenantName}
          logoSrc={logoSrc}
          workspaces={workspaces}
          activeWorkspace={workspace}
          onWorkspaceSelect={onWorkspaceSelect}
          renderWorkspaceAlarms={renderWorkspaceAlarms}
          collapsed={collapsed}
          overlay={mobileOpen}
          onCollapse={collapse}
          onCloseOverlay={closeOverlay}
        />
        <div
          className={`flex flex-1 flex-col overflow-y-auto overflow-x-hidden ${
            collapsed ? 'py-2.5' : 'px-2.5 pb-5 pt-2.5'
          }`}
        >
          {workspace !== undefined &&
            (collapsed ? (
              <RailAreaTiles
                areas={workspace.areas}
                active={active}
                badgeCounts={badgeCounts}
                onExpandArea={expandArea}
                onExpand={expand}
              />
            ) : (
              <RailAreaList
                areas={workspace.areas}
                disclosure={disclosure}
                navigation={{ active, badgeCounts, onNavigate: handleNavigate, onItemHover }}
              />
            ))}
        </div>
        <RailDeviceBand devices={devices} collapsed={collapsed} />
      </div>
    </>
  );
}
