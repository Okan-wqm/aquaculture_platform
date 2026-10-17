/**
 * Greenhouse (gh) — nutrient solution, tools and greenhouse finance; the
 * hydroponics module's workspace (design WSN `gh`). Site work and Finance are
 * farm-module pages and appear only when the tenant also holds farm.
 */
import { FARM_OPERATION_PAGES as OPS } from '../pages/farmOperations';
import { HYDROPONICS_PAGES as HYD } from '../pages/hydroponics';
import type { WorkspaceDef } from '../types';

import { PRODUCTION_FINANCE, financeArea, moduleOverviewArea, teamArea } from './shared';

export const GH_WORKSPACE: WorkspaceDef = {
  id: 'gh',
  labelKey: 'nav.workspace.gh',
  descriptionKey: 'nav.workspace.gh.description',
  accentToken: '--color-sd-ws-gh',
  module: 'hydroponics',
  areas: [
    moduleOverviewArea('gh-home'),
    {
      id: 'gh-operations',
      labelKey: 'nav.area.operations',
      icon: 'sprout',
      groups: [
        { id: 'gh-live', labelKey: 'nav.group.live', pages: [HYD.waterAnalysis, HYD.result] },
        {
          id: 'gh-site-work',
          labelKey: 'nav.group.siteWork',
          pages: [OPS.tasks, OPS.maintenance, OPS.storage],
        },
        {
          id: 'gh-tools',
          labelKey: 'nav.group.toolsSetup',
          pages: [HYD.generalOptions, HYD.userOptions, HYD.pidSimulator, HYD.setup],
        },
      ],
    },
    teamArea('gh-team'),
    financeArea('gh-finance', PRODUCTION_FINANCE),
  ],
};
