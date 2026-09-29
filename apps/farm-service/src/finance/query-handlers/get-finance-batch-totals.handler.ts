import { Injectable } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@platform/cqrs';

import { GetFinanceBatchTotalsQuery } from '../queries/get-finance-batch-totals.query';
import type { BatchTotalShape } from '../services/finance-ledger-model';
import { FinanceLedgerReader } from '../services/finance-ledger-reader';

@Injectable()
@QueryHandler(GetFinanceBatchTotalsQuery)
export class GetFinanceBatchTotalsHandler
  implements IQueryHandler<GetFinanceBatchTotalsQuery>
{
  constructor(private readonly reader: FinanceLedgerReader) {}

  async execute(query: GetFinanceBatchTotalsQuery): Promise<BatchTotalShape[]> {
    return this.reader.readBatchTotals(query.scope, { from: query.from, to: query.to });
  }
}
