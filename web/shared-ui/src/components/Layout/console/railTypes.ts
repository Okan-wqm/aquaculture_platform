/**
 * Console rail model — what IndustrialRail and WorkspaceMenu render.
 *
 * WHAT: workspace → area → group → page → tab, already filtered to what the
 * viewer may see and already localized, where the reader is (`RailActive`),
 * and the badge counts. The foot band's device count is the header's
 * `ConsoleDeviceCounts` (headerTypes.ts), one shape for both.
 *
 * WHY structural: the shell builds this tree (web/shell/src/console/nav,
 * `buildConsoleNav`) from module, role and permission gates the rail must not
 * know about. The shell's built `Workspace` satisfies `RailWorkspace` as it
 * is — its extra fields (message keys, match patterns, gates) are ignored — so
 * the rail is handed the nav model directly, with no adapter to drift. The
 * workspace ids and the icon names are declared here, once, and the shell's
 * types alias them.
 */
import type { ConsoleRailIconName } from './railIcons';

/** The console workspaces in switcher order (README §5): Production, Greenhouse, Control & sensors, Company. */
export const CONSOLE_WORKSPACE_IDS = ['aqua', 'gh', 'ctl', 'org'] as const;

export type ConsoleWorkspaceId = (typeof CONSOLE_WORKSPACE_IDS)[number];

/** Level 3: one tab of a page's in-page strip. */
export interface RailTab {
  readonly id: string;
  readonly label: string;
  /** Full destination, `?tab=` included. */
  readonly path: string;
}

/** Level 2: a page entry. */
export interface RailPage {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  /** A routed "coming soon" page: listed, tagged as planned. */
  readonly status?: 'planned';
  /** The badge's data source; its count is looked up in the rail's `badgeCounts`. */
  readonly badge?: string;
  readonly tabs?: readonly RailTab[];
}

/** A titled or untitled run of pages inside an area. */
export interface RailGroup {
  readonly id: string;
  readonly label?: string;
  readonly pages: readonly RailPage[];
}

/** Level 1: an accordion row (a tile while the rail is collapsed). */
export interface RailArea {
  readonly id: string;
  readonly label: string;
  readonly icon: ConsoleRailIconName;
  readonly groups: readonly RailGroup[];
}

/** One workspace: its switcher entry and its areas. */
export interface RailWorkspace {
  readonly id: ConsoleWorkspaceId;
  readonly label: string;
  readonly description: string;
  readonly areas: readonly RailArea[];
}

/** The entry the current location lights, as the shell's `findActivePage` resolves it. */
export interface RailActive {
  readonly areaId: string;
  readonly pageId: string;
  /** The level-3 tab the location names, when it names one. */
  readonly tabId?: string;
}

/**
 * Counts per badge source (`alarmsUnack`, `leavePending`). A source with no
 * count yet — loading, failed, not for this viewer — is simply absent, and
 * its badge is not drawn: a badge never shows a number nobody measured.
 */
export type RailBadgeCounts = Readonly<Partial<Record<string, number>>>;

/** One row of the workspace menu. */
export type WorkspaceMenuEntry = Pick<RailWorkspace, 'id' | 'label' | 'description'>;
