/**
 * GetFeedingSummaryQuery
 *
 * Batch veya tank için yemleme özet bilgilerini getirir.
 *
 * @module Feeding/Queries
 */
import { ITenantQuery } from '@platform/cqrs';

/**
 * Yemleme özet sonucu
 */
export interface FeedingSummaryResult {
  entityId: string;
  entityType: 'batch' | 'tank';
  entityName: string;

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
  }[];

  // Tarihsel trend (son 7/30 gün)
  dailyTrend: {
    date: string;
    plannedKg: number;
    actualKg: number;
    variancePercent: number;
  }[];
}

export class GetFeedingSummaryQuery implements ITenantQuery {
  readonly queryName = 'GetFeedingSummaryQuery';

  constructor(
    public readonly tenantId: string,
    public readonly entityType: 'batch' | 'tank',
    public readonly entityId: string,
    public readonly fromDate?: Date,
    public readonly toDate?: Date,
  ) {}
}
