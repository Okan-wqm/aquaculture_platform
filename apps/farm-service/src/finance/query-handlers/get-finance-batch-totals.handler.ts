import { Injectable } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@platform/cqrs';

import { GetFinanceBatchTotalsQuery } from '../queries/get-finance-batch-totals.query';
import {
  BatchTotalShape,
  FinanceLedgerQueryService,
} from '../services/finance-ledger-query.service';

@Injectable()
@QueryHandler(GetFinanceBatchTotalsQuery)
export class GetFinanceBatchTotalsHandler
  implements IQueryHandler<GetFinanceBatchTotalsQuery>
{
  constructor(private readonly ledgerService: FinanceLedgerQueryService) {}

  async execute(query: GetFinanceBatchTotalsQuery): Promise<BatchTotalShape[]> {
    return this.ledgerService.getBatchTotals(query.tenantId, {
      from: query.from,
      to: query.to,
    });
  }
}
