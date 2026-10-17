/**
 * Farm-module registry and facility pages (/sites/setup and friends).
 *
 * The setup page's tabs are routes of their own, and the console places them
 * one by one (Facility, Records, Purchasing), as the design does. Three design
 * entries already exist under another route and link there: parameters and
 * reading sources are water-chemistry tabs, fish-health substances is
 * `setup/fish-health`, slaughter facilities is `setup/slaughter-facilities`.
 */
import type { NavPageDef } from '../types';

export const FARM_SETUP_PAGES = {
  // Tenant-wide company record (regulatory identity) served by the farm remote.
  company: { id: 'company', labelKey: 'nav.company', path: '/sites/company', tenantWide: true },
  facilityStructure: {
    id: 'facility-structure',
    labelKey: 'nav.facilityStructure',
    path: '/sites/setup/structure',
  },
  sites: { id: 'setup-sites', labelKey: 'nav.page.sites', path: '/sites/setup/sites' },
  departments: {
    id: 'setup-departments',
    labelKey: 'nav.page.siteDepartments',
    path: '/sites/setup/departments',
  },
  systems: { id: 'setup-systems', labelKey: 'nav.page.waterSystems', path: '/sites/setup/systems' },
  equipment: {
    id: 'setup-equipment',
    labelKey: 'nav.page.equipment',
    path: '/sites/setup/equipment',
  },
  workers: { id: 'setup-workers', labelKey: 'nav.page.siteWorkers', path: '/sites/setup/workers' },
  species: { id: 'setup-species', labelKey: 'nav.page.species', path: '/sites/setup/species' },
  feeds: { id: 'setup-feeds', labelKey: 'nav.page.feeds', path: '/sites/setup/feeds' },
  waterParameters: {
    id: 'water-parameters',
    labelKey: 'nav.page.parametersLimits',
    path: '/sites/water-chemistry?tab=parameters',
  },
  readingSources: {
    id: 'reading-sources',
    labelKey: 'nav.page.readingSources',
    path: '/sites/water-chemistry?tab=sources',
  },
  chemicals: {
    id: 'setup-chemicals',
    labelKey: 'nav.page.chemicals',
    path: '/sites/setup/chemicals',
  },
  fishHealth: {
    id: 'setup-fish-health',
    labelKey: 'nav.page.fishHealthSubstances',
    path: '/sites/setup/fish-health',
  },
  slaughterFacilities: {
    id: 'setup-slaughter-facilities',
    labelKey: 'nav.page.slaughterFacilities',
    path: '/sites/setup/slaughter-facilities',
  },
  suppliers: {
    id: 'setup-suppliers',
    labelKey: 'nav.page.suppliers',
    path: '/sites/setup/suppliers',
  },
  consumables: {
    id: 'setup-consumables',
    labelKey: 'nav.page.consumables',
    path: '/sites/setup/consumables',
  },
} satisfies Record<string, NavPageDef>;
