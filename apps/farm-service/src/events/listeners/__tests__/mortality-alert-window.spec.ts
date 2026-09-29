import {
  cumulativeRateCrossing,
  shiftCalendarDay,
  summarizeMortalityWindow,
} from '../mortality-alert-window';

/** FARM-HIGH-334 — calendar-day arithmetic and the edge-triggered cumulative rule. */
describe('mortality alert window', () => {
  it('shifts calendar days across month and leap boundaries without a timezone', () => {
    // SCENARIO: day arithmetic on stored `date` strings.
    // EXPECTS: pure calendar math — no midnight/zone can move a day.
    expect(shiftCalendarDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftCalendarDay('2028-03-01', -1)).toBe('2028-02-29');
    expect(shiftCalendarDay('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftCalendarDay('2026-09-29', -6)).toBe('2026-09-23');
  });

  it("counts the event's own day and splits the trend window 4 recent / 3 earlier days", () => {
    // SCENARIO: deaths spread over a 7-day window ending 2026-09-29.
    // EXPECTS: the day's own count, the 7-day average and an increasing trend.
    const summary = summarizeMortalityWindow(
      [
        { day: '2026-09-23', count: 1 },
        { day: '2026-09-25', count: 1 },
        { day: '2026-09-27', count: 4 },
        { day: '2026-09-29', count: 8 },
      ],
      '2026-09-29',
    );
    expect(summary.dayCount).toBe(8);
    expect(summary.weeklyAverage).toBe(2);
    expect(summary.trend).toBe('increasing');
  });

  it.each([
    // [rate now, total now, this record, expected]
    [5.2, 52, 4, 'warning'], // 4.8% → 5.2%: crosses 5%
    [12, 50, 10, 'critical'], // 9.6% → 12%: crosses 10% (warning passed earlier)
    [12, 60, 50, 'critical'], // 2% → 12%: one record crosses both — critical wins
    [12, 50, 5, null], // 10.8% → 12%: already above — no re-fire
    [6, 60, 5, null], // 5.5% → 6%: already above warning, below critical
    [4, 40, 40, null], // 0% → 4%: below every threshold
  ] as const)(
    'rate %p with total %p after a record of %p crosses → %p',
    (newMortalityRate, newTotalMortality, quantity, expected) => {
      // SCENARIO: a record moves the cumulative rate.
      // EXPECTS: an alert only for the record that crosses a threshold.
      expect(
        cumulativeRateCrossing(
          { newMortalityRate, newTotalMortality, quantity },
          { warning: 5, critical: 10 },
        ),
      ).toBe(expected);
    },
  );
});
