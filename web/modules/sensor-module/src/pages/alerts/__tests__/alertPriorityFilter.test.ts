/**
 * alertPriorityFilter — an annunciator tile's `?priority=` as the alarm list's
 * own filters, and back.
 *
 * A tile opens the list on the alarms it counted (shared-ui annunciatorScope):
 * P1/P2/P3 on the OPEN (unresolved) alarms of that priority's severities, the
 * "Open" status tab; UNACK on the open alarms of every priority nobody has
 * acknowledged, the "Active" tab over the P1–P3 severities. The reverse is
 * derived from the forward mapping, so a filter the user picks by hand that
 * equals a tile's is that tile, and anything else is no tile at all.
 */
import { describe, expect, it } from 'vitest';

import { ANNUNCIATOR_FILTERS } from '@aquaculture/shared-ui';

import { filterForPriority, priorityForFilter } from '../alertPriorityFilter';
import { SEVERITY_CHOICES, severitiesOfChoice, severityChoiceOf } from '../severityChoices';

describe('filterForPriority', () => {
  it('narrows P1 to open critical, P2 to open high and P3 to open medium and warning alarms', () => {
    expect(filterForPriority('p1')).toEqual({ status: 'open', severities: ['CRITICAL'] });
    expect(filterForPriority('p2')).toEqual({ status: 'open', severities: ['HIGH'] });
    const p3 = filterForPriority('p3');
    expect(p3.status).toBe('open');
    expect([...p3.severities].sort()).toEqual(['MEDIUM', 'WARNING']);
  });

  it('turns UNACK into the unacknowledged open alarms of every priority, advisories left out', () => {
    const unack = filterForPriority('unack');
    expect(unack.status).toBe('active');
    expect([...unack.severities].sort()).toEqual(['CRITICAL', 'HIGH', 'MEDIUM', 'WARNING']);
  });

  it('shows every alarm without a priority', () => {
    expect(filterForPriority(null)).toEqual({ status: 'all', severities: [] });
  });
});

describe('priorityForFilter', () => {
  it('round-trips every tile', () => {
    for (const priority of ANNUNCIATOR_FILTERS) {
      expect(priorityForFilter(filterForPriority(priority))).toBe(priority);
    }
  });

  it('reads a set in any order', () => {
    expect(priorityForFilter({ status: 'open', severities: ['WARNING', 'MEDIUM'] })).toBe('p3');
  });

  it('is no tile for every alarm or for a filter no tile shows', () => {
    expect(priorityForFilter({ status: 'all', severities: [] })).toBeNull();
    expect(priorityForFilter({ status: 'resolved', severities: [] })).toBeNull();
    // Cleared alarms are on no tile, so every-status CRITICAL is not P1.
    expect(priorityForFilter({ status: 'all', severities: ['CRITICAL'] })).toBeNull();
    expect(priorityForFilter({ status: 'active', severities: ['CRITICAL'] })).toBeNull();
    // Advisories are on no tile, so unacknowledged over every severity is not UNACK.
    expect(priorityForFilter({ status: 'active', severities: [] })).toBeNull();
    expect(priorityForFilter({ status: 'open', severities: ['MEDIUM'] })).toBeNull();
    expect(priorityForFilter({ status: 'open', severities: ['LOW'] })).toBeNull();
  });
});

describe('severity choices', () => {
  it('offers a choice for every severity set a tile can ask for', () => {
    for (const priority of ANNUNCIATOR_FILTERS) {
      const { severities } = filterForPriority(priority);
      const choice = severityChoiceOf(severities);
      expect([...severitiesOfChoice(choice)].sort()).toEqual([...severities].sort());
    }
  });

  it('keeps every single severity selectable, beside the P1–P3 and P3 groups', () => {
    expect(SEVERITY_CHOICES.map((choice) => choice.value)).toEqual([
      'all',
      'alarms',
      'CRITICAL',
      'HIGH',
      'p3',
      'WARNING',
      'MEDIUM',
      'LOW',
      'INFO',
    ]);
    expect(severitiesOfChoice('all')).toEqual([]);
    expect([...severitiesOfChoice('alarms')].sort()).toEqual([
      'CRITICAL',
      'HIGH',
      'MEDIUM',
      'WARNING',
    ]);
    expect(severitiesOfChoice('LOW')).toEqual(['LOW']);
  });
});
