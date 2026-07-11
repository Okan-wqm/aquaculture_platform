/**
 * Finance Module — farm operational finance ledger.
 *
 * SSoT posture:
 *   - MANUAL entries live in finance_expense_entries (per-tenant);
 *   - DERIVED costs are query-time projections of the source domain
 *     tables (DERIVED_COST_SOURCES) — never copied;
 *   - COMPUTED lines (5% rules) evaluate at read time;
 *   - the tenant default currency lives in finance_settings and is
 *     resolved exclusively through FinanceSettingsService.
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { FinanceCategory } from './entities/finance-category.entity';
import { FinanceExpenseEntry } from './entities/finance-expense-entry.entity';
import { FinanceSettings } from './entities/finance-settings.entity';
import { FinanceCommandHandlers } from './handlers';
import { FinanceQueryHandlers } from './query-handlers';
import { FinanceResolver } from './resolvers/finance.resolver';
import { ComputedRuleEvaluator } from './services/computed-rule-evaluator';
import { FinanceCategorySeedService } from './services/finance-category-seed.service';
import { FinanceLedgerQueryService } from './services/finance-ledger-query.service';
import { FinanceSettingsService } from './services/finance-settings.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([FinanceCategory, FinanceExpenseEntry, FinanceSettings]),
  ],
  providers: [
    FinanceResolver,
    FinanceCategorySeedService,
    FinanceSettingsService,
    FinanceLedgerQueryService,
    ComputedRuleEvaluator,
    ...FinanceCommandHandlers,
    ...FinanceQueryHandlers,
  ],
  exports: [
    TypeOrmModule,
    FinanceSettingsService,
    FinanceCategorySeedService,
  ],
})
export class FinanceModule {}
