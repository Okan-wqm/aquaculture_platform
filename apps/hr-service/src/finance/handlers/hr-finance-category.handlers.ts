/**
 * HR finance category command handlers — dynamic user-managed taxonomy
 * (rows, never DDL). Computed-rule categories can never be archived.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { createBaseEvent } from '@platform/event-contracts';
import type {
  FinanceCategoryArchivedEvent,
  FinanceCategoryCreatedEvent,
  FinanceCategoryUpdatedEvent,
} from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, EntityManager } from 'typeorm';

import {
  ArchiveHrFinanceCategoryCommand,
  CreateHrFinanceCategoryCommand,
  UpdateHrFinanceCategoryCommand,
} from '../commands/hr-finance.commands';
import { HrFinanceCategory } from '../entities/hr-finance-category.entity';
import { HrFinanceCategorySeedService } from '../services/hr-finance-category-seed.service';

async function assertNameFree(
  manager: EntityManager,
  tenantId: string,
  name: string,
  excludeId?: string,
): Promise<void> {
  const qb = manager
    .createQueryBuilder(HrFinanceCategory, 'c')
    .where('c."tenantId" = :tenantId', { tenantId })
    .andWhere('c."isActive" = true')
    .andWhere('lower(c."name") = lower(:name)', { name });
  if (excludeId) {
    qb.andWhere('c."id" != :excludeId', { excludeId });
  }
  if (await qb.getOne()) {
    throw new ConflictException(`An active HR finance category named "${name}" already exists`);
  }
}

@Injectable()
@CommandHandler(CreateHrFinanceCategoryCommand)
export class CreateHrFinanceCategoryHandler
  implements ICommandHandler<CreateHrFinanceCategoryCommand, HrFinanceCategory>
{
  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly seedService: HrFinanceCategorySeedService,
  ) {}

  async execute(command: CreateHrFinanceCategoryCommand): Promise<HrFinanceCategory> {
    const { tenantId, input, userId } = command;
    return runInTenantTransaction(this.dataSource, 'hr', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      await this.seedService.ensureDefaults(manager, tenantId);
      await assertNameFree(manager, tenantId, input.name);

      const category = manager.create(HrFinanceCategory, {
        tenantId,
        name: input.name,
        code: null,
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
        scope: 'HR_EXPENSE',
        kind: 'EXPENSE',
        isSystem: false,
        sourceService: 'hr-service',
      };
      await this.outboxPublisher.enqueue(event, manager);

      return saved;
    });
  }
}

@Injectable()
@CommandHandler(UpdateHrFinanceCategoryCommand)
export class UpdateHrFinanceCategoryHandler
  implements ICommandHandler<UpdateHrFinanceCategoryCommand, HrFinanceCategory>
{
  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: UpdateHrFinanceCategoryCommand): Promise<HrFinanceCategory> {
    const { tenantId, categoryId, input, userId } = command;
    return runInTenantTransaction(this.dataSource, 'hr', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;

      const category = await manager.findOne(HrFinanceCategory, {
        where: { id: categoryId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!category) {
        throw new NotFoundException(`HR finance category ${categoryId} not found`);
      }
      if (input.isActive === false && category.computedRule) {
        throw new BadRequestException(
          `Category "${category.name}" carries a computed rule and cannot be archived`,
        );
      }
      if (input.name && input.name.toLowerCase() !== category.name.toLowerCase()) {
        await assertNameFree(manager, tenantId, input.name, category.id);
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
        scope: 'HR_EXPENSE',
        sourceService: 'hr-service',
      };
      await this.outboxPublisher.enqueue(event, manager);

      return saved;
    });
  }
}

@Injectable()
@CommandHandler(ArchiveHrFinanceCategoryCommand)
export class ArchiveHrFinanceCategoryHandler
  implements ICommandHandler<ArchiveHrFinanceCategoryCommand, HrFinanceCategory>
{
  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: ArchiveHrFinanceCategoryCommand): Promise<HrFinanceCategory> {
    const { tenantId, categoryId, userId } = command;
    return runInTenantTransaction(this.dataSource, 'hr', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;

      const category = await manager.findOne(HrFinanceCategory, {
        where: { id: categoryId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!category) {
        throw new NotFoundException(`HR finance category ${categoryId} not found`);
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
        scope: 'HR_EXPENSE',
        sourceService: 'hr-service',
      };
      await this.outboxPublisher.enqueue(event, manager);

      return saved;
    });
  }
}
