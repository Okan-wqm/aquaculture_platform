/**
 * alertPriorityFilter — the console's `?priority=` (an annunciator tile) as
 * the alarm list's own filters, and back.
 *
 * WHY: the annunciator in the console header links each tile to this list
 * (`/sensor/alerts?priority=p1|p2|p3|unack`, README §7.5), and the list must
 * hold the alarms the tile counted. Both read them from shared-ui
 * annunciatorScope: every tile holds open (unresolved) alarms of its
 * severities, UNACK only the unacknowledged ones. So P1/P2/P3 land on the
 * "open" tab over that priority's severities, and UNACK on the "active" tab
 * (open and unacknowledged) over the P1–P3 severities. The list keeps its own
 * filters — the status tabs and the severity select — so a tile lands as those
 * filters, visible and changeable, instead of as a hidden mode
 * (alertPriorityParity.test.ts pins that the rows match the count). The
 * reverse is derived from the forward mapping, so the two cannot disagree: a
 * filter the user picks by hand that equals a tile's is that tile, anything
 * else is no tile.
 *
 * WHAT: AlertListFilter, filterForPriority() and priorityForFilter().
 */
import {
  ANNUNCIATOR_FILTERS,
  annunciatorScope,
  type AnnunciatorFilter,
} from '@aquaculture/shared-ui';

import type { AlertFilters } from '../../hooks/useAlerts';

import { sameSeverities } from './severityChoices';

/** The part of the list's filters a tile sets: the status tab and the severity set. */
export type AlertListFilter = Pick<AlertFilters, 'status' | 'severities'>;

export function filterForPriority(priority: AnnunciatorFilter | null): AlertListFilter {
  if (priority === null) return { status: 'all', severities: [] };
  const scope = annunciatorScope(priority);
  return { status: scope.unacknowledgedOnly ? 'active' : 'open', severities: scope.severities };
}

/** The tile whose filter this is, or null when no tile shows it. */
export function priorityForFilter(filter: AlertListFilter): AnnunciatorFilter | null {
  return (
    ANNUNCIATOR_FILTERS.find((priority) => {
      const tile = filterForPriority(priority);
      return tile.status === filter.status && sameSeverities(tile.severities, filter.severities);
    }) ?? null
  );
}
