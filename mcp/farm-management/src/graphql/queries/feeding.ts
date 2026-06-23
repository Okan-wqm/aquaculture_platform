// ============================================================================
// MCP Farm Intelligence — Feeding (Yemleme) Sorguları
// ============================================================================
//
// Yemleme kayıtları, günlük plan ve özet istatistikleri sorgulayan query'ler.
//
// NEDEN GEREKLİ:
//   - FCR hesaplaması yemleme verilerine dayanır
//   - Yemleme düzensizlikleri anomali tespitinin temel girdisidir
//   - Günlük plan vs gerçekleşen karşılaştırması operasyonel verimlilik gösterir
//   - Yemleme maliyeti toplam üretim maliyetinin ~%50-60'ını oluşturur
//
// GraphQL Endpoint: feedingRecords, feedingSummary, dailyFeedingPlan, activeTanks
// ============================================================================

import type { GraphQLClient } from '../client.js';

// ── Tip Tanımları ──────────────────────────────────────────────────

/**
 * Yemleme kaydı.
 * Planlanan vs gerçekleşen yem miktarı, yöntem ve sapma bilgileri.
 */
export interface FeedingRecord {
  id: string;
  batchId: string;
  tankId?: string;
  feedId: string;
  feedingDate: string;
  feedingTime: string;
  feedingSequence: number;
  totalMealsToday: number;
  plannedAmount: number;
  actualAmount: number;
  wasteAmount?: number;
  feedingMethod: string;
  feedCost?: number;
  notes?: string;
  /** Hesaplanmış alan: actualAmount - plannedAmount */
  variance: number;
  /** Hesaplanmış alan: sapma yüzdesi */
  variancePercent: number;
  /** Hesaplanmış alan: gerçekleşen < planlanan mı? */
  isBelowPlan: boolean;
  /** Hesaplanmış alan: sapma ±%10 içinde mi? */
  isVarianceAcceptable: boolean;
}

/** Yemleme kayıtları sayfalanmış yanıt */
export interface FeedingRecordConnection {
  items: FeedingRecord[];
  total: number;
  hasMore: boolean;
}

/** Yem tipi bazlı özet */
export interface FeedTypeSummary {
  feedId: string;
  feedName: string;
  totalKg: number;
  percentage: number;
  cost: number;
}

/**
 * Yemleme özet istatistikleri.
 * Belirli bir dönem için toplam yem, sapma ve maliyet analizi.
 */
export interface FeedingSummary {
  batchId?: string;
  siteId?: string;
  startDate: string;
  endDate: string;
  totalFeedGivenKg: number;
  totalPlannedKg: number;
  varianceKg: number;
  variancePercent: number;
  totalFeedings: number;
  avgFeedingKg: number;
  totalCost: number;
  currency?: string;
  byFeedType: FeedTypeSummary[];
}

/** Günlük plan içindeki tek bir yemleme görevi */
export interface PlannedFeeding {
  batchId: string;
  batchCode: string;
  tankId?: string;
  tankCode?: string;
  feedId: string;
  feedName: string;
  plannedAmountKg: number;
  actualAmountKg: number;
  mealsPlanned: number;
  mealsCompleted: number;
  isComplete: boolean;
}

/**
 * Günlük yemleme planı.
 * Bir site için o günkü tüm planlanan ve gerçekleşen yemlemelerin özeti.
 */
export interface DailyFeedingPlan {
  date: string;
  siteId: string;
  plannedFeedings: PlannedFeeding[];
  totalPlannedKg: number;
  totalActualKg: number;
  completionPercent: number;
}

/** Yemleme kayıtları filtresi */
export interface FeedingRecordFilter {
  batchId?: string;
  tankId?: string;
  feedId?: string;
  startDate?: string;
  endDate?: string;
  feedingMethod?: string;
}

// ── Sorgular ────────────────────────────────────────────────────────

/**
 * Yemleme kayıtlarını filtreli olarak getirir.
 *
 * Kullanım: Yemleme düzensizliği tespiti, FCR hesaplama girdisi,
 * batch/tank bazlı yemleme geçmişi.
 * Sapma alanları (variance, isBelowPlan) resolver tarafından hesaplanır.
 *
 * @param filter - Filtre parametreleri (batchId, tankId, tarih aralığı)
 * @param page - Sayfa numarası (varsayılan: 1)
 * @param limit - Sayfa başına kayıt (varsayılan: 100, analitik için)
 */
