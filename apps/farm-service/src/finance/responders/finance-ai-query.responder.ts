import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { QueryBus } from '@platform/cqrs';
import {
  FARM_AI_QUERY_LIMITS,
  FARM_AI_QUERY_SUBJECTS,
  isFinanceBatchTotalsRequest,
  isFinanceSummaryRequest,
  toEventIso,
  type AiQueryReply,
  type FinanceBatchTotalsReply,
  type FinanceSummaryReply,
  type FinanceSummaryRequest,
} from '@platform/event-contracts';
import { respondAiQuery, toBoundedList } from '../../common/nats/ai-query-responder';
import { GetFinanceBatchTotalsQuery } from '../queries/get-finance-batch-totals.query';
import { GetFinanceSummaryQuery } from '../queries/get-finance-summary.query';
import {
  FinanceGranularity,
  type BatchTotalShape,
  type FinanceSummaryShape,
} from '../services/finance-ledger-query.service';

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
  private readonly logger = new Logger(FinanceAiQueryResponder.name);

  constructor(private readonly queryBus: QueryBus) {}

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FINANCE_SUMMARY)
  getSummary(@Payload() payload: unknown): Promise<AiQueryReply<FinanceSummaryReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.FINANCE_SUMMARY,
      payload,
      isFinanceSummaryRequest,
      async (req) => {
        const result = await this.queryBus.execute<GetFinanceSummaryQuery, FinanceSummaryShape>(
          new GetFinanceSummaryQuery(
            req.tenantId,
            new Date(req.fromDate),
            new Date(req.toDate),
            FinanceGranularity[req.granularity],
          ),
        );
        return projectSummary(req, result);
      },
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FINANCE_BATCH_TOTALS)
  getBatchTotals(@Payload() payload: unknown): Promise<AiQueryReply<FinanceBatchTotalsReply>> {
    return respondAiQuery(
      this.logger,
      FARM_AI_QUERY_SUBJECTS.FINANCE_BATCH_TOTALS,
      payload,
      isFinanceBatchTotalsRequest,
      async (req) => {
        const rows = await this.queryBus.execute<GetFinanceBatchTotalsQuery, BatchTotalShape[]>(
          new GetFinanceBatchTotalsQuery(
            req.tenantId,
            new Date(req.fromDate),
            new Date(req.toDate),
          ),
        );
        return toBoundedList(rows, req.limit, projectBatchTotal);
      },
    );
  }
}
