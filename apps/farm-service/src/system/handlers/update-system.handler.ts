/**
 * Update System Command Handler
 */
import {
  runInTenantTransaction,
  tenantManagerRepo,
  TenantScopedRepository,
} from '@aquaculture/backend-common/database';
import { BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { SystemUpdatedEvent, createBaseEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, Not } from 'typeorm';

import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { UpdateSystemCommand } from '../commands/update-system.command';
import { System } from '../entities/system.entity';

import { systemAuditSnapshot } from './system-audit.util';

@CommandHandler(UpdateSystemCommand)
export class UpdateSystemHandler implements ICommandHandler<UpdateSystemCommand, System> {
  private readonly logger = new Logger(UpdateSystemHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: UpdateSystemCommand): Promise<System> {
    const { input, tenantId, userId } = command;
    const systemId = input.id;

    this.logger.log(`Updating system ${systemId} for tenant ${tenantId}`);

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const systemRepository = tenantManagerRepo(queryRunner.manager, System, tenantId);

      const system = await systemRepository.findOne({
        where: { id: systemId, isDeleted: false, tenantId },
      });

      if (!system) {
        throw new NotFoundException(`System with ID "${systemId}" not found`);
      }

      const before = systemAuditSnapshot(system);

      const normalizedCode = input.code ? input.code.toUpperCase() : undefined;
      if (normalizedCode && normalizedCode !== system.code) {
        const existingByCode = await systemRepository.findOne({
          where: { siteId: system.siteId, code: normalizedCode, id: Not(systemId), tenantId },
        });
        if (existingByCode) {
          throw new ConflictException(
            `System with code "${input.code}" already exists in this site`,
          );
        }
      }

      if (input.parentSystemId !== undefined) {
        if (input.parentSystemId) {
          if (input.parentSystemId === systemId) {
            throw new BadRequestException('A system cannot be its own parent');
          }

          const parentSystem = await systemRepository.findOne({
            where: { id: input.parentSystemId, isDeleted: false, tenantId },
          });
          if (!parentSystem) {
            throw new NotFoundException(
              `Parent system with ID "${input.parentSystemId}" not found`,
            );
          }
          if (parentSystem.siteId !== system.siteId) {
            throw new BadRequestException(
              `Parent system with ID "${input.parentSystemId}" does not belong to Site "${system.siteId}"`,
            );
          }

          await this.checkCircularReference(systemRepository, systemId, input.parentSystemId, tenantId);
        }
      }

      const updateData: Partial<System> = {
        updatedBy: userId,
      };

      if (input.name !== undefined) updateData.name = input.name;
      if (normalizedCode !== undefined) updateData.code = normalizedCode;
      if (input.type !== undefined) updateData.type = input.type;
      if (input.status !== undefined) updateData.status = input.status;
      if (input.description !== undefined) updateData.description = input.description;
      if (input.departmentId !== undefined) updateData.departmentId = input.departmentId;
      if (input.parentSystemId !== undefined) updateData.parentSystemId = input.parentSystemId;
      if (input.totalVolumeM3 !== undefined) updateData.totalVolumeM3 = input.totalVolumeM3;
      if (input.maxBiomassKg !== undefined) updateData.maxBiomassKg = input.maxBiomassKg;
      if (input.tankCount !== undefined) updateData.tankCount = input.tankCount;
      if (input.isActive !== undefined) updateData.isActive = input.isActive;

      Object.assign(system, updateData);

      const updatedSystem = await systemRepository.save(system);

      await this.auditLogService.logWithManager(queryRunner.manager, {
        tenantId,
        entityType: 'System',
        entityId: updatedSystem.id,
        action: AuditAction.UPDATE,
        userId,
        changes: {
          before,
          after: systemAuditSnapshot(updatedSystem),
        },
        metadata: { source: 'SITES_SETUP' },
        entityVersion: updatedSystem.version,
        summary: `Updated system ${updatedSystem.code}`,
      });

      const event: SystemUpdatedEvent = {
        ...createBaseEvent<SystemUpdatedEvent>('SystemUpdated', tenantId, {
          aggregateId: updatedSystem.id,
          aggregateType: 'System',
          userId,
        }),
        systemId: updatedSystem.id,
        siteId: updatedSystem.siteId,
        name: updatedSystem.name,
        status: updatedSystem.status,
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager, {
        aggregateId: updatedSystem.id,
      });

      this.logger.log(`System ${systemId} updated successfully`);
      return updatedSystem;
    });
  }

  /**
   * Check for circular reference in parent-child hierarchy
   */
  private async checkCircularReference(
    systemRepository: TenantScopedRepository<System>,
    systemId: string,
    newParentId: string,
    tenantId: string,
  ): Promise<void> {
    let currentParentId: string | null = newParentId;
    const visited = new Set<string>();

    while (currentParentId) {
      if (visited.has(currentParentId)) {
        throw new BadRequestException('Circular reference detected in system hierarchy');
      }
      if (currentParentId === systemId) {
        throw new BadRequestException(
          'This would create a circular reference in the system hierarchy',
        );
      }
      visited.add(currentParentId);

      const parent = await systemRepository.findOne({
        where: { id: currentParentId, tenantId },
        select: ['id', 'parentSystemId'],
      });

      currentParentId = parent?.parentSystemId ?? null;
    }
  }
}
