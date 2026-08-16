/**
 * Delete Tank Command Handler
 * @module Tank/Handlers
 */
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { NotFoundException, Logger, BadRequestException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { toEventIso, TankDeletedEvent, createBaseEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { defaultFarmStockProjectionForDirectHandlerConstruction } from '../../common/services/direct-handler-dependency-defaults';
import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { FarmStockProjectionService } from '../../farm-stock/farm-stock-projection.service';
import { DeleteTankCommand } from '../commands/delete-tank.command';
import { Tank } from '../entities/tank.entity';

import { tankAuditSnapshot } from './tank-audit.util';
import { BatchAggregateMutationPort } from '../../batch/batch-aggregate-mutation.port';

@CommandHandler(DeleteTankCommand)
export class DeleteTankHandler implements ICommandHandler<DeleteTankCommand, boolean> {
  private readonly logger = new Logger(DeleteTankHandler.name);

  constructor(
    private readonly batchMutations: BatchAggregateMutationPort,
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly farmStockProjection: FarmStockProjectionService = defaultFarmStockProjectionForDirectHandlerConstruction(),
  ) {}

  async execute(command: DeleteTankCommand): Promise<boolean> {
    const { tenantId, userId, id } = command;

    this.logger.log(`Deleting tank: ${id} for tenant: ${tenantId}`);

    await runInTenantTransaction(
      this.dataSource,
      'farm',
      tenantId,
      async (queryRunner, mutationSession) => {
        const tankRepository = tenantManagerRepo(queryRunner.manager, Tank, tenantId);
        const tankBatchRepository = tenantManagerRepo(queryRunner.manager, TankBatch, tenantId);

        const tank = await tankRepository.findOne({
          where: { id, tenantId },
        });

        if (!tank) {
          throw new NotFoundException(`Tank with id "${id}" not found`);
        }

        const tankBatches = await tankBatchRepository.find({ where: { tankId: id, tenantId } });
        const batchesWithStock = tankBatches.filter(
          (batch) =>
            Number(batch.totalQuantity || 0) > 0 ||
            Number(batch.totalBiomassKg || 0) > 0 ||
            Number(batch.cleanerFishQuantity || 0) > 0 ||
            Number(batch.cleanerFishBiomassKg || 0) > 0,
        );

        if (Number(tank.currentBiomass || 0) > 0 || batchesWithStock.length > 0) {
          throw new BadRequestException(
            `Cannot delete tank "${tank.name}": it has active biomass or stock allocations. ` +
              'Please transfer or harvest first.',
          );
        }

        const before = tankAuditSnapshot(tank);
        const deletedAt = new Date();
        if (tankBatches.length > 0) {
          await this.batchMutations.pruneEmptyTankBatchProjection(mutationSession, {
            tankId: id,
          });
        }
        tank.isActive = false;
        tank.updatedBy = userId;

        const saved = await this.batchMutations.commitTankTransition(mutationSession, {
          intent: 'tank_delete',
          aggregate: tank,
        });
        await this.farmStockProjection.refreshContainers(queryRunner.manager, tenantId, [saved.id]);

        await this.auditLogService.logWithManager(queryRunner.manager, {
          tenantId,
          entityType: 'Tank',
          entityId: id,
          action: AuditAction.SOFT_DELETE,
          userId,
          changes: {
            before,
            after: tankAuditSnapshot(saved),
          },
          metadata: { source: 'SITES_SETUP_TANK' },
          entityVersion: saved.version,
          summary: `Soft deleted tank ${saved.code}`,
        });

        const event: TankDeletedEvent = {
          ...createBaseEvent<TankDeletedEvent>('TankDeleted', tenantId, {
            aggregateId: saved.id,
            aggregateType: 'Tank',
            userId,
          }),
          tankId: saved.id,
          departmentId: saved.departmentId,
          name: saved.name,
          code: saved.code,
          deletedAt: toEventIso(deletedAt),
        };
        await this.outboxPublisher.enqueue(event, queryRunner.manager, {
          aggregateId: saved.id,
        });

        this.logger.log(`Tank soft-deleted: ${id}`);
      },
    );

    return true;
  }
}
