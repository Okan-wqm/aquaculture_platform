/**
 * Alarm view-models: per-site tallies on the annunciator's priorities
 * (advisories and site-less alarms count on no site), the operator states
 * from acknowledged/resolved, and the order the panel lists them in.
 */
import { describe, expect, it } from 'vitest';

import { alarmState, tallyBySite, topAlarms, worstPriority, type AlarmRecord } from '../alarms';

describe('tallyBySite', () => {
  it('folds severities onto priorities per site, leaving advisories and site-less rows out', () => {
    const tallies = tallyBySite([
      { severity: 'CRITICAL', acknowledged: false, siteId: 's1', count: 1 },
      { severity: 'MEDIUM', acknowledged: false, siteId: 's1', count: 2 },
      { severity: 'WARNING', acknowledged: true, siteId: 's1', count: 3 },
      { severity: 'INFO', acknowledged: false, siteId: 's2', count: 9 },
      { severity: 'HIGH', acknowledged: false, siteId: null, count: 4 },
    ]);
    expect(tallies.get('s1')).toEqual({ p1: 1, p2: 0, p3: 5 });
    expect(tallies.has('s2')).toBe(false);
    expect(worstPriority({ p1: 0, p2: 0, p3: 1 })).toBe('p3');
    expect(worstPriority({ p1: 0, p2: 0, p3: 0 })).toBeNull();
  });
});

describe('alarm states and order', () => {
  it('maps the two flags to the three states, and drops a cleared acknowledged alarm', () => {
    expect(alarmState({ acknowledged: false, resolved: false })).toBe('unack');
    expect(alarmState({ acknowledged: false, resolved: true })).toBe('cleared');
    expect(alarmState({ acknowledged: true, resolved: false })).toBe('acked');
    expect(alarmState({ acknowledged: true, resolved: true })).toBeNull();
  });

  it('lists unacknowledged first, then cleared, then acknowledged; urgent, then newest', () => {
    const alarm = (
      id: string,
      severity: AlarmRecord['severity'],
      acknowledged: boolean,
      resolved: boolean,
      minutes: number,
    ): AlarmRecord => ({
      id,
      ruleName: id,
      message: id,
      severity,
      acknowledged,
      resolved,
      triggeredAt: new Date(Date.UTC(2026, 9, 17, 10, 60 - minutes)).toISOString(),
      siteId: null,
    });
    const rows = topAlarms(
      [
        alarm('acked-p1', 'CRITICAL', true, false, 1),
        alarm('unack-p3', 'WARNING', false, false, 1),
        alarm('unack-p1-old', 'CRITICAL', false, false, 30),
        alarm('unack-p1-new', 'CRITICAL', false, false, 5),
        alarm('cleared-p2', 'HIGH', false, true, 2),
        alarm('advisory', 'LOW', false, false, 1),
        alarm('unack-p1-new', 'CRITICAL', false, false, 5),
      ],
      5,
    );
    expect(rows.map((row) => row.id)).toEqual([
      'unack-p1-new',
      'unack-p1-old',
      'unack-p3',
      'cleared-p2',
      'acked-p1',
    ]);
  });
});
