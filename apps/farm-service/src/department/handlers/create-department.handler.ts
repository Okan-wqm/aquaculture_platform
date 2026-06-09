/**
 * Create Department Command Handler
 */
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DepartmentCreatedEvent, createBaseEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { Site } from '../../site/entities/site.entity';
import { CreateDepartmentCommand } from '../commands/create-department.command';
import { Department, DepartmentStatus } from '../entities/department.entity';

import { departmentAuditSnapshot } from './department-audit.util';

@CommandHandler(CreateDepartmentCommand)
export class CreateDepartmentHandler
  implements ICommandHandler<CreateDepartmentCommand, Department>
{
  private readonly logger = new Logger(CreateDepartmentHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: CreateDepartmentCommand): Promise<Department> {
    const { input, tenantId, userId } = command;

    this.logger.log(`Creating department "${input.name}" for tenant ${tenantId}`);

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const departmentRepository = tenantManagerRepo(queryRunner.manager, Department, tenantId);
      const siteRepository = tenantManagerRepo(queryRunner.manager, Site, tenantId);

      const site = await siteRepository.findOne({
        where: { id: input.siteId, tenantId },
      });
      if (!site) {
        throw new NotFoundException(`Site with ID "${input.siteId}" not found`);
      }

      const existingByName = await departmentRepository.findOne({
        where: { siteId: input.siteId, name: input.name, tenantId },
      });
      if (existingByName) {
        throw new ConflictException(
          `Department with name "${input.name}" already exists in this site`,
        );
      }

      const code = input.code.toUpperCase();
      const existingByCode = await departmentRepository.findOne({
        where: { code, tenantId },
      });
      if (existingByCode) {
        throw new ConflictException(`Department with code "${input.code}" already exists`);
      }

      const department = departmentRepository.create({
        siteId: input.siteId,
        name: input.name,
        code,
        type: input.type,
        description: input.description,
        capacity: input.capacity,
        notes: input.notes,
        status: DepartmentStatus.ACTIVE,
        managerUserId: input.managerId,
        managerName: input.managerName,
        isActive: true,
        createdBy: userId,
        updatedBy: userId,
      });

      const savedDepartment = await departmentRepository.save(department);

      await this.auditLogService.logWithManager(queryRunner.manager, {
        tenantId,
        entityType: 'Department',
        entityId: savedDepartment.id,
        action: AuditAction.CREATE,
        userId,
        changes: { after: departmentAuditSnapshot(savedDepartment) },
        metadata: { source: 'SITES_SETUP' },
        entityVersion: savedDepartment.version,
        summary: `Created department ${savedDepartment.code}`,
      });

      const event: DepartmentCreatedEvent = {
        ...createBaseEvent<DepartmentCreatedEvent>('DepartmentCreated', tenantId, {
          aggregateId: savedDepartment.id,
          aggregateType: 'Department',
          userId,
        }),
        departmentId: savedDepartment.id,
        siteId: savedDepartment.siteId ?? '',
        name: savedDepartment.name,
        code: savedDepartment.code,
        type: savedDepartment.type,
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager, {
        aggregateId: savedDepartment.id,
      });

      this.logger.log(`Department "${savedDepartment.name}" created with ID ${savedDepartment.id}`);
      return savedDepartment;
    });
  }
}
