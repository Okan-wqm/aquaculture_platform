/**
 * AnnunciatorPriority — the console's alarm priority scale and the
 * `?priority=` filter the annunciator writes and the alarm list reads.
 *
 * Pins the severity mapping (P1 critical, P2 high, P3 medium and warning; low
 * and info are advisories on no tile), that each priority's severity set is
 * the exact inverse of that mapping, and that only the four tile ids parse as
 * a filter.
 */
import { describe, expect, it } from 'vitest';

import type { AlertSeverity } from '../../../../generated/graphql-types';
import {
  ALARM_PRIORITIES,
  ANNUNCIATOR_FILTERS,
  parseAnnunciatorFilter,
  priorityOf,
  severitiesOf,
} from '../AnnunciatorPriority';

const ALL_SEVERITIES: readonly AlertSeverity[] = [
  'CRITICAL',
  'HIGH',
  'MEDIUM',
  'WARNING',
  'LOW',
  'INFO',
];

describe('priorityOf', () => {
  it('maps critical to P1, high to P2 and medium and warning to P3', () => {
    expect(priorityOf('CRITICAL')).toBe('p1');
    expect(priorityOf('HIGH')).toBe('p2');
    expect(priorityOf('MEDIUM')).toBe('p3');
    expect(priorityOf('WARNING')).toBe('p3');
  });

  it('puts low and info on no tile', () => {
    expect(priorityOf('LOW')).toBeNull();
    expect(priorityOf('INFO')).toBeNull();
  });
});

describe('severitiesOf', () => {
  it('lists the severities each priority covers', () => {
    expect(severitiesOf('p1')).toEqual(['CRITICAL']);
    expect(severitiesOf('p2')).toEqual(['HIGH']);
    expect([...severitiesOf('p3')].sort()).toEqual(['MEDIUM', 'WARNING']);
  });

  it('is the exact inverse of priorityOf — no severity on two priorities, none dropped', () => {
    for (const severity of ALL_SEVERITIES) {
      const priority = priorityOf(severity);
      const holders = ALARM_PRIORITIES.filter((p) => severitiesOf(p).includes(severity));
      expect(holders).toEqual(priority === null ? [] : [priority]);
    }
  });
});

describe('parseAnnunciatorFilter', () => {
  it('accepts the four tile ids', () => {
    expect(ANNUNCIATOR_FILTERS).toEqual(['p1', 'p2', 'p3', 'unack']);
    for (const filter of ANNUNCIATOR_FILTERS) {
      expect(parseAnnunciatorFilter(filter)).toBe(filter);
    }
  });

  it('reads anything else as no filter', () => {
    for (const raw of [null, '', 'P1', 'p4', 'all', ' p1', 'critical']) {
      expect(parseAnnunciatorFilter(raw)).toBeNull();
    }
  });
});
