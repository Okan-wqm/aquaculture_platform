/**
 * Which module's people a workspace's HR pages are about (module-scoped HR).
 *
 * The followed workspace names the module it is built on (`WorkspaceDef.module`,
 * `farm` / `hydroponics` / `sensor`); the HR service names a department's module
 * with its own `HrModuleCode`. This is the one place the workspace's module
 * becomes an HR module code: ConsoleShell feeds the answer to
 * `WorkforceScopeProvider`, the HR hooks read it back, and no page or hook
 * spells the mapping itself. (The alarm column's table, rail/alarmWorkspaces,
 * maps the same workspaces to the alert-engine's module; workforceScope.spec
 * ties the two so they cannot drift.)
 *
 * WHY a `Record` over every `ModuleCode`: a module code added to the shell
 * cannot compile until someone decides what it scopes HR to. `hr` is decided
 * `null` — the HR module is the company-wide view, not a department module.
 *
 * React-free and type-only imports, like the rest of `console/nav`, so the nav
 * coverage invariant can load it.
 */
import type { HrModuleCode } from '@platform/shared-ui/generated/graphql-types';

import type { ModuleCode } from './types';

const HR_MODULE_OF: Readonly<Record<ModuleCode, HrModuleCode | null>> = {
  farm: 'FARM',
  hydroponics: 'HYDROPONICS',
  sensor: 'SENSOR',
  hr: null,
};

/**
 * The HR module a workspace scopes people to, or null for every module: the
 * Company workspace carries no module, and the HR module scopes nothing.
 */
export function workforceScopeOf(module: ModuleCode | undefined): HrModuleCode | null {
  return module === undefined ? null : HR_MODULE_OF[module];
}
