/**
 * Delete SubEquipment Command Handler
 */
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { Logger, NotFoundException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { toEventIso, SubEquipmentDeletedEvent, createBaseEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, DeepPartial, FindManyOptions, FindOptionsWhere, UpdateResult } from 'typeorm';

import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { DeleteSubEquipmentCommand } from '../commands/delete-sub-equipment.command';
import { Equipment } from '../entities/equipment.entity';
import { SubEquipment } from '../entities/sub-equipment.entity';

import { subEquipmentAuditSnapshot } from './equipment-audit.util';

type CountUpdateRepository<T> = {
  count: (options?: FindManyOptions<T>) => Promise<number>;
  update: (criteria: FindOptionsWhere<T>, partialEntity: DeepPartial<T>) => Promise<UpdateResult>;
};

@CommandHandler(DeleteSubEquipmentCommand)
export class DeleteSubEquipmentHandler implements ICommandHandler<DeleteSubEquipmentCommand, boolean> {
  private readonly logger = new Logger(DeleteSubEquipmentHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: DeleteSubEquipmentCommand): Promise<boolean> {
    const { id, tenantId, userId } = command;

    this.logger.log(`Deleting sub-equipment ${id} for tenant ${tenantId} by user ${userId}`);

    await runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const subEquipmentRepository = tenantManagerRepo(queryRunner.manager, SubEquipment, tenantId);
      const equipmentRepository = tenantManagerRepo(queryRunner.manager, Equipment, tenantId);

      const subEquipment = await subEquipmentRepository.findOne({ where: { id, tenantId } });
      if (!subEquipment) {
        throw new NotFoundException(`Sub-equipment with ID "${id}" not found`);
      }

      if (!subEquipment.isActive) {
        await this.recomputeParentSubEquipmentCount(
          equipmentRepository,
          subEquipmentRepository,
          subEquipment.parentEquipmentId,
        );
        return;
      }

      const before = subEquipmentAuditSnapshot(subEquipment);
      subEquipment.isActive = false;
      subEquipment.updatedBy = userId;
      const saved = await subEquipmentRepository.save(subEquipment);
      await this.recomputeParentSubEquipmentCount(
        equipmentRepository,
        subEquipmentRepository,
        saved.parentEquipmentId,
      );

      await this.auditLogService.logWithManager(queryRunner.manager, {
        tenantId,
        entityType: 'SubEquipment',
        entityId: saved.id,
        action: AuditAction.SOFT_DELETE,
        userId,
        changes: {
          before,
          after: subEquipmentAuditSnapshot(saved),
        },
        metadata: { source: 'SITES_SETUP_SUB_EQUIPMENT' },
        entityVersion: saved.version,
        summary: `Soft deleted sub-equipment ${saved.code}`,
      });

      const event: SubEquipmentDeletedEvent = {
        ...createBaseEvent<SubEquipmentDeletedEvent>('SubEquipmentDeleted', tenantId, {
          aggregateId: saved.id,
          aggregateType: 'SubEquipment',
          userId,
        }),
        subEquipmentId: saved.id,
        parentEquipmentId: saved.parentEquipmentId,
        name: saved.name,
        code: saved.code,
        deletedAt: toEventIso(new Date()),
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager, { aggregateId: saved.id });
    });

    this.logger.log(`Sub-equipment ${id} deleted successfully`);
    return true;
  }

  private async recomputeParentSubEquipmentCount(
    equipmentRepository: CountUpdateRepository<Equipment>,
    subEquipmentRepository: CountUpdateRepository<SubEquipment>,
    parentEquipmentId: string,
  ): Promise<void> {
    const [childEquipmentCount, subEquipmentCount] = await Promise.all([
      equipmentRepository.count({ where: { parentEquipmentId, isDeleted: false } }),
      subEquipmentRepository.count({ where: { parentEquipmentId, isActive: true } }),
    ]);
    await equipmentRepository.update(
      { id: parentEquipmentId },
      { subEquipmentCount: childEquipmentCount + subEquipmentCount },
    );
  }
}
