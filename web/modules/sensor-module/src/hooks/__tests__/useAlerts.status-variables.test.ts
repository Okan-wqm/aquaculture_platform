/**
 * alertHistoryVariables — every status tab of the alarm list is a server
 * filter.
 *
 * Each tab shows the rows whose status badge it names (AlertsPage
 * StatusBadge): Active = open and unacknowledged, Acknowledged = open and
 * acknowledged, Resolved = cleared, Open = both open states (what a priority
 * tile of the console annunciator counts). alert-engine filters on both
 * `acknowledged` and `resolved`, so a page of a tab is a page of exactly
 * those alarms — no tab is narrowed client-side after a page was cut.
 */
import { describe, expect, it } from 'vitest';

import { alertHistoryVariables } from '../useAlerts';

const PAGE = { page: 3, limit: 20 } as const;

describe('alertHistoryVariables', () => {
  it('maps each status tab to its acknowledgement and resolution filters', () => {
    expect(alertHistoryVariables({ status: 'all', severities: [], ...PAGE })).toEqual(PAGE);
    expect(alertHistoryVariables({ status: 'open', severities: [], ...PAGE })).toEqual({
      ...PAGE,
      resolved: false,
    });
    expect(alertHistoryVariables({ status: 'active', severities: [], ...PAGE })).toEqual({
      ...PAGE,
      acknowledged: false,
      resolved: false,
    });
    expect(alertHistoryVariables({ status: 'acknowledged', severities: [], ...PAGE })).toEqual({
      ...PAGE,
      acknowledged: true,
      resolved: false,
    });
    expect(alertHistoryVariables({ status: 'resolved', severities: [], ...PAGE })).toEqual({
      ...PAGE,
      resolved: true,
    });
  });

  it('sends a severity set only when it narrows', () => {
    expect(
      alertHistoryVariables({ status: 'open', severities: ['MEDIUM', 'WARNING'], ...PAGE }),
    ).toEqual({ ...PAGE, resolved: false, severities: ['MEDIUM', 'WARNING'] });
    expect(alertHistoryVariables({ status: 'all', severities: [], ...PAGE })).not.toHaveProperty(
      'severities',
    );
  });
});
