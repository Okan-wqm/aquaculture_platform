/**
 * DeleteHarvestRecordHandler
 *
 * Handles the DeleteHarvestRecordCommand to soft delete a harvest record.
 * Also reverses the batch and tank quantity changes.
 *
 * @module Harvest/Handlers
 */
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { toEventIso,
  createBaseEvent,
  type HarvestRecordCancelledEvent,
} from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { Repository, DataSource } from 'typeorm';

import { Batch } from '../../batch/entities/batch.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { TankBatchService } from '../../batch/services/tank-batch.service';
import {
  defaultFarmStockProjectionForDirectHandlerConstruction,
} from '../../common/services/direct-handler-dependency-defaults';
import { FarmStockProjectionService } from '../../farm-stock/farm-stock-projection.service';
import { Tank } from '../../tank/entities/tank.entity';
import { DeleteHarvestRecordCommand } from '../commands/delete-harvest-record.command';
import { HarvestRecord, HarvestRecordStatus } from '../entities/harvest-record.entity';

@Injectable()
@CommandHandler(DeleteHarvestRecordCommand)
export class DeleteHarvestRecordHandler implements ICommandHandler<DeleteHarvestRecordCommand, boolean> {
  constructor(
    @InjectRepository(HarvestRecord)
    private readonly harvestRepository: Repository<HarvestRecord>,
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @InjectRepository(TankBatch)
    private readonly tankBatchRepository: Repository<TankBatch>,
    @InjectRepository(Tank)
    private readonly tankRepository: Repository<Tank>,
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    // Single SSoT writer for tank composition — the harvest reversal restores
    // batchDetails[] through this, never by hand (see the applyBatchDelta call).
    private readonly tankBatchService: TankBatchService,
    private readonly farmStockProjection: FarmStockProjectionService =
      defaultFarmStockProjectionForDirectHandlerConstruction(),
  ) {}

  async execute(command: DeleteHarvestRecordCommand): Promise<boolean> {
    const { tenantId, harvestRecordId, deletedBy } = command;

    // All reversal operations in a single transaction. The record is read
    // INSIDE the transaction under a pessimistic_write lock and the reversal is
    // gated on an atomic not-yet-CANCELLED → CANCELLED transition: cancellation
    // is a STATE TRANSITION, not a repeatable side effect. Before this, the
    // record was read outside the transaction with no lock and CANCELLED passed
    // the guard — a double-click / client retry / concurrent pair re-added
    // quantityHarvested to the batch AND the tank on every call.
    await runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const harvestRecord = await queryRunner.manager.findOne(HarvestRecord, {
        where: { id: harvestRecordId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!harvestRecord) {
        throw new NotFoundException(`Harvest record ${harvestRecordId} not found`);
      }

      // Prevent deletion of dispatched/delivered harvests — and re-deletion of
      // an already-cancelled one (its stock reversal was already applied).
      if (harvestRecord.status === HarvestRecordStatus.DISPATCHED ||
          harvestRecord.status === HarvestRecordStatus.DELIVERED) {
        throw new BadRequestException('Cannot delete dispatched or delivered harvest records');
      }
      if (harvestRecord.status === HarvestRecordStatus.CANCELLED) {
        throw new BadRequestException(
          `Harvest record ${harvestRecordId} is already cancelled — its stock reversal has already been applied`,
        );
      }

      // Reverse the batch quantity changes. A missing batch row is a data
      // integrity error — silently skipping it would restock the tank while
      // leaving the batch aggregates un-reversed (a half-reversal).
      const batch = await queryRunner.manager.findOne(Batch, {
        where: { id: harvestRecord.batchId, tenantId },
      });
      if (!batch) {
        throw new NotFoundException(
          `Batch ${harvestRecord.batchId} for harvest record ${harvestRecordId} not found — refusing a partial reversal`,
        );
      }

      batch.currentQuantity += harvestRecord.quantityHarvested;
      batch.harvestedQuantity = Math.max(0, (batch.harvestedQuantity || 0) - harvestRecord.quantityHarvested);
      batch.retentionRate = batch.getRetentionRate();
      batch.updatedBy = deletedBy;
      await queryRunner.manager.save(Batch, batch);

      // Reverse the tank batch changes
      const reversalTankId = harvestRecord.tankId;
      if (reversalTankId) {
        const tank = await queryRunner.manager.findOne(Tank, {
          where: { id: reversalTankId, tenantId },
        });

        // Reverse the harvest decrement through the single SSoT writer so
        // batchDetails[] (the per-batch truth the web + mobile read models
        // render) is restored in lock-step with the aggregates — never by hand.
        // A positive delta re-adds the harvested fish; if the tank-batch was
        // emptied by the harvest, the writer re-creates it. Mirrors the forward
        // path (one writer, no drift).
        //
        // Routing it through the stock scope also gives the reversal the day-plan
        // recalculation it NEVER had: cancelling a harvest puts fish back, and
        // the unit's remaining meals must feed the restored stock. Nothing here
        // had to remember that — the writer cannot be reached without it.
        const biomassKg = Number(harvestRecord.totalBiomass);
        await this.tankBatchService.applyStockChange(
          queryRunner.manager,
          tenantId,
          'harvest_reversal',
          (stock) =>
            stock.applyDelta(
              reversalTankId,
              {
                batchId: harvestRecord.batchId,
                batchNumber: batch.batchNumber,
                quantityDelta: harvestRecord.quantityHarvested,
                biomassDelta: biomassKg,
              },
              { volumeM3: Number(tank?.waterVolume || tank?.volume) || 0 },
            ),
        );

        // Reverse tank biomass. currentCount is derived + written by
        // TankBatchService.applyBatchDelta (the SINGLE count writer) above — the
        // harvest-reversal delta already went through it. biomass-ONLY UPDATE.
        if (tank) {
          await queryRunner.manager
            .createQueryBuilder()
            .update(Tank)
            .set({ currentBiomass: Number(tank.currentBiomass || 0) + Number(harvestRecord.totalBiomass) })
            .where('id = :id', { id: tank.id })
            .execute();
        }

        await this.farmStockProjection.refreshContainers(
          queryRunner.manager,
          tenantId,
          [reversalTankId],
        );
      }

      // Mark the harvest record as cancelled (soft delete)
      harvestRecord.status = HarvestRecordStatus.CANCELLED;
      await queryRunner.manager.save(HarvestRecord, harvestRecord);

      // HarvestRecordCancelled — announce the cascade reversal so
      // Slakterapport consumers withdraw their projection line and
      // batch-retention projections reverse the retention-rate bump
      // without re-reading aggregates.
      const event: HarvestRecordCancelledEvent = {
        ...createBaseEvent<HarvestRecordCancelledEvent>('HarvestRecordCancelled', tenantId, {
          aggregateId: harvestRecord.id,
          aggregateType: 'HarvestRecord',
        }),
        harvestRecordId: harvestRecord.id,
        batchId: harvestRecord.batchId,
        tankId: harvestRecord.tankId,
        reversedQuantity: harvestRecord.quantityHarvested,
        reversedBiomassKg: Number(harvestRecord.totalBiomass),
        cancelledAt: toEventIso(new Date()),
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager);
    });

    return true;
  }
}
