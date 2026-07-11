/**
 * CreateFinanceEntryHandler
 *
 * Books a MANUAL finance entry. Guards:
 *   - category must exist, be active, and belong to the tenant;
 *   - computed categories reject manual entries (their value is a
 *     read-time projection — a booked row would double-count);
 *   - currency defaults from the tenant finance settings (SSoT), never
 *     from a hardcoded literal.
 *
 * Emits FinanceEntryRecorded through the transactional outbox in the
 * same transaction as the insert.
 */
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { createBaseEvent, toEventIso } from '@platform/event-contracts';
import type { FinanceEntryRecordedEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { CreateFinanceEntryCommand } from '../commands/create-finance-entry.command';
import { FinanceCategory } from '../entities/finance-category.entity';
import { FinanceExpenseEntry } from '../entities/finance-expense-entry.entity';
import { FinanceCategorySeedService } from '../services/finance-category-seed.service';
import { FinanceSettingsService } from '../services/finance-settings.service';

@Injectable()
@CommandHandler(CreateFinanceEntryCommand)
export class CreateFinanceEntryHandler
  implements ICommandHandler<CreateFinanceEntryCommand, FinanceExpenseEntry>
{
  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly seedService: FinanceCategorySeedService,
    private readonly settingsService: FinanceSettingsService,
  ) {}

  async execute(command: CreateFinanceEntryCommand): Promise<FinanceExpenseEntry> {
    const { tenantId, input, userId } = command;

    // Seed (idempotently) in its own committed tx before the booking tx —
    // categories exist before we look one up, and a booking rollback can
    // never undo the seed.
    await this.seedService.ensureDefaults(this.dataSource, tenantId);

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      const category = await manager.findOne(FinanceCategory, {
        where: { id: input.categoryId, tenantId },
      });
      if (!category) {
        throw new NotFoundException(`Finance category ${input.categoryId} not found`);
      }
      if (!category.isActive) {
        throw new BadRequestException(
          `Finance category "${category.name}" is archived — restore it before booking entries`,
        );
      }
      if (category.computedRule) {
        throw new BadRequestException(
          `Finance category "${category.name}" is computed (${category.computedRule.percent}% rule) — ` +
            'its value is derived at read time and cannot take manual entries',
        );
      }

      // Every manual entry is booked in the tenant default currency (SSoT)
      // — the ledger is structurally single-currency.
      const currency = await this.settingsService.getDefaultCurrencyInTx(manager, tenantId);

      const entry = manager.create(FinanceExpenseEntry, {
        tenantId,
        categoryId: category.id,
        entryDate: new Date(input.entryDate),
        periodStart: input.periodStart ? new Date(input.periodStart) : undefined,
        periodEnd: input.periodEnd ? new Date(input.periodEnd) : undefined,
        amount: input.amount,
        currency,
        description: input.description,
        siteId: input.siteId,
        batchId: input.batchId,
        createdBy: userId,
        updatedBy: userId,
      });
      const saved = await manager.save(entry);

      const event: FinanceEntryRecordedEvent = {
        ...createBaseEvent<FinanceEntryRecordedEvent>('FinanceEntryRecorded', tenantId, {
          aggregateId: saved.id,
          aggregateType: 'FinanceEntry',
          userId,
        }),
        entryId: saved.id,
        categoryId: category.id,
        categoryCode: category.code ?? undefined,
        scope: category.scope,
        amount: saved.amount.toFixed(2),
        currency: saved.currency,
        entryDate: toEventIso(saved.entryDate),
        dimensions: {
          siteId: saved.siteId ?? undefined,
          batchId: saved.batchId ?? undefined,
        },
        sourceService: 'farm-service',
      };
      await this.outboxPublisher.enqueue(event, manager);

      return saved;
    });
  }
}
