/** Shared period math — month + ISO-week edges (week 53, year boundary). */
import { isoWeekRange, isStandingStockStale, monthRange } from '../../assembly/period.util';

describe('period.util', () => {
  it('monthRange covers the month inclusively (leap February)', () => {
    expect(monthRange(2026, 6)).toEqual({ fromDate: '2026-06-01', toDate: '2026-06-30' });
    expect(monthRange(2024, 2)).toEqual({ fromDate: '2024-02-01', toDate: '2024-02-29' });
  });

  it('isoWeekRange anchors week 1 on the week containing January 4th', () => {
    // 2026-01-04 is a Sunday → ISO week 1 of 2026 runs Mon 2025-12-29 .. Sun 2026-01-04.
    expect(isoWeekRange(2026, 1)).toEqual({ fromDate: '2025-12-29', toDate: '2026-01-04' });
  });

  it('isoWeekRange handles week 53 of a long ISO year (2026 has 53 weeks)', () => {
    expect(isoWeekRange(2026, 53)).toEqual({ fromDate: '2026-12-28', toDate: '2027-01-03' });
  });

  it('isoWeekRange mid-year sanity (week 27 of 2026)', () => {
    expect(isoWeekRange(2026, 27)).toEqual({ fromDate: '2026-06-29', toDate: '2026-07-05' });
  });

  describe('isStandingStockStale (FARM-HIGH-005)', () => {
    // Filing normally happens by the 7th of the month AFTER the period.
    const now = new Date('2026-07-11T09:00:00.000Z');

    it('the just-closed month (filed the following month) is FRESH', () => {
      // June report filed in July — period end is last month → fresh.
      expect(isStandingStockStale('2026-06-30', now)).toBe(false);
    });

    it('the current in-progress month is FRESH', () => {
      expect(isStandingStockStale('2026-07-31', now)).toBe(false);
    });

    it('a month before last is STALE (a full extra month has elapsed)', () => {
      // May report filed in July — over a month of post-period movement → stale.
      expect(isStandingStockStale('2026-05-31', now)).toBe(true);
    });

    it('a long-past historical month is STALE', () => {
      expect(isStandingStockStale('2020-01-31', now)).toBe(true);
    });

    it('is calendar-based across a year boundary (Jan now, Dec period is fresh)', () => {
      const janNow = new Date('2026-01-05T09:00:00.000Z');
      expect(isStandingStockStale('2025-12-31', janNow)).toBe(false);
      expect(isStandingStockStale('2025-11-30', janNow)).toBe(true);
    });
  });
});
