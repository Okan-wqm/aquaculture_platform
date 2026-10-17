/**
 * The console nav a viewer sees (FE-HIGH-335): the workspace definitions
 * filtered by the viewer's gates and localized. Pure — same input, same
 * output — so the rail memoizes it and the specs call it directly.
 *
 * Pruning is bottom-up: a page the viewer may not see is dropped, then a group
 * left empty, then an area, then a workspace with no area left. A module
 * workspace also needs its module assigned to the tenant, so a tenant without
 * hydroponics never gets a Greenhouse switcher row offering only shared pages.
 */
import { canSeePage, type PageAccessContext } from './pageAccess';
import type {
  Area,
  BadgeSource,
  ConsoleNavInput,
  Group,
  NavAreaDef,
  NavGroupDef,
  NavPage,
  NavPageDef,
  Workspace,
  WorkspaceDef,
} from './types';
import { CONSOLE_WORKSPACES } from './workspaces';

type Translate = ConsoleNavInput['t'];

function buildPage(page: NavPageDef, t: Translate): NavPage {
  const { tabs, ...rest } = page;
  return {
    ...rest,
    label: t(page.labelKey),
    ...(tabs === undefined
      ? {}
      : { tabs: tabs.map((tab) => ({ ...tab, label: t(tab.labelKey) })) }),
  };
}

function buildGroup(group: NavGroupDef, context: PageAccessContext, t: Translate): Group | null {
  const pages = group.pages
    .filter((page) => canSeePage(page, context))
    .map((page) => buildPage(page, t));
  if (pages.length === 0) return null;
  const { labelKey } = group;
  return {
    id: group.id,
    ...(labelKey === undefined ? {} : { labelKey, label: t(labelKey) }),
    pages,
  };
}

function buildArea(area: NavAreaDef, context: PageAccessContext, t: Translate): Area | null {
  const groups = area.groups.flatMap((group) => buildGroup(group, context, t) ?? []);
  if (groups.length === 0) return null;
  const badge = [
    ...new Set(
      groups.flatMap((group) =>
        group.pages.flatMap((page): BadgeSource[] => (page.badge ? [page.badge] : [])),
      ),
    ),
  ];
  return {
    id: area.id,
    labelKey: area.labelKey,
    label: t(area.labelKey),
    icon: area.icon,
    ...(badge.length === 0 ? {} : { badge }),
    groups,
  };
}

function buildWorkspace(
  workspace: WorkspaceDef,
  context: PageAccessContext,
  t: Translate,
): Workspace | null {
  if (workspace.module !== undefined && !context.modules.has(workspace.module)) return null;
  const areas = workspace.areas.flatMap((area) => buildArea(area, context, t) ?? []);
  if (areas.length === 0) return null;
  return {
    id: workspace.id,
    labelKey: workspace.labelKey,
    label: t(workspace.labelKey),
    descriptionKey: workspace.descriptionKey,
    description: t(workspace.descriptionKey),
    accentToken: workspace.accentToken,
    ...(workspace.module === undefined ? {} : { module: workspace.module }),
    areas,
  };
}

/**
 * The workspaces, areas, groups, pages and tabs `input` may see, in definition
 * order, labels resolved through `input.t`. `definitions` defaults to the
 * console's own; specs pass their own to exercise the pruning.
 */
export function buildConsoleNav(
  input: ConsoleNavInput,
  definitions: readonly WorkspaceDef[] = CONSOLE_WORKSPACES,
): Workspace[] {
  const context: PageAccessContext = {
    role: input.role,
    modules: new Set(input.modules.map((module) => module.code)),
    hasPermission: input.hasPermission,
  };
  return definitions.flatMap((workspace) => buildWorkspace(workspace, context, input.t) ?? []);
}
