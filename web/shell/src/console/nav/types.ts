/**
 * Tenant console navigation model — the types (FE-HIGH-335).
 *
 * The console rail is a workspace switcher (Production, Greenhouse, Control &
 * sensors, Company) over three levels: an area (level 1, accordion row), its
 * groups and pages (level 2), and a page's tabs (level 3, the in-page strip).
 *
 * WHY plain data: the definitions are read by two consumers that must agree —
 * the rail, and the coverage invariant
 * (tests/invariants/web-console-nav-coverage.spec.ts) that proves every routed
 * tenant page is reachable from it. Everything under `console/nav` is therefore
 * React-free and imports shared-ui for TYPES only, so the invariant imports the
 * very objects the rail renders.
 *
 * WHY the declaring modules and not the `@aquaculture/shared-ui` barrel: even a
 * type-only import loads the barrel into the importer's program, and the
 * barrel re-exports every TSX component. The invariant project type-checks
 * without `jsx` (tests/invariants/tsconfig.spec.json), so a barrel import here
 * pulls every component into it and fails the project. Each name below comes
 * from the JSX-free, side-effect-free module that declares it.
 */
import type { AI_ASSISTANT_USE_CAPABILITY, OwnerModuleCode } from '@aquaculture/shared-contracts';
import type { ConsoleRailIconName } from '@platform/shared-ui/components/Layout/console/railIcons';
import type { ConsoleWorkspaceId } from '@platform/shared-ui/components/Layout/console/railTypes';
import type { MessageKey } from '@platform/shared-ui/i18n/locales/en';
import type { UserRole } from '@platform/shared-ui/types';
import type { TENANT_PANEL_CAPABILITIES } from '@platform/shared-ui/utils/tenant-capabilities';

/**
 * The four console workspaces, in switcher order — declared once by the rail
 * that draws them (shared-ui `CONSOLE_WORKSPACE_IDS`).
 */
export type WorkspaceId = ConsoleWorkspaceId;

/**
 * Tenant module codes the shell mounts behind `ProtectedRoute requiredModule` (App.tsx): the owner
 * modules of the module dictionary (shared-contracts `OwnerModuleCode`), never a list of its own.
 */
export type ModuleCode = OwnerModuleCode;

/**
 * The roles the console serves. SUPER_ADMIN keeps the admin Sidebar and never
 * builds a console nav — excluded at the type level, so a caller cannot hand
 * one in by mistake.
 */
export type ConsoleRole = Exclude<UserRole, 'SUPER_ADMIN'>;

/** Delegatable tenant-panel capabilities (MT-HIGH-060), the gate of the three shared /tenant pages. */
export type TenantCapability = (typeof TENANT_PANEL_CAPABILITIES)[number];

/**
 * The resource permissions a page can require (`useAuth().hasPermission`):
 * the delegatable tenant capabilities, and the AI assistant's surface
 * capability, which the new AI chat page checks in-page (FE-MEDIUM-065).
 * Each is the SSoT constant's own type, so a page cannot name a permission
 * no guard or page checks.
 */
export type NavPermission = TenantCapability | typeof AI_ASSISTANT_USE_CAPABILITY;

/**
 * A page badge's data source. Only sources with a real query exist: the alarm
 * summary's unacknowledged count and the approvable pending-leave count. No
 * static badge is ever declared (design README: never a number without data).
 */
export type BadgeSource = 'alarmsUnack' | 'leavePending';

/**
 * Lucide icon names (kebab-case) the console areas use — the rail's icon
 * vocabulary (shared-ui `CONSOLE_RAIL_ICONS`), so an area cannot name an icon
 * the rail has no component for.
 */
export type ConsoleIcon = ConsoleRailIconName;

/** The theme token carrying a workspace's swatch colour (theme.css `--color-sd-ws-*`). */
export type AccentToken = `--color-sd-ws-${WorkspaceId}`;

/** Level 3: one tab of a page's in-page tab strip, by `?tab=` or by path. */
export interface NavTabDef {
  readonly id: string;
  readonly labelKey: MessageKey;
  /** Full destination: `/sites/feeding?tab=forecast` or `/sites/reports/biomass`. */
  readonly path: string;
}

