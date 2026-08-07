/**
 * FeedSelection DataLoader
 *
 * Batches feed assignment + feed lookups by batchId into bulk IN queries.
 * Uses the same weight-matching logic as FeedSelectorService but in bulk.
 *
 * C-5 (feeding-protocol cycle): the PRIMARY resolution is the unit's active v2
 * `ProtocolAssignment` + ACTIVE `FeedingProtocolV2` band, resolved through
 * `UnitProtocolResolverService` — the same lookup AND the same
 * `ProtocolRateService` math the 06:00 day-plan generator runs, so the tanks
 * page and the plan can never disagree on "current feed".
 *
 * The v1 `batches_v2.protocolId` chain that used to sit between the v2 path and
 * `batch_feed_assignments` is GONE: that column pointed at the v1
 * `feeding_protocols` table and never had a writer, so the branch could only
 * ever evaluate to "no protocol" — dead code wearing the costume of a fallback,
 * plus a `batches_v2` round trip per request. `batch_feed_assignments` remains
 * as the genuine drain-window fallback for units with no v2 assignment.
 *
 * Tenant scoping is structural: the batch function only ever runs with a
 * tenantId the factory resolved fail-closed from the request context, so every
 * `WHERE "tenantId" = $1` clause can never be issued tenant-blind. The schema is
 * derived from that same verified tenantId.
 */
import DataLoader from 'dataloader';
import { ObjectLiteral, Repository } from 'typeorm';
import { createTenantScopedDataLoader } from '@aquaculture/backend-common/dataloader';
import { getTenantSchemaName } from '@aquaculture/backend-common/database';
import {
  FeedSelectionRow,
  FeedSelectionDataLoader,
} from '../../common/types/graphql-context.types';
import type { UnitProtocolResolverService } from '../../feeding-protocol/services/unit-protocol-resolver.service';
import type { BandWeightG } from '../../feeding-protocol/services/protocol-rate.service';

interface BatchFeedContext {
  batchId: string;
  /** Ünite-otoriteli ortalama ağırlık (band çözümünün tek geçerli kaynağı). */
  avgWeightG: BandWeightG;
  biomassKg: number;
  waterTempC?: number;
  /** Equipment.id — v2 protokol ataması ünite-anahtarlıdır (C-5). */
  unitId?: string;
}

interface FeedingCurvePoint {
  fishWeightG: number;
  feedingRatePercent: number;
}

/** A single weight-banded feed entry stored in batch_feed_assignments.feedAssignments. */
interface FeedAssignmentEntry {
  feedId: string;
  priority: number;
  minWeightG: number;
  maxWeightG: number;
}

/** Shape of a batch_feed_assignments row as returned by the raw query. */
interface FeedAssignmentRow {
  batchId: string;
  feedAssignments: FeedAssignmentEntry[] | string;
}

/** Shape of a feeds row as returned by the raw query. */
interface FeedRow {
  id: string;
  code: string;
  name: string;
  feedingCurve: FeedingCurvePoint[] | string | null;
}

