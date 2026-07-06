/**
 * DeleteFinanceEntryHandler — soft delete (aggregates drop the row;
 * the row itself remains as audit history).
 */
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { Injectable, NotFoundException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { createBaseEvent } from '@platform/event-contracts';
import type { FinanceEntryDeletedEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { DeleteFinanceEntryCommand } from '../commands/delete-finance-entry.command';
import { FinanceCategory } from '../entities/finance-category.entity';
import { FinanceExpenseEntry } from '../entities/finance-expense-entry.entity';

@Injectable()
@CommandHandler(DeleteFinanceEntryCommand)
export class DeleteFinanceEntryHandler
  implements ICommandHandler<DeleteFinanceEntryCommand, boolean>
{
  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: DeleteFinanceEntryCommand): Promise<boolean> {
    const { tenantId, entryId, userId } = command;

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;

      const entry = await manager.findOne(FinanceExpenseEntry, {
        where: { id: entryId, tenantId, isDeleted: false },
        lock: { mode: 'pessimistic_write' },
      });
      if (!entry) {
        throw new NotFoundException(`Finance entry ${entryId} not found`);
      }
      const category = await manager.findOne(FinanceCategory, {
        where: { id: entry.categoryId, tenantId },
      });

      entry.isDeleted = true;
      entry.deletedAt = new Date();
      entry.updatedBy = userId;
      await manager.save(entry);

      const event: FinanceEntryDeletedEvent = {
        ...createBaseEvent<FinanceEntryDeletedEvent>('FinanceEntryDeleted', tenantId, {
          aggregateId: entry.id,
          aggregateType: 'FinanceEntry',
          userId,
        }),
        entryId: entry.id,
        categoryId: entry.categoryId,
        scope: category?.scope ?? 'FARM_OPEX',
        sourceService: 'farm-service',
      };
      await this.outboxPublisher.enqueue(event, manager);

      return true;
    });
  }
}
