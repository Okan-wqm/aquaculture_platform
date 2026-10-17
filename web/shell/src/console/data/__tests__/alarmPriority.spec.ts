/**
 * alarmPriority — alert-engine's unresolved-alarm counts as the annunciator's
 * four tiles.
 *
 * Which alarms a tile holds is declared once, in shared-ui (annunciatorScope /
 * isOnTile, pinned by Layout/console/__tests__/AnnunciatorScope.spec.ts), and
 * the alarm list a tile opens is filtered from the same declaration
 * (sensor-module alertPriorityParity.test.ts). Here: that the counts are
 * exactly the alarms isOnTile puts on each tile — so the count and the list
 * agree — that the server's per-(severity, acknowledged) counts add up past
 * any page size, and that advisories count nowhere however many there are.
 * A tile lights on its count (design decision D16, README §7.5); the one
 * per-priority unacknowledged count is P1's, which makes the CRIT square
 * flash until every P1 alarm is acknowledged (ISA-18.2, WCAG 2.2.2).
 */
import { ANNUNCIATOR_FILTERS, isOnTile } from '@aquaculture/shared-ui';
import type { AlertSeverity } from '@platform/shared-ui/generated/graphql-types';
import { describe, expect, it } from 'vitest';

import { summariseAlarms, type AlarmCountRow } from '../alarmPriority';

const ALL_SEVERITIES: readonly AlertSeverity[] = [
  'CRITICAL',
  'HIGH',
  'MEDIUM',
  'WARNING',
  'LOW',
  'INFO',
];

describe('summariseAlarms', () => {
  it('counts active alarms per priority and the unacknowledged ones apart', () => {
    const counts = summariseAlarms([
      { severity: 'CRITICAL', acknowledged: false, count: 1 },
      { severity: 'CRITICAL', acknowledged: true, count: 1 },
      { severity: 'HIGH', acknowledged: false, count: 1 },
      { severity: 'WARNING', acknowledged: true, count: 1 },
      { severity: 'MEDIUM', acknowledged: false, count: 1 },
    ]);

    expect(counts).toEqual({ p1: 2, p2: 1, p3: 2, unack: 3, p1Unack: 1 });
  });

  it('adds the counts, beyond any page size', () => {
    const counts = summariseAlarms([
      { severity: 'HIGH', acknowledged: false, count: 140 },
      { severity: 'MEDIUM', acknowledged: false, count: 30 },
      { severity: 'WARNING', acknowledged: false, count: 12 },
    ]);

    expect(counts).toEqual({ p1: 0, p2: 140, p3: 42, unack: 182, p1Unack: 0 });
  });

  it('counts low and info advisories on no tile, the unacknowledged ones included', () => {
    const counts = summariseAlarms([
      { severity: 'LOW', acknowledged: false, count: 5 },
      { severity: 'INFO', acknowledged: false, count: 250 },
    ]);

    expect(counts).toEqual({ p1: 0, p2: 0, p3: 0, unack: 0, p1Unack: 0 });
  });

  it('counts the P1 alarms awaiting acknowledgement apart, for the CRIT flash', () => {
    const counts = summariseAlarms([
      { severity: 'CRITICAL', acknowledged: false, count: 2 },
      { severity: 'CRITICAL', acknowledged: true, count: 5 },
      { severity: 'HIGH', acknowledged: false, count: 7 },
    ]);
    expect(counts.p1).toBe(7);
    expect(counts.p1Unack).toBe(2);
    expect(summariseAlarms([{ severity: 'CRITICAL', acknowledged: true, count: 4 }]).p1Unack).toBe(
      0,
    );
  });

  it('reads no rows as no active alarms', () => {
    expect(summariseAlarms([])).toEqual({ p1: 0, p2: 0, p3: 0, unack: 0, p1Unack: 0 });
  });

  it('counts on each tile exactly the alarms the list it opens holds (shared-ui isOnTile)', () => {
    // Every (severity, acknowledged) pair activeAlertCounts can return, each
    // with a distinct count so that a row counted twice or dropped shows.
    const rows: AlarmCountRow[] = ALL_SEVERITIES.flatMap((severity, s) =>
      [false, true].map((acknowledged, a) => ({ severity, acknowledged, count: 2 ** (2 * s + a) })),
    );

    const counts = summariseAlarms(rows);

    for (const tile of ANNUNCIATOR_FILTERS) {
      const onTile = rows
        .filter((row) => isOnTile(tile, { ...row, resolved: false }))
        .reduce((sum, row) => sum + row.count, 0);
      expect(counts[tile]).toBe(onTile);
    }
  });
});
