/**
 * UpdateFinanceCategoryHandler — rename / reorder only.
 *
 * System categories may be renamed (display name is presentation; the
 * stable `code` is the binding identity for derivation + rules). Activation
 * state is NOT mutated here — archival (TENANT_ADMIN) is governed by
 * ArchiveFinanceCategoryHandler and reactivation by
 * RestoreFinanceCategoryHandler, so a MODULE_MANAGER cannot archive a
 * category by side-channel through this mutation.
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

import { UpdateFinanceCategoryCommand } from '../commands/update-finance-category.command';
import { FinanceCategory } from '../entities/finance-category.entity';

@Injectable()
@CommandHandler(UpdateFinanceCategoryCommand)
export class UpdateFinanceCategoryHandler
  implements ICommandHandler<UpdateFinanceCategoryCommand, FinanceCategory>
{
  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: UpdateFinanceCategoryCommand): Promise<FinanceCategory> {
    const { tenantId, categoryId, input, userId } = command;

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;

      const category = await manager.findOne(FinanceCategory, {
        where: { id: categoryId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!category) {
        throw new NotFoundException(`Finance category ${categoryId} not found`);
      }

      if (input.name && input.name.toLowerCase() !== category.name.toLowerCase()) {
        const duplicate = await manager
          .createQueryBuilder(FinanceCategory, 'c')
          .where('c."tenantId" = :tenantId', { tenantId })
          .andWhere('c."scope" = :scope', { scope: category.scope })
          .andWhere('c."isActive" = true')
          .andWhere('lower(c."name") = lower(:name)', { name: input.name })
          .andWhere('c."id" != :id', { id: category.id })
          .getOne();
        if (duplicate) {
          throw new ConflictException(
            `An active finance category named "${input.name}" already exists in ${category.scope}`,
          );
        }
      }

      if (input.name !== undefined) category.name = input.name;
      if (input.displayOrder !== undefined) category.displayOrder = input.displayOrder;
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
