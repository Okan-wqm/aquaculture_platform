/**
 * Tenant console navigation model (FE-HIGH-335) — the public surface.
 * React-free: the rail renders it, the coverage invariant imports it.
 */
export { buildConsoleNav } from './buildConsoleNav';
export {
  MATCH_BASE,
  MATCH_EXACT,
  MATCH_NONE,
  MATCH_PATTERN,
  pageMatchScore,
  parseNavLocation,
  patternMatches,
  type MatchablePage,
  type NavLocation,
} from './match';
export { MODULE_MOUNTS, moduleForPath } from './mounts';
export { canSeePage, type PageAccessContext } from './pageAccess';
export type {
  AccentToken,
  Area,
  BadgeSource,
  ConsoleIcon,
  ConsoleNavInput,
  ConsoleRole,
  Group,
  ModuleCode,
  NavAreaDef,
  NavGroupDef,
  NavPage,
  NavPageDef,
  NavPermission,
  NavTab,
  NavTabDef,
  TenantCapability,
  Workspace,
  WorkspaceDef,
  WorkspaceId,
} from './types';
export {
  findActivePage,
  workspaceForPath,
  type ActiveEntry,
  type MatchableWorkspace,
} from './workspaceForPath';
export { workforceScopeOf } from './workforceScope';
export { CONSOLE_WORKSPACES } from './workspaces';
export { findNavPage } from './findNavPage';
export { workspaceHome, type HomeableWorkspace } from './workspaceHome';
export { COMPANY_DASHBOARD_PATH, rootLanding } from './rootLanding';
