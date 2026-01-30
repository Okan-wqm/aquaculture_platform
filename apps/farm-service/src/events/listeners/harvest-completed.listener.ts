/**
 * HarvestCompletedListener
 *
 * Handles HarvestCompletedEvent and performs follow-up actions:
 * - Updates batch status (partial or complete harvest)
 * - Creates harvest reports
 * - Updates farm-level statistics
 * - Triggers inventory and sales notifications
 *
 * @module Events/Listeners
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { Batch, BatchStatus } from '../../batch/entities/batch.entity';
import { HarvestRecord } from '../../harvest/entities/harvest-record.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { EventNames, HarvestCompletedEventPayload } from '../event-types';

/**
 * Harvest report structure
 */
interface HarvestReport {
  batchId: string;
  batchNumber: string;
  harvestId: string;
  harvestDate: Date;
  production: {
    initialQuantity: number;
    harvestedQuantity: number;
    harvestedBiomass: number;
    avgWeight: number;
    survivalRate: number;
    mortalityRate: number;
  };
  performance: {
    daysInProduction: number;
    fcr: number;
    sgr: number;
    totalFeedConsumed: number;
  };
  economics: {
    totalFeedCost: number;
    purchaseCost: number;
    estimatedRevenue: number;
    costPerKg: number;
  };
  quality?: {
    grade: string;
    gradeDistribution?: Record<string, number>;
  };
}

@Injectable()
export class HarvestCompletedListener {
  private readonly logger = new Logger(HarvestCompletedListener.name);

