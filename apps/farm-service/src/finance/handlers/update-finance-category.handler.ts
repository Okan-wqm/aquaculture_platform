/**
 * UpdateFinanceCategoryHandler — rename / reorder / (re)activate.
 *
 * System categories may be renamed (display name is presentation; the
 * stable `code` is the binding identity for derivation + rules), but
 * their archival is governed by ArchiveFinanceCategoryHandler.
 */
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import {
  BadRequestException,
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
import { DERIVED_SYSTEM_CODES } from '../services/derived-cost-sources';

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

      if (input.isActive === false) {
        this.assertArchivable(category);
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
      if (input.isActive !== undefined) category.isActive = input.isActive;
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

  private assertArchivable(category: FinanceCategory): void {
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
  }
}
