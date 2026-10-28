/**
 * ConsoleShell — the tenant console's frame (FE-HIGH-334; design handoff
 * "Tenant Console — Industrial", README §7, digests shell-rail / shell-header).
 *
 * WHAT, left to right: the IndustrialRail with its workspace menu, then the
 * `.sd-content` column — the `page` container every console query reads, the
 * Industry token scope, the engineering-grid ground and the workspace's motif
 * over it (suderra.css, FE-MEDIUM-348) — holding the
 * ConsoleHeader (sticky where it fits; eyebrow + h1, palette trigger, title
 * block, the layout's notifications and AI trigger, the user menu, the
 * annunciator under the row) and <main>, which fills the column, so the page
 * grows and shrinks with the window (no fixed pixel cap; the former 1520 px cap
 * of README §7.1 is gone). The routed page sits inside the WorkforceScopeProvider of the
 * followed workspace's module (Team pages list that module's people). The
 * command palette is a portal beside them. The
 * SUPER_ADMIN act-as banner is not here: this console never mounts for a
 * SUPER_ADMIN (AdminConsole renders it).
 *
 * The rail names the tenant from the session (`me` → AuthUser.tenantName),
 * which every tenant role has; TenantContext holds a tenant only while a
 * SUPER_ADMIN acts as one.
 *
 * WHY the nav decides everything: one built nav (buildConsoleNav — the
 * viewer's modules, role and capabilities; the previewed role's while an
 * admin views as one) feeds the rail, the active entry (header eyebrow, h1,
 * sheet code, how a page's own title renders, the document title and the
 * route announcement — consolePageTitle), the palette's pages, people
 * and devices, and whether the annunciator has an alarm list to open — so no
 * surface can offer what another hides. The rail follows navigation
 * (useFollowedWorkspace); choosing a workspace opens its home page.
 *
 * Real data only: counts come from the console data hooks and draw nothing
 * until ready — the workspace menu's per-module alarm counts included, read
 * from the annunciator's own request (ALERT-MEDIUM-010). The one value without
 * a source renders through MockPreview with its finding: the title block's
 * revision (FE-LOW-338).
 */
