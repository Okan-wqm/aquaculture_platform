/**
 * Production row rules: freshness from gateways and the shown readings, the
 * lowest resolved oxygen among the fed units against the configured
 * parameter (with its source and unit), temperature newest and hottest, feed
 * against plan and against the meals scheduled so far (cancelled and skipped
 * plans count nowhere — on the wire values the API sends), and the tank count
 * only where a system declares one.
 */
import { describe, expect, it } from 'vitest';

import {
  FEED_BEHIND_TOLERANCE,
  STALE_AFTER_MS,
  dataFreshness,
  feedProgress,
  lowestOxygen,
  oxygenLevel,
  oxygenParameterOf,
  plannedUnitIds,
  tankCountOf,
  temperatureOf,
  type DayPlanRecord,
  type OxygenParameter,
  type UnitReadingRecord,
} from '../production';

const NOW = new Date('2026-10-17T10:42:00Z');
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const ahead = (ms: number): string => new Date(NOW.getTime() + ms).toISOString();
const HOUR = 3_600_000;

function present<T>(value: T | null): T {
  if (value === null) throw new Error('expected a value');
  return value;
}

describe('dataFreshness', () => {
  it('is good while a gateway is online, whatever the age of the newest report', () => {
    expect(
      dataFreshness([{ id: 'g', isOnline: true, lastSeenAt: ago(STALE_AFTER_MS * 3) }], [], NOW),
    ).toEqual({
      state: 'good',
      at: new Date(ago(STALE_AFTER_MS * 3)),
    });
  });

  it('is stale when every gateway is offline and the newest reading is old', () => {
    const freshness = dataFreshness(
      [{ id: 'g', isOnline: false, lastSeenAt: ago(STALE_AFTER_MS + 1) }],
      [ago(STALE_AFTER_MS * 2)],
      NOW,
    );
    expect(freshness.state).toBe('stale');
  });

  it('is good from a recent reading alone, and none without any data', () => {
    expect(dataFreshness([], [ago(60_000), null, undefined], NOW).state).toBe('good');
    expect(dataFreshness([], [], NOW)).toEqual({ state: 'none' });
  });
});

