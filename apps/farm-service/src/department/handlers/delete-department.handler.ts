/**
 * Delete Department Command Handler
 * Supports cascade soft delete of all related items
 */
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { toEventIso, DepartmentDeletedEvent, createBaseEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { System } from '../../system/entities/system.entity';
import { Tank } from '../../tank/entities/tank.entity';
import { DeleteDepartmentCommand } from '../commands/delete-department.command';
import { Department } from '../entities/department.entity';

import { departmentAuditSnapshot } from './department-audit.util';
import { BatchAggregateMutationPort } from '../../batch/batch-aggregate-mutation.port';

@CommandHandler(DeleteDepartmentCommand)
export class DeleteDepartmentHandler implements ICommandHandler<DeleteDepartmentCommand, boolean> {
  private readonly logger = new Logger(DeleteDepartmentHandler.name);

  constructor(
    private readonly batchMutations: BatchAggregateMutationPort,
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: DeleteDepartmentCommand): Promise<boolean> {
    const { departmentId, tenantId, userId, cascade } = command;

    this.logger.log(
      `Deleting department ${departmentId} for tenant ${tenantId} (cascade: ${cascade})`,
    );

    await runInTenantTransaction(
      this.dataSource,
      'farm',
      tenantId,
      async (queryRunner, mutationSession) => {
        const departmentRepository = tenantManagerRepo(queryRunner.manager, Department, tenantId);
        const equipmentRepository = tenantManagerRepo(queryRunner.manager, Equipment, tenantId);
        const tankRepository = tenantManagerRepo(queryRunner.manager, Tank, tenantId);
        const systemRepository = tenantManagerRepo(queryRunner.manager, System, tenantId);

        const department = await departmentRepository.findOne({
          where: { id: departmentId, isDeleted: false, tenantId },
        });

        if (!department) {
          throw new NotFoundException(`Department with ID "${departmentId}" not found`);
        }

        const before = departmentAuditSnapshot(department);
        const equipment = await equipmentRepository.find({
          where: { departmentId, isDeleted: false, tenantId },
        });

        const tanks = await tankRepository.find({
          where: { departmentId, isActive: true, tenantId },
        });

        if (!cascade) {
          if (equipment.length > 0 || tanks.length > 0) {
            throw new BadRequestException(
              `Cannot delete department "${department.name}". It has ${equipment.length} equipment(s) and ${tanks.length} tank(s). Use cascade=true to delete all related items.`,
            );
          }
        } else {
          this.logger.log(`Cascade deleting department ${departmentId} with all related items`);

          const now = new Date();
          const tanksWithBiomass = tanks.filter(
            (t) => t.currentBiomass && Number(t.currentBiomass) > 0,
          );

          if (tanksWithBiomass.length > 0) {
            const totalBiomass = tanksWithBiomass.reduce(
              (sum, t) => sum + Number(t.currentBiomass || 0),
              0,
            );
            throw new BadRequestException(
              `Cannot delete department "${department.name}". ${tanksWithBiomass.length} tank(s) contain ${totalBiomass.toFixed(2)} kg of active biomass. Please harvest or transfer fish before deleting.`,
            );
          }

          if (tanks.length > 0) {
            await this.batchMutations.deactivateDepartmentTanks(mutationSession, {
              departmentIds: [departmentId],
              userId,
            });

            this.logger.log(`Soft deleted ${tanks.length} tanks for department ${departmentId}`);
          }

          if (equipment.length > 0) {
            await equipmentRepository.update(
              { departmentId, isDeleted: false },
              {
                isDeleted: true,
                deletedAt: now,
                deletedBy: userId,
                isActive: false,
                updatedBy: userId,
              },
            );

            this.logger.log(
              `Soft deleted ${equipment.length} equipment for department ${departmentId}`,
            );
          }

          await systemRepository.update(
            { departmentId, isDeleted: false },
            {
              departmentId: null,
              updatedBy: userId,
            },
          );

          this.logger.log(`Orphaned systems for department ${departmentId}`);
        }

        department.isDeleted = true;
        department.deletedAt = new Date();
        department.deletedBy = userId;
        department.isActive = false;
        department.updatedBy = userId;
        const deletedDepartment = await departmentRepository.save(department);

        await this.auditLogService.logWithManager(queryRunner.manager, {
          tenantId,
          entityType: 'Department',
          entityId: deletedDepartment.id,
          action: AuditAction.SOFT_DELETE,
          userId,
          changes: {
            before,
            after: departmentAuditSnapshot(deletedDepartment),
          },
          metadata: { source: 'SITES_SETUP' },
          entityVersion: deletedDepartment.version,
          summary: `Soft deleted department ${deletedDepartment.code}`,
        });

        const event: DepartmentDeletedEvent = {
          ...createBaseEvent<DepartmentDeletedEvent>('DepartmentDeleted', tenantId, {
            aggregateId: deletedDepartment.id,
            aggregateType: 'Department',
            userId,
          }),
          departmentId: deletedDepartment.id,
          siteId: deletedDepartment.siteId ?? '',
          name: deletedDepartment.name,
          code: deletedDepartment.code,
          deletedAt: toEventIso(deletedDepartment.deletedAt ?? new Date()),
        };
        await this.outboxPublisher.enqueue(event, queryRunner.manager, {
          aggregateId: deletedDepartment.id,
        });

        this.logger.log(`Department ${departmentId} marked as deleted`);
      },
    );

    return true;
  }
}
