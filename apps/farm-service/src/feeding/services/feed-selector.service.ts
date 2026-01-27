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
import { BatchFeedAssignment, FeedAssignmentEntry } from '../../batch/entities/batch-feed-assignment.entity';
import { Feed, FeedingCurvePoint, FeedingMatrix2D } from '../../feed/entities/feed.entity';
import { BilinearInterpolationService } from './bilinear-interpolation.service';

export interface FeedSelectionResult {
  feedId: string;
  feedCode: string;
  feedName: string;
  feedingRatePercent: number;
  dailyFeedKg: number;
  fcr?: number;              // FCR (Feed Conversion Ratio)
  usedMatrix2D?: boolean;    // Whether 2D matrix was used
}

@Injectable()
export class FeedSelectorService {
  private readonly logger = new Logger(FeedSelectorService.name);

  constructor(
    @InjectRepository(BatchFeedAssignment)
    private readonly assignmentRepo: Repository<BatchFeedAssignment>,
    @InjectRepository(Feed)
    private readonly feedRepo: Repository<Feed>,
    private readonly bilinearService: BilinearInterpolationService,
  ) {}

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
   * @param batchId Batch ID
   * @param avgWeightG Current average fish weight in grams
   * @param biomassKg Current total biomass in kg
   * @param waterTemperature Optional water temperature in °C for 2D interpolation
   */
  async selectFeedForBatch(
    tenantId: string,
    schemaName: string,
    batchId: string,
    avgWeightG: number,
    biomassKg: number,
    waterTemperature?: number,
  ): Promise<FeedSelectionResult | null> {
    try {
      // 1. Get batch's feed assignments using raw query to ensure correct schema
      const assignmentResult = await this.assignmentRepo.query(
        `SELECT * FROM "${schemaName}".batch_feed_assignments
         WHERE "tenantId" = $1 AND "batchId" = $2 AND "isActive" = true AND "isDeleted" = false
         LIMIT 1`,
        [tenantId, batchId]
      );

      const assignment = assignmentResult?.[0];
      if (!assignment || !assignment.feedAssignments || assignment.feedAssignments.length === 0) {
        this.logger.debug(`No feed assignment found for batch ${batchId}`);
        return null;
      }

      // 2. Parse feed assignments (it's stored as JSONB)
      const feedAssignments = typeof assignment.feedAssignments === 'string'
        ? JSON.parse(assignment.feedAssignments)
        : assignment.feedAssignments;

      // 3. Find matching feed by weight range (sorted by priority)
      const sortedAssignments = [...feedAssignments].sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.minWeightG - b.minWeightG;
      });

      const matchingEntry = sortedAssignments.find(
        (entry: FeedAssignmentEntry) => avgWeightG >= entry.minWeightG && avgWeightG < entry.maxWeightG
      );

      if (!matchingEntry) {
        this.logger.debug(`No feed matches weight ${avgWeightG}g for batch ${batchId}`);
        return null;
      }

      // 4. Load feed entity with feeding curve/matrix
      const feedResult = await this.feedRepo.query(
        `SELECT * FROM "${schemaName}".feeds
         WHERE "id" = $1 AND "tenantId" = $2 AND "isDeleted" = false
         LIMIT 1`,
        [matchingEntry.feedId, tenantId]
      );

      const feed = feedResult?.[0];
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
        ? (typeof feed.feedingMatrix2D === 'string'
            ? JSON.parse(feed.feedingMatrix2D)
            : feed.feedingMatrix2D)
        : null;

      if (matrix2D && waterTemperature !== undefined) {
        // Use 2D bilinear interpolation
        const result = this.bilinearService.interpolate(
          matrix2D,
          waterTemperature,
          avgWeightG,
        );
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
      this.logger.error(`Error selecting feed for batch ${batchId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    }
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
    const curve: FeedingCurvePoint[] = typeof feedingCurve === 'string'
      ? JSON.parse(feedingCurve)
      : feedingCurve;

    if (!Array.isArray(curve) || curve.length === 0) {
      return defaultRate;
    }

    // Sort by fish weight descending and find the first match
    // (the highest weight that's still <= current weight)
    const sortedCurve = [...curve].sort((a, b) => b.fishWeightG - a.fishWeightG);
    const curvePoint = sortedCurve.find(p => avgWeightG >= p.fishWeightG);

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
    const curve: FeedingCurvePoint[] = typeof feedingCurve === 'string'
      ? JSON.parse(feedingCurve)
      : feedingCurve;

    if (!Array.isArray(curve) || curve.length === 0) {
      return undefined;
    }

    // Sort by fish weight descending and find the first match
    const sortedCurve = [...curve].sort((a, b) => b.fishWeightG - a.fishWeightG);
    const curvePoint = sortedCurve.find(p => avgWeightG >= p.fishWeightG);

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
    return Math.round((biomassKg * feedingRatePercent / 100) * 100) / 100;
  }
}
