/**
 * Update Tank Status Command Handler
 * @module Tank/Handlers
 */
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { NotFoundException, Logger } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { toEventIso, TankStatusChangedEvent, createBaseEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { defaultFarmStockProjectionForDirectHandlerConstruction } from '../../common/services/direct-handler-dependency-defaults';
import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { FarmStockProjectionService } from '../../farm-stock/farm-stock-projection.service';
import { UpdateTankStatusCommand } from '../commands/update-tank-status.command';
import { Tank } from '../entities/tank.entity';

import { assertTankStatusTransition } from './tank-status.policy';

@CommandHandler(UpdateTankStatusCommand)
export class UpdateTankStatusHandler implements ICommandHandler<UpdateTankStatusCommand, Tank> {
  private readonly logger = new Logger(UpdateTankStatusHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly auditLogService: AuditLogService,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly farmStockProjection: FarmStockProjectionService = defaultFarmStockProjectionForDirectHandlerConstruction(),
  ) {}

  async execute(command: UpdateTankStatusCommand): Promise<Tank> {
    const { tenantId, userId, input } = command;

    this.logger.log(`Updating tank status: ${input.id} to ${input.status} for tenant: ${tenantId}`);

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const tankRepository = tenantManagerRepo(queryRunner.manager, Tank, tenantId);

      const tank = await tankRepository.findOne({
        where: { id: input.id, tenantId },
      });

      if (!tank) {
        throw new NotFoundException(`Tank with id "${input.id}" not found`);
      }

      const oldStatus = tank.status;

      assertTankStatusTransition(tank, input.status);

      const changedAt = new Date();
      tank.status = input.status;
      tank.statusChangedAt = changedAt;
      tank.statusReason = input.reason;
      tank.updatedBy = userId;

      const saved = await tankRepository.save(tank);
      await this.farmStockProjection.refreshContainers(queryRunner.manager, tenantId, [saved.id]);

      await this.auditLogService.logWithManager(queryRunner.manager, {
        tenantId,
        entityType: 'Tank',
        entityId: saved.id,
        action: AuditAction.UPDATE,
        userId,
        changes: {
          before: { status: oldStatus },
          after: { status: saved.status, reason: input.reason },
          changedFields: ['status', 'statusChangedAt', 'statusReason'],
        },
        metadata: { source: 'SITES_SETUP_TANK' },
        entityVersion: saved.version,
        summary: `Updated tank ${saved.code} status from ${oldStatus} to ${saved.status}`,
      });

      const event: TankStatusChangedEvent = {
        ...createBaseEvent<TankStatusChangedEvent>('TankStatusChanged', tenantId, {
          aggregateId: saved.id,
          aggregateType: 'Tank',
          userId,
        }),
        tankId: saved.id,
        previousStatus: oldStatus,
        newStatus: saved.status,
        reason: input.reason,
        changedAt: toEventIso(changedAt),
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager, {
        aggregateId: saved.id,
      });

      this.logger.log(`Tank status updated: ${saved.id} from ${oldStatus} to ${saved.status}`);

      return saved;
    });
  }

}
