/**
 * Farm-module operations pages (/sites): live production, site work and
 * reports. The farm module gate follows from the /sites path (mounts.ts).
 */
import type { NavPageDef } from '../types';

import { pathTabs, queryTabs } from './tabs';

export const FARM_OPERATION_PAGES = {
  environment: {
    id: 'environment',
    labelKey: 'nav.page.waterEnvironment',
    path: '/sites/environment',
    matchPaths: ['/sites/environment/:siteId'],
  },
  // Batches open from the tank list; the batch detail (and its tabs) lights it.
  tanks: {
    id: 'tanks',
    labelKey: 'nav.tanksPonds',
    path: '/sites/tanks',
    matchPaths: ['/sites/batch/:batchId/*'],
    tabs: queryTabs('/sites/tanks', [
      ['production', 'nav.tab.production'],
      ['cleanerFish', 'nav.tab.cleanerFish'],
    ]),
  },
  // Sources and parameters are their own entries (Records), as the design places them.
  waterChemistry: {
    id: 'water-chemistry',
    labelKey: 'nav.waterChemistry',
    path: '/sites/water-chemistry',
    tabs: queryTabs('/sites/water-chemistry', [
      ['calculator', 'nav.tab.calculator'],
      ['record', 'nav.tab.record'],
      ['bulk', 'nav.tab.bulkEntry'],
      ['history', 'nav.tab.history'],
    ]),
  },
  // Records is a tab, as the design places it (digest §8.3: `feedrec` lights
  // Feeding); the strip follows FeedingPage's own tab order.
  feeding: {
    id: 'feeding',
    labelKey: 'nav.feeding',
    path: '/sites/feeding',
    tabs: queryTabs('/sites/feeding', [
      ['meal-board', 'feedingV2.tab.mealBoard'],
      ['forecast', 'feedingV2.tab.forecast'],
      ['records', 'feedingV2.tab.records'],
      ['summary', 'feedingV2.tab.summary'],
      ['growth', 'feedingV2.tab.growth'],
      ['fcr', 'feedingV2.tab.fcr'],
      ['production-plan', 'feedingV2.tab.productionPlan'],
      ['protocols-v2', 'feedingV2.tab.builder'],
      ['assignments', 'feedingV2.tab.assignments'],
      ['sampling', 'nav.tab.sampling'],
    ]),
  },
  health: { id: 'health', labelKey: 'nav.healthEvents', path: '/sites/health' },
  harvest: { id: 'harvest', labelKey: 'nav.page.harvestPlans', path: '/sites/harvest' },
  tasks: {
    id: 'tasks',
    labelKey: 'nav.tasks',
    path: '/sites/tasks',
    tabs: queryTabs('/sites/tasks', [
      ['today', 'nav.today'],
      ['all-tasks', 'nav.tab.allTasks'],
      ['recurring', 'nav.tab.recurring'],
      ['auto-rules', 'nav.tab.autoRules'],
      ['calendar', 'nav.tab.calendar'],
      ['completed', 'nav.tab.completed'],
    ]),
  },
  maintenance: {
    id: 'maintenance',
    labelKey: 'nav.maintenance',
    path: '/sites/maintenance',
    tabs: queryTabs('/sites/maintenance', [
      ['work-orders', 'nav.tab.workOrders'],
      ['schedules', 'nav.tab.schedules'],
      ['spare-parts', 'nav.tab.spareParts'],
    ]),
  },
  // Locations is the Company › Facility entry, so it is not a tab here.
  storage: {
    id: 'storage',
    labelKey: 'nav.storageStock',
    path: '/sites/storage',
    tabs: queryTabs('/sites/storage', [
      ['overview', 'nav.overview'],
      ['feed-stock', 'nav.tab.feedStock'],
      ['chemicals', 'nav.page.chemicals'],
      ['consumables', 'nav.page.consumables'],
      ['healthcare', 'nav.tab.healthcare'],
      ['movements', 'nav.tab.movements'],
      ['purchase-orders', 'nav.tab.purchaseOrders'],
      ['inventory-count', 'nav.tab.inventoryCount'],
    ]),
  },
  storageLocations: {
    id: 'storage-locations',
    labelKey: 'nav.page.storageLocations',
    path: '/sites/storage?tab=locations',
  },
  // /sites/reports only redirects to its first report; the entry names it.
  // Also the real target of the module users' old `/reports` link, which no
  // route served.
  reports: {
    id: 'reports',
    labelKey: 'nav.page.regulatoryReports',
    path: '/sites/reports/sea-lice',
    tabs: pathTabs('/sites/reports', [
      ['sea-lice', 'nav.tab.seaLice'],
      ['biomass', 'nav.tab.biomass'],
      ['smolt', 'nav.tab.smolt'],
      ['cleaner-fish', 'nav.tab.cleanerFish'],
      ['slaughter', 'nav.tab.slaughter'],
      ['welfare', 'nav.tab.welfare'],
      ['disease', 'nav.tab.disease'],
      ['escape', 'nav.tab.escape'],
    ]),
  },
  // /sites/analytics only redirects to its one tab; the entry names it, and a
  // one-tab strip would only repeat the entry, so it draws none.
  analytics: {
    id: 'analytics',
    labelKey: 'nav.analytics',
    path: '/sites/analytics/tanks',
  },
} satisfies Record<string, NavPageDef>;
