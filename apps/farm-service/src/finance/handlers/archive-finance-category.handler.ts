/**
 * ArchiveFinanceCategoryHandler
 *
 * Soft-deactivates a category. Guards:
 *   - categories bound to a derived cost source (DERIVED_SYSTEM_CODES)
 *     or carrying a computed rule can never be archived — the ledger
 *     projection needs them;
 *   - archived categories keep their historical entries; new bookings
 *     are rejected by the entry handlers.
 */
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { createBaseEvent } from '@platform/event-contracts';
import type { FinanceCategoryArchivedEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { ArchiveFinanceCategoryCommand } from '../commands/archive-finance-category.command';
import { FinanceCategory } from '../entities/finance-category.entity';
import { DERIVED_SYSTEM_CODES } from '../services/derived-cost-sources';

@Injectable()
@CommandHandler(ArchiveFinanceCategoryCommand)
export class ArchiveFinanceCategoryHandler
  implements ICommandHandler<ArchiveFinanceCategoryCommand, FinanceCategory>
{
  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: ArchiveFinanceCategoryCommand): Promise<FinanceCategory> {
    const { tenantId, categoryId, userId } = command;

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;

      const category = await manager.findOne(FinanceCategory, {
        where: { id: categoryId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!category) {
        throw new NotFoundException(`Finance category ${categoryId} not found`);
      }
      if (category.code && DERIVED_SYSTEM_CODES.has(category.code)) {
        throw new BadRequestException(
          `Category "${category.name}" is bound to derived cost source ${category.code} and cannot be archived`,
        );
      }
      if (category.computedRule) {
        throw new BadRequestException(
          `Category "${category.name}" carries a computed rule and cannot be archived`,
        );
      }

      category.isActive = false;
      category.updatedBy = userId;
      const saved = await manager.save(category);

      const event: FinanceCategoryArchivedEvent = {
        ...createBaseEvent<FinanceCategoryArchivedEvent>('FinanceCategoryArchived', tenantId, {
          aggregateId: saved.id,
          aggregateType: 'FinanceCategory',
          userId,
        }),
        categoryId: saved.id,
        code: saved.code ?? undefined,
        scope: saved.scope,
        sourceService: 'farm-service',
      };
      await this.outboxPublisher.enqueue(event, manager);

      return saved;
    });
  }
}
