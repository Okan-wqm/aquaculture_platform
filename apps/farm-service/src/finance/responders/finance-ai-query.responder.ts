import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { QueryBus } from '@platform/cqrs';
import {
  FARM_AI_QUERY_LIMITS,
  FARM_AI_QUERY_SUBJECTS,
  isFinanceBatchTotalsRequest,
  isFinanceSummaryRequest,
  toEventIso,
  type TenantBoundReply,
  type FinanceBatchTotalsReply,
  type FinanceSummaryReply,
  type FinanceSummaryRequest,
} from '@platform/event-contracts';
import { toBoundedList } from '../../common/nats/ai-query-responder';
import { GetFinanceBatchTotalsQuery } from '../queries/get-finance-batch-totals.query';
import { GetFinanceSummaryQuery } from '../queries/get-finance-summary.query';
import {
  FinanceGranularity,
  type BatchTotalShape,
  type FinanceSummaryShape,
} from '../services/finance-ledger-model';
import { FarmAiResponder } from '../../common/tenant-boundary/farm-ai-responder';

/** Weekly granularity over a year is 53 buckets; anything finer is capped and flagged. */
const SERIES_CAP = 53;

export function projectSummary(
  req: Pick<FinanceSummaryRequest, 'fromDate' | 'toDate' | 'granularity'>,
  result: FinanceSummaryShape,
): FinanceSummaryReply {
  const categoryCap = FARM_AI_QUERY_LIMITS.MAX_LIST_LIMIT;
  return {
    fromDate: req.fromDate,
    toDate: req.toDate,
    granularity: req.granularity,
    currency: result.currency,
    totalExpense: Number(result.totalExpense),
    totalRevenue: Number(result.totalRevenue),
    netResult: Number(result.netResult),
    byCategory: result.byCategory.slice(0, categoryCap).map((c) => ({
      categoryCode: c.categoryCode,
      categoryName: c.categoryName,
      kind: c.kind,
      total: Number(c.total),
    })),
    byCategoryTruncated: result.byCategory.length > categoryCap,
    series: result.series.slice(0, SERIES_CAP).map((b) => ({
      bucketStart: toEventIso(b.bucketStart),
      totalExpense: Number(b.totalExpense),
      totalRevenue: Number(b.totalRevenue),
    })),
    seriesTruncated: result.series.length > SERIES_CAP,
  };
}

export function projectBatchTotal(row: BatchTotalShape): FinanceBatchTotalsReply['items'][number] {
  const expense = Number(row.totalExpense);
  const revenue = Number(row.totalRevenue);
  return {
    batchId: row.batchId,
    totalExpense: expense,
    totalRevenue: revenue,
    netResult: revenue - expense,
  };
}

/** Finance read surface for the farm production specialist (FARM-MEDIUM-328). */
@Controller()
export class FinanceAiQueryResponder {
  constructor(
    private readonly responder: FarmAiResponder,
    private readonly queryBus: QueryBus,
  ) {}

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FINANCE_SUMMARY)
  getSummary(@Payload() payload: unknown): Promise<TenantBoundReply<FinanceSummaryReply>> {
    return this.responder.respond(
      {
        subject: FARM_AI_QUERY_SUBJECTS.FINANCE_SUMMARY,
        isRequest: isFinanceSummaryRequest,
        handle: async (req, scope) => {
          const result = await this.queryBus.execute<GetFinanceSummaryQuery, FinanceSummaryShape>(
            new GetFinanceSummaryQuery(
              scope,
              new Date(req.fromDate),
              new Date(req.toDate),
              FinanceGranularity[req.granularity],
            ),
          );
          return projectSummary(req, result);
        },
      },
      payload,
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FINANCE_BATCH_TOTALS)
  getBatchTotals(@Payload() payload: unknown): Promise<TenantBoundReply<FinanceBatchTotalsReply>> {
    return this.responder.respond(
      {
        subject: FARM_AI_QUERY_SUBJECTS.FINANCE_BATCH_TOTALS,
        isRequest: isFinanceBatchTotalsRequest,
        handle: async (req, scope) => {
          const rows = await this.queryBus.execute<GetFinanceBatchTotalsQuery, BatchTotalShape[]>(
            new GetFinanceBatchTotalsQuery(scope, new Date(req.fromDate), new Date(req.toDate)),
          );
          return toBoundedList(rows, req.limit, projectBatchTotal);
        },
      },
      payload,
    );
  }
}
