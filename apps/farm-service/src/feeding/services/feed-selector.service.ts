/**
 * Feed Selector Service
 *
 * Auto-selects the correct feed for a batch based on current fish weight.
 * Uses BatchFeedAssignment to determine weight ranges and Feed.feedingCurve
 * or Feed.feedingMatrix2D to get the feeding rate percentage.
 *
 * Supports:
 * - 1D feeding curve (weight only) - legacy
 * - 2D feeding matrix (temperature x weight) with bilinear interpolation
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  BatchFeedAssignment,
  FeedAssignmentEntry,
} from '../../batch/entities/batch-feed-assignment.entity';
import { Feed, FeedingCurvePoint, FeedingMatrix2D } from '../../feed/entities/feed.entity';
import { BilinearInterpolationService } from './bilinear-interpolation.service';
import { UnitProtocolResolverService } from '../../feeding-protocol/services/unit-protocol-resolver.service';
import type { BandWeightG } from '../../feeding-protocol/services/protocol-rate.service';

export interface FeedSelectionResult {
  feedId: string;
  feedCode: string;
  feedName: string;
  feedingRatePercent: number;
  dailyFeedKg: number;
  fcr?: number; // FCR (Feed Conversion Ratio)
  usedMatrix2D?: boolean; // Whether 2D matrix was used
}

interface CachedFeedData {
  assignments: FeedAssignmentEntry[];
  feeds: Map<string, any>; // feedId -> feed row
}

/** Max cache entries before eviction */
const FEED_CACHE_MAX_SIZE = 500;
/** Cache TTL in milliseconds (5 minutes) */
const FEED_CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  data: CachedFeedData;
  expiresAt: number;
}

@Injectable()
export class FeedSelectorService {
  private readonly logger = new Logger(FeedSelectorService.name);
  private readonly feedCache = new Map<string, CacheEntry>();

  constructor(
    @InjectRepository(BatchFeedAssignment)
    private readonly assignmentRepo: Repository<BatchFeedAssignment>,
    @InjectRepository(Feed)
    private readonly feedRepo: Repository<Feed>,
    private readonly bilinearService: BilinearInterpolationService,
    // Protocol lookup + rate SSoT (unit-keyed). The same instance the tanks-page
    // DataLoader and the legacy daily-plan engine use, so "current feed" on a
    // tank cannot disagree with the plan generated for it.
    private readonly unitProtocol: UnitProtocolResolverService,
  ) {}

