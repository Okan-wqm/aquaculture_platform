import 'reflect-metadata';

import { QueryBus } from '@platform/cqrs';

import { FinanceAiQueryResponder } from '../finance-ai-query.responder';
import { GetFinanceSummaryQuery } from '../../queries/get-finance-summary.query';
import { GetFinanceBatchTotalsQuery } from '../../queries/get-finance-batch-totals.query';
import {
  FinanceSummaryShape,
  BatchTotalShape,
} from '../../services/finance-ledger-query.service';

const TENANT = '33333333-3333-4333-8333-333333333333';

const SUMMARY: FinanceSummaryShape = {
  currency: 'NOK',
  totalExpense: 210000,
  totalRevenue: 320000,
  netResult: 110000,
  byCategory: [
    {
      categoryId: 'c1',
      categoryCode: 'feed',
      categoryName: 'Feed',
      scope: 'tenant' as never,
      kind: 'expense' as never,
      isComputed: false,
      isDerived: false,
      total: 90000,
    },
  ],
  series: Array.from({ length: 120 }, (_, i) => ({
    bucketStart: new Date(Date.UTC(2026, 0, 1 + i)),
    totalExpense: 1000,
    totalRevenue: 1500,
  })),
};

const BATCH_TOTALS: BatchTotalShape[] = Array.from({ length: 60 }, (_, i) => ({
  batchId: `b${i}`,
  totalExpense: 1000,
  totalRevenue: 1500,
}));

describe('FinanceAiQueryResponder (PR-4 farm-AI read surface)', () => {
  let execute: jest.Mock;
  let responder: FinanceAiQueryResponder;

  beforeEach(() => {
    execute = jest.fn();
    responder = new FinanceAiQueryResponder({ execute } as unknown as QueryBus);
  });

  // ------------------------------------------------------------- FINANCE_SUMMARY
  it('FINANCE_SUMMARY: invalid payload → INVALID_REQUEST, no query executed', async () => {
    for (const bad of [
      { tenantId: TENANT, fromDate: '2026-01-01', toDate: '2026-12-31' },
      { tenantId: TENANT, fromDate: '2026-01-01', toDate: '2026-12-31', granularity: 'HOUR' },
      { tenantId: TENANT, fromDate: '2025-01-01', toDate: '2026-12-31', granularity: 'MONTH' },
      { tenantId: TENANT, fromDate: '2026-12-31', toDate: '2026-01-01', granularity: 'MONTH' },
    ]) {
      expect(await responder.summary(bad)).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('FINANCE_SUMMARY: happy path caps the series and projects ISO buckets', async () => {
    execute.mockResolvedValue(SUMMARY);

    const reply = await responder.summary({
      tenantId: TENANT,
      fromDate: '2026-01-01',
      toDate: '2026-08-31',
      granularity: 'DAY',
    });

    expect(execute).toHaveBeenCalledWith(expect.any(GetFinanceSummaryQuery));
    const query = execute.mock.calls[0][0] as GetFinanceSummaryQuery;
    expect(query.tenantId).toBe(TENANT);
    expect(query.granularity).toBe('DAY');
    expect(query.from).toEqual(new Date('2026-01-01'));

    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.data.netResult).toBe(110000);
      expect(reply.data.series).toHaveLength(50);
      expect(reply.data.seriesTruncated).toBe(true);
      expect(reply.data.series[0]?.bucketStart).toBe('2026-01-01T00:00:00.000Z');
    }
  });

  it('FINANCE_SUMMARY: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(
      await responder.summary({
        tenantId: TENANT,
        fromDate: '2026-01-01',
        toDate: '2026-08-31',
        granularity: 'MONTH',
      }),
    ).toEqual({ ok: false, error: 'INTERNAL_ERROR' });
  });

  // -------------------------------------------------------- FINANCE_BATCH_TOTALS
  it('FINANCE_BATCH_TOTALS: invalid payload → INVALID_REQUEST, no query executed', async () => {
    expect(
      await responder.batchTotals({ tenantId: TENANT, fromDate: '2026-01-01' }),
    ).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('FINANCE_BATCH_TOTALS: happy path caps the rows and flags truncation', async () => {
    execute.mockResolvedValue(BATCH_TOTALS);

    const reply = await responder.batchTotals({
      tenantId: TENANT,
      fromDate: '2026-01-01',
      toDate: '2026-08-31',
    });

    expect(execute).toHaveBeenCalledWith(expect.any(GetFinanceBatchTotalsQuery));
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.data.items).toHaveLength(50);
      expect(reply.data.truncated).toBe(true);
      expect(reply.data.total).toBe(60);
      expect(reply.data.items[0]?.batchId).toBe('b0');
    }
  });

  it('FINANCE_BATCH_TOTALS: handler rejection → INTERNAL_ERROR', async () => {
    execute.mockRejectedValue(new Error('boom'));
    expect(
      await responder.batchTotals({
        tenantId: TENANT,
        fromDate: '2026-01-01',
        toDate: '2026-08-31',
      }),
    ).toEqual({ ok: false, error: 'INTERNAL_ERROR' });
  });
});
