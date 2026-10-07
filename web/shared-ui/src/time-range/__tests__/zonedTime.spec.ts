import { describe, expect, it } from 'vitest';

import {
  addDays,
  addMonths,
  civilDateAt,
  civilDateKey,
  compareCivilDates,
  instantOfWallClock,
  isValidTimeZone,
  wallClockAt,
  weekdayOf,
} from '../zonedTime';

const at = (iso: string): number => Date.parse(iso);

describe('wall clock ↔ instant in a named zone', () => {
  it('reads a fixed-offset zone exactly, whatever the browser zone is', () => {
    // Europe/Istanbul is UTC+3 all year.
    expect(
      instantOfWallClock({ year: 2026, month: 9, day: 16, hour: 14, minute: 0 }, 'Europe/Istanbul'),
    ).toBe(at('2026-09-16T11:00:00Z'));
    expect(wallClockAt(at('2026-09-16T21:30:00Z'), 'Europe/Istanbul')).toEqual({
      year: 2026,
      month: 9,
      day: 17,
      hour: 0,
      minute: 30,
    });
  });

  it('follows daylight saving on either side of a change', () => {
    // Europe/Oslo: CET (+1) in winter, CEST (+2) in summer; 2026-03-29 02:00 → 03:00.
    expect(
      instantOfWallClock({ year: 2026, month: 3, day: 28, hour: 12, minute: 0 }, 'Europe/Oslo'),
    ).toBe(at('2026-03-28T11:00:00Z'));
    expect(
      instantOfWallClock({ year: 2026, month: 3, day: 30, hour: 12, minute: 0 }, 'Europe/Oslo'),
    ).toBe(at('2026-03-30T10:00:00Z'));
  });

  it('moves a time inside a spring-forward gap forward by the gap', () => {
    // America/New_York 2026-03-08: 02:00 EST → 03:00 EDT; 02:30 never happens.
    const instant = instantOfWallClock(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30 },
      'America/New_York',
    );
    expect(instant).toBe(at('2026-03-08T07:30:00Z'));
    expect(wallClockAt(instant, 'America/New_York')).toMatchObject({ hour: 3, minute: 30 });
  });

  it('takes the earlier of two instants in a fall-back overlap', () => {
    // America/New_York 2026-11-01: 02:00 EDT → 01:00 EST; 01:30 happens twice.
    expect(
      instantOfWallClock(
        { year: 2026, month: 11, day: 1, hour: 1, minute: 30 },
        'America/New_York',
      ),
    ).toBe(at('2026-11-01T05:30:00Z'));
  });

  it('round-trips every hour across a year in a daylight-saving zone', () => {
    const zone = 'Europe/Oslo';
    const mappedToEarlierTwin: string[] = [];
    for (let ms = at('2026-01-01T00:00:00Z'); ms < at('2027-01-01T00:00:00Z'); ms += 3_600_000) {
      const back = instantOfWallClock(wallClockAt(ms, zone), zone);
      if (back !== ms) {
        expect(back).toBe(ms - 3_600_000);
        mappedToEarlierTwin.push(new Date(ms).toISOString());
      }
    }
    // Only the repeated hour of the autumn overlap (02:00–03:00 CET) differs.
    expect(mappedToEarlierTwin).toEqual(['2026-10-25T01:00:00.000Z']);
  });

  it('knows which zones exist', () => {
    expect(isValidTimeZone('Europe/Istanbul')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
  });
});

describe('civil dates', () => {
  it('takes the calendar day in the zone, not in UTC', () => {
    expect(civilDateAt(at('2026-09-16T22:30:00Z'), 'Europe/Istanbul')).toEqual({
      year: 2026,
      month: 9,
      day: 17,
    });
    expect(civilDateAt(at('2026-09-16T22:30:00Z'), 'UTC')).toEqual({
      year: 2026,
      month: 9,
      day: 16,
    });
  });

  it('moves across month and year ends', () => {
    expect(addDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({
      year: 2027,
      month: 1,
      day: 1,
    });
    expect(addDays({ year: 2026, month: 3, day: 1 }, -1)).toEqual({
      year: 2026,
      month: 2,
      day: 28,
    });
    expect(addMonths({ year: 2026, month: 1, day: 31 }, 1)).toEqual({
      year: 2026,
      month: 2,
      day: 1,
    });
    expect(addMonths({ year: 2026, month: 1, day: 15 }, -1)).toEqual({
      year: 2025,
      month: 12,
      day: 1,
    });
  });

  it('orders, keys and names the weekday of a day', () => {
    expect(
      compareCivilDates({ year: 2026, month: 9, day: 16 }, { year: 2026, month: 9, day: 17 }),
    ).toBeLessThan(0);
    expect(civilDateKey({ year: 2026, month: 9, day: 6 })).toBe('2026-09-06');
    // 2026-10-07 is a Wednesday.
    expect(weekdayOf({ year: 2026, month: 10, day: 7 })).toBe(3);
  });
});
