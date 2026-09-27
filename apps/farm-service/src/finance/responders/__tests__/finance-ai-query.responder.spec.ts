import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { QueryBus } from '@platform/cqrs';
import { GetFinanceBatchTotalsQuery } from '../../queries/get-finance-batch-totals.query';
import { GetFinanceSummaryQuery } from '../../queries/get-finance-summary.query';
import { FinanceGranularity } from '../../services/finance-ledger-query.service';
import { FinanceAiQueryResponder } from '../finance-ai-query.responder';

const TENANT = '11111111-1111-4111-8111-111111111111';

describe('FinanceAiQueryResponder (FARM-MEDIUM-328)', () => {
  let execute: jest.Mock;
  let responder: FinanceAiQueryResponder;

  beforeEach(() => {
    execute = jest.fn();
    const queryBus: Pick<QueryBus, 'execute'> = { execute };
    responder = new FinanceAiQueryResponder(queryBus as QueryBus);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('maps the granularity code to the domain enum and caps the series', async () => {
    execute.mockResolvedValue({
      currency: 'NOK',
      totalExpense: '1000',
      totalRevenue: 1500,
      netResult: 500,
      byCategory: [
        {
          categoryId: 'c1',
          categoryCode: 'FEED',
          categoryName: 'Feed',
          scope: 's',
          kind: 'EXPENSE',
          isComputed: false,
          isDerived: false,
          total: '800',
        },
      ],
      series: Array.from({ length: 60 }, (_, i) => ({
        bucketStart: new Date(Date.UTC(2026, 0, 1 + i)),
        totalExpense: 10,
        totalRevenue: 20,
      })),
    });

    const reply = await responder.getSummary({
      tenantId: TENANT,
      fromDate: '2026-01-01',
      toDate: '2026-03-01',
      granularity: 'DAY',
    });

    expect(execute).toHaveBeenCalledWith(expect.any(GetFinanceSummaryQuery));
    expect((execute.mock.calls[0][0] as GetFinanceSummaryQuery).granularity).toBe(
      FinanceGranularity.DAY,
    );
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.data.totalExpense).toBe(1000);
    expect(reply.data.byCategory).toEqual([
      { categoryCode: 'FEED', categoryName: 'Feed', kind: 'EXPENSE', total: 800 },
    ]);
    expect(reply.data.series).toHaveLength(53);
    expect(reply.data.series[0]?.bucketStart).toBe('2026-01-01T00:00:00.000Z');
    expect(reply.data.seriesTruncated).toBe(true);
  });

  it('rejects an unknown granularity', async () => {
    const reply = await responder.getSummary({
      tenantId: TENANT,
      fromDate: '2026-01-01',
      toDate: '2026-03-01',
      granularity: 'HOUR',
    });
    expect(reply).toEqual({ ok: false, error: 'INVALID_REQUEST' });
  });

  it('derives net result per batch and bounds the list', async () => {
    execute.mockResolvedValue([{ batchId: 'b1', totalExpense: '100', totalRevenue: 250 }]);
    const reply = await responder.getBatchTotals({
      tenantId: TENANT,
      fromDate: '2026-01-01',
      toDate: '2026-03-01',
      limit: 5,
    });
    expect(execute).toHaveBeenCalledWith(expect.any(GetFinanceBatchTotalsQuery));
    expect(reply).toEqual({
      ok: true,
      data: {
        items: [{ batchId: 'b1', totalExpense: 100, totalRevenue: 250, netResult: 150 }],
        truncated: false,
      },
    });
  });
});