import {
  BRAND,
  Button,
  ConsoleHeader,
  IndustrialRail,
  PageTitleScope,
  TitleBlock,
  ViewAsBanner,
  WorkforceScopeProvider,
  deriveSheetCode,
  useAuth,
  useAuthContext,
  useI18n,
  usePageTitle,
  type RailBadgeCounts,
} from '@aquaculture/shared-ui';
import { Menu } from 'lucide-react';
import { useCallback, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';

// E2E-FLAKE: warms a remote's route chunk when the user hovers a rail entry,
// so the click does not land in the remote's Suspense fallback.
import { preloadRoute } from '../utils/routePreload';

import { TenantConsoleShellProvider, useConsoleShell } from './ConsoleShellContext';
import { useAlarmSummary, useDeviceStatus, useSiteStatus, type ViewAsRole } from './data';
import { TitleBlockRevision } from './header/TitleBlockRevision';
import {
  buildConsoleNav,
  findNavPage,
  workforceScopeOf,
  workspaceForPath,
  workspaceHome,
  type ConsoleNavInput,
  type ConsoleRole,
  type WorkspaceId,
} from './nav';
import { ConsolePalette } from './palette/ConsolePalette';
import { useWorkspaceAlarmsSlot } from './rail/WorkspaceAlarms';
import { resolveActiveEntry } from './shell/activeEntry';
import { ConsoleAnnunciator } from './shell/ConsoleAnnunciator';
import { consolePageTitle } from './shell/pageTitle';
import { ConsoleUserMenu } from './shell/ConsoleUserMenu';
import { useFollowedWorkspace } from './shell/useFollowedWorkspace';
import { isPathInNav, viewAsNavInput } from './shell/viewAs';

/** The rail's id — the hamburger's `aria-controls` target. */
export const CONSOLE_RAIL_ID = 'main-navigation';

export interface ConsoleShellProps {
  /** The signed-in user's role (MainLayout gives SUPER_ADMIN its own console). */
  readonly role: ConsoleRole;
  /** The layout's header tools — notifications and the AI trigger. */
  readonly headerTools: ReactNode;
  readonly onSignOut: () => void;
}

export function ConsoleShell(props: ConsoleShellProps): ReactElement {
  return (
    <TenantConsoleShellProvider>
      <ConsoleFrame {...props} />
    </TenantConsoleShellProvider>
  );
}

function ConsoleFrame({ role, headerTools, onSignOut }: ConsoleShellProps): ReactElement {
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const { modules, user } = useAuthContext();
  const { hasPermission } = useAuth();
  const shell = useConsoleShell();
  const { viewAsRole, setViewAsRole, setWs, setPaletteOpen } = shell;
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // The nav: the user's own, or the previewed role's (view only — every
  // request still carries the user's own token).
  const real = useMemo(
    (): ConsoleNavInput => ({ role, modules, hasPermission, t }),
    [role, modules, hasPermission, t],
  );
  const shown = useMemo(
    () => (viewAsRole === null ? real : viewAsNavInput(real, viewAsRole)),
    [real, viewAsRole],
  );
  const workspaces = useMemo(() => buildConsoleNav(shown), [shown]);

  const path = `${location.pathname}${location.search}`;
  const activeId = useFollowedWorkspace(path, workspaces);
  const workspace = workspaces.find((candidate) => candidate.id === activeId);
  // The module the followed workspace is built on: the HR pages routed below
  // list that module's people (Company, with no module, lists everyone).
  const workforceScope = workforceScopeOf(workspace?.module);
  const entry = useMemo(() => resolveActiveEntry(path, workspace), [path, workspace]);
  // The page's identity: the document title and the route announcement.
  usePageTitle(consolePageTitle(entry, workspace));

  const alarms = useAlarmSummary();
  const devices = useDeviceStatus();
  const sites = useSiteStatus();
  // One gate for every alarm surface: the annunciator and the workspace
  // menu's alarm column both appear only when the nav on screen lists the
  // alarm list.
  const alarmList = findNavPage(workspaces, 'alarms');
  const renderWorkspaceAlarms = useWorkspaceAlarmsSlot(alarmList !== undefined);
  const badgeCounts = useMemo(
    (): RailBadgeCounts => (alarms.status === 'ready' ? { alarmsUnack: alarms.unack } : {}),
    [alarms.status, alarms.unack],
  );

  const selectWorkspace = useCallback(
    (id: WorkspaceId): void => {
      setWs(id);
      const target = workspaces.find((candidate) => candidate.id === id);
      const home = target === undefined ? undefined : workspaceHome(target);
      if (home !== undefined) navigate(home);
    },
    [setWs, workspaces, navigate],
  );

  // A preview that cannot open the page on screen moves to the home of the
  // workspace it would show, as a holder of the role would land.
  const previewRole = useCallback(
    (picked: ViewAsRole | null): void => {
      setViewAsRole(picked);
      if (picked === null) return;
      const preview = buildConsoleNav(viewAsNavInput(real, picked));
      if (isPathInNav(path, preview)) return;
      const owner = workspaceForPath(path, preview, activeId);
      const target = preview.find((candidate) => candidate.id === owner);
      const home = target === undefined ? undefined : workspaceHome(target);
      if (home !== undefined) navigate(home);
    },
    [setViewAsRole, real, path, activeId, navigate],
  );

  // Exiting removes the banner and its button, so focus moves to the page
  // instead of falling back to the document body.
  const mainRef = useRef<HTMLElement>(null);
  const exitViewAs = useCallback((): void => {
    setViewAsRole(null);
    mainRef.current?.focus();
  }, [setViewAsRole]);

  const openPalette = useCallback(() => setPaletteOpen(true), [setPaletteOpen]);
  const sheetCode =
    entry === undefined ? null : deriveSheetCode({ areaId: entry.area.id, pageId: entry.page.id });

  return (
    <>
      <IndustrialRail
        id={CONSOLE_RAIL_ID}
        workspaces={workspaces}
        activeWorkspaceId={activeId}
        onWorkspaceSelect={selectWorkspace}
        renderWorkspaceAlarms={renderWorkspaceAlarms}
        active={entry?.rail}
        badgeCounts={badgeCounts}
        onNavigate={navigate}
        onItemHover={preloadRoute}
        tenantName={user?.tenantName ?? null}
        logoSrc={BRAND.mark}
        collapsed={shell.navCollapsed}
        onCollapsedChange={shell.setNavCollapsed}
        devices={devices}
        mobileOpen={mobileNavOpen}
        onMobileOpenChange={setMobileNavOpen}
      />

      <div className="sd-content flex min-h-screen min-w-0 flex-1 flex-col">
        <ConsoleHeader
          navToggle={
            // Phone widths only: it opens the rail's overlay (below md the rail is off-canvas).
            <Button
              variant="ghost"
              iconOnly
              onClick={() => setMobileNavOpen(true)}
              aria-label={t('header.openNavigation')}
              aria-expanded={mobileNavOpen}
              aria-controls={CONSOLE_RAIL_ID}
              className="shrink-0 md:hidden"
            >
              <Menu className="size-6" aria-hidden="true" />
            </Button>
          }
          workspaceLabel={workspace?.label ?? ''}
          areaLabel={entry?.area.label}
          title={entry?.page.label ?? workspace?.label ?? ''}
          onOpenPalette={openPalette}
          paletteOpen={shell.paletteOpen}
          titleBlock={
            <TitleBlock
              sites={sites}
              devices={devices}
              sheetCode={sheetCode}
              revision={sheetCode === null ? undefined : <TitleBlockRevision />}
            />
          }
          rightContent={headerTools}
          userMenu={<ConsoleUserMenu real={real} onViewAs={previewRole} onSignOut={onSignOut} />}
          annunciator={
            alarmList === undefined ? undefined : (
              <ConsoleAnnunciator summary={alarms} listPath={alarmList.path} />
            )
          }
        />

        <main
          ref={mainRef}
          id="main-content"
          tabIndex={-1}
          className="sd-main w-full flex-1 overflow-auto focus:outline-hidden"
        >
          {/* Always mounted: its status must be in the page before the first
              switch, or the switch is not announced (ViewAsBanner). */}
          <div className={viewAsRole === null ? undefined : 'mb-[clamp(20px,2.4cqi,36px)]'}>
            <ViewAsBanner
              roleLabel={viewAsRole === null ? null : viewAsRole.name}
              onExit={exitViewAs}
            />
          </div>
          {/* The header's h1 names the page; a PageHeader below follows (README §4). */}
          <PageTitleScope mode={entry?.titleMode ?? 'subtitle'}>
            <WorkforceScopeProvider moduleCode={workforceScope}>
              <Outlet />
            </WorkforceScopeProvider>
          </PageTitleScope>
        </main>
      </div>

      <ConsolePalette
        workspaces={workspaces}
        currentWorkspace={activeId}
        onNavigate={navigate}
        onSelectWorkspace={selectWorkspace}
      />
    </>
  );
}
