import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { forEachTenantSchema } from '@aquaculture/backend-common/database';
import { withTenantContext } from '@aquaculture/backend-common/context';

import { VfdChangeSet } from '../entities/vfd-change-set.entity';
import { VfdChangeSetStatus } from '../../vfd/entities/vfd.enums';
import { VfdParameterWriterService } from './vfd-parameter-writer.service';

/**
 * VFD Change Set Scheduler Service
 * Runs on a 30-second cron interval to apply approved change sets that have a
 * scheduledAt timestamp in the past.
 *
 * vfd_change_sets is a PER-TENANT table, so it exists once per tenant schema.
 * A cron runs outside any request/tenant context, so it must fan out across
 * every provisioned tenant schema and apply each tenant's due change sets
 * inside that tenant's context — an unscoped repository query would run against
 * the empty source-schema template and either find nothing (scheduled applies
 * silently never happen) or resolve to the wrong schema.
 */
@Injectable()
export class VfdChangeSetSchedulerService {
  private readonly logger = new Logger(VfdChangeSetSchedulerService.name);
  private isProcessing = false;

  constructor(
    @InjectRepository(VfdChangeSet)
    private readonly changeSetRepository: Repository<VfdChangeSet>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly parameterWriterService: VfdParameterWriterService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Check for approved change sets that are due to be applied, across every
   * tenant schema. Runs every 30 seconds. Skips if a previous cycle is still
   * processing.
   */
  @Cron('*/30 * * * * *')
  async handleScheduledChangeSets(): Promise<void> {
    if (this.isProcessing) {
      this.logger.debug('Scheduler already processing, skipping cycle');
      return;
    }

    this.isProcessing = true;

    try {
      await forEachTenantSchema(
        this.dataSource,
        async ({ schema, queryRunner }) => {
          // Discover this tenant's due change-set ids under the tenant
          // search_path (established by forEachTenantSchema). The tenant_id
          // column carries the full tenant UUID that the schema name (a
          // truncated hash) cannot recover.
          const dueRows: { id: string; tenant_id: string }[] = await queryRunner.query(
            `SELECT id, tenant_id FROM vfd_change_sets
             WHERE status = $1 AND scheduled_at IS NOT NULL AND scheduled_at <= now()
             ORDER BY scheduled_at ASC`,
            [VfdChangeSetStatus.APPROVED],
          );

          if (dueRows.length === 0) {
            return;
          }

          this.logger.log(
            `Found ${dueRows.length} scheduled change set(s) due for application in schema ${schema}`,
          );

          for (const row of dueRows) {
            // Apply inside the tenant context so the parameter writer's own
            // repositories (pool connections) resolve the correct search_path.
            await withTenantContext(row.tenant_id, async () => {
              const changeSet = await this.changeSetRepository.findOne({
                where: { id: row.id },
                relations: ['items'],
              });

              // Re-check under the scoped read: the set may have been cancelled
              // or already picked up since discovery.
              if (!changeSet || changeSet.status !== VfdChangeSetStatus.APPROVED) {
                return;
              }

              await this.applyScheduledChangeSet(changeSet);
            });
          }
        },
        {
          searchPathSuffix: 'sensor, public',
          concurrency: 4,
          perTenantTimeoutMs: 120_000,
          logger: this.logger,
        },
      );
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
   * Apply a single scheduled change set (already loaded inside its tenant
   * context). On failure: logs error, emits alert, does NOT auto-retry.
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
