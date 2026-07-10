import { Injectable } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@platform/cqrs';

import { GetFinanceLedgerQuery } from '../queries/get-finance-ledger.query';
import {
  FinanceLedgerQueryService,
  FinanceLineItemShape,
} from '../services/finance-ledger-query.service';

@Injectable()
@QueryHandler(GetFinanceLedgerQuery)
export class GetFinanceLedgerHandler implements IQueryHandler<GetFinanceLedgerQuery> {
  constructor(private readonly ledgerService: FinanceLedgerQueryService) {}

  async execute(query: GetFinanceLedgerQuery): Promise<FinanceLineItemShape[]> {
    return this.ledgerService.getLineItems(query.tenantId, query.filter);
  }
}
