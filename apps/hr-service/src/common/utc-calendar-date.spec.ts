import {
  addUtcCalendarDays,
  formatUtcCalendarYearMonth,
  getUtcCalendarWeekday,
  toIsoCalendarDate,
  toUtcCalendarDate,
} from './utc-calendar-date';

const HOST_TIMEZONES = ['UTC', 'Etc/GMT+6', 'Etc/GMT-9'] as const;

describe('UTC calendar-date SSoT', () => {
  const originalTimezone = process.env.TZ;

  afterEach(() => {
    if (originalTimezone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTimezone;
    }
  });

  it.each(HOST_TIMEZONES)(
    'keeps year, month, weekday and day increments stable under host timezone %s',
    (timezone) => {
      process.env.TZ = timezone;

      const januaryStart = toUtcCalendarDate('2026-01-01');
      const monday = toUtcCalendarDate('2026-03-02');

      expect(formatUtcCalendarYearMonth(januaryStart)).toBe('202601');
      expect(getUtcCalendarWeekday(monday)).toBe(1);
      expect(toIsoCalendarDate(addUtcCalendarDays(monday, 1))).toBe('2026-03-03');
    },
  );

  it('rejects invalid dates and non-integral calendar increments', () => {
    expect(() => toUtcCalendarDate('not-a-date')).toThrow(RangeError);
    expect(() => toUtcCalendarDate('2026-02-30')).toThrow(RangeError);
    expect(() => addUtcCalendarDays(new Date('2026-01-01T00:00:00.000Z'), 0.5)).toThrow(RangeError);
  });
});
