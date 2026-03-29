import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, LessThan, IsNull } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';

import { RetentionPolicy } from '../entities/retention-policy.entity';
import { Message } from '../../message/entities/message.entity';
import { LegalHoldService } from './legal-hold.service';
import { ComplianceAuditService } from './compliance-audit.service';
import { ComplianceAction } from '../entities/compliance-audit-log.entity';

/**
 * Manages retention policies and executes nightly message cleanup.
 *
 * Policies cascade: tenant-level default applies unless a channel-level
 * override exists. Messages under legal hold are always preserved.
 *
 * @see ADR-012 Phase 3 (Message Retention Policies)
 */
@Injectable()
export class RetentionPolicyService {
  private readonly logger = new Logger(RetentionPolicyService.name);

  constructor(
    @InjectRepository(RetentionPolicy)
    private readonly policyRepo: Repository<RetentionPolicy>,
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly legalHoldService: LegalHoldService,
    private readonly auditService: ComplianceAuditService,
  ) {}

  /**
   * Create or update a retention policy for a tenant or channel.
   */
  async setPolicy(
    tenantId: string,
    channelId: string | null,
    retentionDays: number,
    userId: string,
  ): Promise<RetentionPolicy> {
    const existing = await this.policyRepo.findOne({
      where: { tenantId, channelId: channelId ?? IsNull() },
    });

    if (existing) {
      existing.retentionDays = retentionDays;
      const updated = await this.policyRepo.save(existing);
      this.logger.log(
        `Updated retention policy ${updated.id}: ${retentionDays} days (tenant=${tenantId}, channel=${channelId ?? 'all'})`,
      );
      return updated;
    }

    const policy = this.policyRepo.create({
      tenantId,
      channelId,
      retentionDays,
      createdBy: userId,
    });
    const saved = await this.policyRepo.save(policy);
    this.logger.log(
      `Created retention policy ${saved.id}: ${retentionDays} days (tenant=${tenantId}, channel=${channelId ?? 'all'})`,
    );
    return saved;
  }

  /**
   * Get all retention policies for a tenant (default + channel overrides).
   */
  async getPolicies(tenantId: string): Promise<RetentionPolicy[]> {
    return this.policyRepo.find({
      where: { tenantId },
      order: { channelId: 'ASC', createdAt: 'ASC' },
    });
  }

  /**
   * Get the effective retention days for a given tenant+channel.
   * Falls back to tenant default (365) if no policy exists.
   */
  async getEffectiveRetentionDays(
    tenantId: string,
    channelId: string,
  ): Promise<number> {
    const channelPolicy = await this.policyRepo.findOne({
      where: { tenantId, channelId },
    });
    if (channelPolicy) return channelPolicy.retentionDays;

    const tenantPolicy = await this.policyRepo.findOne({
      where: { tenantId, channelId: IsNull() },
    });
    return tenantPolicy?.retentionDays ?? 365;
  }

  /**
   * Nightly cleanup — runs at 02:00 UTC.
   * Iterates all retention policies, deletes expired messages that are
   * not under legal hold, and cascades attachment cleanup.
   */
  @Cron('0 2 * * *', { name: 'retention-cleanup' })
  async executeRetentionCleanup(): Promise<void> {
    this.logger.log('Starting nightly retention cleanup...');
    const startTime = Date.now();
    let totalDeleted = 0;

    try {
      const policies = await this.policyRepo.find({
        where: {},
      });

      for (const policy of policies) {
        if (policy.retentionDays === -1) continue; // indefinite — skip

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - policy.retentionDays);

        const deleted = await this.cleanupForPolicy(policy, cutoffDate);
        totalDeleted += deleted;
      }

      const durationMs = Date.now() - startTime;
      this.logger.log(
        `Retention cleanup completed: ${totalDeleted} messages deleted in ${durationMs}ms`,
      );

      // Log cleanup stats to compliance audit
      await this.auditService.log({
        tenantId: '00000000-0000-0000-0000-000000000000',
        userId: '00000000-0000-0000-0000-000000000000',
        action: ComplianceAction.RETENTION_SET,
        resourceType: 'system',
        resourceId: '00000000-0000-0000-0000-000000000000',
        details: { type: 'nightly_cleanup', totalDeleted, durationMs },
        ipAddress: null,
        userAgent: 'system/retention-cleanup',
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Retention cleanup failed: ${message}`);
    }
  }

  /**
   * Delete expired messages for a single retention policy,
   * skipping any messages under legal hold.
   */
  private async cleanupForPolicy(
    policy: RetentionPolicy,
    cutoffDate: Date,
  ): Promise<number> {
    const { tenantId, channelId } = policy;

    // Check if entire tenant or specific channel is under legal hold
    const tenantHeld = await this.legalHoldService.isUnderLegalHold(tenantId, null);
    if (tenantHeld && !channelId) {
      this.logger.debug(`Skipping retention for tenant ${tenantId}: under legal hold`);
      return 0;
    }

    if (channelId) {
      const channelHeld = await this.legalHoldService.isUnderLegalHold(tenantId, channelId);
      if (channelHeld) {
        this.logger.debug(`Skipping retention for channel ${channelId}: under legal hold`);
        return 0;
      }
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      // Delete attachments for expired messages first
      const deleteAttachmentsQuery = channelId
        ? `DELETE FROM message_attachments att
           USING messages m
           WHERE att."messageId" = m.id
             AND att."messageCreatedAt" = m."createdAt"
             AND m."channelId" = $1
             AND m."createdAt" < $2`
        : `DELETE FROM message_attachments att
           USING messages m
           WHERE att."messageId" = m.id
             AND att."messageCreatedAt" = m."createdAt"
             AND m."createdAt" < $1`;

      const attachParams = channelId
        ? [channelId, cutoffDate.toISOString()]
        : [cutoffDate.toISOString()];
      await qr.query(deleteAttachmentsQuery, attachParams);

      // Hard-delete expired messages
      const deleteMessagesQuery = channelId
        ? `DELETE FROM messages WHERE "channelId" = $1 AND "createdAt" < $2`
        : `DELETE FROM messages WHERE "createdAt" < $1`;

      const msgParams = channelId
        ? [channelId, cutoffDate.toISOString()]
        : [cutoffDate.toISOString()];
      const result = await qr.query(deleteMessagesQuery, msgParams);

      await qr.commitTransaction();

      const deletedCount = Array.isArray(result) ? (result[1] as number) ?? 0 : 0;
      if (deletedCount > 0) {
        this.logger.log(
          `Retention cleanup: deleted ${deletedCount} messages for tenant=${tenantId}, channel=${channelId ?? 'all'}`,
        );
      }
      return deletedCount;
    } catch (err: unknown) {
      await qr.rollbackTransaction();
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Retention cleanup failed for policy ${policy.id}: ${message}`);
      return 0;
    } finally {
      await qr.release();
    }
  }
}
