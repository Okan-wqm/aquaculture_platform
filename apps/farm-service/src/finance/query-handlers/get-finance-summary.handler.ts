import { Injectable } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@platform/cqrs';

import { GetFinanceSummaryQuery } from '../queries/get-finance-summary.query';
import type { FinanceSummaryShape } from '../services/finance-ledger-model';
import { FinanceLedgerReader } from '../services/finance-ledger-reader';

@Injectable()
@QueryHandler(GetFinanceSummaryQuery)
export class GetFinanceSummaryHandler implements IQueryHandler<GetFinanceSummaryQuery> {
  constructor(private readonly reader: FinanceLedgerReader) {}

  async execute(query: GetFinanceSummaryQuery): Promise<FinanceSummaryShape> {
    return this.reader.readSummary(
      query.scope,
      { from: query.from, to: query.to },
      query.granularity,
    );
  }
}
