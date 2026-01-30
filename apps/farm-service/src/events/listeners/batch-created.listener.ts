/**
 * BatchCreatedListener
 *
 * Handles BatchCreatedEvent and updates farm statistics.
 * Updates tenant-level statistics, species counts, and
 * notifies relevant parties about new batch creation.
 *
 * @module Events/Listeners
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { Batch } from '../../batch/entities/batch.entity';
import { Species } from '../../species/entities/species.entity';
import { Site } from '../../site/entities/site.entity';
import { EventNames, BatchCreatedEventPayload } from '../event-types';

/**
 * Farm statistics summary
 */
interface FarmStatistics {
  totalBatches: number;
  activeBatches: number;
  totalQuantity: number;
  totalBiomass: number;
  speciesBreakdown: Record<string, {
    count: number;
    quantity: number;
    biomass: number;
  }>;
}

@Injectable()
export class BatchCreatedListener {
  private readonly logger = new Logger(BatchCreatedListener.name);

  constructor(
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @InjectRepository(Species)
    private readonly speciesRepository: Repository<Species>,
    @InjectRepository(Site)
    private readonly siteRepository: Repository<Site>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Handle BatchCreated event
   *
   * Actions:
   * 1. Log the event for audit purposes
   * 2. Update farm-level statistics (cached or in DB)
   * 3. Update species statistics
   * 4. Emit follow-up notifications if needed
   */
  @OnEvent(EventNames.BATCH_CREATED)
  async handleBatchCreated(payload: BatchCreatedEventPayload): Promise<void> {
    this.logger.log(
      `[BatchCreated] Processing event for batch ${payload.batchNumber} (${payload.batchId})`,
    );

    try {
      // 1. Log event details
      this.logger.debug(
        `Batch created: ${payload.batchNumber}, Species: ${payload.speciesName}, ` +
        `Quantity: ${payload.initialQuantity}, Biomass: ${payload.initialBiomass}kg`,
      );

      // 2. Update farm statistics
      await this.updateFarmStatistics(payload);

      // 3. Update species-level statistics
      await this.updateSpeciesStatistics(payload);

      // 4. Check if batch requires special attention (large batch, rare species, etc.)
      await this.checkAndEmitAlerts(payload);

      this.logger.log(
        `[BatchCreated] Successfully processed event for batch ${payload.batchNumber}`,
      );
    } catch (error) {
      this.logger.error(
        `[BatchCreated] Failed to process event for batch ${payload.batchNumber}: ${error}`,
        error instanceof Error ? error.stack : undefined,
      );
      // Don't rethrow - event handling should be fault-tolerant
    }
  }

  /**
   * Update tenant-level farm statistics
   */
  private async updateFarmStatistics(payload: BatchCreatedEventPayload): Promise<void> {
    this.logger.debug(`Updating farm statistics for tenant ${payload.tenantId}`);

    // Calculate current farm statistics
    const stats = await this.calculateFarmStatistics(payload.tenantId);

    // In a production system, you might cache this or store in a dedicated table
    this.logger.log(
      `[FarmStats] Tenant ${payload.tenantId}: ` +
      `${stats.activeBatches} active batches, ` +
      `${stats.totalQuantity} total fish, ` +
      `${stats.totalBiomass.toFixed(2)}kg biomass`,
    );

    // Emit statistics updated event for dashboard refresh
    this.eventEmitter.emit('farm.statistics.updated', {
      tenantId: payload.tenantId,
      statistics: stats,
      triggeredBy: 'batch.created',
      batchId: payload.batchId,
    });
  }

  /**
   * Calculate current farm statistics
   */
  private async calculateFarmStatistics(tenantId: string): Promise<FarmStatistics> {
    const activeBatches = await this.batchRepository.find({
      where: {
        tenantId,
        isActive: true,
      },
      select: ['id', 'speciesId', 'currentQuantity', 'status'],
    });

    const speciesBreakdown: FarmStatistics['speciesBreakdown'] = {};
    let totalQuantity = 0;
    let totalBiomass = 0;

    for (const batch of activeBatches) {
      totalQuantity += batch.currentQuantity;
      const biomass = batch.getCurrentBiomass();
      totalBiomass += biomass;

      const speciesId = batch.speciesId;
      if (!speciesBreakdown[speciesId]) {
        speciesBreakdown[speciesId] = { count: 0, quantity: 0, biomass: 0 };
      }
      speciesBreakdown[speciesId].count++;
      speciesBreakdown[speciesId].quantity += batch.currentQuantity;
      speciesBreakdown[speciesId].biomass += biomass;
    }

    const totalBatches = await this.batchRepository.count({
      where: { tenantId },
    });

    return {
      totalBatches,
      activeBatches: activeBatches.length,
      totalQuantity,
      totalBiomass,
      speciesBreakdown,
    };
  }

  /**
   * Update species-level statistics
   */
  private async updateSpeciesStatistics(payload: BatchCreatedEventPayload): Promise<void> {
    try {
      const species = await this.speciesRepository.findOne({
        where: { id: payload.speciesId },
      });

      if (species) {
        // Count active batches for this species
        const activeBatchCount = await this.batchRepository.count({
          where: {
            tenantId: payload.tenantId,
            speciesId: payload.speciesId,
            isActive: true,
          },
        });

        this.logger.debug(
          `Species ${species.commonName} now has ${activeBatchCount} active batches`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Failed to update species statistics: ${error}`,
      );
    }
  }

  /**
   * Check if batch requires special alerts
   */
  private async checkAndEmitAlerts(payload: BatchCreatedEventPayload): Promise<void> {
    const alertThresholds = {
      largeBatchQuantity: 100000,
      largeBatchBiomass: 10000, // kg
    };

    // Alert for large batches
    if (
      payload.initialQuantity > alertThresholds.largeBatchQuantity ||
      payload.initialBiomass > alertThresholds.largeBatchBiomass
    ) {
      this.logger.log(
        `[Alert] Large batch created: ${payload.batchNumber} ` +
        `(${payload.initialQuantity} fish, ${payload.initialBiomass}kg)`,
      );

      this.eventEmitter.emit('batch.largeCreated', {
        tenantId: payload.tenantId,
        batchId: payload.batchId,
        batchNumber: payload.batchNumber,
        quantity: payload.initialQuantity,
        biomass: payload.initialBiomass,
        alertType: 'large_batch',
      });
    }

    // Notify about tank allocations
    if (payload.tankAllocations && payload.tankAllocations.length > 0) {
      this.logger.log(
        `Batch ${payload.batchNumber} allocated to ${payload.tankAllocations.length} tank(s)`,
      );

      for (const allocation of payload.tankAllocations) {
        this.eventEmitter.emit('tank.batchAllocated', {
          tenantId: payload.tenantId,
          tankId: allocation.tankId,
          tankCode: allocation.tankCode,
          batchId: payload.batchId,
          batchNumber: payload.batchNumber,
          quantity: allocation.quantity,
          biomass: allocation.biomass,
        });
      }
    }
  }
}