function parseEntries(value: FeedAssignmentEntry[] | string): FeedAssignmentEntry[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * @param repo any tenant-scoped repository — used only as a raw-SQL handle.
 * @param unitProtocol the protocol-lookup + rate SSoT (injected, not
 *   constructed here, so the tanks page provably shares ONE resolver instance
 *   and one formula with every other feeding caller).
 */
export function createFeedSelectionLoader(
  repo: Repository<ObjectLiteral>,
  unitProtocol: UnitProtocolResolverService,
): FeedSelectionDataLoader {
  // Store batch context for weight/biomass lookup
  const contextMap = new Map<string, BatchFeedContext>();

  const loader = createTenantScopedDataLoader<string, FeedSelectionRow | null>(
    async (tenantId: string, batchIds: readonly string[]): Promise<(FeedSelectionRow | null)[]> => {
      const schema = getTenantSchemaName(tenantId);

      // 0. C-5 PRIMARY: bulk load the active protocol binding for every unit in
      // context. A unit with a live v2 assignment resolves from the protocol
      // band — the legacy chain below never runs for it.
      const contextUnitIds = batchIds
        .map((batchId) => contextMap.get(batchId)?.unitId)
        .filter((unitId): unitId is string => unitId != null);
      const bindingByUnit = await unitProtocol.loadActiveBindings(repo, tenantId, contextUnitIds);

      // 1. Bulk load all feed assignments
      const assignments: FeedAssignmentRow[] = await repo.query(
        `SELECT * FROM "${schema}".batch_feed_assignments
         WHERE "tenantId" = $1 AND "batchId" = ANY($2::uuid[])
         AND "isActive" = true AND "isDeleted" = false`,
        [tenantId, [...batchIds]],
      );

      // Group assignments by batchId
      const assignmentMap = new Map<string, FeedAssignmentRow>();
      const feedIdSet = new Set<string>();

      for (const a of assignments) {
        assignmentMap.set(a.batchId, a);
        for (const entry of parseEntries(a.feedAssignments)) {
          feedIdSet.add(entry.feedId);
        }
      }

      // 2. Bulk load all referenced feeds
      const feedMap = new Map<string, FeedRow>();
      const feedIds = [...feedIdSet];
      if (feedIds.length > 0) {
        const feeds: FeedRow[] = await repo.query(
          `SELECT * FROM "${schema}".feeds
           WHERE "id" = ANY($1::uuid[]) AND "tenantId" = $2 AND "isDeleted" = false`,
          [feedIds, tenantId],
        );
        for (const feed of feeds) {
          feedMap.set(feed.id, feed);
        }
      }

      // 3. Resolve each batchId
      return batchIds.map((batchId) => {
        const ctx = contextMap.get(batchId);
        if (!ctx || ctx.avgWeightG <= 0 || ctx.biomassKg <= 0) return null;

        // C-5 PRIMARY: unit's active v2 assignment — same band/rate math as
        // the 06:00 day-plan generator (bandFor + tempMultiplier + overrides),
        // because it is literally the same service call.
        const binding = ctx.unitId ? bindingByUnit.get(ctx.unitId) : undefined;
        if (binding) {
          const resolved = unitProtocol.resolveRate(
            binding,
            ctx.avgWeightG,
            // No reading → null, never a fabricated default (P-20).
            ctx.waterTempC ?? null,
          );
          if (resolved) {
            const rate = resolved.effectiveRatePercent;
            return {
              feedId: resolved.feedId,
              feedCode: resolved.feedCode,
              feedName: resolved.feedName,
              feedingRatePercent: rate,
              dailyFeedKg: Math.round(((ctx.biomassKg * rate) / 100) * 100) / 100,
            };
          }
        }

        // Legacy drain-window fallback — batch_feed_assignments; retired with
        // the rest of the v1 feed stack.
        const assignment = assignmentMap.get(batchId);
        if (!assignment) return null;

        const entries = parseEntries(assignment.feedAssignments);
        if (entries.length === 0) return null;

        // Find matching feed by weight range
        const sorted = [...entries].sort((a, b) => {
          if (a.priority !== b.priority) return a.priority - b.priority;
          return a.minWeightG - b.minWeightG;
        });

        const match = sorted.find(
          (e) => ctx.avgWeightG >= e.minWeightG && ctx.avgWeightG < e.maxWeightG,
        );

        if (!match) return null;

        const feed = feedMap.get(match.feedId);
        if (!feed) return null;

        // Get feeding rate from curve
        const feedingRatePercent = getFeedingRateFromCurve(feed.feedingCurve, ctx.avgWeightG);
        const dailyFeedKg = Math.round(((ctx.biomassKg * feedingRatePercent) / 100) * 100) / 100;

        return {
          feedId: feed.id,
          feedCode: feed.code,
          feedName: feed.name,
          feedingRatePercent,
          dailyFeedKg,
        };
      });
    },
    { batchFnName: 'FeedSelectionDataLoader', dataLoaderOptions: { maxBatchSize: 100 } },
  );

  // Expose method to set batch context before loading. Object.assign keeps the
  // result structurally a FeedSelectionDataLoader without a type assertion.
  return Object.assign(loader, {
    setContext: (
      batchId: string,
      avgWeightG: BandWeightG,
      biomassKg: number,
      waterTempC?: number,
      unitId?: string,
    ): void => {
      contextMap.set(batchId, { batchId, avgWeightG, biomassKg, waterTempC, unitId });
    },
  });
}

function getFeedingRateFromCurve(
  feedingCurve: FeedingCurvePoint[] | string | null,
  avgWeightG: number,
): number {
  const defaultRate = 3.0;
  if (!feedingCurve) return defaultRate;

  const curve: FeedingCurvePoint[] =
    typeof feedingCurve === 'string' ? JSON.parse(feedingCurve) : feedingCurve;

  if (!Array.isArray(curve) || curve.length === 0) return defaultRate;

  const sorted = [...curve].sort((a, b) => b.fishWeightG - a.fishWeightG);
  const point = sorted.find((p) => avgWeightG >= p.fishWeightG);

  return point?.feedingRatePercent ?? defaultRate;
}