/** Level 2: a page entry as declared. */
export interface NavPageDef {
  /** Stable id; one id is one destination in every workspace that lists it. */
  readonly id: string;
  readonly labelKey: MessageKey;
  /**
   * Redirect-free destination (pathname, optionally `?tab=`). A path that is
   * only a `<Navigate>` source costs a render + remount before the page mounts
   * (E2E-FLAKE), so the entry names the final route.
   */
  readonly path: string;
  /**
   * Route patterns that highlight this page without being menu leaves: detail,
   * create and alias routes (`/sensor/devices/:deviceId`, `/hr/employees/new`).
   * `:name` matches one segment, a trailing `*` the rest.
   */
  readonly matchPaths?: readonly string[];
  /** Level 3: the page's tabs, in strip order — a real strip, two tabs or more. */
  readonly tabs?: readonly NavTabDef[];
  /**
   * The `?tab=` value that renders the same view as the bare path (finance's
   * `overview`), so the URL spelling it out lights this entry. Matching only:
   * no level-3 row is drawn for it.
   */
  readonly defaultTab?: string;
  /** A routed "coming soon" placeholder (HR): listed, rendered as planned. */
  readonly status?: 'planned';
  /** The role must be one of these (finance, payroll: as the page's own in-page gate). */
  readonly requiredRoles?: readonly ConsoleRole[];
  /** A resource permission: a tenant admin, or a viewer holding it. */
  readonly requiredPermission?: NavPermission;
  /**
   * A tenant-wide record served by a module remote (Company, under /sites).
   * The route guard admits a tenant admin whatever the tenant's modules, and
   * the tenant admin's nav always listed it; other roles still need the module.
   */
  readonly tenantWide?: true;
  readonly badge?: BadgeSource;
}

/** A titled (or untitled) run of pages inside an area. */
export interface NavGroupDef {
  readonly id: string;
  readonly labelKey?: MessageKey;
  readonly pages: readonly NavPageDef[];
}

/** Level 1: an accordion row of the rail. */
export interface NavAreaDef {
  readonly id: string;
  readonly labelKey: MessageKey;
  readonly icon: ConsoleIcon;
  readonly groups: readonly NavGroupDef[];
}

/** A workspace as declared. */
export interface WorkspaceDef {
  readonly id: WorkspaceId;
  readonly labelKey: MessageKey;
  readonly descriptionKey: MessageKey;
  readonly accentToken: AccentToken;
  /** The module the tenant must hold for the workspace to appear; Company has none. */
  readonly module?: ModuleCode;
  readonly areas: readonly NavAreaDef[];
}

// ── Built nav: what buildConsoleNav returns — visible entries only, localized ──

export interface NavTab extends NavTabDef {
  readonly label: string;
}

export interface NavPage extends Omit<NavPageDef, 'tabs'> {
  readonly label: string;
  readonly tabs?: readonly NavTab[];
}

export interface Group extends Omit<NavGroupDef, 'pages'> {
  readonly label?: string;
  readonly pages: readonly NavPage[];
}

export interface Area extends Omit<NavAreaDef, 'groups'> {
  readonly label: string;
  /** The badge sources of the area's visible pages; the rail sums their counts. */
  readonly badge?: readonly BadgeSource[];
  readonly groups: readonly Group[];
}

export interface Workspace extends Omit<WorkspaceDef, 'areas'> {
  readonly label: string;
  readonly description: string;
  readonly areas: readonly Area[];
}

/** Who is looking: everything the gates read, and the translator. */
export interface ConsoleNavInput {
  /** The tenant's assigned modules (AuthContext `modules`). */
  readonly modules: readonly { readonly code: string }[];
  readonly role: ConsoleRole;
  /** The resource-permission SSoT (`useAuth().hasPermission`), fail-closed for non-admins. */
  readonly hasPermission: (permission: string) => boolean;
  readonly t: (key: MessageKey) => string;
}
