// ============================================================================
// MCP Farm Intelligence — Growth (Büyüme) Sorguları
// ============================================================================
//
// Büyüme ölçümleri ve büyüme analizini sorgulayan GraphQL query'leri.
//
// NEDEN GEREKLİ:
//   - SGR (Spesifik Büyüme Oranı) anomali tespitinin temel parametresidir
//   - Büyüme trendi anormal değişimler gösteriyorsa alarm tetiklenir
//   - Hasat tarihi projeksiyonu büyüme verilerine dayanır
//   - Ağırlık CV (varyasyon katsayısı) grading gereksinimini belirler
//
// GraphQL Endpoint: growthMeasurements, growthAnalysis, latestGrowthMeasurement, batchGrowthHistory
// ============================================================================

import type { GraphQLClient } from '../client.js';

// ── Tip Tanımları ──────────────────────────────────────────────────

/**
 * Büyüme ölçümü.
 * Numune ağırlıkları, istatistikler ve hesaplanmış büyüme oranları.
 */
export interface GrowthMeasurement {
  id: string;
  batchId: string;
  tankId?: string;
  measurementDate: string;
  measurementType: string;
  measurementMethod: string;
  sampleSize: number;
  populationSize: number;
  averageWeight: number;
  weightCV: number;
  estimatedBiomass: number;
  /** Hesaplanmış alan: numune oranı (%) */
  samplePercent: number;
  /** Hesaplanmış alan: homojen büyüme mi (CV < %20)? */
  isUniformGrowth: boolean;
  /** Hesaplanmış alan: grading gerekli mi (CV > %25)? */
  needsGrading: boolean;
  /** Hesaplanmış alan: günlük büyüme hızı (g/gün) */
  dailyGrowthRate?: number;
  /** Hesaplanmış alan: spesifik büyüme oranı (SGR) */
  specificGrowthRate?: number;
  /** Hesaplanmış alan: dönem FCR */
  periodFCR?: number;
  /** Hesaplanmış alan: hedefte mi? */
  isOnTarget: boolean;
  notes?: string;
}

/** Büyüme ölçümleri sayfalanmış yanıt */
export interface GrowthMeasurementConnection {
  items: GrowthMeasurement[];
  total: number;
  hasMore: boolean;
}

/** Büyüme metrikleri — mevcut durum özeti */
export interface GrowthMetrics {
  currentAvgWeightG: number;
  theoreticalWeightG: number;
  weightVariancePercent: number;
  currentBiomassKg: number;
  currentQuantity: number;
  survivalRate: number;
  mortalityRate: number;
  currentFCR: number;
  targetFCR: number;
  fcrVariancePercent: number;
  dailyGrowthRateG: number;
  specificGrowthRate: number;
  weightCV: number;
  performanceRating: string;
}

/** Büyüme trendi — son 7/30 gün karşılaştırması */
export interface GrowthTrend {
  direction: string;
  avgDailyGrowthLast7Days: number;
  avgDailyGrowthLast30Days: number;
  growthAcceleration: number;
  fcrTrend: string;
  fcrChangeLast7Days: number;
}

/** Büyüme projeksiyonu — hasat tahmini */
export interface GrowthProjection {
  projectedWeightIn30Days: number;
  projectedBiomassIn30Days: number;
  estimatedHarvestDate: string;
  harvestTargetWeightG: number;
  daysToHarvest: number;
  projectedTotalFeedKg: number;
  projectedFinalFCR: number;
}

/** Büyüme önerisi */
export interface GrowthRecommendation {
  priority: string;
  type: string;
  description: string;
  reason: string;
  actionRequired?: string;
}

/** Ölçüm geçmişi özet satırı */
export interface GrowthMeasurementSummary {
  id: string;
  measurementDate: string;
  averageWeight: number;
  weightCV: number;
  sampleSize: number;
  estimatedBiomass: number;
  dailyGrowthRate?: number;
  periodFCR?: number;
  performance?: string;
}

/**
 * Büyüme analizi — kapsamlı batch büyüme raporu.
 * Mevcut metrikler, trend, projeksiyon ve öneriler tek yanıtta.
 */
export interface GrowthAnalysis {
  batchId: string;
  batchCode: string;
  speciesName: string;
  analysisDate: string;
  daysInProduction: number;
  currentMetrics: GrowthMetrics;
  trend: GrowthTrend;
  projection: GrowthProjection;
  recommendations: GrowthRecommendation[];
  measurementHistory: GrowthMeasurementSummary[];
}

/** Büyüme ölçümü filtresi */
export interface GrowthMeasurementFilter {
  batchId?: string;
  tankId?: string;
  measurementType?: string;
  startDate?: string;
  endDate?: string;
  verifiedOnly?: boolean;
}

// ── Sorgular ────────────────────────────────────────────────────────

/**
 * Büyüme ölçümlerini filtreli olarak getirir.
 *
 * Kullanım: Ölçüm geçmişi analizi, büyüme grafiği verisi,
 * ölçümler arası karşılaştırma.
 *
 * @param filter - Filtre parametreleri (batchId, tankId, tarih aralığı)
 * @param limit - Maksimum kayıt sayısı (varsayılan: 100)
 */
