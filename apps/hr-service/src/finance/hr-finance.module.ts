/**
 * HrFinanceModule — HR finance tab surface.
 *
 * SSoT posture:
 *   - Labour cost is a READ MODEL over employees + payrolls + the
 *     tenant fund percentages (no payroll write model duplicated);
 *   - manual HR expenses live in hr_finance_entries (per-tenant);
 *   - categories are dynamic per-tenant DATA rows;
 *   - the default currency is PROJECTED from the farm finance_settings
 *     SSoT by FinanceSettingsUpdatedConsumer — never a second editable
 *     source.
 */
import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';

import { HrOutboxModule } from '../hr-outbox.module';
import {
  ArchiveHrFinanceCategoryHandler,
  CreateHrFinanceCategoryHandler,
  UpdateHrFinanceCategoryHandler,
} from './handlers/hr-finance-category.handlers';
import {
  CreateHrFinanceEntryHandler,
  DeleteHrFinanceEntryHandler,
  UpdateHrFinanceEntryHandler,
} from './handlers/hr-finance-entry.handlers';
import { UpdatePayrollCostSettingsHandler } from './handlers/update-payroll-cost-settings.handler';
import {
  GetHrFinanceCategoriesHandler,
  GetHrFinanceEntriesHandler,
  GetPayrollCostSettingsHandler,
} from './query-handlers/get-hr-finance-catalog.handlers';
import { GetHrFinanceSummaryHandler } from './query-handlers/get-hr-finance-summary.handler';
import { GetHrLabourCostHandler } from './query-handlers/get-hr-labour-cost.handler';
import { HrFinanceCategory } from './entities/hr-finance-category.entity';
import { HrFinanceEntry } from './entities/hr-finance-entry.entity';
import { PayrollCostSettings } from './entities/payroll-cost-settings.entity';
import { HrFinanceResolver } from './resolvers/hr-finance.resolver';
import { FinanceSettingsUpdatedConsumer } from './services/finance-settings-updated.consumer';
import { HrFinanceCategorySeedService } from './services/hr-finance-category-seed.service';
import { LabourCostCalculator } from './services/labour-cost-calculator.service';
import { PayrollCostSettingsService } from './services/payroll-cost-settings.service';

const CommandHandlers = [
  CreateHrFinanceEntryHandler,
  UpdateHrFinanceEntryHandler,
  DeleteHrFinanceEntryHandler,
  CreateHrFinanceCategoryHandler,
  UpdateHrFinanceCategoryHandler,
  ArchiveHrFinanceCategoryHandler,
  UpdatePayrollCostSettingsHandler,
];

const QueryHandlers = [
  GetHrLabourCostHandler,
  GetHrFinanceSummaryHandler,
  GetHrFinanceCategoriesHandler,
  GetHrFinanceEntriesHandler,
  GetPayrollCostSettingsHandler,
];

@Module({
  imports: [
    TypeOrmModule.forFeature([HrFinanceCategory, HrFinanceEntry, PayrollCostSettings]),
    CqrsModule,
    HrOutboxModule,
  ],
  providers: [
    HrFinanceResolver,
    HrFinanceCategorySeedService,
    PayrollCostSettingsService,
    LabourCostCalculator,
    FinanceSettingsUpdatedConsumer,
    ...CommandHandlers,
    ...QueryHandlers,
  ],
  exports: [TypeOrmModule, PayrollCostSettingsService],
})
export class HrFinanceModule {}
