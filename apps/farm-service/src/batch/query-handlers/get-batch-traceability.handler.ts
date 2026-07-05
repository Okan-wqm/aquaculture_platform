/**
 * GetBatchTraceabilityHandler — assembles one batch's lifecycle report (Phase 6).
 *
 * Pure composition over existing SSoTs — no new write model:
 *  - `batch_locations` rows ARE the residency intervals ([movedAt, exitedAt) per tank)
 *  - the event timeline is the existing GetBatchHistoryQuery via the QueryBus
 *    (one assembler, not a second copy of the operation-merge logic)
 *  - feed eaten comes from `feeding_records` (the per-batch attribution table the
 *    FCR SSoT also sums), aggregated in SQL per feed and per residency window
 *  - water temperature per residency is aggregated in SQL over
 *    `water_quality_measurements` for the residency tank + window
 *
 * All reads go through the fail-closed tenant boundary (runInTenantRead).
 *
 * @module Batch/QueryHandlers
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { QueryHandler, IQueryHandler, QueryBus } from '@platform/cqrs';

import { Batch } from '../entities/batch.entity';
import { BatchLocation } from '../entities/batch-location.entity';
import { Tank } from '../../tank/entities/tank.entity';
import { Feed } from '../../feed/entities/feed.entity';
import { FeedingProtocol } from '../../feed/entities/feeding-protocol.entity';
import { FeedingRecord } from '../../feeding/entities/feeding-record.entity';
import { WaterQualityMeasurement } from '../../water-quality/entities/water-quality-measurement.entity';
import { GetBatchHistoryQuery, BatchHistoryEntry } from '../queries/get-batch-history.query';
import {
  GetBatchTraceabilityQuery,
  BatchFeedTotal,
  BatchResidency,
  BatchResidencyWater,
  BatchTraceabilityResult,
} from '../queries/get-batch-traceability.query';

const MS_PER_DAY = 86_400_000;
/** Upper bound for the composed event timeline — a report, not an infinite scroll. */
const EVENT_LIMIT = 500;

interface FeedAggRow {
  feedId: string;
  totalKg: string | null;
  totalCost: string | null;
}

