/**
 * Update Department Command Handler
 */
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DepartmentUpdatedEvent, createBaseEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, IsNull, Not } from 'typeorm';

import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { UpdateDepartmentCommand } from '../commands/update-department.command';
import { Department } from '../entities/department.entity';

import { departmentAuditSnapshot } from './department-audit.util';

@CommandHandler(UpdateDepartmentCommand)
export class UpdateDepartmentHandler
  implements ICommandHandler<UpdateDepartmentCommand, Department>
{
  private readonly logger = new Logger(UpdateDepartmentHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: UpdateDepartmentCommand): Promise<Department> {
    const { departmentId, input, tenantId, userId } = command;

    this.logger.log(`Updating department ${departmentId} for tenant ${tenantId}`);

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const departmentRepository = tenantManagerRepo(queryRunner.manager, Department, tenantId);

      const department = await departmentRepository.findOne({
        where: { id: departmentId, tenantId },
      });

      if (!department) {
        throw new NotFoundException(`Department with ID "${departmentId}" not found`);
      }

      const before = departmentAuditSnapshot(department);

      if (input.name && input.name !== department.name) {
        const existingByName = await departmentRepository.findOne({
          where: {
            siteId: department.siteId === null ? IsNull() : department.siteId,
            name: input.name,
            id: Not(departmentId),
            tenantId,
          },
        });
        if (existingByName) {
          throw new ConflictException(
            `Department with name "${input.name}" already exists in this site`,
          );
        }
      }

      const normalizedCode = input.code ? input.code.toUpperCase() : undefined;
      if (normalizedCode && normalizedCode !== department.code) {
        const existingByCode = await departmentRepository.findOne({
          where: { code: normalizedCode, id: Not(departmentId), tenantId },
        });
        if (existingByCode) {
          throw new ConflictException(`Department with code "${input.code}" already exists`);
        }
      }

      Object.assign(department, {
        ...input,
        code: normalizedCode ?? department.code,
        managerUserId: input.managerId ?? department.managerUserId,
        updatedBy: userId,
      });

      const updatedDepartment = await departmentRepository.save(department);

      await this.auditLogService.logWithManager(queryRunner.manager, {
        tenantId,
        entityType: 'Department',
        entityId: updatedDepartment.id,
        action: AuditAction.UPDATE,
        userId,
        changes: {
          before,
          after: departmentAuditSnapshot(updatedDepartment),
        },
        metadata: { source: 'SITES_SETUP' },
        entityVersion: updatedDepartment.version,
        summary: `Updated department ${updatedDepartment.code}`,
      });

      const event: DepartmentUpdatedEvent = {
        ...createBaseEvent<DepartmentUpdatedEvent>('DepartmentUpdated', tenantId, {
          aggregateId: updatedDepartment.id,
          aggregateType: 'Department',
          userId,
        }),
        departmentId: updatedDepartment.id,
        siteId: updatedDepartment.siteId ?? '',
        name: updatedDepartment.name,
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager, {
        aggregateId: updatedDepartment.id,
      });

      this.logger.log(`Department ${departmentId} updated successfully`);
      return updatedDepartment;
    });
  }
}
