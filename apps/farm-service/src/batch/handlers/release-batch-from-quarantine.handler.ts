/**
 * ReleaseBatchFromQuarantineHandler
 *
 * Moves a QUARANTINE batch to ACTIVE through the batch status table
 * (BatchLifecyclePolicyService), in one tenant transaction that also writes
 * the farm_audit_logs row and the BatchStatusChanged outbox event
 * (FARM-MEDIUM-402).
 *
 * WHY a dedicated command: a quarantined batch cannot be harvested
 * (FARM-MEDIUM-401), so releasing the hold is a biosecurity decision. It is
 * MODULE_MANAGER+ (permission matrix), needs a reason, and leaves an audit
 * row; the generic updateBatchStatus (open to MODULE_USER, no audit) refuses
 * this transition and points here.
 *
 * @module Batch/Handlers
 */
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { hasAnyRole } from '@aquaculture/backend-common/decorators';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { createBaseEvent } from '@platform/event-contracts';
import type { BatchStatusChangedEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { MUTATION_ROLES } from '../../common/authz/permission-matrix';
import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { ReleaseBatchFromQuarantineCommand } from '../commands/release-batch-from-quarantine.command';
import { Batch, BatchStatus } from '../entities/batch.entity';
import { BatchLifecyclePolicyService } from '../services/batch-lifecycle-policy.service';

/** The releaseBatchFromQuarantine role set from the permission matrix (empty = nobody). */
const RELEASE_ROLES = [...(MUTATION_ROLES['releaseBatchFromQuarantine'] ?? [])];

@Injectable()
@CommandHandler(ReleaseBatchFromQuarantineCommand)
export class ReleaseBatchFromQuarantineHandler
  implements ICommandHandler<ReleaseBatchFromQuarantineCommand, Batch>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly lifecyclePolicy: BatchLifecyclePolicyService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async execute(command: ReleaseBatchFromQuarantineCommand): Promise<Batch> {
    const { tenantId, batchId, reason, caller } = command;
    if (!caller.roles.some((role) => hasAnyRole(role, RELEASE_ROLES))) {
      throw new ForbiddenException('Access denied');
    }

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const batchRepo = tenantManagerRepo(queryRunner.manager, Batch, tenantId);
      const batch = await batchRepo.findOne({
        where: { id: batchId, tenantId, isActive: true },
        lock: { mode: 'pessimistic_write' },
      });
      if (!batch) {
        throw new NotFoundException(`Batch ${batchId} not found`);
      }
      if (batch.status !== BatchStatus.QUARANTINE) {
        throw new BadRequestException(
          `Batch ${batch.batchNumber} is ${batch.status}, not in quarantine; there is nothing to release.`,
        );
      }
      this.lifecyclePolicy.assertCanTransitionStatus(batch, BatchStatus.ACTIVE);

      const releasedAt = new Date();
      const statusReason = `Released from quarantine: ${reason}`;
      batch.status = BatchStatus.ACTIVE;
      batch.statusChangedAt = releasedAt;
      batch.statusReason = statusReason;
      batch.updatedBy = caller.sub;
      const saved = await batchRepo.save(batch);

      await this.auditLogService.logWithManager(queryRunner.manager, {
        tenantId,
        entityType: 'Batch',
        entityId: batchId,
        action: AuditAction.UPDATE,
        userId: caller.sub,
        changes: {
          before: { status: BatchStatus.QUARANTINE },
          after: { status: BatchStatus.ACTIVE, statusReason, quarantineReleaseReason: reason },
        },
        metadata: { source: 'API' },
        summary: `Batch ${batch.batchNumber} released from quarantine`,
      });

      const statusEvent: BatchStatusChangedEvent = {
        ...createBaseEvent<BatchStatusChangedEvent>('BatchStatusChanged', tenantId, {
          aggregateId: saved.id,
          aggregateType: 'Batch',
        }),
        timestamp: releasedAt.toISOString(),
        userId: caller.sub,
        batchId: saved.id,
        previousStatus: BatchStatus.QUARANTINE,
        newStatus: BatchStatus.ACTIVE,
        reason: statusReason,
      };
      await this.outboxPublisher.enqueue(statusEvent, queryRunner.manager);
      return saved;
    });
  }
}
