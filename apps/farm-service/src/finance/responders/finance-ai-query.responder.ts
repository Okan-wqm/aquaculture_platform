/**
 * Finance farm-AI read-only NATS responder (PR-4, Production specialist).
 * Two `request.farm.ai.*` subjects backed EXCLUSIVELY by the finance
 * module's existing tenant-scoped CQRS query handlers via QueryBus — no
 * direct DB access, no commands, PII-free projections (see ./projections.ts).
 * Envelope + validation plumbing lives in common/nats/ai-query-responder.ts.
 */
import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { QueryBus } from '@platform/cqrs';
import {
  AiQueryReply,
  FARM_AI_QUERY_SUBJECTS,
  isFinanceBatchTotalsRequest,
  isFinanceSummaryRequest,
} from '@platform/event-contracts';

import { respondAiQuery } from '../../common/nats/ai-query-responder';
import { GetFinanceSummaryQuery } from '../queries/get-finance-summary.query';
import { GetFinanceBatchTotalsQuery } from '../queries/get-finance-batch-totals.query';
import {
  BatchTotalShape,
  FinanceGranularity,
  FinanceSummaryShape,
} from '../services/finance-ledger-query.service';
import {
  FinanceBatchTotalDto,
  FinanceSummaryDto,
  projectFinanceBatchTotals,
  projectFinanceSummary,
} from './projections';

@Controller()
export class FinanceAiQueryResponder {
  private readonly logger = new Logger(FinanceAiQueryResponder.name);

  constructor(private readonly queryBus: QueryBus) {}

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FINANCE_SUMMARY)
  async summary(@Payload() payload: unknown): Promise<AiQueryReply<FinanceSummaryDto>> {
    return respondAiQuery(
      this.logger,
      payload,
      isFinanceSummaryRequest,
      async (req) =>
        projectFinanceSummary(
          await this.queryBus.execute<GetFinanceSummaryQuery, FinanceSummaryShape>(
            new GetFinanceSummaryQuery(
              req.tenantId,
              new Date(req.fromDate),
              new Date(req.toDate),
              // Guard pinned granularity to the enum's literal union — the
              // cast bridges the contract's string union to the service enum.
              req.granularity as FinanceGranularity,
            ),
          ),
        ),
    );
  }

  @MessagePattern(FARM_AI_QUERY_SUBJECTS.FINANCE_BATCH_TOTALS)
  async batchTotals(
    @Payload() payload: unknown,
  ): Promise<AiQueryReply<{ items: FinanceBatchTotalDto[]; truncated: boolean; total: number }>> {
    return respondAiQuery(
      this.logger,
      payload,
      isFinanceBatchTotalsRequest,
      async (req) =>
        projectFinanceBatchTotals(
          await this.queryBus.execute<GetFinanceBatchTotalsQuery, BatchTotalShape[]>(
            new GetFinanceBatchTotalsQuery(
              req.tenantId,
              new Date(req.fromDate),
              new Date(req.toDate),
            ),
          ),
        ),
    );
  }
}
