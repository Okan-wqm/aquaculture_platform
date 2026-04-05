import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, EntityManager } from 'typeorm';

import { LegalHold } from '../entities/legal-hold.entity';

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
  ) {}

  /**
   * Activate a legal hold on a tenant or specific channel.
   *
   * @param manager Optional EntityManager for transactional callers.
   *   BEFORE: no manager parameter — activate() used its own injected repo,
   *   so it was always outside the caller's transaction boundary.
   *   WHY: ToggleLegalHoldHandler wraps activate() + audit + outbox in one
   *   dataSource.transaction(). Without manager propagation, activate() committed
   *   independently — if audit or outbox save failed, the hold was already committed
   *   but had no audit trail (ghost legal hold).
   *   With manager: all three writes share the same transaction context.
   */
  async activate(
    tenantId: string,
    channelId: string | null,
    reason: string,
    userId: string,
    manager?: EntityManager,
  ): Promise<LegalHold> {
    // Use caller's transaction manager if provided, fall back to injected repo
    const repo = manager ? manager.getRepository(LegalHold) : this.holdRepo;

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
      startedBy: userId,
      isActive: true,
    });
    const saved = await repo.save(hold);

    this.logger.log(
      `Legal hold activated: id=${saved.id}, tenant=${tenantId}, channel=${channelId ?? 'all'}, by=${userId}`,
    );
    return saved;
  }

  /**
   * Release (deactivate) an existing legal hold.
   *
   * @param manager Optional EntityManager for transactional callers (same rationale as activate).
   */
  async release(holdId: string, userId: string, manager?: EntityManager): Promise<LegalHold> {
    const repo = manager ? manager.getRepository(LegalHold) : this.holdRepo;

    const hold = await repo.findOne({ where: { id: holdId } });
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
    // Check tenant-wide hold first
    const tenantHold = await this.holdRepo.findOne({
      where: { tenantId, channelId: IsNull(), isActive: true },
    });
    if (tenantHold) return true;

    // If a specific channel is requested, also check channel-level hold
    if (channelId) {
      const channelHold = await this.holdRepo.findOne({
        where: { tenantId, channelId, isActive: true },
      });
      if (channelHold) return true;
    }

    return false;
  }

  /**
   * Get all legal holds for a tenant (active and released).
   */
  async getHolds(tenantId: string): Promise<LegalHold[]> {
    return this.holdRepo.find({
      where: { tenantId },
      order: { startedAt: 'DESC' },
    });
  }

  /**
   * Get only active legal holds for a tenant.
   */
  async getActiveHolds(tenantId: string): Promise<LegalHold[]> {
    return this.holdRepo.find({
      where: { tenantId, isActive: true },
      order: { startedAt: 'DESC' },
    });
  }
}
