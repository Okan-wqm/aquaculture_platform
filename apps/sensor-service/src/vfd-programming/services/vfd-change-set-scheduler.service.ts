import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { VfdChangeSet } from '../entities/vfd-change-set.entity';
import { VfdChangeSetStatus } from '../../vfd/entities/vfd.enums';
import { VfdParameterWriterService } from './vfd-parameter-writer.service';

/**
 * VFD Change Set Scheduler Service
 * Runs on a 30-second cron interval to apply approved change sets
 * that have a scheduledAt timestamp in the past.
 */
@Injectable()
export class VfdChangeSetSchedulerService {
  private readonly logger = new Logger(VfdChangeSetSchedulerService.name);
  private isProcessing = false;

  constructor(
    @InjectRepository(VfdChangeSet)
    private readonly changeSetRepository: Repository<VfdChangeSet>,
    private readonly parameterWriterService: VfdParameterWriterService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Check for approved change sets that are due to be applied.
   * Runs every 30 seconds. Skips if a previous cycle is still processing.
   */
  @Cron('*/30 * * * * *')
  async handleScheduledChangeSets(): Promise<void> {
    if (this.isProcessing) {
      this.logger.debug('Scheduler already processing, skipping cycle');
      return;
    }

    this.isProcessing = true;

    try {
      const now = new Date();

      const dueChangeSets = await this.changeSetRepository.find({
        where: {
          status: VfdChangeSetStatus.APPROVED,
          scheduledAt: LessThanOrEqual(now),
        },
        relations: ['items'],
        order: { scheduledAt: 'ASC' },
      });

      if (dueChangeSets.length === 0) {
        return;
      }

      this.logger.log(
        `Found ${dueChangeSets.length} scheduled change set(s) due for application`,
      );

      for (const changeSet of dueChangeSets) {
        await this.applyScheduledChangeSet(changeSet);
      }
    } catch (error) {
      this.logger.error(
        `Scheduler error: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Apply a single scheduled change set.
   * On failure: logs error, emits alert, does NOT auto-retry.
   */
  private async applyScheduledChangeSet(changeSet: VfdChangeSet): Promise<void> {
    this.logger.log(
      `Applying scheduled change set ${changeSet.id} (scheduled at: ${changeSet.scheduledAt?.toISOString()})`,
    );

    try {
      const result = await this.parameterWriterService.applyChangeSet(changeSet);

      this.logger.log(
        `Scheduled change set ${changeSet.id} applied with status: ${result.status}`,
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.logger.error(
        `Failed to apply scheduled change set ${changeSet.id}: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );

      this.eventEmitter.emit('vfd.changeset.schedule-failed', {
        changeSetId: changeSet.id,
        tenantId: changeSet.tenantId,
        vfdDeviceId: changeSet.vfdDeviceId,
        error: errorMessage,
        scheduledAt: changeSet.scheduledAt,
      });
    }
  }
}
