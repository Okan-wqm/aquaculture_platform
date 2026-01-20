/**
 * GetFeedingSummaryHandler
 *
 * GetFeedingSummaryQuery'yi işler ve yemleme özet bilgilerini döner.
 *
 * @module Feeding/QueryHandlers
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, MoreThanOrEqual, LessThanOrEqual } from 'typeorm';
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
    @InjectRepository(FeedingRecord)
    private readonly feedingRecordRepository: Repository<FeedingRecord>,
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @InjectRepository(Tank)
    private readonly tankRepository: Repository<Tank>,
    @InjectRepository(Feed)
    private readonly feedRepository: Repository<Feed>,
  ) {}

  async execute(query: GetFeedingSummaryQuery): Promise<FeedingSummaryResult> {
    const { tenantId, entityType, entityId, fromDate, toDate } = query;

    // Entity'yi doğrula ve adını al
    let entityName: string;

    if (entityType === 'batch') {
      const batch = await this.batchRepository.findOne({
        where: { id: entityId, tenantId },
      });
      if (!batch) {
        throw new NotFoundException(`Batch ${entityId} bulunamadı`);
      }
      entityName = batch.batchNumber;
    } else {
      const tank = await this.tankRepository.findOne({
        where: { id: entityId, tenantId },
      });
      if (!tank) {
        throw new NotFoundException(`Tank ${entityId} bulunamadı`);
      }
      entityName = tank.name;
    }

    // Query builder oluştur
    const queryBuilder = this.feedingRecordRepository
      .createQueryBuilder('fr')
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
    const feedMap = new Map<string, { feedId: string; feedName: string; totalKg: number }>();
    for (const record of records) {
      const existing = feedMap.get(record.feedId);
      if (existing) {
        existing.totalKg += Number(record.actualAmount);
      } else {
        feedMap.set(record.feedId, {
          feedId: record.feedId,
          feedName: '', // Sonra dolduracağız
          totalKg: Number(record.actualAmount),
        });
      }
    }

    // Feed isimlerini al
    const feedTypeDistribution = [];
    for (const [feedId, data] of feedMap) {
      const feed = await this.feedRepository.findOne({
        where: { id: feedId, tenantId },
      });
      feedTypeDistribution.push({
        feedId,
        feedName: feed?.name || 'Unknown',
        totalKg: data.totalKg,
        percentage: totalActualKg > 0 ? (data.totalKg / totalActualKg) * 100 : 0,
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

    return {
      entityId,
      entityType,
      entityName,
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
  }
}
