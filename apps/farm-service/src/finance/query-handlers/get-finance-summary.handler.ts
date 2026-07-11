import { Injectable } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@platform/cqrs';

import { GetFinanceSummaryQuery } from '../queries/get-finance-summary.query';
import {
  FinanceLedgerQueryService,
  FinanceSummaryShape,
} from '../services/finance-ledger-query.service';

@Injectable()
@QueryHandler(GetFinanceSummaryQuery)
export class GetFinanceSummaryHandler implements IQueryHandler<GetFinanceSummaryQuery> {
  constructor(private readonly ledgerService: FinanceLedgerQueryService) {}

  async execute(query: GetFinanceSummaryQuery): Promise<FinanceSummaryShape> {
    return this.ledgerService.getSummary(
      query.tenantId,
      { from: query.from, to: query.to },
      query.granularity,
    );
  }
}
