/**
 * Update SubEquipment Command Handler
 */
import { ConflictException, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { SubEquipmentUpdatedEvent, createBaseEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { UpdateSubEquipmentCommand } from '../commands/update-sub-equipment.command';
import { SubEquipment } from '../entities/sub-equipment.entity';
import { subEquipmentAuditSnapshot } from './equipment-audit.util';

@CommandHandler(UpdateSubEquipmentCommand)
export class UpdateSubEquipmentHandler implements ICommandHandler<UpdateSubEquipmentCommand, SubEquipment> {
  private readonly logger = new Logger(UpdateSubEquipmentHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: UpdateSubEquipmentCommand): Promise<SubEquipment> {
    const { id, input, tenantId, userId } = command;

    this.logger.log(`Updating sub-equipment ${id} for tenant ${tenantId}`);

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const subEquipmentRepository = tenantManagerRepo(queryRunner.manager, SubEquipment, tenantId);

      const subEquipment = await subEquipmentRepository.findOne({
        where: { id, tenantId },
        relations: ['subEquipmentType', 'parentEquipment'],
      });
      if (!subEquipment) {
        throw new NotFoundException(`Sub-equipment with ID "${id}" not found`);
      }

      const before = subEquipmentAuditSnapshot(subEquipment);

      if (input.code && input.code.toUpperCase() !== subEquipment.code) {
        const normalizedCode = input.code.toUpperCase();
        const existingByCode = await subEquipmentRepository.findOne({
          where: {
            parentEquipmentId: subEquipment.parentEquipmentId,
            code: normalizedCode,
            tenantId,
          },
        });
        if (existingByCode && existingByCode.id !== id) {
          throw new ConflictException(
            `Sub-equipment with code "${normalizedCode}" already exists for this parent equipment`,
          );
        }
        input.code = normalizedCode;
      }

      if (input.serialNumber && input.serialNumber !== subEquipment.serialNumber) {
        const existingBySerial = await subEquipmentRepository.findOne({
          where: { serialNumber: input.serialNumber, tenantId },
        });
        if (existingBySerial && existingBySerial.id !== id) {
          throw new ConflictException(`Sub-equipment with serial number "${input.serialNumber}" already exists`);
        }
      }

      const { id: _id, ...updateFields } = input;
      Object.assign(subEquipment, {
        ...updateFields,
        updatedBy: userId,
      });

      const saved = await subEquipmentRepository.save(subEquipment);

      await this.auditLogService.logWithManager(queryRunner.manager, {
        tenantId,
        entityType: 'SubEquipment',
        entityId: saved.id,
        action: AuditAction.UPDATE,
        userId,
        changes: {
          before,
          after: subEquipmentAuditSnapshot(saved),
        },
        metadata: { source: 'SITES_SETUP_SUB_EQUIPMENT' },
        entityVersion: saved.version,
        summary: `Updated sub-equipment ${saved.code}`,
      });

      const event: SubEquipmentUpdatedEvent = {
        ...createBaseEvent<SubEquipmentUpdatedEvent>('SubEquipmentUpdated', tenantId, {
          aggregateId: saved.id,
          aggregateType: 'SubEquipment',
          userId,
        }),
        subEquipmentId: saved.id,
        parentEquipmentId: saved.parentEquipmentId,
        name: saved.name,
        status: saved.status,
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager, { aggregateId: saved.id });

      const reloaded = await subEquipmentRepository.findOne({
        where: { id: saved.id, tenantId },
        relations: ['subEquipmentType', 'parentEquipment'],
      });
      if (!reloaded) {
        throw new InternalServerErrorException(
          `Sub-equipment ${saved.id} vanished between save and reload`,
        );
      }
      return reloaded;
    });
  }
}