interface WaterAggRow {
  tmin: string | null;
  tavg: string | null;
  tmax: string | null;
  cnt: string;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

@Injectable()
@QueryHandler(GetBatchTraceabilityQuery)
export class GetBatchTraceabilityHandler
  implements IQueryHandler<GetBatchTraceabilityQuery, BatchTraceabilityResult>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly queryBus: QueryBus,
  ) {}

  async execute(query: GetBatchTraceabilityQuery): Promise<BatchTraceabilityResult> {
    const { tenantId, batchId } = query;

    // The event timeline reuses the existing assembler through the bus — one SSoT
    // for how operations become history entries.
    const events: BatchHistoryEntry[] = await this.queryBus.execute(
      new GetBatchHistoryQuery(tenantId, batchId, undefined, undefined, undefined, EVENT_LIMIT),
    );

    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;

      const batch = await manager.findOne(Batch, {
        where: { id: batchId, tenantId },
        relations: { species: true },
      });
      if (!batch) {
        throw new NotFoundException(`Batch ${batchId} bulunamadı`);
      }

      const protocolName = batch.protocolId
        ? (
            await manager.findOne(FeedingProtocol, {
              where: { id: batch.protocolId, tenantId },
            })
          )?.name
        : undefined;

      // ── Residencies ──────────────────────────────────────────────────────
      const locations = await manager.find(BatchLocation, {
        where: { tenantId, batchId },
        order: { movedAt: 'ASC' },
      });
      const containerIds = [
        ...new Set(
          locations.map((l) => l.tankId ?? l.pondId).filter((id): id is string => id != null),
        ),
      ];
      const tanks = containerIds.length
        ? await manager.find(Tank, { where: { id: In(containerIds), tenantId } })
        : [];
      const tankById = new Map(tanks.map((t) => [t.id, t]));

      const now = new Date();
      const residencies: BatchResidency[] = [];
      for (const loc of locations) {
        const containerId = loc.tankId ?? loc.pondId;
        if (!containerId) {
          continue;
        }
        const windowEnd = loc.exitedAt ?? now;
        const [water, feedRows] = await Promise.all([
          this.aggregateWater(manager, tenantId, containerId, loc.movedAt, loc.exitedAt),
          this.aggregateFeed(manager, tenantId, batchId, {
            tankId: containerId,
            fromDate: isoDate(loc.movedAt),
            toDate: loc.exitedAt ? isoDate(loc.exitedAt) : undefined,
          }),
        ]);
        const tank = tankById.get(containerId);
        residencies.push({
          tankId: containerId,
          tankName: tank?.name,
          tankCode: tank?.code,
          movedAt: loc.movedAt,
          exitedAt: loc.exitedAt ?? undefined,
          isCurrent: loc.isCurrentLocation,
          durationDays:
            Math.round(((windowEnd.getTime() - loc.movedAt.getTime()) / MS_PER_DAY) * 10) / 10,
          quantityAtEntry: loc.quantity,
          avgWeightAtEntryG: loc.avgWeight != null ? Number(loc.avgWeight) : undefined,
          transferReason: loc.transferReason ?? undefined,
          water,
          feed: feedRows,
          feedTotalKg: Math.round(feedRows.reduce((s, f) => s + f.totalKg, 0) * 100) / 100,
        });
      }

      // ── Whole-batch feed totals ──────────────────────────────────────────
      const feedTotals = await this.aggregateFeed(manager, tenantId, batchId, {});
      const totalFeedKg = Math.round(feedTotals.reduce((s, f) => s + f.totalKg, 0) * 100) / 100;
      const totalFeedCostRaw = feedTotals.reduce((s, f) => s + (f.totalCost ?? 0), 0);

      // Resolve feed names/codes across every aggregate in one lookup.
      const feedIds = [
        ...new Set([...feedTotals, ...residencies.flatMap((r) => r.feed)].map((f) => f.feedId)),
      ];
      if (feedIds.length) {
        const feeds = await manager.find(Feed, { where: { id: In(feedIds), tenantId } });
        const feedById = new Map(feeds.map((f) => [f.id, f]));
        for (const agg of [...feedTotals, ...residencies.flatMap((r) => r.feed)]) {
          const feed = feedById.get(agg.feedId);
          agg.feedName = feed?.name;
          agg.feedCode = feed?.code;
        }
      }

      const harvestedAt = batch.actualHarvestDate ?? undefined;
      const endOfProduction = harvestedAt ? new Date(harvestedAt) : now;

      return {
        summary: {
          batchId: batch.id,
          batchNumber: batch.batchNumber,
          status: batch.status,
          speciesName: batch.species?.commonName ?? batch.species?.scientificName,
          stockedAt: batch.createdAt,
          harvestedAt,
          daysInProduction: Math.max(
            0,
            Math.floor((endOfProduction.getTime() - batch.createdAt.getTime()) / MS_PER_DAY),
          ),
          initialQuantity: batch.initialQuantity,
          currentQuantity: batch.currentQuantity,
          initialAvgWeightG: batch.weight?.initial?.avgWeight,
          currentAvgWeightG:
            batch.weight?.actual?.avgWeight ?? batch.weight?.theoretical?.avgWeight,
          survivalRatePercent:
            batch.initialQuantity > 0
              ? Math.round((batch.currentQuantity / batch.initialQuantity) * 1000) / 10
              : undefined,
          protocolId: batch.protocolId ?? undefined,
          protocolName,
          totalFeedKg,
          totalFeedCost: totalFeedCostRaw > 0 ? Math.round(totalFeedCostRaw * 100) / 100 : undefined,
          fcrActual: batch.fcr?.actual ?? undefined,
        },
        residencies,
        feedTotals,
        events,
      };
    });
  }

  /** SUM(actualAmount)/SUM(feedCost) per feed for the batch, optionally windowed to one residency. */
  private async aggregateFeed(
    manager: EntityManager,
    tenantId: string,
    batchId: string,
    window: { tankId?: string; fromDate?: string; toDate?: string },
  ): Promise<BatchFeedTotal[]> {
    let qb = manager
      .createQueryBuilder(FeedingRecord, 'fr')
      .select('fr.feedId', 'feedId')
      .addSelect('SUM(fr.actualAmount)', 'totalKg')
      .addSelect('SUM(fr.feedCost)', 'totalCost')
      .where('fr.tenantId = :tenantId', { tenantId })
      .andWhere('fr.batchId = :batchId', { batchId })
      .groupBy('fr.feedId');
    if (window.tankId) {
      qb = qb.andWhere('fr.tankId = :tankId', { tankId: window.tankId });
    }
    if (window.fromDate) {
      qb = qb.andWhere('fr.feedingDate >= :fromDate', { fromDate: window.fromDate });
    }
    if (window.toDate) {
      qb = qb.andWhere('fr.feedingDate <= :toDate', { toDate: window.toDate });
    }
    const rows: FeedAggRow[] = await qb.getRawMany();
    return rows.map((r) => ({
      feedId: r.feedId,
      totalKg: Math.round(Number(r.totalKg ?? 0) * 100) / 100,
      totalCost: r.totalCost != null ? Math.round(Number(r.totalCost) * 100) / 100 : undefined,
    }));
  }

  /** MIN/AVG/MAX temperature over the residency window for the tank. */
  private async aggregateWater(
    manager: EntityManager,
    tenantId: string,
    containerId: string,
    from: Date,
    to: Date | null | undefined,
  ): Promise<BatchResidencyWater> {
    let qb = manager
      .createQueryBuilder(WaterQualityMeasurement, 'm')
      .select('MIN(m.temperature)', 'tmin')
      .addSelect('AVG(m.temperature)', 'tavg')
      .addSelect('MAX(m.temperature)', 'tmax')
      .addSelect('COUNT(m.id)', 'cnt')
      .where('m.tenantId = :tenantId', { tenantId })
      .andWhere('(m.tankId = :cid OR m.equipmentId = :cid)', { cid: containerId })
      .andWhere('m.temperature IS NOT NULL')
      .andWhere('m.measuredAt >= :from', { from });
    if (to) {
      qb = qb.andWhere('m.measuredAt < :to', { to });
    }
    const row: WaterAggRow | undefined = await qb.getRawOne();
    const count = Number(row?.cnt ?? 0);
    return {
      temperatureMinC: row?.tmin != null ? Math.round(Number(row.tmin) * 10) / 10 : undefined,
      temperatureAvgC: row?.tavg != null ? Math.round(Number(row.tavg) * 10) / 10 : undefined,
      temperatureMaxC: row?.tmax != null ? Math.round(Number(row.tmax) * 10) / 10 : undefined,
      measurementCount: count,
    };
  }
}
