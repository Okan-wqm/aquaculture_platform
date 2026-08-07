/**
 * Four surfaces render the same pen. This is the file that makes them agree, so
 * these tests pin the two things that went wrong when they did not:
 *
 *   • a status with no entry — ORPHAN-HIGH-583 crashed the unit detail on a
 *     FALLOW pen, which is a routine state between production cycles;
 *   • a nullable metric printed as 0, which states a fact the farm never gave.
 */
import { describe, expect, it } from 'vitest';

import type { Tank } from '@/types';
import {
  NO_VALUE,
  compactCount,
  fixedOrNone,
  groupUnitsBySite,
  unitStatusMeta,
} from '@/utils/unit-display';

const ALL_STATUSES: Array<Tank['status']> = [
  'ACTIVE',
  'PREPARING',
  'CLEANING',
  'MAINTENANCE',
  'HARVESTING',
  'FALLOW',
  'QUARANTINE',
  'INACTIVE',
];

function unit(id: string, siteId: string | null): Tank {
  return {
    id,
    name: id,
    code: id,
    volume: 0,
    status: 'ACTIVE',
    siteId,
    currentQuantity: 0,
    currentBiomass: 0,
    maxBiomass: 0,
    batchMetrics: null,
  };
}

describe('unitStatusMeta', () => {
  it.each(ALL_STATUSES)('gives %s both a word and a tone', (status) => {
    const meta = unitStatusMeta(status);

    // The word is what a colourblind worker reads, so it is not optional.
    expect(meta.label.length).toBeGreaterThan(0);
    expect(['ok', 'warn', 'crit']).toContain(meta.tone);
  });

  it('never calls a cleaning or fallowing pen "Inactive"', () => {
    // TankCard's lookup omits both and falls through to the INACTIVE row, which
    // is how a cleaning pen came to be labelled inactive. The SSoT names them.
    expect(unitStatusMeta('CLEANING').label).toBe('Cleaning');
    expect(unitStatusMeta('FALLOW').label).toBe('Fallow');
  });
});

describe('groupUnitsBySite', () => {
  it('labels a single-site tenant "Units" rather than "Site 1"', () => {
    const groups = groupUnitsBySite([unit('U-01', 'site-a'), unit('U-02', 'site-a')]);

    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Units');
    expect(groups[0].units).toHaveLength(2);
  });

  it('numbers multiple sites in first-seen order', () => {
    const groups = groupUnitsBySite([
      unit('U-01', 'site-b'),
      unit('U-02', 'site-a'),
      unit('U-03', 'site-b'),
    ]);

    expect(groups.map((g) => g.label)).toEqual(['Site 1', 'Site 2']);
    expect(groups[0].units.map((u) => u.id)).toEqual(['U-01', 'U-03']);
  });

  it('keeps units with no site rather than dropping them', () => {
    const groups = groupUnitsBySite([unit('U-01', null)]);

    expect(groups[0].siteId).toBe('unassigned');
    expect(groups[0].units).toHaveLength(1);
  });
});

describe('fixedOrNone', () => {
  it('renders a missing metric as unknown, not as zero', () => {
    expect(fixedOrNone(null, 0)).toBe(NO_VALUE);
    expect(fixedOrNone(undefined, 1)).toBe(NO_VALUE);
  });

  it('still renders a real zero', () => {
    // 0 % capacity is a legitimate reading for an empty pen; only the ABSENCE
    // of a figure is unknown.
    expect(fixedOrNone(0, 0)).toBe('0');
  });

  it('formats to the requested precision', () => {
    expect(fixedOrNone(28.44, 1)).toBe('28.4');
  });
});

describe('compactCount', () => {
  it('abbreviates the counts a pen actually holds', () => {
    expect(compactCount(18_200)).toBe('18.2K');
    expect(compactCount(1_400_000)).toBe('1.4M');
  });

  it('leaves small counts exact', () => {
    expect(compactCount(920)).toBe('920');
  });
});
