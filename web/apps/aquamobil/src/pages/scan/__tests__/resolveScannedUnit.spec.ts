/**
 * resolveScannedUnit specs — tag formats seen in the field.
 *
 * Farms do not re-print their tags to suit an app. The same site can carry tags
 * that encode a bare code, a URL, or the container UUID, so the resolver has to
 * accept all three. These specs pin that tolerance, and equally pin that it does
 * NOT become a fuzzy match: a tag from another site must resolve to nothing
 * rather than to the nearest-looking unit, because a mortality logged against
 * the wrong pen is worse than a scan that fails.
 */
import { describe, expect, it } from 'vitest';

import { resolveScannedUnit } from '../ScanPage';

import type { Tank } from '@/types';

function tank(overrides: Partial<Tank>): Tank {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'North 7',
    code: 'U-07',
    volume: 1200,
    status: 'ACTIVE',
    currentBiomass: 0,
    maxBiomass: 0,
    batchMetrics: null,
    siteId: 'site-a',
    ...overrides,
  };
}

const UNITS: Tank[] = [
  tank({}),
  tank({ id: '22222222-2222-4222-8222-222222222222', name: 'North 3', code: 'U-03' }),
];

describe('resolveScannedUnit', () => {
  it('matches a bare unit code', () => {
    expect(resolveScannedUnit('U-07', UNITS)?.code).toBe('U-07');
  });

  it('matches case-insensitively — tags are printed inconsistently', () => {
    expect(resolveScannedUnit('u-07', UNITS)?.code).toBe('U-07');
  });

  it('matches the last segment of a URL tag', () => {
    expect(resolveScannedUnit('https://farm.example/units/U-03', UNITS)?.code).toBe('U-03');
  });

  it('ignores a query string or fragment on a URL tag', () => {
    expect(resolveScannedUnit('https://farm.example/u/U-03?src=rail', UNITS)?.code).toBe('U-03');
  });

  it('matches the container UUID', () => {
    expect(resolveScannedUnit('11111111-1111-4111-8111-111111111111', UNITS)?.code).toBe('U-07');
  });

  it('matches the unit name', () => {
    expect(resolveScannedUnit('North 3', UNITS)?.code).toBe('U-03');
  });

  it('trims surrounding whitespace', () => {
    expect(resolveScannedUnit('  U-07\n', UNITS)?.code).toBe('U-07');
  });

  it('returns null for a tag from another site rather than guessing', () => {
    // The dangerous failure mode: a near-miss silently resolving to a real unit
    // would let a worker log against a pen they are not standing at.
    expect(resolveScannedUnit('U-99', UNITS)).toBeNull();
    expect(resolveScannedUnit('U-0', UNITS)).toBeNull();
    expect(resolveScannedUnit('U-077', UNITS)).toBeNull();
  });

  it('returns null for empty or whitespace-only input', () => {
    expect(resolveScannedUnit('', UNITS)).toBeNull();
    expect(resolveScannedUnit('   ', UNITS)).toBeNull();
  });

  it('returns null when the unit list has not loaded', () => {
    expect(resolveScannedUnit('U-07', [])).toBeNull();
  });
});
