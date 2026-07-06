/**
 * CreateFinanceCategoryHandler — user-defined dynamic categories.
 *
 * Categories are rows, never DDL: the tenant's custom expense types are
 * data inside its own tenant_<uuid> schema. User categories never carry
 * a `code` (system identity) or a computedRule.
 */
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { ConflictException, Injectable } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { createBaseEvent } from '@platform/event-contracts';
import type { FinanceCategoryCreatedEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { CreateFinanceCategoryCommand } from '../commands/create-finance-category.command';
import {
  FinanceCategory,
  FinanceCategoryKind,
} from '../entities/finance-category.entity';
import { FinanceCategorySeedService } from '../services/finance-category-seed.service';

@Injectable()
@CommandHandler(CreateFinanceCategoryCommand)
export class CreateFinanceCategoryHandler
  implements ICommandHandler<CreateFinanceCategoryCommand, FinanceCategory>
{
  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly seedService: FinanceCategorySeedService,
  ) {}

  async execute(command: CreateFinanceCategoryCommand): Promise<FinanceCategory> {
    const { tenantId, input, userId } = command;

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      await this.seedService.ensureDefaults(manager, tenantId);

      const duplicate = await manager
        .createQueryBuilder(FinanceCategory, 'c')
        .where('c."tenantId" = :tenantId', { tenantId })
        .andWhere('c."scope" = :scope', { scope: input.scope })
        .andWhere('c."isActive" = true')
        .andWhere('lower(c."name") = lower(:name)', { name: input.name })
        .getOne();
      if (duplicate) {
        throw new ConflictException(
          `An active finance category named "${input.name}" already exists in ${input.scope}`,
        );
      }

      const category = manager.create(FinanceCategory, {
        tenantId,
        name: input.name,
        code: null,
        scope: input.scope,
        kind: input.kind ?? FinanceCategoryKind.EXPENSE,
        isSystem: false,
        isActive: true,
        displayOrder: input.displayOrder ?? 1000,
        createdBy: userId,
        updatedBy: userId,
      });
      const saved = await manager.save(category);

      const event: FinanceCategoryCreatedEvent = {
        ...createBaseEvent<FinanceCategoryCreatedEvent>('FinanceCategoryCreated', tenantId, {
          aggregateId: saved.id,
          aggregateType: 'FinanceCategory',
          userId,
        }),
        categoryId: saved.id,
        name: saved.name,
        scope: saved.scope,
        kind: saved.kind,
        isSystem: false,
        sourceService: 'farm-service',
      };
      await this.outboxPublisher.enqueue(event, manager);

      return saved;
    });
  }
}