export async function fetchFeedingRecords(
  client: GraphQLClient,
  filter?: FeedingRecordFilter,
  page = 1,
  limit = 100,
): Promise<FeedingRecordConnection> {
  const query = `
    query FeedingRecords($filter: FeedingRecordFilterInput, $pagination: FeedingPaginationInput) {
      feedingRecords(filter: $filter, pagination: $pagination) {
        items {
          id
          batchId
          tankId
          feedId
          feedingDate
          feedingTime
          feedingSequence
          totalMealsToday
          plannedAmount
          actualAmount
          wasteAmount
          feedingMethod
          feedCost
          notes
          variance
          variancePercent
          isBelowPlan
          isVarianceAcceptable
        }
        total
        hasMore
      }
    }
  `;

  const data = await client.query<{ feedingRecords: FeedingRecordConnection }>(query, {
    filter: filter
      ? {
          batchId: filter.batchId ?? null,
          tankId: filter.tankId ?? null,
          feedId: filter.feedId ?? null,
          startDate: filter.startDate ?? null,
          endDate: filter.endDate ?? null,
          feedingMethod: filter.feedingMethod ?? null,
        }
      : null,
    pagination: { page, limit },
  });
  return data.feedingRecords;
}

/**
 * Yemleme özet istatistiklerini getirir.
 *
 * Kullanım: Dönemsel yemleme analizi, maliyet raporu, yem tipi dağılımı.
 * entityType='batch' veya 'tank' olabilir.
 *
 * @param entityType - 'batch' veya 'tank'
 * @param entityId - Batch veya Tank UUID'si
 * @param startDate - Başlangıç tarihi (ISO string, opsiyonel)
 * @param endDate - Bitiş tarihi (ISO string, opsiyonel)
 */
export async function fetchFeedingSummary(
  client: GraphQLClient,
  entityType: 'batch' | 'tank',
  entityId: string,
  startDate?: string,
  endDate?: string,
): Promise<FeedingSummary> {
  const query = `
    query FeedingSummary($entityType: String!, $entityId: ID!, $startDate: DateTime, $endDate: DateTime) {
      feedingSummary(entityType: $entityType, entityId: $entityId, startDate: $startDate, endDate: $endDate) {
        batchId
        siteId
        startDate
        endDate
        totalFeedGivenKg
        totalPlannedKg
        varianceKg
        variancePercent
        totalFeedings
        avgFeedingKg
        totalCost
        currency
        byFeedType {
          feedId
          feedName
          totalKg
          percentage
          cost
        }
      }
    }
  `;

  const data = await client.query<{ feedingSummary: FeedingSummary }>(query, {
    entityType,
    entityId,
    startDate: startDate ?? null,
    endDate: endDate ?? null,
  });
  return data.feedingSummary;
}

/**
 * Günlük yemleme planını getirir.
 *
 * Kullanım: Operasyonel durum kontrolü — hangi batch/tank'a ne kadar
 * yem planlandı ve ne kadarı verildi. Tamamlanma yüzdesi ile.
 *
 * @param siteId - Site UUID'si
 * @param date - Tarih (ISO string, opsiyonel — yoksa bugün)
 */
export async function fetchDailyFeedingPlan(
  client: GraphQLClient,
  siteId: string,
  date?: string,
): Promise<DailyFeedingPlan> {
  const query = `
    query DailyFeedingPlan($siteId: ID!, $date: DateTime) {
      dailyFeedingPlan(siteId: $siteId, date: $date) {
        date
        siteId
        plannedFeedings {
          batchId
          batchCode
          tankId
          tankCode
          feedId
          feedName
          plannedAmountKg
          actualAmountKg
          mealsPlanned
          mealsCompleted
          isComplete
        }
        totalPlannedKg
        totalActualKg
        completionPercent
      }
    }
  `;

  const data = await client.query<{ dailyFeedingPlan: DailyFeedingPlan }>(query, {
    siteId,
    date: date ?? null,
  });
  return data.dailyFeedingPlan;
}
