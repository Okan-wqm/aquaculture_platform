/**
 * RestoreFinanceCategoryHandler — reactivate an archived category.
 *
 * The symmetric counterpart of ArchiveFinanceCategoryHandler: both are
 * TENANT_ADMIN-gated so activation state can only ever change through an
 * admin-authorised mutation (a MODULE_MANAGER cannot flip it via
 * updateFinanceCategory). Restoring re-enables new bookings; the name must
 * not collide with another active category in the same scope.
 */
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { createBaseEvent } from '@platform/event-contracts';
import type { FinanceCategoryUpdatedEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { RestoreFinanceCategoryCommand } from '../commands/restore-finance-category.command';
import { FinanceCategory } from '../entities/finance-category.entity';

@Injectable()
@CommandHandler(RestoreFinanceCategoryCommand)
export class RestoreFinanceCategoryHandler
  implements ICommandHandler<RestoreFinanceCategoryCommand, FinanceCategory>
{
  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: RestoreFinanceCategoryCommand): Promise<FinanceCategory> {
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

      if (!category.isActive) {
        const duplicate = await manager
          .createQueryBuilder(FinanceCategory, 'c')
          .where('c."tenantId" = :tenantId', { tenantId })
          .andWhere('c."scope" = :scope', { scope: category.scope })
          .andWhere('c."isActive" = true')
          .andWhere('lower(c."name") = lower(:name)', { name: category.name })
          .andWhere('c."id" != :id', { id: category.id })
          .getOne();
        if (duplicate) {
          throw new ConflictException(
            `An active finance category named "${category.name}" already exists in ${category.scope}`,
          );
        }
      }

      category.isActive = true;
      category.updatedBy = userId;
      const saved = await manager.save(category);

      const event: FinanceCategoryUpdatedEvent = {
        ...createBaseEvent<FinanceCategoryUpdatedEvent>('FinanceCategoryUpdated', tenantId, {
          aggregateId: saved.id,
          aggregateType: 'FinanceCategory',
          userId,
        }),
        categoryId: saved.id,
        code: saved.code ?? undefined,
        name: saved.name,
        scope: saved.scope,
        sourceService: 'farm-service',
      };
      await this.outboxPublisher.enqueue(event, manager);

      return saved;
    });
  }
}