  constructor(
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @InjectRepository(HarvestRecord)
    private readonly harvestRecordRepository: Repository<HarvestRecord>,
    @InjectRepository(TankBatch)
    private readonly tankBatchRepository: Repository<TankBatch>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Handle HarvestCompleted event
   */
  @OnEvent(EventNames.HARVEST_COMPLETED)
  async handleHarvestCompleted(payload: HarvestCompletedEventPayload): Promise<void> {
    this.logger.log(
      `[HarvestCompleted] Processing event for batch ${payload.batchNumber}: ` +
      `${payload.harvestedQuantity} fish, ${payload.harvestedBiomass.toFixed(2)}kg`,
    );

    try {
      // 1. Log harvest details
      this.logHarvestDetails(payload);

      // 2. Update batch status
      await this.updateBatchStatus(payload);

      // 3. Generate harvest report
      const report = await this.generateHarvestReport(payload);

      // 4. Update farm statistics
      await this.updateFarmStatistics(payload);

      // 5. Emit follow-up events
      await this.emitFollowUpEvents(payload, report);

      this.logger.log(
        `[HarvestCompleted] Successfully processed event for batch ${payload.batchNumber}`,
      );
    } catch (error) {
      this.logger.error(
        `[HarvestCompleted] Failed to process event: ${error}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Log harvest details
   */
  private logHarvestDetails(payload: HarvestCompletedEventPayload): void {
    this.logger.log(
      `[Harvest] Batch: ${payload.batchNumber}, ` +
      `Quantity: ${payload.harvestedQuantity}, Biomass: ${payload.harvestedBiomass.toFixed(2)}kg, ` +
      `Avg Weight: ${payload.avgWeight.toFixed(1)}g, ` +
      `Partial: ${payload.isPartialHarvest}, Remaining: ${payload.remainingQuantity}`,
    );

    if (payload.destinationInfo) {
      this.logger.debug(
        `Destination: ${payload.destinationInfo.customerName || 'N/A'} - ` +
        `${payload.destinationInfo.destination || 'N/A'}`,
      );
    }
  }

  /**
   * Update batch status based on harvest type
   */
  private async updateBatchStatus(payload: HarvestCompletedEventPayload): Promise<void> {
    const batch = await this.batchRepository.findOne({
      where: { id: payload.batchId, tenantId: payload.tenantId },
    });

    if (!batch) {
      this.logger.warn(`Batch ${payload.batchId} not found for status update`);
      return;
    }

    if (payload.isPartialHarvest) {
      // Partial harvest - update status to HARVESTING if not already
      if (batch.status !== BatchStatus.HARVESTING) {
        batch.status = BatchStatus.HARVESTING;
        batch.statusChangedAt = new Date();
        batch.statusReason = 'Partial harvest in progress';
        this.logger.log(`Batch ${payload.batchNumber} status updated to HARVESTING`);
      }
    } else {
      // Complete harvest
      batch.status = BatchStatus.HARVESTED;
      batch.statusChangedAt = new Date();
      batch.statusReason = 'Harvest completed';
      batch.actualHarvestDate = payload.harvestedAt;
      batch.harvestedQuantity = (batch.harvestedQuantity || 0) + payload.harvestedQuantity;

      this.logger.log(`Batch ${payload.batchNumber} status updated to HARVESTED`);
    }

    // Update batch metrics
    batch.currentQuantity = payload.remainingQuantity;
    batch.updatedBy = payload.harvestedBy;

    await this.batchRepository.save(batch);
  }

  /**
   * Generate comprehensive harvest report
   */
  private async generateHarvestReport(
    payload: HarvestCompletedEventPayload,
  ): Promise<HarvestReport> {
    const batch = await this.batchRepository.findOne({
      where: { id: payload.batchId, tenantId: payload.tenantId },
    });

    if (!batch) {
      throw new Error(`Batch ${payload.batchId} not found`);
    }

    const daysInProduction = batch.getDaysInProduction();
    const survivalRate = batch.getSurvivalRate();
    const mortalityRate = batch.getMortalityRate();

    // Calculate economics (simplified)
    const estimatedPricePerKg = 50; // This should come from configuration
    const estimatedRevenue = payload.harvestedBiomass * estimatedPricePerKg;
    const totalCost = (batch.totalFeedCost || 0) + (batch.purchaseCost || 0);
    const costPerKg = payload.harvestedBiomass > 0
      ? totalCost / payload.harvestedBiomass
      : 0;

    const report: HarvestReport = {
      batchId: payload.batchId,
      batchNumber: payload.batchNumber,
      harvestId: payload.harvestId,
      harvestDate: payload.harvestedAt,
      production: {
        initialQuantity: batch.initialQuantity,
        harvestedQuantity: payload.harvestedQuantity,
        harvestedBiomass: payload.harvestedBiomass,
        avgWeight: payload.avgWeight,
        survivalRate,
        mortalityRate,
      },
      performance: {
        daysInProduction,
        fcr: batch.fcr?.actual || 0,
        sgr: batch.sgr || 0,
        totalFeedConsumed: batch.totalFeedConsumed || 0,
      },
      economics: {
        totalFeedCost: batch.totalFeedCost || 0,
        purchaseCost: batch.purchaseCost || 0,
        estimatedRevenue,
        costPerKg,
      },
    };

    if (payload.qualityGrade) {
      report.quality = {
        grade: payload.qualityGrade,
      };
    }

    // Log report summary
    this.logger.log(
      `[HarvestReport] Batch ${payload.batchNumber}: ` +
      `FCR: ${report.performance.fcr.toFixed(2)}, ` +
      `Survival: ${survivalRate.toFixed(1)}%, ` +
      `Days: ${daysInProduction}, ` +
      `Cost/kg: ${costPerKg.toFixed(2)}`,
    );

    // Emit report generated event
    this.eventEmitter.emit('report.harvestGenerated', {
      tenantId: payload.tenantId,
      report,
    });

    return report;
  }

  /**
   * Update farm-level statistics
   */
  private async updateFarmStatistics(
    payload: HarvestCompletedEventPayload,
  ): Promise<void> {
    // Emit statistics update event
    this.eventEmitter.emit('farm.statistics.updated', {
      tenantId: payload.tenantId,
      triggeredBy: 'harvest.completed',
      batchId: payload.batchId,
      quantityChange: -payload.harvestedQuantity,
      biomassChange: -payload.harvestedBiomass,
      harvestedQuantity: payload.harvestedQuantity,
      harvestedBiomass: payload.harvestedBiomass,
    });

    // Update tank batch if applicable
    await this.updateTankBatchAfterHarvest(payload);
  }

  /**
   * Update tank batch after harvest
   */
  private async updateTankBatchAfterHarvest(
    payload: HarvestCompletedEventPayload,
  ): Promise<void> {
    // Find tank batches associated with this batch
    const tankBatches = await this.tankBatchRepository.find({
      where: {
        tenantId: payload.tenantId,
        primaryBatchId: payload.batchId,
      },
    });

    for (const tankBatch of tankBatches) {
      // Check if tank should be cleared after complete harvest
      if (!payload.isPartialHarvest && payload.remainingQuantity === 0) {
        this.logger.log(
          `Tank ${tankBatch.tankCode || tankBatch.tankId} cleared after complete harvest`,
        );

        // Emit tank cleared event
        this.eventEmitter.emit('tank.cleared', {
          tenantId: payload.tenantId,
          tankId: tankBatch.tankId,
          tankCode: tankBatch.tankCode,
          previousBatchId: payload.batchId,
          previousBatchNumber: payload.batchNumber,
          clearedAt: payload.harvestedAt,
        });
      }
    }
  }

  /**
   * Emit follow-up events
   */
  private async emitFollowUpEvents(
    payload: HarvestCompletedEventPayload,
    report: HarvestReport,
  ): Promise<void> {
    // Notify about successful harvest
    this.eventEmitter.emit('notification.send', {
      tenantId: payload.tenantId,
      type: 'harvest_completed',
      priority: 'normal',
      title: `Harvest Completed - ${payload.batchNumber}`,
      message: `Successfully harvested ${payload.harvestedQuantity} fish (${payload.harvestedBiomass.toFixed(1)}kg) from batch ${payload.batchNumber}.`,
      data: {
        batchId: payload.batchId,
        harvestId: payload.harvestId,
        avgWeight: payload.avgWeight,
      },
    });

    // If complete harvest, emit batch completion event
    if (!payload.isPartialHarvest && payload.remainingQuantity === 0) {
      this.eventEmitter.emit('batch.production.completed', {
        tenantId: payload.tenantId,
        batchId: payload.batchId,
        batchNumber: payload.batchNumber,
        performance: report.performance,
        production: report.production,
        completedAt: payload.harvestedAt,
      });
    }

    // Emit for inventory/sales integration
    if (payload.destinationInfo?.customerId) {
      this.eventEmitter.emit('sales.harvestDelivery', {
        tenantId: payload.tenantId,
        batchId: payload.batchId,
        batchNumber: payload.batchNumber,
        harvestId: payload.harvestId,
        customerId: payload.destinationInfo.customerId,
        customerName: payload.destinationInfo.customerName,
        quantity: payload.harvestedQuantity,
        biomass: payload.harvestedBiomass,
        avgWeight: payload.avgWeight,
        qualityGrade: payload.qualityGrade,
        harvestedAt: payload.harvestedAt,
      });
    }

    // Emit for regulatory/traceability
    this.eventEmitter.emit('regulatory.harvestRecorded', {
      tenantId: payload.tenantId,
      batchId: payload.batchId,
      batchNumber: payload.batchNumber,
      harvestId: payload.harvestId,
      quantity: payload.harvestedQuantity,
      biomass: payload.harvestedBiomass,
      avgWeight: payload.avgWeight,
      harvestedAt: payload.harvestedAt,
      harvestedBy: payload.harvestedBy,
    });
  }
}
