/**
 * GetFeedingSummaryHandler
 *
 * GetFeedingSummaryQuery'yi işler ve yemleme özet bilgilerini döner.
 *
 * @module Feeding/QueryHandlers
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { GetFeedingSummaryQuery, FeedingSummaryResult } from '../queries/get-feeding-summary.query';
import { FeedingRecord, FishAppetite } from '../entities/feeding-record.entity';
import { Batch } from '../../batch/entities/batch.entity';
import { Tank } from '../../tank/entities/tank.entity';
import { Feed } from '../../feed/entities/feed.entity';

@Injectable()
@QueryHandler(GetFeedingSummaryQuery)
export class GetFeedingSummaryHandler implements IQueryHandler<GetFeedingSummaryQuery, FeedingSummaryResult> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetFeedingSummaryQuery): Promise<FeedingSummaryResult> {
    const { tenantId, entityType, entityId, fromDate, toDate } = query;

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      // Entity'yi doğrula ve adını al
      let entityName: string;

      if (entityType === 'batch') {
        const batch = await queryRunner.manager.findOne(Batch, {
          where: { id: entityId, tenantId },
        });
        if (!batch) {
          throw new NotFoundException(`Batch ${entityId} bulunamadı`);
        }
        entityName = batch.batchNumber;
      } else {
        const tank = await queryRunner.manager.findOne(Tank, {
          where: { id: entityId, tenantId },
        });
        if (!tank) {
          throw new NotFoundException(`Tank ${entityId} bulunamadı`);
        }
        entityName = tank.name;
      }

      // Query builder oluştur
      const queryBuilder = queryRunner.manager
        .createQueryBuilder(FeedingRecord, 'fr')
        .where('fr.tenantId = :tenantId', { tenantId });

      if (entityType === 'batch') {
        queryBuilder.andWhere('fr.batchId = :entityId', { entityId });
      } else {
        queryBuilder.andWhere('fr.tankId = :entityId', { entityId });
      }

      // Tarih filtresi
      if (fromDate && toDate) {
        queryBuilder.andWhere('fr.feedingDate BETWEEN :from AND :to', {
          from: fromDate,
          to: toDate,
        });
      } else if (fromDate) {
        queryBuilder.andWhere('fr.feedingDate >= :from', { from: fromDate });
      } else if (toDate) {
        queryBuilder.andWhere('fr.feedingDate <= :to', { to: toDate });
      }

      const records = await queryBuilder.getMany();

      // Özet hesaplamaları
      const totalFeedingsCount = records.length;
      const totalPlannedKg = records.reduce((sum, r) => sum + Number(r.plannedAmount), 0);
      const totalActualKg = records.reduce((sum, r) => sum + Number(r.actualAmount), 0);
      const totalVarianceKg = totalActualKg - totalPlannedKg;
      const totalWasteKg = records.reduce((sum, r) => sum + Number(r.wasteAmount || 0), 0);
      const totalFeedCost = records.reduce((sum, r) => sum + Number(r.feedCost || 0), 0);

      // Unique günleri say
      const uniqueDays = new Set(records.map(r => r.feedingDate.toString())).size;
      const avgDailyFeedingKg = uniqueDays > 0 ? totalActualKg / uniqueDays : 0;
      const avgVariancePercent = totalPlannedKg > 0
        ? (totalVarianceKg / totalPlannedKg) * 100
        : 0;

      // Ortalama yemleme süresi
      const durationsWithValue = records.filter(r => r.feedingDurationMinutes);
      const avgFeedingDuration = durationsWithValue.length > 0
        ? durationsWithValue.reduce((sum, r) => sum + (r.feedingDurationMinutes || 0), 0) / durationsWithValue.length
        : 0;

      // İştah dağılımı
      const appetiteDistribution = {
        excellent: 0,
        good: 0,
        moderate: 0,
        poor: 0,
        none: 0,
      };

      for (const record of records) {
        const appetite = record.fishBehavior?.appetite || FishAppetite.MODERATE;
        appetiteDistribution[appetite]++;
      }

      // Yem tipi dağılımı
      const feedMap = new Map<string, { feedId: string; feedName: string; totalKg: number; cost: number }>();
      for (const record of records) {
        const existing = feedMap.get(record.feedId);
        if (existing) {
          existing.totalKg += Number(record.actualAmount);
          existing.cost += Number(record.feedCost || 0);
        } else {
          feedMap.set(record.feedId, {
            feedId: record.feedId,
            feedName: '', // Sonra dolduracağız
            totalKg: Number(record.actualAmount),
            cost: Number(record.feedCost || 0),
          });
        }
      }

      // Batch fetch all feeds to avoid N+1 queries
      const feedIds = Array.from(feedMap.keys());
      const feeds = feedIds.length > 0
        ? await queryRunner.manager.find(Feed, {
            where: { id: In(feedIds), tenantId },
          })
        : [];
      const feedNameMap = new Map(feeds.map(f => [f.id, f.name]));

      // Build feed type distribution using the pre-fetched feed names
      const feedTypeDistribution = [];
      for (const [feedId, data] of feedMap) {
        feedTypeDistribution.push({
          feedId,
          feedName: feedNameMap.get(feedId) || 'Unknown',
          totalKg: data.totalKg,
          percentage: totalActualKg > 0 ? (data.totalKg / totalActualKg) * 100 : 0,
          cost: data.cost,
        });
      }

      // Günlük trend (son 30 gün)
      const dailyMap = new Map<string, { plannedKg: number; actualKg: number }>();
      for (const record of records) {
        const feedingDateStr = record.feedingDate instanceof Date
          ? record.feedingDate.toISOString()
          : String(record.feedingDate);
        const dateKey = feedingDateStr.split('T')[0] || '';
        const existing = dailyMap.get(dateKey);
        if (existing) {
          existing.plannedKg += Number(record.plannedAmount);
          existing.actualKg += Number(record.actualAmount);
        } else {
          dailyMap.set(dateKey, {
            plannedKg: Number(record.plannedAmount),
            actualKg: Number(record.actualAmount),
          });
        }
      }

      const dailyTrend = Array.from(dailyMap.entries())
        .map(([date, data]) => ({
          date,
          plannedKg: data.plannedKg,
          actualKg: data.actualKg,
          variancePercent: data.plannedKg > 0
            ? ((data.actualKg - data.plannedKg) / data.plannedKg) * 100
            : 0,
        }))
        .sort((a, b) => a.date.localeCompare(b.date));

      // Özetlenen dönem: istenen aralık, yoksa kayıtların kendi tarih aralığı.
      const feedingDates = records
        .map((r) => (r.feedingDate instanceof Date ? r.feedingDate : new Date(r.feedingDate)))
        .filter((d) => !Number.isNaN(d.getTime()))
        .sort((a, b) => a.getTime() - b.getTime());
      const startDate = fromDate ?? feedingDates[0] ?? new Date();
      const endDate = toDate ?? feedingDates[feedingDates.length - 1] ?? new Date();

      return {
        entityId,
        entityType,
        entityName,
        startDate,
        endDate,
        totalFeedingsCount,
        totalPlannedKg,
        totalActualKg,
        totalVarianceKg,
        totalWasteKg,
        totalFeedCost,
        avgDailyFeedingKg,
        avgVariancePercent,
        avgFeedingDuration,
        appetiteDistribution,
        feedTypeDistribution,
        dailyTrend,
      };
    });
  }
}
