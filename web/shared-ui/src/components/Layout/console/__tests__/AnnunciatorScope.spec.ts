/**
 * AnnunciatorScope — the alarms each annunciator tile stands for.
 *
 * One declaration serves both sides of a tile: the shell counts the alarms on
 * it (summariseAlarms) and the alarm list opens filtered to the same alarms
 * (sensor-module alertPriorityFilter). Pinned here: a priority tile holds the
 * open alarms of its severities, acknowledged or not; UNACK holds the open
 * alarms of every priority that nobody has acknowledged; a cleared alarm and
 * an advisory (LOW, INFO) are on no tile.
 */
import { describe, expect, it } from 'vitest';

import type { AlertSeverity } from '../../../../generated/graphql-types';
import { ANNUNCIATOR_FILTERS } from '../AnnunciatorPriority';
import {
  ALARM_SEVERITIES,
  annunciatorScope,
  isOnTile,
  type AnnunciatorAlarm,
} from '../AnnunciatorScope';

const ALL_SEVERITIES: readonly AlertSeverity[] = [
  'CRITICAL',
  'HIGH',
  'MEDIUM',
  'WARNING',
  'LOW',
  'INFO',
];

/** Every alarm state the annunciator can meet: each severity, acknowledged or not, open or cleared. */
const EVERY_ALARM: readonly AnnunciatorAlarm[] = ALL_SEVERITIES.flatMap((severity) =>
  [false, true].flatMap((acknowledged) =>
    [false, true].map((resolved) => ({ severity, acknowledged, resolved })),
  ),
);

function sorted(severities: readonly AlertSeverity[]): AlertSeverity[] {
  return [...severities].sort();
}

describe('annunciatorScope', () => {
  it('gives each priority tile its severities, acknowledged or not', () => {
    expect(annunciatorScope('p1')).toEqual({ severities: ['CRITICAL'], unacknowledgedOnly: false });
    expect(annunciatorScope('p2')).toEqual({ severities: ['HIGH'], unacknowledgedOnly: false });
    const p3 = annunciatorScope('p3');
    expect(sorted(p3.severities)).toEqual(['MEDIUM', 'WARNING']);
    expect(p3.unacknowledgedOnly).toBe(false);
  });

  it('gives UNACK the severities of every priority, unacknowledged only', () => {
    const unack = annunciatorScope('unack');
    expect(sorted(unack.severities)).toEqual(['CRITICAL', 'HIGH', 'MEDIUM', 'WARNING']);
    expect(unack.unacknowledgedOnly).toBe(true);
  });

  it('counts the alarm severities as those on a priority, advisories excluded', () => {
    expect(sorted(ALARM_SEVERITIES)).toEqual(['CRITICAL', 'HIGH', 'MEDIUM', 'WARNING']);
  });
});

describe('isOnTile', () => {
  it('puts a cleared alarm on no tile', () => {
    for (const alarm of EVERY_ALARM.filter((a) => a.resolved)) {
      expect(ANNUNCIATOR_FILTERS.filter((tile) => isOnTile(tile, alarm))).toEqual([]);
    }
  });

  it('puts an open advisory on no tile, acknowledged or not', () => {
    for (const alarm of EVERY_ALARM.filter((a) => a.severity === 'LOW' || a.severity === 'INFO')) {
      expect(ANNUNCIATOR_FILTERS.filter((tile) => isOnTile(tile, alarm))).toEqual([]);
    }
  });

  it('puts an open alarm on its priority tile, and on UNACK while unacknowledged', () => {
    const tilesOf = (alarm: AnnunciatorAlarm): string[] =>
      ANNUNCIATOR_FILTERS.filter((tile) => isOnTile(tile, alarm));

    expect(tilesOf({ severity: 'CRITICAL', acknowledged: false, resolved: false })).toEqual([
      'p1',
      'unack',
    ]);
    expect(tilesOf({ severity: 'CRITICAL', acknowledged: true, resolved: false })).toEqual(['p1']);
    expect(tilesOf({ severity: 'HIGH', acknowledged: false, resolved: false })).toEqual([
      'p2',
      'unack',
    ]);
    expect(tilesOf({ severity: 'WARNING', acknowledged: true, resolved: false })).toEqual(['p3']);
    expect(tilesOf({ severity: 'MEDIUM', acknowledged: false, resolved: false })).toEqual([
      'p3',
      'unack',
    ]);
  });

  it('agrees with the scope it is read from, for every alarm state', () => {
    for (const tile of ANNUNCIATOR_FILTERS) {
      const scope = annunciatorScope(tile);
      for (const alarm of EVERY_ALARM) {
        const expected =
          !alarm.resolved &&
          scope.severities.includes(alarm.severity) &&
          (!scope.unacknowledgedOnly || !alarm.acknowledged);
        expect(isOnTile(tile, alarm)).toBe(expected);
      }
    }
  });
});
