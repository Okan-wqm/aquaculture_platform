/**
 * FeedSelection DataLoader
 *
 * Batches feed assignment + feed lookups by batchId into bulk IN queries.
 * Uses the same weight-matching logic as FeedSelectorService but in bulk.
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
import { FeedingProtocolRateService } from '../../feed/services/feeding-protocol-rate.service';
import type {
  GrowthStageProtocol,
  TemperatureRange,
} from '../../feed/entities/feeding-protocol.entity';

interface BatchFeedContext {
  batchId: string;
  avgWeightG: number;
  biomassKg: number;
  waterTempC?: number;
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

/** Shape of a batches_v2 row (protocol lookup) as returned by the raw query. */
interface BatchProtocolRow {
  id: string;
  protocolId: string | null;
}

/** Shape of a feeding_protocols row as returned by the raw query. */
interface ProtocolRow {
  id: string;
  name: string | null;
  feedId: string | null;
  growthStageProtocols: GrowthStageProtocol[] | string | null;
  temperatureRanges: TemperatureRange[] | string | null;
}

function parseJsonArray<T>(value: T[] | string | null | undefined): T[] | undefined {
  if (value == null) return undefined;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? (parsed as T[]) : undefined;
}

const protocolRate = new FeedingProtocolRateService();

function parseEntries(value: FeedAssignmentEntry[] | string): FeedAssignmentEntry[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed : [];
}

export function createFeedSelectionLoader(
  repo: Repository<ObjectLiteral>,
): FeedSelectionDataLoader {
  // Store batch context for weight/biomass lookup
  const contextMap = new Map<string, BatchFeedContext>();

  const loader = createTenantScopedDataLoader<string, FeedSelectionRow | null>(
    async (tenantId: string, batchIds: readonly string[]): Promise<(FeedSelectionRow | null)[]> => {
      const schema = getTenantSchemaName(tenantId);

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

      // 2b. Bulk load feeding protocols for batches that carry one — a protocol
      // takes precedence over batch_feed_assignments (it IS the feed driver).
      const batchProtocolRows: BatchProtocolRow[] = await repo.query(
        `SELECT "id", "protocolId" FROM "${schema}".batches_v2
         WHERE "id" = ANY($1::uuid[]) AND "tenantId" = $2 AND "protocolId" IS NOT NULL`,
        [[...batchIds], tenantId],
      );
      const protocolIdByBatch = new Map<string, string>();
      const protocolIdSet = new Set<string>();
      for (const row of batchProtocolRows) {
        if (row.protocolId) {
          protocolIdByBatch.set(row.id, row.protocolId);
          protocolIdSet.add(row.protocolId);
        }
      }

      const protocolMap = new Map<string, ProtocolRow>();
      if (protocolIdSet.size > 0) {
        const protocols: ProtocolRow[] = await repo.query(
          `SELECT "id", "name", "feedId", "growthStageProtocols", "temperatureRanges"
             FROM "${schema}".feeding_protocols
            WHERE "id" = ANY($1::uuid[]) AND "tenantId" = $2
              AND "isActive" = true AND "isDeleted" = false`,
          [[...protocolIdSet], tenantId],
        );
        for (const p of protocols) {
          protocolMap.set(p.id, p);
        }
        // Load feed products the protocols reference (for feedCode/feedName).
        const protocolFeedIds = [
          ...new Set(
            protocols
              .map((p) => p.feedId)
              .filter((id): id is string => id != null && !feedMap.has(id)),
          ),
        ];
        if (protocolFeedIds.length > 0) {
          const protocolFeeds: FeedRow[] = await repo.query(
            `SELECT * FROM "${schema}".feeds
             WHERE "id" = ANY($1::uuid[]) AND "tenantId" = $2 AND "isDeleted" = false`,
            [protocolFeedIds, tenantId],
          );
          for (const feed of protocolFeeds) {
            feedMap.set(feed.id, feed);
          }
        }
      }

      // 3. Resolve each batchId
      return batchIds.map((batchId) => {
        const ctx = contextMap.get(batchId);
        if (!ctx || ctx.avgWeightG <= 0 || ctx.biomassKg <= 0) return null;

        // Protocol precedence: drive the rate from the assigned protocol.
        const protocolId = protocolIdByBatch.get(batchId);
        if (protocolId) {
          const protocol = protocolMap.get(protocolId);
          if (protocol) {
            const rate = protocolRate.calculateRate(
              {
                growthStageProtocols: parseJsonArray(protocol.growthStageProtocols),
                temperatureRanges: parseJsonArray(protocol.temperatureRanges),
              },
              ctx.avgWeightG,
              ctx.waterTempC,
            );
            if (rate) {
              const dailyFeedKg =
                Math.round(((ctx.biomassKg * rate.feedingRatePercent) / 100) * 100) / 100;
              const protocolFeed = protocol.feedId ? feedMap.get(protocol.feedId) : undefined;
              return {
                feedId: protocolFeed?.id ?? '',
                feedCode: protocolFeed?.code ?? '',
                feedName: protocolFeed?.name ?? protocol.name ?? 'Protocol',
                feedingRatePercent: rate.feedingRatePercent,
                dailyFeedKg,
              };
            }
          }
        }

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
      avgWeightG: number,
      biomassKg: number,
      waterTempC?: number,
    ): void => {
      contextMap.set(batchId, { batchId, avgWeightG, biomassKg, waterTempC });
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
