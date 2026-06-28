/**
 * Delete System Command Handler
 * Supports cascade soft delete of all related items
 */
import {
  runInTenantTransaction,
  tenantManagerRepo,
  TenantScopedRepository,
} from '@aquaculture/backend-common/database';
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { toEventIso, SystemDeletedEvent, createBaseEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, In } from 'typeorm';

import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { EquipmentSystem } from '../../equipment/entities/equipment-system.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { DeleteSystemCommand } from '../commands/delete-system.command';
import { System } from '../entities/system.entity';

import { systemAuditSnapshot } from './system-audit.util';

@CommandHandler(DeleteSystemCommand)
export class DeleteSystemHandler implements ICommandHandler<DeleteSystemCommand, boolean> {
  private readonly logger = new Logger(DeleteSystemHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: DeleteSystemCommand): Promise<boolean> {
    const { systemId, tenantId, userId, cascade } = command;

    this.logger.log(`Deleting system ${systemId} for tenant ${tenantId} (cascade: ${cascade})`);

    await runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const systemRepository = tenantManagerRepo(queryRunner.manager, System, tenantId);
      const equipmentRepository = tenantManagerRepo(queryRunner.manager, Equipment, tenantId);
      const equipmentSystemRepository = tenantManagerRepo(
        queryRunner.manager,
        EquipmentSystem,
        tenantId,
      );

      const system = await systemRepository.findOne({
        where: { id: systemId, isDeleted: false, tenantId },
      });

      if (!system) {
        throw new NotFoundException(`System with ID "${systemId}" not found`);
      }

      const before = systemAuditSnapshot(system);
      const childSystems = await this.getChildSystemsRecursive(systemRepository, systemId, tenantId);

      if (!cascade) {
        if (childSystems.length > 0) {
          throw new BadRequestException(
            `Cannot delete system "${system.name}". It has ${childSystems.length} child system(s). Use cascade=true to delete all related items.`,
          );
        }
      } else {
        this.logger.log(
          `Cascade deleting system ${systemId} with ${childSystems.length} child systems`,
        );

        const allSystemIds = [systemId, ...childSystems.map((s) => s.id)];

        await equipmentSystemRepository.delete({
          systemId: In(allSystemIds),
        });

        this.logger.log(
          `Deleted equipment-system junction records for ${allSystemIds.length} systems`,
        );

        for (const childSystem of childSystems.reverse()) {
          childSystem.softDelete(userId);
          await systemRepository.save(childSystem);
          this.logger.log(`Soft deleted child system ${childSystem.id}`);
        }
      }

      const equipmentSystems = await equipmentSystemRepository.find({
        where: { systemId, tenantId },
        relations: ['equipment'],
      });

      if (equipmentSystems.length > 0) {
        this.logger.log(
          `Found ${equipmentSystems.length} equipment(s) connected to system ${systemId}. Setting them as inactive.`,
        );

        const equipmentIds = equipmentSystems.map((es) => es.equipmentId);
        await equipmentRepository.update(
          { id: In(equipmentIds) },
          { isActive: false, updatedBy: userId },
        );

        await equipmentSystemRepository.delete({ systemId });

        this.logger.log(
          `Deactivated ${equipmentIds.length} equipment(s) and removed their system associations`,
        );
      }

      system.softDelete(userId);
      const deletedSystem = await systemRepository.save(system);

      await this.auditLogService.logWithManager(queryRunner.manager, {
        tenantId,
        entityType: 'System',
        entityId: deletedSystem.id,
        action: AuditAction.SOFT_DELETE,
        userId,
        changes: {
          before,
          after: systemAuditSnapshot(deletedSystem),
        },
        metadata: { source: 'SITES_SETUP' },
        entityVersion: deletedSystem.version,
        summary: `Soft deleted system ${deletedSystem.code}`,
      });

      const event: SystemDeletedEvent = {
        ...createBaseEvent<SystemDeletedEvent>('SystemDeleted', tenantId, {
          aggregateId: deletedSystem.id,
          aggregateType: 'System',
          userId,
        }),
        systemId: deletedSystem.id,
        siteId: deletedSystem.siteId,
        name: deletedSystem.name,
        code: deletedSystem.code,
        deletedAt: toEventIso(deletedSystem.deletedAt ?? new Date()),
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager, {
        aggregateId: deletedSystem.id,
      });

      this.logger.log(`System ${systemId} marked as deleted`);
    });

    return true;
  }

  /**
   * Get all child systems using batch loading to avoid N+1 queries
   * Uses iterative breadth-first approach with depth limit
   */
  private async getChildSystemsRecursive(
    systemRepository: TenantScopedRepository<System>,
    parentId: string,
    tenantId: string,
    maxDepth: number = 10,
  ): Promise<System[]> {
    const allChildren: System[] = [];
    let currentParentIds = [parentId];
    let depth = 0;

    while (currentParentIds.length > 0 && depth < maxDepth) {
      // Batch fetch all children for current level
      const children = await systemRepository.find({
        where: {
          parentSystemId: In(currentParentIds),
          isDeleted: false,
          tenantId,
        },
      });

      if (children.length === 0) {
        break;
      }

      allChildren.push(...children);
      currentParentIds = children.map((child) => child.id);
      depth++;
    }

    if (depth >= maxDepth) {
      this.logger.warn(
        `Max depth (${maxDepth}) reached while fetching child systems for parent ${parentId}`,
      );
    }

    return allChildren;
  }
}