export async function fetchGrowthMeasurements(
  client: GraphQLClient,
  filter?: GrowthMeasurementFilter,
  limit = 100,
): Promise<GrowthMeasurementConnection> {
  const query = `
    query GrowthMeasurements($filter: GrowthMeasurementFilterInput, $pagination: GrowthPaginationInput) {
      growthMeasurements(filter: $filter, pagination: $pagination) {
        items {
          id
          batchId
          tankId
          measurementDate
          measurementType
          measurementMethod
          sampleSize
          populationSize
          averageWeight
          weightCV
          estimatedBiomass
          samplePercent
          isUniformGrowth
          needsGrading
          dailyGrowthRate
          specificGrowthRate
          periodFCR
          isOnTarget
          notes
        }
        total
        hasMore
      }
    }
  `;

  const data = await client.query<{ growthMeasurements: GrowthMeasurementConnection }>(query, {
    filter: filter
      ? {
          batchId: filter.batchId ?? null,
          tankId: filter.tankId ?? null,
          measurementType: filter.measurementType ?? null,
          startDate: filter.startDate ?? null,
          endDate: filter.endDate ?? null,
          verifiedOnly: filter.verifiedOnly ?? null,
        }
      : null,
    pagination: { offset: 0, limit },
  });
  return data.growthMeasurements;
}

/**
 * Batch için kapsamlı büyüme analizi getirir.
 *
 * En değerli sorgu — mevcut metrikler, trend, projeksiyon ve
 * aksiyon önerileri tek yanıtta. Anomali tespiti bu verileri kullanır.
 *
 * @param batchId - Batch UUID'si
 */
export async function fetchGrowthAnalysis(
  client: GraphQLClient,
  batchId: string,
): Promise<GrowthAnalysis> {
  const query = `
    query GrowthAnalysis($batchId: ID!) {
      growthAnalysis(batchId: $batchId) {
        batchId
        batchCode
        speciesName
        analysisDate
        daysInProduction
        currentMetrics {
          currentAvgWeightG
          theoreticalWeightG
          weightVariancePercent
          currentBiomassKg
          currentQuantity
          survivalRate
          mortalityRate
          currentFCR
          targetFCR
          fcrVariancePercent
          dailyGrowthRateG
          specificGrowthRate
          weightCV
          performanceRating
        }
        trend {
          direction
          avgDailyGrowthLast7Days
          avgDailyGrowthLast30Days
          growthAcceleration
          fcrTrend
          fcrChangeLast7Days
        }
        projection {
          projectedWeightIn30Days
          projectedBiomassIn30Days
          estimatedHarvestDate
          harvestTargetWeightG
          daysToHarvest
          projectedTotalFeedKg
          projectedFinalFCR
        }
        recommendations {
          priority
          type
          description
          reason
          actionRequired
        }
        measurementHistory {
          id
          measurementDate
          averageWeight
          weightCV
          sampleSize
          estimatedBiomass
          dailyGrowthRate
          periodFCR
          performance
        }
      }
    }
  `;

  const data = await client.query<{ growthAnalysis: GrowthAnalysis }>(query, { batchId });
  return data.growthAnalysis;
}

/**
 * Batch için en son büyüme ölçümünü getirir.
 *
 * Kullanım: Güncel ağırlık bilgisi, hızlı durum kontrolü.
 * Null dönebilir — henüz ölçüm yapılmamış batch'ler için.
 *
 * @param batchId - Batch UUID'si
 */
export async function fetchLatestGrowth(
  client: GraphQLClient,
  batchId: string,
): Promise<GrowthMeasurement | null> {
  const query = `
    query LatestGrowthMeasurement($batchId: ID!) {
      latestGrowthMeasurement(batchId: $batchId) {
        id
        batchId
        tankId
        measurementDate
        measurementType
        sampleSize
        populationSize
        averageWeight
        weightCV
        estimatedBiomass
        samplePercent
        isUniformGrowth
        needsGrading
        dailyGrowthRate
        specificGrowthRate
        periodFCR
        isOnTarget
        notes
      }
    }
  `;

  const data = await client.query<{ latestGrowthMeasurement: GrowthMeasurement | null }>(query, {
    batchId,
  });
  return data.latestGrowthMeasurement;
}

/**
 * Batch büyüme geçmişini getirir.
 *
 * Kullanım: Büyüme eğrisi grafiği, trend analizi.
 * En son ölçümler önce gelir (DESC sıralama).
 *
 * @param batchId - Batch UUID'si
 * @param limit - Maksimum kayıt sayısı (varsayılan: 50)
 */
export async function fetchGrowthHistory(
  client: GraphQLClient,
  batchId: string,
  limit = 50,
): Promise<GrowthMeasurement[]> {
  const query = `
    query BatchGrowthHistory($batchId: ID!, $limit: Int) {
      batchGrowthHistory(batchId: $batchId, limit: $limit) {
        id
        batchId
        tankId
        measurementDate
        measurementType
        sampleSize
        averageWeight
        weightCV
        estimatedBiomass
        dailyGrowthRate
        specificGrowthRate
        periodFCR
        isOnTarget
      }
    }
  `;

  const data = await client.query<{ batchGrowthHistory: GrowthMeasurement[] }>(query, {
    batchId,
    limit,
  });
  return data.batchGrowthHistory;
}
