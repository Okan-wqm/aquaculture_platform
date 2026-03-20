/**
 * FeedSelection DataLoader
 *
 * Batches feed assignment + feed lookups by batchId into bulk IN queries.
 * Uses the same weight-matching logic as FeedSelectorService but in bulk.
 */
import DataLoader from 'dataloader';
import { Repository } from 'typeorm';
import { FeedSelectionRow } from '../../common/types/graphql-context.types';

interface BatchFeedContext {
  batchId: string;
  avgWeightG: number;
  biomassKg: number;
}

interface FeedingCurvePoint {
  fishWeightG: number;
  feedingRatePercent: number;
}

export function createFeedSelectionLoader(
  repo: Repository<any>,
  tenantId: string,
  schema: string,
): DataLoader<string, FeedSelectionRow | null> {
  // Store batch context for weight/biomass lookup
  const contextMap = new Map<string, BatchFeedContext>();

  const batchFn = async (batchIds: readonly string[]): Promise<(FeedSelectionRow | null)[]> => {
    // 1. Bulk load all feed assignments
    const assignments = await repo.query(
      `SELECT * FROM "${schema}".batch_feed_assignments
       WHERE "tenantId" = $1 AND "batchId" = ANY($2::uuid[])
       AND "isActive" = true AND "isDeleted" = false`,
      [tenantId, [...batchIds]],
    );

    // Group assignments by batchId
    const assignmentMap = new Map<string, any>();
    const feedIdSet = new Set<string>();

    for (const a of assignments) {
      assignmentMap.set(a.batchId, a);
      const entries = typeof a.feedAssignments === 'string'
        ? JSON.parse(a.feedAssignments)
        : a.feedAssignments;
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          feedIdSet.add(entry.feedId);
        }
      }
    }

    // 2. Bulk load all referenced feeds
    const feedMap = new Map<string, any>();
    const feedIds = [...feedIdSet];
    if (feedIds.length > 0) {
      const feeds = await repo.query(
        `SELECT * FROM "${schema}".feeds
         WHERE "id" = ANY($1::uuid[]) AND "tenantId" = $2 AND "isDeleted" = false`,
        [feedIds, tenantId],
      );
      for (const feed of feeds) {
        feedMap.set(feed.id, feed);
      }
    }

    // 3. Resolve each batchId
    return batchIds.map(batchId => {
      const assignment = assignmentMap.get(batchId);
      if (!assignment) return null;

      const ctx = contextMap.get(batchId);
      if (!ctx || ctx.avgWeightG <= 0 || ctx.biomassKg <= 0) return null;

      const entries = typeof assignment.feedAssignments === 'string'
        ? JSON.parse(assignment.feedAssignments)
        : assignment.feedAssignments;

      if (!Array.isArray(entries) || entries.length === 0) return null;

      // Find matching feed by weight range
      const sorted = [...entries].sort((a: any, b: any) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.minWeightG - b.minWeightG;
      });

      const match = sorted.find(
        (e: any) => ctx.avgWeightG >= e.minWeightG && ctx.avgWeightG < e.maxWeightG,
      );

      if (!match) return null;

      const feed = feedMap.get(match.feedId);
      if (!feed) return null;

      // Get feeding rate from curve
      const feedingRatePercent = getFeedingRateFromCurve(feed.feedingCurve, ctx.avgWeightG);
      const dailyFeedKg = Math.round((ctx.biomassKg * feedingRatePercent / 100) * 100) / 100;

      return {
        feedId: feed.id,
        feedCode: feed.code,
        feedName: feed.name,
        feedingRatePercent,
        dailyFeedKg,
      };
    });
  };

  const loader = new DataLoader(batchFn, { maxBatchSize: 100 });

  // Expose method to set batch context before loading
  (loader as any).setContext = (batchId: string, avgWeightG: number, biomassKg: number) => {
    contextMap.set(batchId, { batchId, avgWeightG, biomassKg });
  };

  return loader;
}

function getFeedingRateFromCurve(
  feedingCurve: FeedingCurvePoint[] | string | null,
  avgWeightG: number,
): number {
  const defaultRate = 3.0;
  if (!feedingCurve) return defaultRate;

  const curve: FeedingCurvePoint[] = typeof feedingCurve === 'string'
    ? JSON.parse(feedingCurve)
    : feedingCurve;

  if (!Array.isArray(curve) || curve.length === 0) return defaultRate;

  const sorted = [...curve].sort((a, b) => b.fishWeightG - a.fishWeightG);
  const point = sorted.find(p => avgWeightG >= p.fishWeightG);

  return point?.feedingRatePercent ?? defaultRate;
}
