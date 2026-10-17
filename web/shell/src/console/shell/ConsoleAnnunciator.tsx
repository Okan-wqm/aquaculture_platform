/**
 * ConsoleAnnunciator — the header's alarm strip, wired to the alarm list
 * (FE-HIGH-334, design README §7.5).
 *
 * WHAT: shared-ui's Annunciator with the real counts (useAlarmSummary, read
 * once by the console and shared with the rail's badge). A tile opens the
 * alarm list filtered to its priority (`?priority=p1|p2|p3|unack`, which the
 * list reads as its own filters); pressing the tile of the filter on screen
 * clears it. The tile of the list's current filter is pressed.
 *
 * WHY the list path is passed in: the strip exists only for a viewer whose nav
 * offers the alarm list (the sensor module's page), at the path the rail uses
 * — a strip whose tiles lead to a refused route would be a dead end.
 */
import {
  ALARM_PRIORITY_PARAM,
  Annunciator,
  parseAnnunciatorFilter,
  type AnnunciatorCounts,
  type AnnunciatorFilter,
} from '@aquaculture/shared-ui';
import { useCallback, useMemo, type ReactElement } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import type { AlarmSummary } from '../data';

export interface ConsoleAnnunciatorProps {
  /** The console's alarm summary; 'unavailable' renders no strip. */
  readonly summary: AlarmSummary;
  /** The alarm list's path, as the viewer's nav lists it. */
  readonly listPath: string;
}

export function ConsoleAnnunciator({
  summary,
  listPath,
}: ConsoleAnnunciatorProps): ReactElement | null {
  const location = useLocation();
  const navigate = useNavigate();

  const activePriority =
    location.pathname === listPath
      ? parseAnnunciatorFilter(new URLSearchParams(location.search).get(ALARM_PRIORITY_PARAM))
      : null;
  const counts = useMemo(
    (): AnnunciatorCounts => ({
      p1: summary.p1,
      p2: summary.p2,
      p3: summary.p3,
      unack: summary.unack,
    }),
    [summary.p1, summary.p2, summary.p3, summary.unack],
  );
  const handleSelect = useCallback(
    (priority: AnnunciatorFilter | null): void => {
      navigate(
        priority === null
          ? listPath
          : `${listPath}?${new URLSearchParams({ [ALARM_PRIORITY_PARAM]: priority }).toString()}`,
      );
    },
    [navigate, listPath],
  );

  if (summary.status === 'unavailable') return null;
  return (
    <Annunciator
      status={summary.status}
      counts={counts}
      unacknowledgedP1={summary.p1Unack}
      activePriority={activePriority}
      onSelect={handleSelect}
    />
  );
}
