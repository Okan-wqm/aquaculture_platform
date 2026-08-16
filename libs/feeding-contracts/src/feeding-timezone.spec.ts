import {
  FEEDING_LOCAL_TIME_POLICY_V1,
  FEEDING_UTC_TIMEZONE,
  FeedingTimezoneValidationError,
  compileFeedingTimezone,
  feedingClockSnapshot,
  feedingShiftLocalDate,
  feedingShiftLocalMinute,
  feedingWallTimeToInstant,
} from './feeding-timezone';

describe('feeding timezone authority', () => {
  it('admits only canonical IANA names at the raw-string boundary', () => {
    expect(compileFeedingTimezone('Europe/Oslo')).toBe('Europe/Oslo');
    expect(FEEDING_UTC_TIMEZONE).toBe('UTC');
    expect(() => compileFeedingTimezone('US/Eastern')).toThrow(FeedingTimezoneValidationError);
    expect(() => compileFeedingTimezone('Not/AZone')).toThrow(FeedingTimezoneValidationError);
  });

  it('projects a supplied instant without consulting the process clock', () => {
    const observedAt = new Date('2026-08-08T21:45:12.000Z');
    expect(feedingClockSnapshot(observedAt, compileFeedingTimezone('Europe/Istanbul'))).toEqual({
      at: observedAt,
      timezone: 'Europe/Istanbul',
      localDate: '2026-08-09',
      localTime: '00:45',
      localWeekday: 7,
    });
  });

  it('uses the declared next-valid-instant policy for a DST spring gap', () => {
    expect(FEEDING_LOCAL_TIME_POLICY_V1.nonexistentLocalTime).toBe('next_valid_instant');
    expect(
      feedingWallTimeToInstant(
        '2026-03-29',
        '02:30',
        compileFeedingTimezone('Europe/Oslo'),
      ).toISOString(),
    ).toBe('2026-03-29T01:00:00.000Z');
  });

  it('uses the declared earlier-instant policy for a DST autumn fold', () => {
    expect(FEEDING_LOCAL_TIME_POLICY_V1.ambiguousLocalTime).toBe('earlier_instant');
    expect(
      feedingWallTimeToInstant(
        '2026-10-25',
        '02:30',
        compileFeedingTimezone('Europe/Oslo'),
      ).toISOString(),
    ).toBe('2026-10-25T00:30:00.000Z');
  });

  it('rejects impossible calendar values and shifts minutes across day boundaries', () => {
    expect(() => feedingWallTimeToInstant('2026-02-30', '08:00', FEEDING_UTC_TIMEZONE)).toThrow(
      FeedingTimezoneValidationError,
    );
    expect(feedingShiftLocalMinute('00:15', -30)).toEqual({
      dayOffset: -1,
      localTime: '23:45',
    });
    expect(feedingShiftLocalDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(feedingShiftLocalDate('2028-03-01', -1)).toBe('2028-02-29');
  });
});
