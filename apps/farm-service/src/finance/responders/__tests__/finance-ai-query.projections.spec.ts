/**
 * Projection spec for the finance farm-AI responder (PR-4): ISO bucket dates
 * and cap/truncated.
 */
import {
  projectFinanceSummary,
  projectFinanceBatchTotals,
} from '../projections';

describe('finance farm-AI projections (PR-4 read-only namespace)', () => {
  it('serializes series buckets as ISO strings and caps at 50', () => {
    const projection = projectFinanceSummary({
      currency: 'NOK',
      totalExpense: 100,
      totalRevenue: 150,
      netResult: 50,
      byCategory: [],
      series: Array.from({ length: 120 }, (_, i) => ({
        bucketStart: new Date(Date.UTC(2026, 0, 1 + i)),
        totalExpense: 1,
        totalRevenue: 1.5,
      })),
    });
    expect(projection.series).toHaveLength(50);
    expect(projection.seriesTruncated).toBe(true);
    expect(projection.series[0]?.bucketStart).toBe('2026-01-01T00:00:00.000Z');
    expect(projection.netResult).toBe(50);
  });

  it('caps per-batch totals at 50 with total + truncated', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      batchId: `b${i}`,
      totalExpense: 100,
      totalRevenue: 150,
    }));
    const projection = projectFinanceBatchTotals(rows);
    expect(projection.items).toHaveLength(50);
    expect(projection.truncated).toBe(true);
    expect(projection.total).toBe(60);
  });

  it('flags no truncation on short lists', () => {
    const projection = projectFinanceBatchTotals([
      { batchId: 'b1', totalExpense: 1, totalRevenue: 2 },
    ]);
    expect(projection.truncated).toBe(false);
    expect(projection.items).toHaveLength(1);
  });
});
