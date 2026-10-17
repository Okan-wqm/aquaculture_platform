/**
 * Production (aqua) — fish sites, feeding, health, reports and production
 * finance; the farm module's workspace (design WSN `aqua`).
 *
 * Beyond the design tree it lists the repo pages the design lacks, themed the
 * same: dashboard analytics and the new AI chat (Overview), the setup
 * departments and workers tabs (Facility). Feed records is Feeding's Records
 * tab, as in the design.
 */
import { FARM_OPERATION_PAGES as OPS } from '../pages/farmOperations';
import { FARM_SETUP_PAGES as SETUP } from '../pages/farmSetup';
import { SENSOR_PAGES } from '../pages/sensor';
import { TENANT_PAGES } from '../pages/tenant';
import type { WorkspaceDef } from '../types';

import { PRODUCTION_FINANCE, financeArea, moduleOverviewArea, teamArea } from './shared';

export const AQUA_WORKSPACE: WorkspaceDef = {
  id: 'aqua',
  labelKey: 'nav.workspace.aqua',
  descriptionKey: 'nav.workspace.aqua.description',
  accentToken: '--color-sd-ws-aqua',
  module: 'farm',
  areas: [
    moduleOverviewArea('aq-home'),
    {
      id: 'aq-operations',
      labelKey: 'nav.area.operations',
      icon: 'fish',
      groups: [
        {
          id: 'aq-live',
          labelKey: 'nav.group.live',
          pages: [
            OPS.environment,
            OPS.tanks,
            OPS.waterChemistry,
            OPS.feeding,
            OPS.health,
            OPS.harvest,
          ],
        },
        {
          id: 'aq-site-work',
          labelKey: 'nav.group.siteWork',
          pages: [OPS.tasks, OPS.maintenance, OPS.storage],
        },
      ],
    },
    teamArea('aq-team'),
    {
      id: 'aq-reports',
      labelKey: 'nav.reports',
      icon: 'clipboard-check',
      groups: [{ id: 'aq-reports-main', pages: [OPS.reports, OPS.analytics] }],
    },
    financeArea('aq-finance', PRODUCTION_FINANCE),
    {
      id: 'aq-facility',
      labelKey: 'nav.area.facility',
      icon: 'building-2',
      groups: [
        {
          id: 'aq-facility-main',
          pages: [
            SETUP.company,
            SETUP.facilityStructure,
            SENSOR_PAGES.processes,
            SETUP.systems,
            SETUP.equipment,
            SETUP.departments,
            SETUP.workers,
          ],
        },
        {
          id: 'aq-platform',
          labelKey: 'nav.platform',
          pages: [TENANT_PAGES.architecture, TENANT_PAGES.architectureReview],
        },
      ],
    },
    {
      id: 'aq-records',
      labelKey: 'nav.area.records',
      icon: 'file-text',
      groups: [
        {
          id: 'aq-records-main',
          pages: [
            SETUP.species,
            SETUP.feeds,
            SETUP.waterParameters,
            SETUP.readingSources,
            SETUP.chemicals,
            SETUP.fishHealth,
            SETUP.slaughterFacilities,
          ],
        },
        {
          id: 'aq-purchasing',
          labelKey: 'nav.group.purchasing',
          pages: [SETUP.suppliers, SETUP.consumables],
        },
      ],
    },
  ],
};
