/**
 * Finance pages: the farm finance page's tabs as console entries
 * (/sites/finance?tab=…) and HR finance.
 *
 * Finance is gated as today's nav gates it, and as both pages gate themselves
 * in-page: tenant admins and module managers. Budget and cost centres are
 * finance tabs this program adds; their figures render as labelled previews
 * (FARM-MEDIUM-439, FARM-MEDIUM-440) until the backend models them.
 */
import type { ConsoleRole, NavPageDef } from '../types';

import { queryTabs } from './tabs';

export const FINANCE_ROLES: readonly ConsoleRole[] = ['TENANT_ADMIN', 'MODULE_MANAGER'];

export const FINANCE_PAGES = {
  // The bare URL renders the overview tab; its explicit `?tab=overview` form is
  // the same view, so it lights this entry too (`defaultTab`: no strip row).
  overview: {
    id: 'finance-overview',
    labelKey: 'nav.overview',
    path: '/sites/finance',
    defaultTab: 'overview',
    requiredRoles: FINANCE_ROLES,
  },
  expenses: {
    id: 'finance-expenses',
    labelKey: 'nav.page.expenses',
    path: '/sites/finance?tab=expenses',
    requiredRoles: FINANCE_ROLES,
  },
  budget: {
    id: 'finance-budget',
    labelKey: 'nav.page.budget',
    path: '/sites/finance?tab=budget',
    requiredRoles: FINANCE_ROLES,
  },
  costCentres: {
    id: 'finance-cost-centres',
    labelKey: 'nav.page.costCentres',
    path: '/sites/finance?tab=cost-centres',
    requiredRoles: FINANCE_ROLES,
  },
  charts: {
    id: 'finance-charts',
    labelKey: 'nav.page.charts',
    path: '/sites/finance?tab=charts',
    requiredRoles: FINANCE_ROLES,
  },
  categories: {
    id: 'finance-categories',
    labelKey: 'nav.page.categories',
    path: '/sites/finance?tab=categories',
    requiredRoles: FINANCE_ROLES,
  },
  settings: {
    id: 'finance-settings',
    labelKey: 'nav.page.financeSettings',
    path: '/sites/finance?tab=settings',
    requiredRoles: FINANCE_ROLES,
  },
  hrFinance: {
    id: 'hr-finance',
    labelKey: 'nav.page.hrFinance',
    path: '/hr/finance',
    requiredRoles: FINANCE_ROLES,
    tabs: queryTabs('/hr/finance', [
      ['personnel', 'nav.tab.personnel'],
      ['salaries', 'nav.tab.salaries'],
      ['labour', 'nav.tab.labourCost'],
      ['expenses', 'nav.page.expenses'],
      ['charts', 'nav.page.charts'],
    ]),
  },
} satisfies Record<string, NavPageDef>;
