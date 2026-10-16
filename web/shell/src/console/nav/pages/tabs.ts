/**
 * Level-3 tab builders (FE-HIGH-335): a tabbed page's strip as nav data, so the
 * destination of every tab is spelled once — `?tab=<id>` or `/<id>` under the
 * page's pathname, the id being the value the page itself reads.
 */
import type { MessageKey } from '@platform/shared-ui/i18n/locales/en';

import type { NavTabDef } from '../types';

/** `[tab id, label key]`, in strip order. */
export type TabSpec = readonly [id: string, labelKey: MessageKey];

/** Tabs the page reads from `?tab=` (`/sites/feeding?tab=forecast`). */
export function queryTabs(pathname: string, specs: readonly TabSpec[]): readonly NavTabDef[] {
  return specs.map(([id, labelKey]) => ({ id, labelKey, path: `${pathname}?tab=${id}` }));
}

/** Tabs that are child routes of the page (`/sites/reports/biomass`). */
export function pathTabs(pathname: string, specs: readonly TabSpec[]): readonly NavTabDef[] {
  return specs.map(([id, labelKey]) => ({ id, labelKey, path: `${pathname}/${id}` }));
}
