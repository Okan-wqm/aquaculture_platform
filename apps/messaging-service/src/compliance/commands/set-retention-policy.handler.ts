import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Logger, BadRequestException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { OutboxPublisher } from '@platform/outbox';
import { createBaseEvent, BaseEvent } from '@platform/event-contracts';
import { SetRetentionPolicyCommand } from './set-retention-policy.command';
import { RetentionPolicy } from '../entities/retention-policy.entity';
import { RetentionPolicyService } from '../services/retention-policy.service';
import { ComplianceAuditService } from '../services/compliance-audit.service';
import { ComplianceAction } from '../entities/compliance-audit-log.entity';
import { ComplianceAuditLog } from '../entities/compliance-audit-log.entity';

/** Allowed retention values in days. */
const ALLOWED_RETENTION_DAYS = [90, 365, 1095, -1];

/**
 * Handler for SetRetentionPolicyCommand.
 *
 * Validates retention days, creates/updates the policy, logs to compliance
 * audit, and publishes a RetentionPolicyChanged outbox event.
 *
 * All three operations (policy + audit + outbox) execute inside a single
 * database transaction for atomicity.
 *
 * @see ADR-012 Phase 3 (Retention Policies)
 */
@CommandHandler(SetRetentionPolicyCommand)
export class SetRetentionPolicyHandler
  implements ICommandHandler<SetRetentionPolicyCommand, RetentionPolicy>
{
  private readonly logger = new Logger(SetRetentionPolicyHandler.name);

  constructor(
    private readonly retentionService: RetentionPolicyService,
    private readonly auditService: ComplianceAuditService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: SetRetentionPolicyCommand): Promise<RetentionPolicy> {
    const { tenantId, userId, channelId, retentionDays } = command;

    // Validate retention days
    if (!ALLOWED_RETENTION_DAYS.includes(retentionDays)) {
      throw new BadRequestException(
        `Invalid retentionDays value. Allowed: ${ALLOWED_RETENTION_DAYS.join(', ')}`,
      );
    }

    // Wrap policy + audit + outbox in a single transaction
    return this.dataSource.transaction(async (manager) => {
      // Create or update the policy — pass manager for transactional atomicity.
      // BEFORE: setPolicy() used its own injected repo, committing outside this transaction.
      const policy = await this.retentionService.setPolicy(
        tenantId,
        channelId,
        retentionDays,
        userId,
        manager,
      );

      // Log to compliance audit — pass manager for atomicity.
      // BEFORE: auditService.log() was fire-and-forget outside this transaction.
      await this.auditService.log({
        tenantId,
        userId,
        action: ComplianceAction.RETENTION_SET,
        resourceType: channelId ? 'channel' : 'tenant',
        resourceId: channelId ?? tenantId,
        details: { retentionDays, policyId: policy.id },
        ipAddress: null,
        userAgent: null,
      }, manager);

      // Publish outbox event within the transaction
      await this.outboxPublisher.enqueue({
        ...createBaseEvent('RetentionPolicyChanged', tenantId),
        channelId,
        retentionDays,
        policyId: policy.id,
        changedBy: userId,
        changedAt: new Date().toISOString(),
      },  manager);

      this.logger.log(
        `Retention policy set: ${retentionDays} days for tenant=${tenantId}, channel=${channelId ?? 'all'}`,
      );

      return policy;
    });
  }
}
