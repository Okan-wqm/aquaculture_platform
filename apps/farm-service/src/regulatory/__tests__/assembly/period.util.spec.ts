/** Shared period math — month + ISO-week edges (week 53, year boundary). */
import { isoWeekRange, monthRange } from '../../assembly/period.util';

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
});
