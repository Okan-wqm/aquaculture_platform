import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource, IsNull, EntityManager } from 'typeorm';
import { Cron } from '@nestjs/schedule';

import {
  pinTenantSchemaTransactionSearchPath,
  runInTenantTransaction,
  tenantManagerRepo,
} from '@aquaculture/backend-common/database';
import { RetentionPolicy } from '../entities/retention-policy.entity';
import {
  LegalHoldDestructiveMutationAuthority,
  LegalHoldDestructiveMutationBlocked,
} from './legal-hold-destructive-mutation.authority';
import { ComplianceAuditService } from './compliance-audit.service';
import { AttachmentObjectPurgeService } from './attachment-object-purge.service';
import { ComplianceAction } from '../entities/compliance-audit-log.entity';

/** Per-tenant schema name guard (mirrors KnowledgeExtractionService). */
const TENANT_SCHEMA_REGEX = /^tenant_[a-f0-9]{16}$/;

/** Minimal retention-policy shape read from a tenant schema during the sweep. */
interface RetentionPolicyRow {
  id: string;
  tenantId: string;
  channelId: string | null;
  retentionDays: number;
}

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
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly destructiveMutationAuthority: LegalHoldDestructiveMutationAuthority,
    private readonly auditService: ComplianceAuditService,
    // MSG-CRITICAL-058: retention deletes DB rows AND the MinIO attachment objects.
    private readonly attachmentObjectPurge: AttachmentObjectPurgeService,
  ) {}

  /**
   * Enumerate the tenant schemas (`tenant_<16hex>`), regex-guarded. The nightly
   * sweep must iterate these — the retention_policies table is per-tenant (cloned
   * into each tenant schema), so a connection-default read hits the empty
   * `messaging` template and finds ZERO policies (MT-MEDIUM-054).
   */
  private async listTenantSchemas(): Promise<string[]> {
    const rows: { schema_name: string }[] = await this.dataSource.query(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name ~ '^tenant_[a-f0-9]{16}$'
       ORDER BY schema_name`,
    );
    return rows.map((r) => r.schema_name).filter((name) => TENANT_SCHEMA_REGEX.test(name));
  }

  /**
   * Read every tenant's retention policies by pinning each tenant schema in turn
   * (MT-MEDIUM-054). Each row carries its real tenantId, which every downstream
   * step (legal-hold checks, advisory lock, search_path pin, object purge) keys on.
   */
  private async loadAllPoliciesAcrossTenants(): Promise<RetentionPolicyRow[]> {
    const schemas = await this.listTenantSchemas();
    const all: RetentionPolicyRow[] = [];
    for (const schema of schemas) {
      const qr = this.dataSource.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      try {
        await pinTenantSchemaTransactionSearchPath(qr, 'messaging', schema);
        const rows: RetentionPolicyRow[] = await qr.query(
          `SELECT id, "tenantId", "channelId", "retentionDays" FROM retention_policies`,
        );
        await qr.commitTransaction();
        all.push(...rows);
      } catch (err: unknown) {
        try {
          await qr.rollbackTransaction();
        } catch {
          /* rollback on a non-active tx throws — ignore */
        }
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Retention: failed to read policies for schema ${schema}: ${message}`);
      } finally {
        await qr.release();
      }
    }
    return all;
  }

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
    const repo = manager ? tenantManagerRepo(manager, RetentionPolicy, tenantId) : this.policyRepo;

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
    return runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) =>
      tenantManagerRepo(queryRunner.manager, RetentionPolicy, tenantId).find({
        where: { tenantId },
        order: { channelId: 'ASC', createdAt: 'ASC' },
      }),
    );
  }

  /**
   * Get the effective retention days for a given tenant+channel.
   * Falls back to tenant default (365) if no policy exists.
   */
  async getEffectiveRetentionDays(tenantId: string, channelId: string): Promise<number> {
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
      // MT-MEDIUM-054: read policies from EVERY tenant schema, not the connection-
      // default `messaging` template (which is empty) — otherwise the sweep finds
      // zero policies and deletes nothing for anyone.
      const policies = await this.loadAllPoliciesAcrossTenants();

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

        // MSG-CRITICAL-058: the attachment ROWS for the expired messages are now
        // committed-deleted; purge their MinIO objects (best-effort, post-commit).
        if (result.objectKeys.length > 0) {
          const purge = await this.attachmentObjectPurge.purgeObjects(
            policy.tenantId,
            result.objectKeys,
          );
          if (purge.failed > 0) {
            this.logger.error(
              `Retention: ${purge.failed}/${purge.requested} attachment object(s) failed to ` +
                `delete for tenant ${policy.tenantId}; orphaned objects require reaper cleanup`,
            );
          }
        }

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
   * PostgreSQL partition pruning keeps the row delete bounded by the cutoff,
   * while the mutation authority supplies channel exclusions from the same
   * locked hold snapshot that governs the commit.
   * @see MSG-MEDIUM-045
   */
  private async cleanupForPolicy(
    policy: RetentionPolicyRow,
    cutoffDate: Date,
  ): Promise<{ deletedCount: number; skipReason: string | null; objectKeys: string[] }> {
    const { tenantId, channelId } = policy;
    try {
      const result = channelId
        ? await this.destructiveMutationAuthority.runChannelMutation(
            tenantId,
            () => Promise.resolve({ channelId, target: policy }),
            ({ manager }) => this.deleteExpiredMessages(manager, cutoffDate, channelId, []),
          )
        : await this.destructiveMutationAuthority.runPartitionedTenantMutation(
            tenantId,
            ({ manager, heldChannelIds }) =>
              this.deleteExpiredMessages(manager, cutoffDate, null, heldChannelIds),
          );

      if (result.deletedCount > 0) {
        this.logger.log(
          `Retention cleanup: deleted ${result.deletedCount} messages for tenant=${tenantId}, channel=${channelId ?? 'all'}`,
        );
      }
      return result;
    } catch (err: unknown) {
      if (err instanceof LegalHoldDestructiveMutationBlocked) {
        const skipReason =
          err.reason === 'TENANT_WIDE_HOLD'
            ? 'tenant-wide legal hold'
            : 'channel-scoped legal hold';
        this.logger.debug(
          `Skipping retention for tenant=${tenantId}, channel=${channelId ?? 'all'}: ${skipReason}`,
        );
        return { deletedCount: 0, skipReason, objectKeys: [] };
      }
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Retention cleanup failed for policy ${policy.id}: ${message}`);
      return { deletedCount: 0, skipReason: `error: ${message}`, objectKeys: [] };
    }
  }

  /**
   * Delete one policy's rows through the already-authorized transaction.
   * Tenant policies receive the exact locked channel exclusions; channel
   * policies reach this method only after their channel has been cleared.
   */
  private async deleteExpiredMessages(
    manager: EntityManager,
    cutoffDate: Date,
    channelId: string | null,
    heldChannelIds: readonly string[],
  ): Promise<{ deletedCount: number; skipReason: string | null; objectKeys: string[] }> {
    const channelPredicate = channelId
      ? 'm."channelId" = $1 AND m."createdAt" < $2'
      : 'm."createdAt" < $1 AND NOT (m."channelId" = ANY($2::uuid[]))';
    const messagePredicate = channelId
      ? '"channelId" = $1 AND "createdAt" < $2'
      : '"createdAt" < $1 AND NOT ("channelId" = ANY($2::uuid[]))';
    const parameters = channelId
      ? [channelId, cutoffDate.toISOString()]
      : [cutoffDate.toISOString(), heldChannelIds];

    const attachmentRows: Array<{ storageKey: string; thumbnailKey: string | null }> =
      await manager.query(
        `SELECT att."storageKey", att."thumbnailKey"
         FROM message_attachments att, messages m
         WHERE att."messageId" = m.id
           AND att."messageCreatedAt" = m."createdAt"
           AND ${channelPredicate}`,
        parameters,
      );
    const objectKeys = collectAttachmentObjectKeys(attachmentRows);

    await manager.query(
      `DELETE FROM message_attachments att USING messages m
       WHERE att."messageId" = m.id
         AND att."messageCreatedAt" = m."createdAt"
         AND ${channelPredicate}`,
      parameters,
    );

    const result: unknown = await manager.query(
      `DELETE FROM messages WHERE ${messagePredicate}`,
      parameters,
    );
    const deletedCount = Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
    return { deletedCount, skipReason: null, objectKeys };
  }
}

/** Flatten attachment rows into a deduped list of non-null MinIO object keys. */
function collectAttachmentObjectKeys(
  rows: ReadonlyArray<{ storageKey: string; thumbnailKey: string | null }>,
): string[] {
  const keys: string[] = [];
  for (const row of rows) {
    if (row.storageKey) keys.push(row.storageKey);
    if (row.thumbnailKey) keys.push(row.thumbnailKey);
  }
  return keys;
}
