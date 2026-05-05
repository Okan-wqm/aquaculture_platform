import { Injectable, Logger, ForbiddenException, Inject, Optional } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, IsNull, EntityManager } from 'typeorm';
import Redis from 'ioredis';

import {
  runInTenantTransaction,
  tenantManagerRepo,
} from '@aquaculture/backend-common/database';
import { LegalHold } from '../entities/legal-hold.entity';
import { REDIS_CLIENT } from '../../shared/redis.provider';

/**
 * Manages legal holds on messaging data.
 *
 * When a legal hold is active, messages in scope (tenant-wide or channel-specific)
 * cannot be deleted by GDPR anonymise or retention cleanup.
 *
 * Only TENANT_ADMIN or SUPER_ADMIN may toggle legal holds.
 *
 * @see ADR-012 Phase 3 (Legal Hold Support)
 */
@Injectable()
export class LegalHoldService {
  private readonly logger = new Logger(LegalHoldService.name);

  constructor(
    @InjectRepository(LegalHold)
    private readonly holdRepo: Repository<LegalHold>,
    @Optional() @Inject(REDIS_CLIENT)
    private readonly redis?: Redis,
    @Optional() @InjectDataSource()
    private readonly dataSource?: DataSource,
  ) {}

  /**
   * Activate a legal hold on a tenant or specific channel.
   *
   * @param tenantId - Tenant identifier
   * @param channelId - Optional channel to scope the hold (null = tenant-wide)
   * @param reason - Human-readable reason for the hold
   * @param userId - User activating the hold
   * @param legalMatterId - UUID of the legal matter/regulatory request (REQUIRED for GDPR proportionality)
   * @param options - Optional fields: legalMatterDescription, requestedBy, expiresAt
   * @param manager Optional EntityManager for transactional callers.
   *   BEFORE: no manager parameter -- activate() used its own injected repo,
   *   so it was always outside the caller's transaction boundary.
   *   WHY: ToggleLegalHoldHandler wraps activate() + audit + outbox in one
   *   dataSource.transaction(). Without manager propagation, activate() committed
   *   independently -- if audit or outbox save failed, the hold was already committed
   *   but had no audit trail (ghost legal hold).
   *   With manager: all three writes share the same transaction context.
   */
  async activate(
    tenantId: string,
    channelId: string | null,
    reason: string,
    userId: string,
    legalMatterId: string,
    options?: {
      legalMatterDescription?: string;
      requestedBy?: string;
      expiresAt?: Date;
    },
    manager?: EntityManager,
  ): Promise<LegalHold> {
    // SECURITY: legalMatterId is mandatory for GDPR proportionality.
    // A hold without a legal matter reference is a blanket freeze that violates
    // data protection regulations.
    // @see MSG-CRITICAL-018
    if (!legalMatterId) {
      throw new ForbiddenException(
        'legalMatterId is required: a legal hold must reference a specific legal matter (GDPR proportionality)',
      );
    }

    // Use caller's transaction manager if provided, fall back to injected
    // request-scoped repo. The `manager` branch wraps via tenantManagerRepo
    // so cross-tenant rows can never be written from inside a caller's
    // transaction; the fallback `this.holdRepo` branch carries explicit
    // `tenantId` in every downstream `where:` clause.
    const repo = manager
      ? tenantManagerRepo(manager, LegalHold, tenantId)
      : this.holdRepo;

    // Check for existing active hold on same scope
    const existing = await repo.findOne({
      where: {
        tenantId,
        channelId: channelId ?? IsNull(),
        isActive: true,
      },
    });

    if (existing) {
      throw new ForbiddenException(
        `An active legal hold already exists for this scope (hold ID: ${existing.id})`,
      );
    }

    const hold = repo.create({
      tenantId,
      channelId,
      reason,
      legalMatterId,
      legalMatterDescription: options?.legalMatterDescription ?? null,
      requestedBy: options?.requestedBy ?? null,
      expiresAt: options?.expiresAt ?? null,
      startedBy: userId,
      isActive: true,
    });
    const saved = await repo.save(hold);

    // IMPORTANT: Invalidate any cached legal hold status on toggle to prevent
    // stale cache from allowing deletion of held messages during the staleness window.
    // @see MSG-MEDIUM-023
    await this.invalidateLegalHoldCache(tenantId, channelId);

    this.logger.log(
      `Legal hold activated: id=${saved.id}, tenant=${tenantId}, ` +
      `channel=${channelId ?? 'all'}, legalMatter=${legalMatterId}, by=${userId}`,
    );
    return saved;
  }

  /**
   * Release (deactivate) an existing legal hold.
   *
   * @param manager Optional EntityManager for transactional callers (same rationale as activate).
   */
  async release(
    holdId: string,
    tenantId: string,
    userId: string,
    manager?: EntityManager,
  ): Promise<LegalHold> {
    // tenantId is required so the find below cannot match a hold that
    // belongs to a different tenant than the caller. Without this scope,
    // a user from Tenant A who learned a hold's id (via leaked log,
    // forwarded ticket, etc.) could release Tenant B's hold — defeating
    // GDPR's per-tenant retention guarantees. The tenantManagerRepo
    // wrapper enforces the same scope structurally on the manager-branch.
    const repo = manager
      ? tenantManagerRepo(manager, LegalHold, tenantId)
      : this.holdRepo;

    const hold = await repo.findOne({ where: { id: holdId, tenantId } });
    if (!hold) {
      throw new ForbiddenException(`Legal hold not found: ${holdId}`);
    }
    if (!hold.isActive) {
      throw new ForbiddenException(`Legal hold ${holdId} is already released`);
    }

    hold.isActive = false;
    hold.releasedBy = userId;
    hold.releasedAt = new Date();
    const saved = await repo.save(hold);

    // IMPORTANT: Invalidate cached legal hold status on release.
    // @see MSG-MEDIUM-023
    await this.invalidateLegalHoldCache(hold.tenantId, hold.channelId ?? null);

    this.logger.log(`Legal hold released: id=${holdId}, by=${userId}`);
    return saved;
  }

