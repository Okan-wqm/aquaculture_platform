/**
 * GetFeedingSummaryQuery
 *
 * Batch veya tank için yemleme özet bilgilerini getirir.
 *
 * @module Feeding/Queries
 */
import type { TenantScope } from '@aquaculture/backend-common/database';

/**
 * Yemleme özet sonucu
 */
export interface FeedingSummaryResult {
  entityId: string;
  entityType: 'batch' | 'tank';
  entityName: string;

  // Özetlenen dönem (istenen aralık, yoksa verinin kendi aralığı)
  startDate: Date;
  endDate: Date;

  // Toplam değerler
  totalFeedingsCount: number;
  totalPlannedKg: number;
  totalActualKg: number;
  totalVarianceKg: number;
  totalWasteKg: number;
  totalFeedCost: number;

  // Ortalamalar
  avgDailyFeedingKg: number;
  avgVariancePercent: number;
  avgFeedingDuration: number;

  // İştah dağılımı
  appetiteDistribution: {
    excellent: number;
    good: number;
    moderate: number;
    poor: number;
    none: number;
  };

  // Yem tipi dağılımı
  feedTypeDistribution: {
    feedId: string;
    feedName: string;
    totalKg: number;
    percentage: number;
    cost: number;
  }[];

  // Tarihsel trend (son 7/30 gün)
  dailyTrend: {
    date: string;
    plannedKg: number;
    actualKg: number;
    variancePercent: number;
  }[];
}

export class GetFeedingSummaryQuery {
  readonly queryName = 'GetFeedingSummaryQuery';

  constructor(
    public readonly scope: TenantScope,
    public readonly entityType: 'batch' | 'tank',
    public readonly entityId: string,
    public readonly fromDate?: Date,
    public readonly toDate?: Date,
  ) {}
}
