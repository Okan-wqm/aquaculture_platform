/**
 * Production row rules: freshness from gateways and measurements, the lowest
 * oxygen at each unit's latest measurement against the configured limits,
 * temperature newest and hottest, feed against plan (cancelled plans count
 * nowhere), and the tank count only where a system declares one.
 */
import { describe, expect, it } from 'vitest';

import {
  STALE_AFTER_MS,
  dataFreshness,
  feedProgress,
  lowestOxygen,
  oxygenLevel,
  oxygenLimitOf,
  tankCountOf,
  temperatureOf,
} from '../production';

const NOW = new Date('2026-10-17T10:42:00Z');
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

describe('dataFreshness', () => {
  it('is good while a gateway is online, whatever the age of the newest report', () => {
    expect(
      dataFreshness([{ isOnline: true, lastSeenAt: ago(STALE_AFTER_MS * 3) }], [], NOW),
    ).toEqual({
      state: 'good',
      at: new Date(ago(STALE_AFTER_MS * 3)),
    });
  });

  it('is stale when every gateway is offline and the newest data is old', () => {
    const freshness = dataFreshness(
      [{ isOnline: false, lastSeenAt: ago(STALE_AFTER_MS + 1) }],
      [{ tankId: 't', equipmentId: null, dissolvedOxygen: 7, measuredAt: ago(STALE_AFTER_MS * 2) }],
      NOW,
    );
    expect(freshness.state).toBe('stale');
  });

  it('is good from a recent measurement alone, and none without any data', () => {
    expect(
      dataFreshness(
        [],
        [{ tankId: 't', equipmentId: null, dissolvedOxygen: 7, measuredAt: ago(60_000) }],
        NOW,
      ).state,
    ).toBe('good');
    expect(dataFreshness([], [], NOW)).toEqual({ state: 'none' });
  });
});

describe('lowestOxygen', () => {
  const limit = { criticalMin: 6, warningMin: 6.5 };

  it('compares each unit at its latest measurement and names the unit', () => {
    const reading = lowestOxygen(
      [
        { tankId: 'a', equipmentId: null, dissolvedOxygen: 6.2, measuredAt: ago(1) },
        { tankId: 'b', equipmentId: null, dissolvedOxygen: 7.1, measuredAt: ago(2) },
        { tankId: 'a', equipmentId: null, dissolvedOxygen: 2.0, measuredAt: ago(3) },
      ],
      new Map([['a', 'B-12']]),
      limit,
    );
    expect(reading).toEqual({ value: 6.2, unitCode: 'B-12', limit: 6.5, level: 'warning' });
  });

  it('reads a measurement filed on equipment and skips one without oxygen', () => {
    expect(
      lowestOxygen(
        [
          { tankId: null, equipmentId: 'e', dissolvedOxygen: null, measuredAt: ago(1) },
          { tankId: null, equipmentId: 'e', dissolvedOxygen: 5.5, measuredAt: ago(2) },
        ],
        new Map(),
        null,
      ),
    ).toEqual({ value: 5.5, unitCode: null, limit: null, level: 'normal' });
  });

  it('has no reading without a measurement', () => {
    expect(lowestOxygen([], new Map(), limit)).toBeNull();
  });

  it('judges against the critical limit first, then the warning limit', () => {
    expect(oxygenLevel(5.9, limit)).toBe('critical');
    expect(oxygenLevel(6.4, limit)).toBe('warning');
    expect(oxygenLevel(6.5, limit)).toBe('normal');
    expect(oxygenLevel(1, { criticalMin: null, warningMin: null })).toBe('normal');
  });

  it('finds the dissolved-oxygen config among the active ones', () => {
    expect(
      oxygenLimitOf([
        { code: 'ph', criticalMin: 6, warningMin: 6.5 },
        { code: 'dissolved_oxygen', criticalMin: 4, warningMin: 5 },
      ]),
    ).toEqual({ criticalMin: 4, warningMin: 5 });
    expect(oxygenLimitOf([])).toBeNull();
  });
});

describe('temperatureOf', () => {
  it('takes the newest reading and names the hottest unit when there are several', () => {
    expect(
      temperatureOf(
        [
          { unitId: 'a', celsius: 22.1, measuredAt: ago(1) },
          { unitId: 'b', celsius: 24.6, measuredAt: ago(9) },
          { unitId: 'c', celsius: null, measuredAt: null },
        ],
        new Map([
          ['a', 'B-12'],
          ['b', 'B-03'],
        ]),
      ),
    ).toEqual({ latest: 22.1, hottest: { unitCode: 'B-03', celsius: 24.6 } });
  });

  it('names no hottest unit for one reading, and has nothing without readings', () => {
    expect(
      temperatureOf([{ unitId: 'a', celsius: 20, measuredAt: ago(1) }], new Map([['a', 'A']])),
    ).toEqual({
      latest: 20,
      hottest: null,
    });
    expect(temperatureOf([], new Map())).toBeNull();
  });
});

describe('feedProgress and tankCountOf', () => {
  it('adds meals and unplanned feeding against the plan, leaving cancelled plans out', () => {
    expect(
      feedProgress([
        {
          unitId: 'a',
          unitCode: 'A',
          status: 'in_progress',
          plannedTotalKg: 100,
          unplannedActualKg: 5,
          meals: [{ actualKg: 45 }],
        },
        {
          unitId: 'b',
          unitCode: 'B',
          status: 'cancelled',
          plannedTotalKg: 80,
          unplannedActualKg: 0,
          meals: null,
        },
      ]),
    ).toEqual({ plannedKg: 100, actualKg: 50, ratio: 0.5 });
    expect(feedProgress([])).toBeNull();
  });

  it('counts tanks only where a system declares them', () => {
    expect(tankCountOf([{ tankCount: 10 }, { tankCount: null }, { tankCount: 8 }])).toBe(18);
    expect(tankCountOf([{ tankCount: null }])).toBeNull();
  });
});
