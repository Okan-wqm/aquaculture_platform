import { GetFinanceBatchTotalsHandler } from './get-finance-batch-totals.handler';
import { GetFinanceCategoriesHandler } from './get-finance-categories.handler';
import { GetFinanceLedgerHandler } from './get-finance-ledger.handler';
import { GetFinanceSettingsHandler } from './get-finance-settings.handler';
import { GetFinanceSummaryHandler } from './get-finance-summary.handler';

export const FinanceQueryHandlers = [
  GetFinanceCategoriesHandler,
  GetFinanceLedgerHandler,
  GetFinanceSummaryHandler,
  GetFinanceBatchTotalsHandler,
  GetFinanceSettingsHandler,
];

export {
  GetFinanceBatchTotalsHandler,
  GetFinanceCategoriesHandler,
  GetFinanceLedgerHandler,
  GetFinanceSettingsHandler,
  GetFinanceSummaryHandler,
};
