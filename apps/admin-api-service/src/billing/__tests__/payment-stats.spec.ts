/**
 * PaymentManagementService.getPaymentStats — dashboard KPI aggregate.
 *
 * London-school: the DataSource is mocked; assertions cover the status
 * folding (refund states count as money-moved successes), the terminal-only
 * success-rate denominator, and the zero-division guard.
 */
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';

import { PaymentManagementService } from '../services/payment-management.service';

describe('PaymentManagementService.getPaymentStats', () => {
  const queryMock = jest.fn();

  const makeService = async (): Promise<PaymentManagementService> => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        PaymentManagementService,
        { provide: getDataSourceToken(), useValue: { query: queryMock } },
      ],
    }).compile();
    return moduleRef.get(PaymentManagementService);
  };

  beforeEach(() => {
    queryMock.mockReset();
  });

  it('folds per-status rows into the dashboard window and computes the terminal success rate', async () => {
    const allTime = [
      { status: 'succeeded', count: '6', total: '600' },
      { status: 'failed', count: '2', total: '200' },
      { status: 'refunded', count: '1', total: '100' },
      { status: 'partially_refunded', count: '1', total: '50' },
      { status: 'pending', count: '3', total: '300' },
      { status: 'processing', count: '1', total: '10' },
      { status: 'cancelled', count: '1', total: '40' },
    ];
    queryMock.mockResolvedValueOnce(allTime).mockResolvedValueOnce([]);

    const service = await makeService();
    const stats = await service.getPaymentStats();

    expect(stats.totalPayments).toBe(15);
    expect(stats.succeeded).toBe(6);
    expect(stats.failed).toBe(2);
    expect(stats.refunded).toBe(2); // refunded + partially_refunded
    expect(stats.pending).toBe(4); // pending + processing
    // (6 succeeded + 2 refund-states) / (6 + 2 + 2 failed) terminal attempts
    expect(stats.successRate).toBeCloseTo(8 / 10);
    expect(stats.totalAmount).toBe(1300);
  });

  it('sums captured and refunded money over every row, not the page on screen', async () => {
    // The payments page used to compute these in the browser from the 50 rows
    // it had loaded, narrowed by the active status filter, and label the
    // difference "Net Revenue" — so filtering to `failed` showed $0 net.
    queryMock
      .mockResolvedValueOnce([
        { status: 'succeeded', count: '6', total: '600', refundedTotal: '0' },
        { status: 'failed', count: '2', total: '200', refundedTotal: '0' },
        { status: 'refunded', count: '1', total: '100', refundedTotal: '100' },
        // The case the client-side sum could not get right: this payment
        // captured 50 and gave back 20. Its full amount is not the refund.
        { status: 'partially_refunded', count: '1', total: '50', refundedTotal: '20' },
      ])
      .mockResolvedValueOnce([]);

    const service = await makeService();
    const stats = await service.getPaymentStats();

    // A partially refunded payment still captured in full.
    expect(stats.succeededAmount).toBe(650);
    // Only what was handed back, from refunded_amount — not 150.
    expect(stats.refundedAmount).toBe(120);
  });

  it('returns a 0 success rate (not NaN) when there are no terminal attempts', async () => {
    queryMock
      .mockResolvedValueOnce([{ status: 'pending', count: '2', total: '20' }])
      .mockResolvedValueOnce([]);

    const service = await makeService();
    const stats = await service.getPaymentStats();

    expect(stats.successRate).toBe(0);
    expect(stats.last30Days.totalPayments).toBe(0);
    expect(stats.last30Days.successRate).toBe(0);
  });

  it('scopes the second query to the trailing 30 days', async () => {
    queryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ status: 'succeeded', count: 4, total: 400 }]);

    const service = await makeService();
    const stats = await service.getPaymentStats();

    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(String(queryMock.mock.calls[1]?.[0])).toContain("INTERVAL '30 days'");
    expect(stats.last30Days.succeeded).toBe(4);
    expect(stats.last30Days.successRate).toBe(1);
  });
});
