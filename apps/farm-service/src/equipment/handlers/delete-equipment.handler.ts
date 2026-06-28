/**
 * Delete Equipment Command Handler
 */
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { toEventIso,
  EquipmentDeletedEvent,
  SubEquipmentDeletedEvent,
  createBaseEvent,
} from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import {
  DataSource,
  DeepPartial,
  FindManyOptions,
  FindOptionsWhere,
  In,
  QueryRunner,
  UpdateResult,
} from 'typeorm';

import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { Tank } from '../../tank/entities/tank.entity';
import { DeleteEquipmentCommand } from '../commands/delete-equipment.command';
import { Equipment } from '../entities/equipment.entity';
import { SubEquipment } from '../entities/sub-equipment.entity';
import { TankEquipmentAdapterService } from '../services/tank-equipment-adapter.service';

import { equipmentAuditSnapshot, subEquipmentAuditSnapshot } from './equipment-audit.util';

type ScopedWriteRepository<T> = {
  find: (options?: FindManyOptions<T>) => Promise<T[]>;
  count: (options?: FindManyOptions<T>) => Promise<number>;
  save: (entity: T) => Promise<T>;
  update: (criteria: FindOptionsWhere<T>, partialEntity: DeepPartial<T>) => Promise<UpdateResult>;
};

@CommandHandler(DeleteEquipmentCommand)
export class DeleteEquipmentHandler implements ICommandHandler<DeleteEquipmentCommand, boolean> {
  private readonly logger = new Logger(DeleteEquipmentHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly tankEquipmentAdapter: TankEquipmentAdapterService,
  ) {}

  async execute(command: DeleteEquipmentCommand): Promise<boolean> {
    const { equipmentId, tenantId, userId, cascade } = command;

    this.logger.log(`Deleting equipment ${equipmentId} for tenant ${tenantId} (cascade: ${cascade})`);

    const tankRepository = tenantManagerRepo(this.dataSource.manager, Tank, tenantId);
    const tank = await tankRepository.findOne({
      where: { id: equipmentId, tenantId },
    });
    if (tank) {
      return this.tankEquipmentAdapter.deleteFromEquipment(equipmentId, tenantId, userId);
    }

    await runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const equipmentRepository = tenantManagerRepo(queryRunner.manager, Equipment, tenantId);
      const subEquipmentRepository = tenantManagerRepo(queryRunner.manager, SubEquipment, tenantId);

      const equipment = await equipmentRepository.findOne({
        where: { id: equipmentId, isDeleted: false, tenantId },
      });
      if (!equipment) {
        throw new NotFoundException(`Equipment with ID "${equipmentId}" not found`);
      }

      const childEquipment = await this.getChildEquipmentRecursive(
        equipmentRepository,
        equipmentId,
        tenantId,
      );
      const subEquipment = await subEquipmentRepository.find({
        where: { parentEquipmentId: equipmentId, isActive: true, tenantId },
      });

      if (!cascade) {
        if (childEquipment.length > 0) {
          throw new BadRequestException(
            `Cannot delete equipment "${equipment.name}". It has ${childEquipment.length} child equipment(s). Use cascade=true to delete all related items.`,
          );
        }
        if (subEquipment.length > 0) {
          throw new BadRequestException(
            `Cannot delete equipment "${equipment.name}". It has ${subEquipment.length} sub-equipment(s). Use cascade=true to delete all related items.`,
          );
        }
      }

      const deletedAt = new Date();
      if (cascade) {
            for (const child of [...childEquipment].reverse()) {
              await this.softDeleteEquipment(
                queryRunner,
                equipmentRepository,
                child,
                tenantId,
            userId,
            deletedAt,
          );
        }
            for (const childSubEquipment of subEquipment) {
              await this.softDeleteSubEquipment(
                queryRunner,
                subEquipmentRepository,
                childSubEquipment,
                tenantId,
            userId,
          );
        }
      }

          await this.softDeleteEquipment(
            queryRunner,
            equipmentRepository,
            equipment,
            tenantId,
        userId,
        deletedAt,
      );

      await this.recomputeChildEquipmentCount(equipmentRepository, equipment.parentEquipmentId);
    });

    this.logger.log(`Equipment ${equipmentId} marked as deleted`);
    return true;
  }

  private async softDeleteEquipment(
    queryRunner: QueryRunner,
    equipmentRepository: ScopedWriteRepository<Equipment>,
    equipment: Equipment,
    tenantId: string,
    userId: string,
    deletedAt: Date,
  ): Promise<void> {
    const before = equipmentAuditSnapshot(equipment);
    equipment.isDeleted = true;
    equipment.deletedAt = deletedAt;
    equipment.deletedBy = userId;
    equipment.isActive = false;
    equipment.updatedBy = userId;
    const saved = await equipmentRepository.save(equipment);

    await this.auditLogService.logWithManager(queryRunner.manager, {
      tenantId,
      entityType: 'Equipment',
      entityId: saved.id,
      action: AuditAction.SOFT_DELETE,
      userId,
      changes: {
        before,
        after: equipmentAuditSnapshot(saved),
      },
      metadata: { source: 'SITES_SETUP_EQUIPMENT' },
      entityVersion: saved.version,
      summary: `Soft deleted equipment ${saved.code}`,
    });

    const event: EquipmentDeletedEvent = {
      ...createBaseEvent<EquipmentDeletedEvent>('EquipmentDeleted', tenantId, {
        aggregateId: saved.id,
        aggregateType: 'Equipment',
        userId,
      }),
      equipmentId: saved.id,
      name: saved.name,
      code: saved.code,
      deletedAt: toEventIso(deletedAt),
    };
    await this.outboxPublisher.enqueue(event, queryRunner.manager, { aggregateId: saved.id });
  }

  private async softDeleteSubEquipment(
    queryRunner: QueryRunner,
    subEquipmentRepository: ScopedWriteRepository<SubEquipment>,
    subEquipment: SubEquipment,
    tenantId: string,
    userId: string,
  ): Promise<void> {
    const before = subEquipmentAuditSnapshot(subEquipment);
    subEquipment.isActive = false;
    subEquipment.updatedBy = userId;
    const saved = await subEquipmentRepository.save(subEquipment);

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
  }

  private async getChildEquipmentRecursive(
    equipmentRepository: ScopedWriteRepository<Equipment>,
    parentId: string,
    tenantId: string,
    maxDepth = 10,
  ): Promise<Equipment[]> {
    const allChildren: Equipment[] = [];
    let currentParentIds = [parentId];
    let depth = 0;

    while (currentParentIds.length > 0) {
      if (depth >= maxDepth) {
        throw new BadRequestException(`Equipment hierarchy depth limit (${maxDepth}) exceeded`);
      }
      const children = await equipmentRepository.find({
        where: {
          parentEquipmentId: In(currentParentIds),
          isDeleted: false,
          tenantId,
        },
      });
      if (children.length === 0) break;
      allChildren.push(...children);
      currentParentIds = children.map((child) => child.id);
      depth += 1;
    }

    return allChildren;
  }

  private async recomputeChildEquipmentCount(
    equipmentRepository: ScopedWriteRepository<Equipment>,
    equipmentId?: string,
  ): Promise<void> {
    if (!equipmentId) return;
    const childCount = await equipmentRepository.count({
      where: { parentEquipmentId: equipmentId, isDeleted: false },
    });
    await equipmentRepository.update({ id: equipmentId }, { subEquipmentCount: childCount });
  }
}
