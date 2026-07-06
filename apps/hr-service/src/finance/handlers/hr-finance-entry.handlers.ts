/**
 * HR finance entry command handlers — manual HR expense bookings.
 *
 * Guards mirror the farm finance handlers: category must exist, be
 * active and not computed; currency defaults from the tenant settings
 * (never a literal); every write enqueues its finance event on the
 * hr outbox inside the same transaction.
 */
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { createBaseEvent, toEventIso } from '@platform/event-contracts';
import type {
  FinanceEntryDeletedEvent,
  FinanceEntryRecordedEvent,
  FinanceEntryUpdatedEvent,
} from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, EntityManager } from 'typeorm';

import {
  CreateHrFinanceEntryCommand,
  DeleteHrFinanceEntryCommand,
  UpdateHrFinanceEntryCommand,
} from '../commands/hr-finance.commands';
import { HrFinanceCategory } from '../entities/hr-finance-category.entity';
import { HrFinanceEntry } from '../entities/hr-finance-entry.entity';
import { HrFinanceCategorySeedService } from '../services/hr-finance-category-seed.service';
import { PayrollCostSettingsService } from '../services/payroll-cost-settings.service';

async function loadBookableCategory(
  manager: EntityManager,
  tenantId: string,
  categoryId: string,
): Promise<HrFinanceCategory> {
  const category = await manager.findOne(HrFinanceCategory, {
    where: { id: categoryId, tenantId },
  });
  if (!category) {
    throw new NotFoundException(`HR finance category ${categoryId} not found`);
  }
  if (!category.isActive) {
    throw new BadRequestException(
      `HR finance category "${category.name}" is archived — restore it before booking entries`,
    );
  }
  if (category.computedRule) {
    throw new BadRequestException(
      `HR finance category "${category.name}" is computed — its value is derived at read time`,
    );
  }
  return category;
}

@Injectable()
@CommandHandler(CreateHrFinanceEntryCommand)
export class CreateHrFinanceEntryHandler
  implements ICommandHandler<CreateHrFinanceEntryCommand, HrFinanceEntry>
{
  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly seedService: HrFinanceCategorySeedService,
    private readonly settingsService: PayrollCostSettingsService,
  ) {}

  async execute(command: CreateHrFinanceEntryCommand): Promise<HrFinanceEntry> {
    const { tenantId, input, userId } = command;
    return runInTenantTransaction(this.dataSource, 'hr', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      await this.seedService.ensureDefaults(manager, tenantId);
      const category = await loadBookableCategory(manager, tenantId, input.categoryId);

      const currency =
        input.currency ??
        (await this.settingsService.getDefaultCurrencyInTx(manager, tenantId));

      const entry = manager.create(HrFinanceEntry, {
        tenantId,
        categoryId: category.id,
        entryDate: new Date(input.entryDate),
        amount: input.amount,
        currency,
        description: input.description,
        departmentHrId: input.departmentHrId,
        employeeId: input.employeeId,
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
        scope: 'HR_EXPENSE',
        amount: Number(saved.amount).toFixed(2),
        currency: saved.currency,
        entryDate: toEventIso(saved.entryDate),
        dimensions: { departmentHrId: saved.departmentHrId ?? undefined },
        sourceService: 'hr-service',
      };
      await this.outboxPublisher.enqueue(event, manager);

      return saved;
    });
  }
}

@Injectable()
@CommandHandler(UpdateHrFinanceEntryCommand)
export class UpdateHrFinanceEntryHandler
  implements ICommandHandler<UpdateHrFinanceEntryCommand, HrFinanceEntry>
{
  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: UpdateHrFinanceEntryCommand): Promise<HrFinanceEntry> {
    const { tenantId, entryId, input, userId } = command;
    return runInTenantTransaction(this.dataSource, 'hr', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;

      const entry = await manager.findOne(HrFinanceEntry, {
        where: { id: entryId, tenantId, isDeleted: false },
        lock: { mode: 'pessimistic_write' },
      });
      if (!entry) {
        throw new NotFoundException(`HR finance entry ${entryId} not found`);
      }

      let category: HrFinanceCategory;
      if (input.categoryId && input.categoryId !== entry.categoryId) {
        category = await loadBookableCategory(manager, tenantId, input.categoryId);
        entry.categoryId = category.id;
      } else {
        const existing = await manager.findOne(HrFinanceCategory, {
          where: { id: entry.categoryId, tenantId },
        });
        if (!existing) {
          throw new NotFoundException(`HR finance category ${entry.categoryId} not found`);
        }
        category = existing;
      }

      if (input.entryDate !== undefined) entry.entryDate = new Date(input.entryDate);
      if (input.amount !== undefined) entry.amount = input.amount;
      if (input.currency !== undefined) entry.currency = input.currency;
      if (input.description !== undefined) entry.description = input.description;
      if (input.departmentHrId !== undefined) entry.departmentHrId = input.departmentHrId;
      if (input.employeeId !== undefined) entry.employeeId = input.employeeId;
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
        scope: 'HR_EXPENSE',
        amount: Number(saved.amount).toFixed(2),
        currency: saved.currency,
        entryDate: toEventIso(saved.entryDate),
        dimensions: { departmentHrId: saved.departmentHrId ?? undefined },
        sourceService: 'hr-service',
      };
      await this.outboxPublisher.enqueue(event, manager);

      return saved;
    });
  }
}

@Injectable()
@CommandHandler(DeleteHrFinanceEntryCommand)
export class DeleteHrFinanceEntryHandler
  implements ICommandHandler<DeleteHrFinanceEntryCommand, boolean>
{
  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: DeleteHrFinanceEntryCommand): Promise<boolean> {
    const { tenantId, entryId, userId } = command;
    return runInTenantTransaction(this.dataSource, 'hr', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;

      const entry = await manager.findOne(HrFinanceEntry, {
        where: { id: entryId, tenantId, isDeleted: false },
        lock: { mode: 'pessimistic_write' },
      });
      if (!entry) {
        throw new NotFoundException(`HR finance entry ${entryId} not found`);
      }

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
        scope: 'HR_EXPENSE',
        sourceService: 'hr-service',
      };
      await this.outboxPublisher.enqueue(event, manager);

      return true;
    });
  }
}