  /**
   * Check whether a tenant or specific channel is under active legal hold.
   *
   * Used by deletion, anonymisation, and retention cleanup handlers.
   */
  async isUnderLegalHold(
    tenantId: string,
    channelId: string | null,
  ): Promise<boolean> {
    if (this.dataSource) {
      return runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) =>
        this.isUnderLegalHoldWithManager(queryRunner.manager, tenantId, channelId),
      );
    }

    return this.isUnderLegalHoldWithRepo(this.holdRepo, tenantId, channelId);
  }

  private async isUnderLegalHoldWithManager(
    manager: EntityManager,
    tenantId: string,
    channelId: string | null,
  ): Promise<boolean> {
    return this.isUnderLegalHoldWithRepo(
      tenantManagerRepo(manager, LegalHold, tenantId),
      tenantId,
      channelId,
    );
  }

  private async isUnderLegalHoldWithRepo(
    repo: Pick<Repository<LegalHold>, 'findOne'>,
    tenantId: string,
    channelId: string | null,
  ): Promise<boolean> {
    // Check tenant-wide hold first
    const tenantHold = await repo.findOne({
      where: { tenantId, channelId: IsNull(), isActive: true },
    });
    if (tenantHold && !this.isExpired(tenantHold)) return true;

    // If a specific channel is requested, also check channel-level hold
    if (channelId) {
      const channelHold = await repo.findOne({
        where: { tenantId, channelId, isActive: true },
      });
      if (channelHold && !this.isExpired(channelHold)) return true;
    }

    return false;
  }

  /**
   * Check if a legal hold has expired based on its expiresAt field.
   * Expired holds are still active (isActive=true) but should not enforce
   * data retention. They must be explicitly reviewed and released or renewed.
   *
   * @param hold - The legal hold to check
   * @returns true if the hold has an expiresAt date in the past
   */
  private isExpired(hold: LegalHold): boolean {
    if (!hold.expiresAt) return false;
    return hold.expiresAt < new Date();
  }

  /**
   * Return IDs of all channels with an active channel-scoped legal hold.
   *
   * Used by tenant-wide retention cleanup to exclude held channels from DELETE.
   * O(1) query — returns only the channelId column, not full hold records.
   */
  async getHeldChannelIds(tenantId: string): Promise<string[]> {
    const holds = this.dataSource
      ? await runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) =>
          tenantManagerRepo(queryRunner.manager, LegalHold, tenantId).find({
            where: { tenantId, isActive: true },
            select: ['channelId'],
          }),
        )
      : await this.holdRepo.find({
          where: { tenantId, isActive: true },
          select: ['channelId'],
        });

    return holds
      .filter((h) => h.channelId !== null)
      .map((h) => h.channelId as string);
  }

  /**
   * Get all legal holds for a tenant (active and released).
   */
  async getHolds(tenantId: string): Promise<LegalHold[]> {
    if (this.dataSource) {
      return runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) =>
        tenantManagerRepo(queryRunner.manager, LegalHold, tenantId).find({
          where: { tenantId },
          order: { startedAt: 'DESC' },
        }),
      );
    }

    return this.holdRepo.find({ where: { tenantId }, order: { startedAt: 'DESC' } });
  }

  /**
   * Get only active legal holds for a tenant.
   */
  async getActiveHolds(tenantId: string): Promise<LegalHold[]> {
    if (this.dataSource) {
      return runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) =>
        tenantManagerRepo(queryRunner.manager, LegalHold, tenantId).find({
          where: { tenantId, isActive: true },
          order: { startedAt: 'DESC' },
        }),
      );
    }

    return this.holdRepo.find({
      where: { tenantId, isActive: true },
      order: { startedAt: 'DESC' },
    });
  }

  /**
   * Invalidate Redis cache for legal hold status when a hold is toggled.
   * Prevents stale cached legal hold status from allowing deletion of
   * messages that are now under legal hold (or vice versa).
   *
   * Cache key pattern: msg:legal_hold:{tenantId}:{channelId|'all'}
   * @see MSG-MEDIUM-023
   */
  private async invalidateLegalHoldCache(
    tenantId: string,
    channelId: string | null,
  ): Promise<void> {
    if (!this.redis) return;

    try {
      const channelKey = channelId ?? 'all';
      const cacheKey = `msg:legal_hold:${tenantId}:${channelKey}`;
      await this.redis.del(cacheKey);

      // Also invalidate the tenant-wide key since it affects all channels
      if (channelId) {
        await this.redis.del(`msg:legal_hold:${tenantId}:all`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Legal hold cache invalidation failed: ${message}`);
      // Non-fatal — cache will expire naturally via TTL
    }
  }
}
