/**
 * Areas several workspaces carry (FE-HIGH-335): Overview, Team and Finance.
 *
 * A shared page is the same object in every workspace — one id, one label,
 * one path — so moving between workspaces never changes where an entry goes.
 * Each page still keeps its own gate: Team pages need the HR module, Finance
 * pages the farm module and a finance role, whichever workspace lists them.
 */
import { FINANCE_PAGES } from '../pages/finance';
import { HR_PAGES } from '../pages/hr';
import { SENSOR_PAGES } from '../pages/sensor';
import { SHELL_PAGES } from '../pages/shell';
import { TENANT_PAGES } from '../pages/tenant';
import type { NavAreaDef, NavPageDef } from '../types';

/** Overview of a module workspace: dashboards, the shared alarm list, messages. */
export function moduleOverviewArea(id: string): NavAreaDef {
  return {
    id,
    labelKey: 'nav.overview',
    icon: 'gauge',
    groups: [
      {
        id: `${id}-main`,
        pages: [
          SHELL_PAGES.dashboard,
          SHELL_PAGES.dashboardAnalytics,
          SENSOR_PAGES.alarms,
          SHELL_PAGES.messaging,
          SHELL_PAGES.newAiChat,
        ],
      },
    ],
  };
}

/** The team a module workspace works with: today, shifts, leave, the crew list and its organisation. */
export function teamArea(id: string): NavAreaDef {
  return {
    id,
    labelKey: 'nav.area.team',
    icon: 'users',
    groups: [
      {
        id: `${id}-main`,
        pages: [HR_PAGES.today, HR_PAGES.scheduling, HR_PAGES.leaves, HR_PAGES.crew],
      },
      {
        id: `${id}-organisation`,
        labelKey: 'nav.group.organisation',
        pages: [HR_PAGES.departments, TENANT_PAGES.roles],
      },
    ],
  };
}

/** A workspace's Finance area over the given finance entries. */
export function financeArea(id: string, pages: readonly NavPageDef[]): NavAreaDef {
  return {
    id,
    labelKey: 'nav.finance',
    icon: 'credit-card',
    groups: [{ id: `${id}-main`, pages }],
  };
}

/** The finance entries of a production workspace (Production, Greenhouse). */
export const PRODUCTION_FINANCE: readonly NavPageDef[] = [
  FINANCE_PAGES.overview,
  FINANCE_PAGES.expenses,
  FINANCE_PAGES.budget,
  FINANCE_PAGES.costCentres,
];
