/**
 * UpdateFinanceSettingsHandler
 *
 * Upserts the tenant's single finance settings row (currency SSoT +
 * fiscal year anchor) and emits FinanceSettingsUpdated so hr-service
 * projects the currency into hr_payroll_cost_settings — one
 * tenant-editable currency source across both finance tabs.
 */
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { createBaseEvent } from '@platform/event-contracts';
import type { FinanceSettingsUpdatedEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { UpdateFinanceSettingsCommand } from '../commands/update-finance-settings.command';
import {
  FinanceSettings,
  PLATFORM_DEFAULT_CURRENCY,
} from '../entities/finance-settings.entity';
import { FinanceSettingsService } from '../services/finance-settings.service';

@Injectable()
@CommandHandler(UpdateFinanceSettingsCommand)
export class UpdateFinanceSettingsHandler
  implements ICommandHandler<UpdateFinanceSettingsCommand, FinanceSettings>
{
  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly settingsService: FinanceSettingsService,
  ) {}

  async execute(command: UpdateFinanceSettingsCommand): Promise<FinanceSettings> {
    const { tenantId, input, userId } = command;

    const saved = await runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;

      let settings = await manager.findOne(FinanceSettings, {
        where: { tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!settings) {
        settings = manager.create(FinanceSettings, {
          tenantId,
          defaultCurrency: PLATFORM_DEFAULT_CURRENCY,
          fiscalYearStartMonth: 1,
        });
      }

      if (input.defaultCurrency !== undefined) settings.defaultCurrency = input.defaultCurrency;
      if (input.fiscalYearStartMonth !== undefined) {
        settings.fiscalYearStartMonth = input.fiscalYearStartMonth;
      }
      settings.updatedBy = userId;

      const persisted = await manager.save(settings);

      const event: FinanceSettingsUpdatedEvent = {
        ...createBaseEvent<FinanceSettingsUpdatedEvent>('FinanceSettingsUpdated', tenantId, {
          aggregateId: tenantId,
          aggregateType: 'FinanceSettings',
          userId,
        }),
        defaultCurrency: persisted.defaultCurrency,
        fiscalYearStartMonth: persisted.fiscalYearStartMonth,
        sourceService: 'farm-service',
      };
      await this.outboxPublisher.enqueue(event, manager);

      return persisted;
    });

    // Cache invalidation only after the transaction committed.
    this.settingsService.invalidate(tenantId);
    return saved;
  }
}
