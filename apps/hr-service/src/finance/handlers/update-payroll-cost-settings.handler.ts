/**
 * UpdatePayrollCostSettingsHandler — upserts the tenant's fund
 * percentages. defaultCurrency is intentionally NOT writable here (it
 * is projected from the farm finance settings SSoT by
 * FinanceSettingsUpdatedConsumer).
 */
import { Injectable } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { DataSource } from 'typeorm';

import { UpdatePayrollCostSettingsCommand } from '../commands/hr-finance.commands';
import {
  HR_PLATFORM_DEFAULT_CURRENCY,
  PayrollCostSettings,
} from '../entities/payroll-cost-settings.entity';
import { PayrollCostSettingsService } from '../services/payroll-cost-settings.service';

@Injectable()
@CommandHandler(UpdatePayrollCostSettingsCommand)
export class UpdatePayrollCostSettingsHandler
  implements ICommandHandler<UpdatePayrollCostSettingsCommand, PayrollCostSettings>
{
  constructor(
    private readonly dataSource: DataSource,
    private readonly settingsService: PayrollCostSettingsService,
  ) {}

  async execute(command: UpdatePayrollCostSettingsCommand): Promise<PayrollCostSettings> {
    const { tenantId, input, userId } = command;
    const saved = await runInTenantTransaction(this.dataSource, 'hr', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;

      let settings = await manager.findOne(PayrollCostSettings, {
        where: { tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!settings) {
        settings = manager.create(PayrollCostSettings, {
          tenantId,
          pensionFundPct: 0,
          socialInsurancePct: 0,
          medicalInsurancePct: 0,
          otherCostPct: 5,
          defaultCurrency: HR_PLATFORM_DEFAULT_CURRENCY,
        });
      }

      if (input.pensionFundPct !== undefined) settings.pensionFundPct = input.pensionFundPct;
      if (input.socialInsurancePct !== undefined) {
        settings.socialInsurancePct = input.socialInsurancePct;
      }
      if (input.medicalInsurancePct !== undefined) {
        settings.medicalInsurancePct = input.medicalInsurancePct;
      }
      if (input.otherCostPct !== undefined) settings.otherCostPct = input.otherCostPct;
      settings.updatedBy = userId;

      return manager.save(settings);
    });

    this.settingsService.invalidate(tenantId);
    return saved;
  }
}
