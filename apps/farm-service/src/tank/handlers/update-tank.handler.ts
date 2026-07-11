/**
 * Update Tank Command Handler
 * @module Tank/Handlers
 */
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { NotFoundException, Logger, BadRequestException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { TankUpdatedEvent, createBaseEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { defaultFarmStockProjectionForDirectHandlerConstruction } from '../../common/services/direct-handler-dependency-defaults';
import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { Department } from '../../department/entities/department.entity';
import { FarmStockProjectionService } from '../../farm-stock/farm-stock-projection.service';
import { System } from '../../system/entities/system.entity';
import { UpdateTankCommand } from '../commands/update-tank.command';
import { Tank } from '../entities/tank.entity';

import { tankAuditSnapshot } from './tank-audit.util';
import { assertTankStatusTransition } from './tank-status.policy';

@CommandHandler(UpdateTankCommand)
export class UpdateTankHandler implements ICommandHandler<UpdateTankCommand, Tank> {
  private readonly logger = new Logger(UpdateTankHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly farmStockProjection: FarmStockProjectionService = defaultFarmStockProjectionForDirectHandlerConstruction(),
  ) {}

  async execute(command: UpdateTankCommand): Promise<Tank> {
    const { tenantId, userId, input } = command;
    const { id, ...updateData } = input;

    this.logger.log(`Updating tank: ${id} for tenant: ${tenantId}`);

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const tankRepository = tenantManagerRepo(queryRunner.manager, Tank, tenantId);
      const departmentRepository = tenantManagerRepo(queryRunner.manager, Department, tenantId);
      const systemRepository = tenantManagerRepo(queryRunner.manager, System, tenantId);
      const tankBatchRepository = tenantManagerRepo(queryRunner.manager, TankBatch, tenantId);

      const existing = await tankRepository.findOne({
        where: { id, tenantId },
      });

      if (!existing) {
        throw new NotFoundException(`Tank with id "${id}" not found`);
      }

      const hasDimensionChanges =
        updateData.diameter !== undefined ||
        updateData.length !== undefined ||
        updateData.width !== undefined ||
        updateData.depth !== undefined ||
        updateData.volume !== undefined;

      const tankBatches =
        hasDimensionChanges || updateData.status !== undefined
          ? await tankBatchRepository.find({ where: { tankId: id, tenantId } })
          : [];
      const activeStock = tankBatches.some(
        (batch) =>
          Number(batch.totalQuantity || 0) > 0 ||
          Number(batch.totalBiomassKg || 0) > 0 ||
          Number(batch.cleanerFishQuantity || 0) > 0 ||
          Number(batch.cleanerFishBiomassKg || 0) > 0,
      );

      if ((Number(existing.currentBiomass || 0) > 0 || activeStock) && hasDimensionChanges) {
        throw new BadRequestException(
          'Cannot update dimensions while tank has active biomass. Please transfer or harvest first.',
        );
      }

      const before = tankAuditSnapshot(existing);
      const previousStatus = existing.status;

      if (updateData.code !== undefined) {
        const code = updateData.code.toUpperCase();
        if (code !== existing.code) {
          const duplicate = await tankRepository.findOne({
            where: { code, tenantId },
          });
          if (duplicate && duplicate.id !== existing.id) {
            throw new BadRequestException(`Tank with code "${code}" already exists`);
          }
          existing.code = code;
        }
      }

      if (
        updateData.departmentId !== undefined &&
        updateData.departmentId !== existing.departmentId
      ) {
        const department = await departmentRepository.findOne({
          where: { id: updateData.departmentId, tenantId },
        });
        if (!department) {
          throw new NotFoundException(`Department with id "${updateData.departmentId}" not found`);
        }
        if (department.isDeleted) {
          throw new BadRequestException(
            `Department with id "${updateData.departmentId}" is deleted`,
          );
        }
        if (existing.systemId) {
          const system = await systemRepository.findOne({
            where: { id: existing.systemId, tenantId },
          });
          if (system && system.siteId !== department.siteId) {
            throw new BadRequestException(
              `System "${system.name}" does not belong to the same site as the department`,
            );
          }
        }
        existing.departmentId = updateData.departmentId;
      }

      if (updateData.systemId !== undefined) {
        if (updateData.systemId) {
          const system = await systemRepository.findOne({
            where: { id: updateData.systemId, tenantId },
          });
          if (!system) {
            throw new NotFoundException(`System with id "${updateData.systemId}" not found`);
          }
          if (system.isDeleted) {
            throw new BadRequestException(`System with id "${updateData.systemId}" is deleted`);
          }
          const department = await departmentRepository.findOne({
            where: { id: existing.departmentId, tenantId },
          });
          if (!department) {
            throw new NotFoundException(`Department with id "${existing.departmentId}" not found`);
          }
          if (system.siteId !== department.siteId) {
            throw new BadRequestException(
              `System "${system.name}" does not belong to the same site as the department`,
            );
          }
          existing.systemId = updateData.systemId;
        } else {
          existing.systemId = undefined;
        }
      }

      if (updateData.name !== undefined) existing.name = updateData.name;
      if (updateData.description !== undefined) existing.description = updateData.description;
      if (updateData.containerKind !== undefined) existing.containerKind = updateData.containerKind;
      if (updateData.equipmentTypeId !== undefined)
        existing.equipmentTypeId = updateData.equipmentTypeId;
      if (updateData.temperatureSensorId !== undefined)
        existing.temperatureSensorId = updateData.temperatureSensorId;
      if (updateData.equipmentTypeCode !== undefined)
        existing.equipmentTypeCode = updateData.equipmentTypeCode;
      if (updateData.regulatoryUnitId !== undefined)
        existing.regulatoryUnitId = updateData.regulatoryUnitId;
      if (updateData.tankType !== undefined) existing.tankType = updateData.tankType;
      if (updateData.material !== undefined) existing.material = updateData.material;
      if (updateData.waterType !== undefined) existing.waterType = updateData.waterType;
      if (updateData.diameter !== undefined) existing.diameter = updateData.diameter;
      if (updateData.length !== undefined) existing.length = updateData.length;
      if (updateData.width !== undefined) existing.width = updateData.width;
      if (updateData.depth !== undefined) existing.depth = updateData.depth;
      if (updateData.waterDepth !== undefined) existing.waterDepth = updateData.waterDepth;
      if (updateData.freeboard !== undefined) existing.freeboard = updateData.freeboard;
      if (updateData.maxBiomass !== undefined) existing.maxBiomass = updateData.maxBiomass;
      if (updateData.maxDensity !== undefined) existing.maxDensity = updateData.maxDensity;
      if (updateData.volume !== undefined) existing.volume = updateData.volume;
      if (updateData.waterFlow !== undefined) {
        existing.waterFlow = updateData.waterFlow;
      }
      if (updateData.aeration !== undefined) {
        existing.aeration = updateData.aeration as Tank['aeration'];
      }
      if (updateData.location !== undefined) {
        existing.location = updateData.location;
      }
      if (updateData.notes !== undefined) existing.notes = updateData.notes;
      if (updateData.installationDate !== undefined) {
        existing.installationDate = new Date(updateData.installationDate);
      }
      if (updateData.status !== undefined && updateData.status !== existing.status) {
        assertTankStatusTransition(existing, updateData.status);
        existing.status = updateData.status;
        existing.statusChangedAt = new Date();
        existing.statusReason = 'Updated from sites setup equipment compatibility path';
      }

      existing.updatedBy = userId;
      existing.calculateVolume();

      if (existing.volume <= 0 && updateData.volume && updateData.volume > 0) {
        existing.volume = updateData.volume;
      }

      if (existing.volume <= 0) {
        throw new BadRequestException(
          'Invalid dimensions: calculated volume must be greater than 0',
        );
      }

      const saved = await tankRepository.save(existing);
      await this.farmStockProjection.refreshContainers(queryRunner.manager, tenantId, [saved.id]);

      await this.auditLogService.logWithManager(queryRunner.manager, {
        tenantId,
        entityType: 'Tank',
        entityId: saved.id,
        action: AuditAction.UPDATE,
        userId,
        changes: {
          before,
          after: tankAuditSnapshot(saved),
        },
        metadata: { source: 'SITES_SETUP_TANK' },
        entityVersion: saved.version,
        summary: `Updated tank ${saved.code}`,
      });

      const event: TankUpdatedEvent = {
        ...createBaseEvent<TankUpdatedEvent>('TankUpdated', tenantId, {
          aggregateId: saved.id,
          aggregateType: 'Tank',
          userId,
        }),
        tankId: saved.id,
        departmentId: saved.departmentId,
        systemId: saved.systemId,
        name: saved.name,
        tankType: saved.tankType,
        status: saved.status,
        volume: Number(saved.volume),
        maxBiomass: Number(saved.maxBiomass),
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager, {
        aggregateId: saved.id,
      });

      if (saved.status !== previousStatus) {
        await this.auditLogService.logWithManager(queryRunner.manager, {
          tenantId,
          entityType: 'Tank',
          entityId: saved.id,
          action: AuditAction.UPDATE,
          userId,
          changes: {
            before: { status: previousStatus },
            after: { status: saved.status },
            changedFields: ['status', 'statusChangedAt', 'statusReason'],
          },
          metadata: { source: 'SITES_SETUP_TANK' },
          entityVersion: saved.version,
          summary: `Updated tank ${saved.code} status from ${previousStatus} to ${saved.status}`,
        });

        await this.outboxPublisher.enqueue(
          {
            ...createBaseEvent('TankStatusChanged', tenantId, {
              aggregateId: saved.id,
              aggregateType: 'Tank',
              userId,
            }),
            tankId: saved.id,
            previousStatus,
            newStatus: saved.status,
            reason: 'Updated from sites setup equipment compatibility path',
            changedAt: saved.statusChangedAt ?? new Date(),
          },
          queryRunner.manager,
          { aggregateId: saved.id },
        );
      }

      this.logger.log(`Tank updated: ${saved.id}`);

      return saved;
    });
  }
}
