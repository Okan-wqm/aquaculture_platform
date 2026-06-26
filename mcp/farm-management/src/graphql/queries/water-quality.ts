// ============================================================================
// MCP Farm Intelligence — Water Quality (Su Kalitesi) Sorguları
// ============================================================================
//
// Su kalitesi ölçümlerini ve istatistiklerini sorgulayan GraphQL query'leri.
//
// NEDEN GEREKLİ:
//   - Su kalitesi balık sağlığının 1 numaralı belirleyicisidir
//   - Kritik parametreler (DO, pH, amonyak) anormal değişimler gösterirse
//     hemen müdahale gerekir — bu anomali tespitinin en öncelikli alanıdır
//   - Cross-domain korelasyonda su kalitesi ↔ mortalite ↔ büyüme ilişkisi kurulur
//   - Tank bazlı izleme en granüler veri seviyesidir
//
// GraphQL Endpoint: waterQualityMeasurements, latestWaterQuality,
//                   waterQualityStatistics, criticalWaterQuality
// ============================================================================

import type { GraphQLClient } from '../client.js';

// ── Tip Tanımları ──────────────────────────────────────────────────

/**
 * Su kalitesi ölçümü.
 * Temel su parametreleri — sıcaklık, DO, pH, amonyak, nitrit, nitrat, tuzluluk.
 * overallStatus alanı ölçümün genel durumunu gösterir (optimal/warning/critical).
 */
export interface WaterQualityMeasurement {
  id: string;
  tankId?: string;
  pondId?: string;
  siteId?: string;
  measuredAt: string;
  source: string;
  overallStatus: string;
  /** Su parametreleri — JSON nesnesi olarak döner */
  parameters?: {
    temperature?: number;
    dissolvedOxygen?: number;
    oxygenSaturation?: number;
    pH?: number;
    salinity?: number;
    ammonia?: number;
    totalAmmoniaNitrogen?: number;
    nitrite?: number;
    nitrate?: number;
    turbidity?: number;
    co2?: number;
    alkalinity?: number;
    hardness?: number;
  };
  notes?: string;
  measuredBy?: string;
}

/** Su kalitesi listesi yanıtı */
export interface WaterQualityListResponse {
  items: WaterQualityMeasurement[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  /**
   * Sonraki sayfa var mı? Şemada `offset`/`hasMore` yoktur; gerçek sayfalama
   * alanları page/limit/totalPages/hasNextPage'tir.
   */
  hasNextPage: boolean;
}

/**
 * Su kalitesi istatistikleri.
 * Belirli bir tank için ortalamalar, ölçüm sayıları ve son ölçüm.
 */
export interface WaterQualityStatistics {
  avgTemperature: number | null;
  avgDO: number | null;
  avgPH: number | null;
  avgAmmonia: number | null;
  avgNitrite: number | null;
  measurementCount: number;
  criticalCount: number;
  warningCount: number;
  lastMeasurement: WaterQualityMeasurement | null;
}

/** Su kalitesi filtresi */
export interface WaterQualityFilter {
  tankId?: string;
  startDate?: string;
  endDate?: string;
}

// ── Sorgular ────────────────────────────────────────────────────────

/**
 * Su kalitesi ölçümlerini filtreli olarak getirir.
 *
 * Kullanım: Tank bazlı su kalitesi geçmişi, trend analizi,
 * parametre değişim grafikleri.
 *
 * @param filter - Filtre parametreleri (tankId, tarih aralığı)
 * @param limit - Maksimum kayıt sayısı (varsayılan: 500, performans koruması)
 */
export async function fetchWaterQuality(
  client: GraphQLClient,
  filter?: WaterQualityFilter,
  limit = 500,
): Promise<WaterQualityListResponse> {
  // NEDEN limit filtreye taşındı: Query.waterQualityMeasurements yalnızca
  // `filter` argümanı alır; sayfalama limiti WaterQualityFilterInput.limit
  // alanına aittir (şemada üst düzey `limit` argümanı yoktur).
  const query = `
    query WaterQualityMeasurements($filter: WaterQualityFilterInput) {
      waterQualityMeasurements(filter: $filter) {
        items {
          id
          tankId
          pondId
          siteId
          measuredAt
          source
          overallStatus
          parameters
          notes
          measuredBy
        }
        total
        page
        limit
        totalPages
        hasNextPage
      }
    }
  `;

  const data = await client.query<{ waterQualityMeasurements: WaterQualityListResponse }>(query, {
    filter: {
      tankId: filter?.tankId ?? null,
      fromDate: filter?.startDate ?? null,
      toDate: filter?.endDate ?? null,
      limit,
    },
  });
  return data.waterQualityMeasurements;
}

/**
 * Tank için en son su kalitesi ölçümünü getirir.
 *
 * Kullanım: Anlık durum kontrolü, dashboard gösterimi.
 * Null dönebilir — henüz ölçüm yapılmamış tanklar için.
 *
 * @param tankId - Tank UUID'si
 */
export async function fetchLatestWaterQuality(
  client: GraphQLClient,
  tankId: string,
): Promise<WaterQualityMeasurement | null> {
  const query = `
    query LatestWaterQuality($tankId: ID!) {
      latestWaterQuality(tankId: $tankId) {
        id
        tankId
        measuredAt
        source
        overallStatus
        parameters
        notes
        measuredBy
      }
    }
  `;

  const data = await client.query<{ latestWaterQuality: WaterQualityMeasurement | null }>(query, {
    tankId,
  });
  return data.latestWaterQuality;
}

/**
 * Tank için su kalitesi istatistiklerini getirir.
 *
 * Kullanım: Dönemsel ortalamalar, kritik/uyarı ölçüm sayıları.
 * Anomali tespitinde ortalamalardan sapma hesaplanır.
 *
 * @param tankId - Tank UUID'si
 * @param days - Kaç günlük istatistik (varsayılan: 7)
 */
export async function fetchWaterQualityStats(
  client: GraphQLClient,
  tankId: string,
  days = 7,
): Promise<WaterQualityStatistics> {
  const query = `
    query WaterQualityStatistics($tankId: ID!, $days: Int) {
      waterQualityStatistics(tankId: $tankId, days: $days) {
        avgTemperature
        avgDO
        avgPH
        avgAmmonia
        avgNitrite
        measurementCount
        criticalCount
        warningCount
        lastMeasurement {
          id
          tankId
          measuredAt
          source
          overallStatus
          parameters
        }
      }
    }
  `;

  const data = await client.query<{ waterQualityStatistics: WaterQualityStatistics }>(query, {
    tankId,
    days,
  });
  return data.waterQualityStatistics;
}

/**
 * Kritik durumda olan tüm tankları getirir.
 *
 * En yüksek öncelikli sorgu — parametre değerleri tehlikeli aralıkta
 * olan tankları listeler. Alarm ve acil müdahale kararları bu veriye dayanır.
 * Tüm tenant genelinde tarama yapar.
 */
export async function fetchCriticalWaterQuality(
  client: GraphQLClient,
): Promise<WaterQualityMeasurement[]> {
  const query = `
    query CriticalWaterQuality {
      criticalWaterQuality {
        id
        tankId
        pondId
        siteId
        measuredAt
        source
        overallStatus
        parameters
        notes
      }
    }
  `;

  const data = await client.query<{ criticalWaterQuality: WaterQualityMeasurement[] }>(query);
  return data.criticalWaterQuality;
}
