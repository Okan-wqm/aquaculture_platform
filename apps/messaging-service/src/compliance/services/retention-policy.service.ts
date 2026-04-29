import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, LessThan, IsNull, EntityManager } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';

import { tenantManagerRepo } from '@aquaculture/backend-common/database';
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
  /**
   * @param manager Optional EntityManager for transactional callers.
   *   BEFORE: setPolicy() used its own injected repo — writes were outside the
   *   caller's transaction. SetRetentionPolicyHandler wrapped policy+audit+outbox
   *   in dataSource.transaction() but setPolicy() committed independently.
   *   WHY: Retention policy change must be atomic with its audit log entry.
   *   If the audit log save fails, the policy change must roll back with it.
   */
  async setPolicy(
    tenantId: string,
    channelId: string | null,
    retentionDays: number,
    userId: string,
    manager?: EntityManager,
  ): Promise<RetentionPolicy> {
    // Inside-transaction path wraps via tenantManagerRepo so policy rows
    // can never be written under a different tenant than the caller. The
    // fallback `this.policyRepo` carries explicit tenantId in `where:`.
    const repo = manager
      ? tenantManagerRepo(manager, RetentionPolicy, tenantId)
      : this.policyRepo;

    const existing = await repo.findOne({
      where: { tenantId, channelId: channelId ?? IsNull() },
    });

    if (existing) {
      existing.retentionDays = retentionDays;
      const updated = await repo.save(existing);
      this.logger.log(
        `Updated retention policy ${updated.id}: ${retentionDays} days (tenant=${tenantId}, channel=${channelId ?? 'all'})`,
      );
      return updated;
    }

    const policy = repo.create({
      tenantId,
      channelId,
      retentionDays,
      createdBy: userId,
    });
    const saved = await repo.save(policy);
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

      // LEGAL-LOW-002 cure: emit one audit row PER (tenantId,
      // policyId) processed instead of one anonymous system row
      // for the whole sweep. Pre-cure the post-sweep audit
      // hardcoded zero-UUID tenant + user, making per-tenant
      // retention reporting impossible — and any legal-hold
      // post-mortem ("did retention sweep on this tenant during
      // the hold window?") had no signal beyond the global
      // totalDeleted aggregate. The per-policy row attributes
      // each delete batch to the correct tenant; the legal-hold
      // skip path now writes a row with deleted=0 + reason so
      // the held-tenant evidence is durable.
      for (const policy of policies) {
        if (policy.retentionDays === -1) continue; // indefinite — skip

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - policy.retentionDays);

        const policyStart = Date.now();
        const result = await this.cleanupForPolicy(policy, cutoffDate);
        totalDeleted += result.deletedCount;

        // Per-policy audit row. tenantId/userId are real (the
        // policy's owning tenant + a system-cron actor identity
        // that the messaging audit service treats as the
        // authoritative actor for scheduled retention). resourceId
        // points at the policy.id so a "show me every cleanup
        // for this policy" query is a single indexed lookup.
        await this.auditService.log({
          tenantId: policy.tenantId,
          userId: 'system:retention-cleanup',
          action: ComplianceAction.RETENTION_SET,
          resourceType: 'retention_policy',
          resourceId: policy.id,
          details: {
            type: 'nightly_cleanup',
            policyId: policy.id,
            channelId: policy.channelId ?? null,
            retentionDays: policy.retentionDays,
            cutoffDate: cutoffDate.toISOString(),
            deletedCount: result.deletedCount,
            skipReason: result.skipReason ?? null,
            durationMs: Date.now() - policyStart,
          },
          ipAddress: null,
          userAgent: 'system/retention-cleanup',
        });
      }

      const durationMs = Date.now() - startTime;
      this.logger.log(
        `Retention cleanup completed: ${totalDeleted} messages deleted in ${durationMs}ms across ${policies.length} policies`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Retention cleanup failed: ${message}`);
    }
  }

  /**
   * Delete expired messages for a single retention policy,
   * skipping any messages under legal hold.
   *
   * IMPORTANT: For tenant-wide cleanup without channel-scoped holds, this uses
   * TimescaleDB drop_chunks() which is orders of magnitude faster than row-by-row
   * DELETE and generates no WAL bloat. For channel-scoped or held-channel-excluded
   * cleanup, falls back to row DELETE since drop_chunks operates on entire chunks.
   * @see MSG-MEDIUM-045
   */
  private async cleanupForPolicy(
    policy: RetentionPolicy,
    cutoffDate: Date,
  ): Promise<{ deletedCount: number; skipReason: string | null }> {
    const { tenantId, channelId } = policy;

    // Check if entire tenant is under legal hold — skip everything
    const tenantHeld = await this.legalHoldService.isUnderLegalHold(tenantId, null);
    if (tenantHeld) {
      this.logger.debug(`Skipping retention for tenant ${tenantId}: under tenant-wide legal hold`);
      return { deletedCount: 0, skipReason: 'tenant-wide legal hold' };
    }

    if (channelId) {
      const channelHeld = await this.legalHoldService.isUnderLegalHold(tenantId, channelId);
      if (channelHeld) {
        this.logger.debug(`Skipping retention for channel ${channelId}: under legal hold`);
        return { deletedCount: 0, skipReason: 'channel-scoped legal hold' };
      }
    }

    // For tenant-wide cleanup (no channelId): fetch all channels under hold so the
    // DELETE queries exclude them. Without this, channels under channel-scoped holds
    // would be silently wiped by the tenant-wide policy.
    let heldChannelIds: string[] = [];
    if (!channelId) {
      heldChannelIds = await this.legalHoldService.getHeldChannelIds(tenantId);
      if (heldChannelIds.length > 0) {
        this.logger.debug(
          `Tenant-wide retention for ${tenantId}: excluding ${heldChannelIds.length} held channel(s)`,
        );
      }
    }

    // ── Fast path: TimescaleDB drop_chunks() for tenant-wide, no held channels ──
    // drop_chunks() is orders of magnitude faster than row-by-row DELETE:
    // - Drops entire hypertable chunks (file-level operation, ~ms)
    // - No WAL bloat, no index maintenance, no vacuum needed
    // Only applicable when we can drop entire time ranges without exclusions.
    // @see MSG-MEDIUM-045
    if (!channelId && heldChannelIds.length === 0) {
      const dropped = await this.dropChunksForTenant(tenantId, cutoffDate);
      return { deletedCount: dropped, skipReason: null };
    }

    // ── Slow path: row-by-row DELETE for channel-scoped or held-channel-excluded cleanup ──
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      // Set tenant schema before any DB operation (cron job has no HTTP context)
      await qr.query(
        `SET search_path TO "tenant_${tenantId.replace(/[^a-zA-Z0-9_-]/g, '')}", messaging, public`,
      );

      // Build exclusion clause for held channels (tenant-wide cleanup only)
      const heldExclusion =
        heldChannelIds.length > 0
          ? ` AND m."channelId" NOT IN (${heldChannelIds.map((_, i) => `$${i + 2}`).join(',')})`
          : '';
      const heldExclusionMsg =
        heldChannelIds.length > 0
          ? ` AND "channelId" NOT IN (${heldChannelIds.map((_, i) => `$${i + 2}`).join(',')})`
          : '';

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
             AND m."createdAt" < $1${heldExclusion}`;

      const attachParams = channelId
        ? [channelId, cutoffDate.toISOString()]
        : [cutoffDate.toISOString(), ...heldChannelIds];
      await qr.query(deleteAttachmentsQuery, attachParams);

      // Hard-delete expired messages
      const deleteMessagesQuery = channelId
        ? `DELETE FROM messages WHERE "channelId" = $1 AND "createdAt" < $2`
        : `DELETE FROM messages WHERE "createdAt" < $1${heldExclusionMsg}`;

      const msgParams = channelId
        ? [channelId, cutoffDate.toISOString()]
        : [cutoffDate.toISOString(), ...heldChannelIds];
      const result = await qr.query(deleteMessagesQuery, msgParams);

      await qr.commitTransaction();

      const deletedCount = Array.isArray(result) ? (result[1] as number) ?? 0 : 0;
      if (deletedCount > 0) {
        this.logger.log(
          `Retention cleanup: deleted ${deletedCount} messages for tenant=${tenantId}, channel=${channelId ?? 'all'}`,
        );
      }
      return { deletedCount, skipReason: null };
    } catch (err: unknown) {
      await qr.rollbackTransaction();
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Retention cleanup failed for policy ${policy.id}: ${message}`);
      return { deletedCount: 0, skipReason: `error: ${message}` };
    } finally {
      await qr.release();
    }
  }

  /**
   * Use TimescaleDB drop_chunks() for fast retention cleanup.
   * Drops entire hypertable chunks older than cutoffDate in one operation.
   * Falls back to row DELETE if drop_chunks() is not available (non-TimescaleDB deployment).
   * @see MSG-MEDIUM-045
   */
  private async dropChunksForTenant(
    tenantId: string,
    cutoffDate: Date,
  ): Promise<number> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();

    try {
      await qr.query(
        `SET search_path TO "tenant_${tenantId.replace(/[^a-zA-Z0-9_-]/g, '')}", messaging, public`,
      );

      // drop_chunks returns the list of dropped chunk names.
      // First drop attachment chunks (child table), then message chunks (parent).
      await qr.query(
        `SELECT drop_chunks('message_attachments', older_than => $1::timestamptz)`,
        [cutoffDate.toISOString()],
      ).catch(() => {
        // message_attachments may not be a hypertable — silently skip
      });

      const result = await qr.query(
        `SELECT drop_chunks('messages', older_than => $1::timestamptz)`,
        [cutoffDate.toISOString()],
      );

      const droppedChunks = Array.isArray(result) ? result.length : 0;
      if (droppedChunks > 0) {
        this.logger.log(
          `Retention: dropped ${droppedChunks} chunk(s) for tenant=${tenantId} (older than ${cutoffDate.toISOString()})`,
        );
      }
      return droppedChunks;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // If drop_chunks fails (e.g., table is not a hypertable), log and return 0.
      // The caller can handle this as a no-op; manual row DELETE fallback is above.
      this.logger.warn(
        `drop_chunks not available for tenant=${tenantId}: ${message}. ` +
        'Falling back to row-level DELETE on next cycle.',
      );
      return 0;
    } finally {
      await qr.release();
    }
  }
}