describe('lowestOxygen', () => {
  const parameter: OxygenParameter = {
    id: 'pc-do',
    unit: 'mg/L',
    criticalMin: 6,
    warningMin: 6.5,
  };
  const reading = (
    unitId: string,
    value: number | null,
    sourceKind: UnitReadingRecord['sourceKind'],
    observedAt: string | null,
  ): UnitReadingRecord => ({
    point: { id: unitId },
    value,
    unit: 'mg/L',
    sourceKind,
    observedAt,
    unresolved: value === null ? 'NO_SOURCE' : null,
  });
  const codes = new Map([
    ['a', 'B-12'],
    ['b', 'B-03'],
    ['c', 'B-07'],
  ]);

  it('takes the lowest resolved value, naming its unit, source, unit of measure and age', () => {
    const state = lowestOxygen(
      [
        reading('a', 6.2, 'CHANNEL_PRIMARY', ago(60_000)),
        reading('b', 7.1, 'MANUAL', ago(2 * HOUR)),
        reading('c', null, null, null),
      ],
      codes,
      parameter,
    );
    expect(state).toEqual({
      kind: 'reading',
      reading: {
        value: 6.2,
        unit: 'mg/L',
        unitCode: 'B-12',
        limit: 6.5,
        level: 'warning',
        source: 'live',
        observedAt: new Date(ago(60_000)),
      },
    });
  });

  it('says a person’s sample is manual, a backup channel live', () => {
    const manual = lowestOxygen([reading('b', 5.5, 'MANUAL', ago(HOUR))], codes, parameter);
    expect(manual.kind === 'reading' && manual.reading.source).toBe('manual');
    const backup = lowestOxygen([reading('b', 5.5, 'CHANNEL_BACKUP', ago(HOUR))], codes, parameter);
    expect(backup.kind === 'reading' && backup.reading.source).toBe('live');
  });

  it('has no reading when no unit resolved a value, and counts no unit it did not ask for', () => {
    expect(lowestOxygen([reading('c', null, null, null)], codes, parameter)).toEqual({
      kind: 'noReading',
    });
    expect(lowestOxygen([reading('stranger', 1, 'MANUAL', ago(HOUR))], codes, parameter)).toEqual({
      kind: 'noReading',
    });
  });

  it('judges against the critical limit first, then the warning limit', () => {
    expect(oxygenLevel(5.9, parameter)).toBe('critical');
    expect(oxygenLevel(6.4, parameter)).toBe('warning');
    expect(oxygenLevel(6.5, parameter)).toBe('normal');
    expect(oxygenLevel(1, { criticalMin: null, warningMin: null })).toBe('normal');
  });

  it('finds the dissolved-oxygen parameter, with its id and unit, among the active ones', () => {
    expect(
      oxygenParameterOf([
        { id: 'pc-ph', code: 'ph', unit: 'pH', criticalMin: 6, warningMin: 6.5 },
        { id: 'pc-do', code: 'dissolved_oxygen', unit: 'mg/L', criticalMin: 4, warningMin: null },
      ]),
    ).toEqual({ id: 'pc-do', unit: 'mg/L', criticalMin: 4, warningMin: null });
    expect(oxygenParameterOf([])).toBeNull();
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

describe('feedProgress', () => {
  const plan = (overrides: Partial<DayPlanRecord>): DayPlanRecord => ({
    id: 'p',
    unitId: 'a',
    unitCode: 'A',
    status: 'IN_PROGRESS',
    plannedTotalKg: 100,
    unplannedActualKg: 0,
    meals: null,
    ...overrides,
  });

  it('adds meals and unplanned feeding against the plan, leaving cancelled and skipped plans out', () => {
    expect(
      feedProgress(
        [
          plan({
            unplannedActualKg: 5,
            meals: [{ actualKg: 45, plannedKg: 50, scheduledAt: ago(HOUR), status: 'FED' }],
          }),
          plan({ unitId: 'b', status: 'CANCELLED', plannedTotalKg: 80 }),
          plan({ unitId: 'c', status: 'SKIPPED', plannedTotalKg: 60 }),
        ],
        NOW,
      ),
    ).toEqual({
      plannedKg: 100,
      actualKg: 50,
      ratio: 0.5,
      plannedByNowRatio: 0.5,
      behind: false,
    });
    expect(feedProgress([plan({ status: 'CANCELLED' })], NOW)).toBeNull();
    expect(feedProgress([], NOW)).toBeNull();
  });

  it('marks the share planned by now from the meals scheduled so far, and is behind past the tolerance', () => {
    const meals = [
      { actualKg: 20, plannedKg: 40, scheduledAt: ago(3 * HOUR), status: 'FED' as const },
      { actualKg: 0, plannedKg: 40, scheduledAt: ago(HOUR), status: 'MISSED' as const },
      { actualKg: 0, plannedKg: 20, scheduledAt: ahead(HOUR), status: 'SCHEDULED' as const },
      { actualKg: 0, plannedKg: 30, scheduledAt: ago(HOUR), status: 'CANCELLED' as const },
    ];
    const progress = present(feedProgress([plan({ meals })], NOW));
    // 80 of 100 kg was due by now; 20 kg (20%) was fed.
    expect(progress.plannedByNowRatio).toBeCloseTo(0.8);
    expect(progress.ratio).toBeCloseTo(0.2);
    expect(progress.behind).toBe(true);

    const onTrack = present(
      feedProgress(
        [
          plan({
            meals: [
              {
                actualKg: 45,
                plannedKg: 50,
                scheduledAt: ago(HOUR),
                status: 'FED',
              },
            ],
          }),
        ],
        NOW,
      ),
    );
    // 45% fed against 50% due: within the tolerance.
    expect(0.5 - onTrack.ratio).toBeLessThan(FEED_BEHIND_TOLERANCE);
    expect(onTrack.behind).toBe(false);
  });

  it('draws no marker when no plan names its meals', () => {
    expect(feedProgress([plan({ meals: null, unplannedActualKg: 10 })], NOW)).toEqual({
      plannedKg: 100,
      actualKg: 10,
      ratio: 0.1,
      plannedByNowRatio: null,
      behind: false,
    });
  });
});

describe('tankCountOf and plannedUnitIds', () => {
  it('counts tanks only where a system declares them', () => {
    expect(
      tankCountOf([
        { id: '1', tankCount: 10 },
        { id: '2', tankCount: null },
        { id: '3', tankCount: 8 },
      ]),
    ).toBe(18);
    expect(tankCountOf([{ id: '1', tankCount: null }])).toBeNull();
  });

  it('lists the planned units once each, sorted', () => {
    expect(
      plannedUnitIds([
        {
          id: '1',
          unitId: 'b',
          unitCode: 'B',
          status: 'PLANNED',
          plannedTotalKg: 1,
          unplannedActualKg: 0,
        },
        {
          id: '2',
          unitId: 'a',
          unitCode: 'A',
          status: 'PLANNED',
          plannedTotalKg: 1,
          unplannedActualKg: 0,
        },
        {
          id: '3',
          unitId: 'b',
          unitCode: 'B',
          status: 'PLANNED',
          plannedTotalKg: 1,
          unplannedActualKg: 0,
        },
      ]),
    ).toEqual(['a', 'b']);
  });
});