  /**
   * Preload all feed assignment and feed data for a batch into memory cache.
   * Call this once before a simulation loop to avoid N queries per day.
   * Reduces batch queries from 2*N (N=days) to just 2 total.
   */
  async preloadFeedDataForBatch(
    tenantId: string,
    schemaName: string,
    batchId: string,
  ): Promise<void> {
    const cacheKey = `${tenantId}:${batchId}`;
    const existing = this.feedCache.get(cacheKey);
    if (existing && existing.expiresAt > Date.now()) {
      return; // Already cached and not expired
    }

    try {
      // 1. Load feed assignments (single query)
      const assignmentResult = await this.assignmentRepo.query(
        `SELECT * FROM "${schemaName}".batch_feed_assignments
         WHERE "tenantId" = $1 AND "batchId" = $2 AND "isActive" = true AND "isDeleted" = false
         LIMIT 1`,
        [tenantId, batchId],
      );

      const assignment = assignmentResult?.[0];
      if (!assignment || !assignment.feedAssignments || assignment.feedAssignments.length === 0) {
        this.setCacheEntry(cacheKey, { assignments: [], feeds: new Map() });
        return;
      }

      const feedAssignments: FeedAssignmentEntry[] =
        typeof assignment.feedAssignments === 'string'
          ? JSON.parse(assignment.feedAssignments)
          : assignment.feedAssignments;

      // 2. Load all referenced feeds in a single query
      const feedIds = [...new Set(feedAssignments.map((a) => a.feedId))];
      const feeds = new Map<string, any>();

      if (feedIds.length > 0) {
        const placeholders = feedIds.map((_, i) => `$${i + 3}`).join(', ');
        const feedResults = await this.feedRepo.query(
          `SELECT * FROM "${schemaName}".feeds
           WHERE "id" IN (${placeholders}) AND "tenantId" = $1 AND "isDeleted" = false`,
          [tenantId, ...feedIds],
        );
        for (const feed of feedResults) {
          feeds.set(feed.id, feed);
        }
      }

      this.setCacheEntry(cacheKey, { assignments: feedAssignments, feeds });
      this.logger.debug(
        `Preloaded feed data for batch ${batchId}: ${feedAssignments.length} assignments, ${feeds.size} feeds`,
      );
    } catch (error: unknown) {
      this.logger.error(
        `Error preloading feed data for batch ${batchId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      this.setCacheEntry(cacheKey, { assignments: [], feeds: new Map() });
    }
  }

  /**
   * Set a cache entry with TTL and evict oldest entries if over max size.
   */
  private setCacheEntry(key: string, data: CachedFeedData): void {
    // Evict expired entries periodically
    if (this.feedCache.size >= FEED_CACHE_MAX_SIZE) {
      const now = Date.now();
      for (const [k, v] of this.feedCache) {
        if (v.expiresAt < now) {
          this.feedCache.delete(k);
        }
      }
      // If still over limit, evict oldest entries
      if (this.feedCache.size >= FEED_CACHE_MAX_SIZE) {
        const keysToDelete = [...this.feedCache.keys()].slice(
          0,
          Math.floor(FEED_CACHE_MAX_SIZE / 4),
        );
        for (const k of keysToDelete) {
          this.feedCache.delete(k);
        }
      }
    }
    this.feedCache.set(key, { data, expiresAt: Date.now() + FEED_CACHE_TTL_MS });
  }

  /**
   * Get cached data if not expired.
   */
  private getCacheEntry(key: string): CachedFeedData | undefined {
    const entry = this.feedCache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.feedCache.delete(key);
      return undefined;
    }
    return entry.data;
  }

  /**
   * Clear cached feed data (call after simulation completes)
   */
  clearCache(tenantId?: string, batchId?: string): void {
    if (tenantId && batchId) {
      this.feedCache.delete(`${tenantId}:${batchId}`);
    } else {
      this.feedCache.clear();
    }
  }

  /**
   * Select the correct feed for a batch based on current fish weight
   * Returns the feed info + calculated daily feed amount
   *
   * Supports both 1D (weight only) and 2D (temperature x weight) feeding curves.
   * When waterTemperature is provided and the feed has a feedingMatrix2D,
   * bilinear interpolation is used for more accurate rate calculation.
   *
   * @param tenantId Tenant ID
   * @param schemaName Tenant schema name
   * @param batchId Batch ID — keys the batch_feed_assignments fallback only
   * @param unitId `Equipment.id` of the tank/pond/cage holding the fish, or
   *   null when the caller genuinely has no unit (a hypothetical projection).
   *   REQUIRED, not optional: protocol authority is unit-scoped, and an
   *   optional parameter would let a caller silently lose its protocol by
   *   forgetting an argument. The compiler now makes that omission impossible.
   * @param avgWeightG UNIT-authoritative average weight in grams — see
   *   `BandWeightG`; a batch-scoped weight is a compile error.
   * @param biomassKg Current total biomass in kg
   * @param waterTemperature Optional water temperature in °C for 2D interpolation
   */
  async selectFeedForBatch(
    tenantId: string,
    schemaName: string,
    batchId: string,
    unitId: string | null,
    avgWeightG: BandWeightG,
    biomassKg: number,
    waterTemperature?: number,
  ): Promise<FeedSelectionResult | null> {
    try {
      // Protocol takes precedence: a unit with an active protocol assignment
      // drives its rate from the protocol band × temperature multiplier × unit
      // override, not from the BatchFeedAssignment + Feed matrix. Falls through
      // when the unit has no assignment or the protocol has no matching band.
      const protocolResult = unitId
        ? await this.selectFeedFromProtocol(
            tenantId,
            unitId,
            avgWeightG,
            biomassKg,
            waterTemperature,
          )
        : null;
      if (protocolResult) {
        return protocolResult;
      }

      // Check cache first (populated by preloadFeedDataForBatch)
      const cacheKey = `${tenantId}:${batchId}`;
      const cached = this.getCacheEntry(cacheKey);

      let feedAssignments: FeedAssignmentEntry[];
      let feedLookup: (feedId: string) => Promise<any>;

      if (cached) {
        // Use cached data - zero queries
        feedAssignments = cached.assignments;
        feedLookup = async (feedId: string) => cached.feeds.get(feedId) ?? null;
      } else {
        // Fallback: query DB directly (uncached path)
        const assignmentResult = await this.assignmentRepo.query(
          `SELECT * FROM "${schemaName}".batch_feed_assignments
           WHERE "tenantId" = $1 AND "batchId" = $2 AND "isActive" = true AND "isDeleted" = false
           LIMIT 1`,
          [tenantId, batchId],
        );

        const assignment = assignmentResult?.[0];
        if (!assignment || !assignment.feedAssignments || assignment.feedAssignments.length === 0) {
          this.logger.debug(`No feed assignment found for batch ${batchId}`);
          return null;
        }

        feedAssignments =
          typeof assignment.feedAssignments === 'string'
            ? JSON.parse(assignment.feedAssignments)
            : assignment.feedAssignments;

        feedLookup = async (feedId: string) => {
          const feedResult = await this.feedRepo.query(
            `SELECT * FROM "${schemaName}".feeds
             WHERE "id" = $1 AND "tenantId" = $2 AND "isDeleted" = false
             LIMIT 1`,
            [feedId, tenantId],
          );
          return feedResult?.[0] ?? null;
        };
      }

      if (feedAssignments.length === 0) {
        this.logger.debug(`No feed assignment found for batch ${batchId}`);
        return null;
      }

      // Find matching feed by weight range (sorted by priority)
      const sortedAssignments = [...feedAssignments].sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.minWeightG - b.minWeightG;
      });

      const matchingEntry = sortedAssignments.find(
        (entry: FeedAssignmentEntry) =>
          avgWeightG >= entry.minWeightG && avgWeightG < entry.maxWeightG,
      );

      if (!matchingEntry) {
        this.logger.debug(`No feed matches weight ${avgWeightG}g for batch ${batchId}`);
        return null;
      }

      // Load feed entity (from cache or DB)
      const feed = await feedLookup(matchingEntry.feedId);
      if (!feed) {
        this.logger.warn(`Feed ${matchingEntry.feedId} not found for batch ${batchId}`);
        return null;
      }

      // 5. Get feeding rate - use 2D matrix if available and temperature provided
      let feedingRatePercent: number;
      let fcr: number | undefined;
      let usedMatrix2D = false;

      // Parse feedingMatrix2D if it's a string
      const matrix2D: FeedingMatrix2D | null = feed.feedingMatrix2D
        ? typeof feed.feedingMatrix2D === 'string'
          ? JSON.parse(feed.feedingMatrix2D)
          : feed.feedingMatrix2D
        : null;

      if (matrix2D && waterTemperature !== undefined) {
        // Use 2D bilinear interpolation
        const result = this.bilinearService.interpolate(matrix2D, waterTemperature, avgWeightG);
        feedingRatePercent = result.feedingRatePercent;
        fcr = result.fcr;
        usedMatrix2D = true;

        this.logger.debug(
          `2D interpolation: temp=${waterTemperature}°C, weight=${avgWeightG}g -> rate=${feedingRatePercent}%` +
            (fcr ? `, fcr=${fcr}` : ''),
        );
      } else {
        // Fallback to 1D curve
        feedingRatePercent = this.getFeedingRateFromCurve(feed.feedingCurve, avgWeightG);
        fcr = this.getFCRFromCurve(feed.feedingCurve, avgWeightG);
      }

      // 6. Calculate daily feed amount
      const dailyFeedKg = this.calculateDailyFeed(biomassKg, feedingRatePercent);

      return {
        feedId: feed.id,
        feedCode: feed.code,
        feedName: feed.name,
        feedingRatePercent,
        dailyFeedKg,
        fcr,
        usedMatrix2D,
      };
    } catch (error: unknown) {
      this.logger.error(
        `Error selecting feed for batch ${batchId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return null;
    }
  }

  /**
   * Resolve the feed + rate for a UNIT from its active protocol assignment.
   * Returns null (caller falls through to the batch_feed_assignments path) when
   * the unit has no active assignment or the protocol carries no band for this
   * weight.
   *
   * WHY unit-keyed: the previous implementation read `batches_v2.protocolId`
   * and joined the v1 `feeding_protocols` table. That column had no writer
   * anywhere in the repo, so this branch could only ever return null — the feed
   * product and rate shown next to a tank came from the feed matrix while the
   * v2 engine planned that same tank from its assignment band. Authority is
   * `feeding_protocol_assignments.unitId` (one active row per unit, enforced by
   * a partial unique index), which is also the domain truth: the tank owns the
   * band, the batch is traceability.
   *
   * WHY no `fcr`: the band carries an `expectedFcr`, but the honest FCR answer
   * is `ProtocolRateService.resolveExpectedFcr` (override → matrix → band),
   * which needs the protocol and feed FCR matrices this caller does not load.
   * Reporting the band scalar as "the FCR" would be a quieter lie than leaving
   * it undefined, which is exactly what the v1 path did.
   */
  private async selectFeedFromProtocol(
    tenantId: string,
    unitId: string,
    avgWeightG: BandWeightG,
    biomassKg: number,
    waterTemperature?: number,
  ): Promise<FeedSelectionResult | null> {
    const resolved = await this.unitProtocol.resolveForUnit(
      this.assignmentRepo,
      tenantId,
      unitId,
      avgWeightG,
      // No reading → null; a fabricated temperature must never scale the rate.
      waterTemperature ?? null,
    );
    if (!resolved) {
      return null;
    }

    return {
      // The feed product is denormalized onto the band, so there is no second
      // `feeds` lookup and no way for the label to disagree with the plan.
      feedId: resolved.feedId,
      feedCode: resolved.feedCode,
      feedName: resolved.feedName,
      feedingRatePercent: resolved.effectiveRatePercent,
      dailyFeedKg: this.calculateDailyFeed(biomassKg, resolved.effectiveRatePercent),
      usedMatrix2D: false,
    };
  }

  /**
   * Get feeding rate percentage from feed's feeding curve
   * Finds the curve point that matches the fish weight
   */
  private getFeedingRateFromCurve(
    feedingCurve: FeedingCurvePoint[] | string | null,
    avgWeightG: number,
  ): number {
    // Default feeding rate if no curve
    const defaultRate = 3.0;

    if (!feedingCurve) {
      return defaultRate;
    }

    // Parse if string
    const curve: FeedingCurvePoint[] =
      typeof feedingCurve === 'string' ? JSON.parse(feedingCurve) : feedingCurve;

    if (!Array.isArray(curve) || curve.length === 0) {
      return defaultRate;
    }

    // Sort by fish weight descending and find the first match
    // (the highest weight that's still <= current weight)
    const sortedCurve = [...curve].sort((a, b) => b.fishWeightG - a.fishWeightG);
    const curvePoint = sortedCurve.find((p) => avgWeightG >= p.fishWeightG);

    return curvePoint?.feedingRatePercent ?? defaultRate;
  }

  /**
   * Get FCR from feed's feeding curve (1D)
   * Returns undefined if no curve or no FCR data
   */
  private getFCRFromCurve(
    feedingCurve: FeedingCurvePoint[] | string | null,
    avgWeightG: number,
  ): number | undefined {
    if (!feedingCurve) {
      return undefined;
    }

    // Parse if string
    const curve: FeedingCurvePoint[] =
      typeof feedingCurve === 'string' ? JSON.parse(feedingCurve) : feedingCurve;

    if (!Array.isArray(curve) || curve.length === 0) {
      return undefined;
    }

    // Sort by fish weight descending and find the first match
    const sortedCurve = [...curve].sort((a, b) => b.fishWeightG - a.fishWeightG);
    const curvePoint = sortedCurve.find((p) => avgWeightG >= p.fishWeightG);

    return curvePoint?.fcr;
  }

  /**
   * Calculate daily feed amount
   * Formula: dailyFeedKg = biomassKg * (feedingRatePercent / 100)
   */
  calculateDailyFeed(biomassKg: number, feedingRatePercent: number): number {
    if (!biomassKg || !feedingRatePercent) {
      return 0;
    }
    // Round to 2 decimal places
    return Math.round(((biomassKg * feedingRatePercent) / 100) * 100) / 100;
  }
}
