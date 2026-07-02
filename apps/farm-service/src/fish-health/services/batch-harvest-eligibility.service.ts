/**
 * Batch Harvest Eligibility Service
 *
 * Centralises the "can this batch be harvested on this date?" invariant.
 * The rule: if any active HealthEvent on the batch has an
 * `earliestHarvestDate` in the future of the intended harvest date, the
 * harvest is BLOCKED.
 *
 * Why a service (not an inline check in the harvest handler): the same
 * invariant applies to at least three write paths:
 *   1. createHarvestRecord — hard block on early harvest
 *   2. createHarvestPlan    — advisory warning when the planned date
 *                             falls before earliestHarvestDate
 *   3. closeBatch           — advisory warning if active treatments are
 *                             still open
 * Consolidating the read + decision logic here keeps the rule in one
 * place and lets a pre-submit GraphQL query (see
 * batch-harvest-eligibility.query.ts) reuse it so the UI can disable
 * the harvest button before the mutation is sent.
 *
 * Compliance background: Norwegian Mattilsynet and EU Reg 37/2010
 * mandate a medicine withdrawal period between treatment and human
 * consumption. A harvest during that window is a food-safety violation.
 * Prior to this service the check was absent — see
 * docs/illustrator/farm-modulu-kor-noktalar-dogrulama.md (Girdi 14h).
 */
import { Injectable, Logger } from '@nestjs/common';
import { DataSource, In, MoreThan } from 'typeorm';
import { runInTenantRead, tenantManagerRepo } from '@aquaculture/backend-common/database';

import {
  HealthEvent,
  HealthEventStatus,
} from '../entities/health-event.entity';

export interface BlockingHealthEvent {
  id: string;
  title: string;
  diseaseName: string | null;
  earliestHarvestDate: Date;
  withdrawalPeriodDays: number | null;
  status: HealthEventStatus;
}

export interface HarvestEligibilityResult {
  /** true when every active health event's earliestHarvestDate is on or before the intended harvest date. */
  eligible: boolean;
  /** The latest earliestHarvestDate among blocking events (the effective earliest harvest date for the whole batch). */
  blockedUntil?: Date;
  /** Human-readable reason; present only when `eligible === false`. */
  reason?: string;
  /** Full list of blocking events — UI can render them. */
  blockingEvents: BlockingHealthEvent[];
}

@Injectable()
export class BatchHarvestEligibilityService {
  private readonly logger = new Logger(BatchHarvestEligibilityService.name);

  // WHY: harvest-eligibility reads tenant health_events; a raw injected repository
  // resolves the table via the pooled connection's ambient search_path and can read
  // another tenant's events (a wrong, safety-relevant harvest decision). WHAT: read
  // through the fail-closed runInTenantRead boundary (search_path + RLS pinned).
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Check whether the given batch can be harvested on (or after) the
   * requested date without violating any active medicine withdrawal
   * period.
   *
   * The query narrows to:
   *   - tenantId match (isolation)
   *   - batchId match
   *   - status in { ACTIVE, MONITORING } — only open/observed events
   *     impose a withdrawal constraint
   *   - earliestHarvestDate > harvestDate  — only events whose window
   *     has not yet elapsed are blocking
   */
  async checkEligibility(
    tenantId: string,
    batchId: string,
    harvestDate: Date,
  ): Promise<HarvestEligibilityResult> {
    const events = await runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) =>
      // tenantId auto-injected by the tenant-scoped repo
      tenantManagerRepo(queryRunner.manager, HealthEvent, tenantId).find({
        where: {
          batchId,
          status: In([HealthEventStatus.ACTIVE, HealthEventStatus.MONITORING]),
          earliestHarvestDate: MoreThan(harvestDate),
        },
        order: { earliestHarvestDate: 'DESC' },
        select: [
          'id',
          'title',
          'diseaseName',
          'earliestHarvestDate',
          'withdrawalPeriodDays',
          'status',
        ],
      }),
    );

    const blockingEvents: BlockingHealthEvent[] = events.map((e) => ({
      id: e.id,
      title: e.title,
      diseaseName: e.diseaseName ?? null,
      // SAFETY: MoreThan(harvestDate) filter guarantees non-null here;
      // the assertion documents the invariant for downstream readers.
      earliestHarvestDate: e.earliestHarvestDate as Date,
      withdrawalPeriodDays: e.withdrawalPeriodDays ?? null,
      status: e.status,
    }));

    // DESC order: the first row has the latest earliestHarvestDate and
    // therefore defines the effective block window for the batch.
    // Use an explicit const (instead of blockingEvents[0].x) so
    // noUncheckedIndexedAccess can refine length>0 into a definite value.
    const firstBlocker = blockingEvents[0];
    if (!firstBlocker) {
      return { eligible: true, blockingEvents: [] };
    }

    const blockedUntil = firstBlocker.earliestHarvestDate;
    const reason =
      `Batch has ${blockingEvents.length} active health event(s) with ` +
      `open withdrawal period. Earliest permissible harvest date: ` +
      `${blockedUntil.toISOString().slice(0, 10)}.`;

    this.logger.warn(
      `Harvest blocked for batch=${batchId} tenant=${tenantId.slice(0, 8)}... ` +
        `until ${blockedUntil.toISOString().slice(0, 10)} ` +
        `(${blockingEvents.length} event(s))`,
    );

    return { eligible: false, blockedUntil, reason, blockingEvents };
  }
}
