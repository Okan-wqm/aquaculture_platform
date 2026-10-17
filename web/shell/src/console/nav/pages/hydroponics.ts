/**
 * Hydroponics-module pages (/hydroponics). The nutrient-solution steps are
 * routes of their own; the four drainage-readjustment steps exist only in
 * adjusting mode (the page mounts them then, and redirects them to General
 * options otherwise), so they are General options' level-3 tabs — the page
 * whose mode switch reveals them — rather than menu rows.
 */
import type { NavPageDef } from '../types';

import { pathTabs } from './tabs';

export const HYDROPONICS_PAGES = {
  waterAnalysis: {
    id: 'hydroponics-water',
    labelKey: 'nav.waterAnalysis',
    path: '/hydroponics/solution/water_analysis',
  },
  result: {
    id: 'hydroponics-result',
    labelKey: 'nav.page.nutrientResult',
    path: '/hydroponics/solution/result',
  },
  generalOptions: {
    id: 'hydroponics-general',
    labelKey: 'nav.generalOptions',
    path: '/hydroponics/solution/general_options',
    tabs: pathTabs('/hydroponics/solution', [
      ['drainage_composition', 'nav.tab.currentDrainage'],
      ['previous_drainage', 'nav.tab.previousDrainage'],
      ['current_ns_formula', 'nav.tab.currentNsFormula'],
      ['readjustment', 'nav.tab.readjustment'],
    ]),
  },
  userOptions: {
    id: 'hydroponics-user',
    labelKey: 'nav.userOptions',
    path: '/hydroponics/solution/user_options',
  },
  pidSimulator: {
    id: 'hydroponics-pid-sim',
    labelKey: 'nav.pidSimulator',
    path: '/hydroponics/pid-simulator',
  },
  setup: { id: 'hydroponics-setup', labelKey: 'nav.setup', path: '/hydroponics/setup' },
} satisfies Record<string, NavPageDef>;
