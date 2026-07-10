/**
 * UpdateFinanceEntryHandler
 *
 * Updates a MANUAL finance entry (amount, date, category, dimensions).
 * Derived line items never reach this handler — they have no
 * finance_expense_entries row; the finance tab deep-links their edits to
 * the source record's own form.
 */
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { createBaseEvent, toEventIso } from '@platform/event-contracts';
import type { FinanceEntryUpdatedEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { UpdateFinanceEntryCommand } from '../commands/update-finance-entry.command';
import { FinanceCategory } from '../entities/finance-category.entity';
import { FinanceExpenseEntry } from '../entities/finance-expense-entry.entity';

@Injectable()
@CommandHandler(UpdateFinanceEntryCommand)
export class UpdateFinanceEntryHandler
  implements ICommandHandler<UpdateFinanceEntryCommand, FinanceExpenseEntry>
{
  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: UpdateFinanceEntryCommand): Promise<FinanceExpenseEntry> {
    const { tenantId, entryId, input, userId } = command;

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;

      const entry = await manager.findOne(FinanceExpenseEntry, {
        where: { id: entryId, tenantId, isDeleted: false },
        lock: { mode: 'pessimistic_write' },
      });
      if (!entry) {
        throw new NotFoundException(`Finance entry ${entryId} not found`);
      }

      let category = await manager.findOne(FinanceCategory, {
        where: { id: entry.categoryId, tenantId },
      });

      if (input.categoryId && input.categoryId !== entry.categoryId) {
        category = await manager.findOne(FinanceCategory, {
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
            `Finance category "${category.name}" is computed — it cannot take manual entries`,
          );
        }
        entry.categoryId = category.id;
      }
      if (!category) {
        throw new NotFoundException(`Finance category ${entry.categoryId} not found`);
      }

      if (input.entryDate !== undefined) entry.entryDate = new Date(input.entryDate);
      if (input.amount !== undefined) entry.amount = input.amount;
      // Currency is not editable — an entry stays in the tenant default it
      // was booked in (the ledger is structurally single-currency).
      if (input.description !== undefined) entry.description = input.description;
      if (input.siteId !== undefined) entry.siteId = input.siteId;
      if (input.batchId !== undefined) entry.batchId = input.batchId;
      if (input.periodStart !== undefined) entry.periodStart = new Date(input.periodStart);
      if (input.periodEnd !== undefined) entry.periodEnd = new Date(input.periodEnd);
      entry.updatedBy = userId;

      const saved = await manager.save(entry);

      const event: FinanceEntryUpdatedEvent = {
        ...createBaseEvent<FinanceEntryUpdatedEvent>('FinanceEntryUpdated', tenantId, {
          aggregateId: saved.id,
          aggregateType: 'FinanceEntry',
          userId,
        }),
        entryId: saved.id,
        categoryId: saved.categoryId,
        categoryCode: category.code ?? undefined,
        scope: category.scope,
        amount: Number(saved.amount).toFixed(2),
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
