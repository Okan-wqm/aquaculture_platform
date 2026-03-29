import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { SetRetentionPolicyCommand } from './set-retention-policy.command';
import { RetentionPolicy } from '../entities/retention-policy.entity';
import { RetentionPolicyService } from '../services/retention-policy.service';
import { ComplianceAuditService } from '../services/compliance-audit.service';
import { ComplianceAction } from '../entities/compliance-audit-log.entity';
import { MessagingOutbox } from '../../outbox/messaging-outbox.entity';

/** Allowed retention values in days. */
const ALLOWED_RETENTION_DAYS = [90, 365, 1095, -1];

/**
 * Handler for SetRetentionPolicyCommand.
 *
 * Validates retention days, creates/updates the policy, logs to compliance
 * audit, and publishes a RetentionPolicyChanged outbox event.
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
    @InjectRepository(MessagingOutbox)
    private readonly outboxRepo: Repository<MessagingOutbox>,
  ) {}

  async execute(command: SetRetentionPolicyCommand): Promise<RetentionPolicy> {
    const { tenantId, userId, channelId, retentionDays } = command;

    // Validate retention days
    if (!ALLOWED_RETENTION_DAYS.includes(retentionDays)) {
      throw new BadRequestException(
        `Invalid retentionDays value. Allowed: ${ALLOWED_RETENTION_DAYS.join(', ')}`,
      );
    }

    // Create or update the policy
    const policy = await this.retentionService.setPolicy(
      tenantId,
      channelId,
      retentionDays,
      userId,
    );

    // Log to compliance audit
    await this.auditService.log({
      tenantId,
      userId,
      action: ComplianceAction.RETENTION_SET,
      resourceType: channelId ? 'channel' : 'tenant',
      resourceId: channelId ?? tenantId,
      details: { retentionDays, policyId: policy.id },
      ipAddress: null,
      userAgent: null,
    });

    // Publish outbox event
    const outboxEvent = this.outboxRepo.create({
      eventType: 'RetentionPolicyChanged',
      payload: {
        tenantId,
        channelId,
        retentionDays,
        policyId: policy.id,
        changedBy: userId,
        changedAt: new Date().toISOString(),
      },
    });
    await this.outboxRepo.save(outboxEvent);

    this.logger.log(
      `Retention policy set: ${retentionDays} days for tenant=${tenantId}, channel=${channelId ?? 'all'}`,
    );

    return policy;
  }
}
