// ============================================================================
// MCP Farm Intelligence — Health (Sağlık) Sorguları
// ============================================================================
//
// Balık sağlığı olaylarını sorgulayan GraphQL query'leri.
//
// NEDEN GEREKLİ:
//   - Sağlık olayları mortalite ve üretim kaybının doğrudan nedenidir
//   - Hastalık salgını tespiti erken müdahale imkanı sağlar
//   - Cross-domain korelasyonda su kalitesi ↔ sağlık olayı ilişkisi kurulur
//   - Tedavi maliyetleri ve karantina süreleri operasyonel planlamayı etkiler
//   - Kritik sağlık olayları anında bildirilmesi gereken acil durumlardır
//
// GraphQL Endpoint: healthEvents, healthEventsByBatch,
//                   criticalHealthEvents, healthEventStats
// ============================================================================

import type { GraphQLClient } from '../client.js';

// ── Tip Tanımları ──────────────────────────────────────────────────

/**
 * Sağlık olayı.
 * Hastalık, tedavi, karantina ve gözlem kayıtları.
 * severity ve status alanları önceliklendirme için kritiktir.
 */
export interface HealthEvent {
  id: string;
  batchId: string;
  tankId?: string;
  eventType: string;
  severity: string;
  status: string;
  title: string;
  description?: string;
  diseaseCategory?: string;
  diagnosisConfidence?: string;
  /**
   * Olay tarihi. Şema başlangıç/bitiş aralığı yerine tek bir `eventDate`
   * taşır — eski `startDate`/`endDate` çifti şemada yoktur.
   */
  eventDate: string;
  isQuarantined: boolean;
  isUnderTreatment: boolean;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

/** Sayfalanmış sağlık olayları yanıtı */
export interface PaginatedHealthEvents {
  items: HealthEvent[];
  total: number;
  /**
   * Sonraki sayfa var mı? Şemada `hasMore` yoktur; PaginatedHealthEventsResponse
   * gerçek sayfalama alanı olarak `hasNextPage`'i sunar.
   */
  hasNextPage: boolean;
}

/**
 * Sağlık olayı istatistikleri.
 * Genel duruma hızlı bakış — kaç aktif, kaç kritik, kaç tedavide.
 */
export interface HealthEventStats {
  total: number;
  active: number;
  critical: number;
  underTreatment: number;
  quarantined: number;
  resolved: number;
  /** Olay tipine göre dağılım (disease_outbreak: 3, symptom_observed: 7, ...) */
  byEventType: Record<string, number>;
  /** Şiddete göre dağılım (minor: 5, moderate: 3, severe: 1, critical: 0) */
  bySeverity: Record<string, number>;
}

/** Sağlık olayı filtresi */
export interface HealthEventFilter {
  batchId?: string;
  tankId?: string;
  eventType?: string;
  severity?: string;
  status?: string;
  startDate?: string;
  endDate?: string;
}

// ── Sorgular ────────────────────────────────────────────────────────

/**
 * Sağlık olaylarını filtreli olarak getirir.
 *
 * Kullanım: Sağlık olayı listesi, filtreleme ve geçmiş analiz.
 * Sayfalama gateway tarafında yönetilir.
 *
 * @param filter - Opsiyonel filtre (batchId, severity, status gibi)
 */
export async function fetchHealthEvents(
  client: GraphQLClient,
  filter?: HealthEventFilter,
): Promise<PaginatedHealthEvents> {
  const query = `
    query HealthEvents($filter: HealthEventFilterInput) {
      healthEvents(filter: $filter) {
        items {
          id
          batchId
          tankId
          eventType
          severity
          status
          title
          description
          diseaseCategory
          eventDate
          isQuarantined
          isUnderTreatment
          notes
          createdAt
        }
        total
        hasNextPage
      }
    }
  `;

  const data = await client.query<{ healthEvents: PaginatedHealthEvents }>(query, {
    filter: filter ?? null,
  });
  return data.healthEvents;
}

/**
 * Belirli bir batch'in sağlık olaylarını getirir.
 *
 * Kullanım: Batch bazlı sağlık geçmişi, root cause analizi.
 * activeOnly=true ile sadece devam eden olaylar filtrelenir.
 *
 * @param batchId - Batch UUID'si
 * @param activeOnly - Sadece aktif olaylar (varsayılan: false)
 */
export async function fetchHealthEventsByBatch(
  client: GraphQLClient,
  batchId: string,
  activeOnly = false,
): Promise<HealthEvent[]> {
  const query = `
    query HealthEventsByBatch($batchId: ID!, $activeOnly: Boolean) {
      healthEventsByBatch(batchId: $batchId, activeOnly: $activeOnly) {
        id
        batchId
        tankId
        eventType
        severity
        status
        title
        description
        diseaseCategory
        eventDate
        isQuarantined
        isUnderTreatment
        notes
        createdAt
      }
    }
  `;

  const data = await client.query<{ healthEventsByBatch: HealthEvent[] }>(query, {
    batchId,
    activeOnly,
  });
  return data.healthEventsByBatch;
}

/**
 * Kritik sağlık olaylarını getirir.
 *
 * En yüksek öncelikli sorgu — severe/critical şiddetinde ve
 * aktif durumda olan sağlık olayları. Acil müdahale gerektiren
 * durumları tespit etmek için kullanılır.
 * Tüm tenant genelinde tarama yapar.
 */
export async function fetchCriticalHealthEvents(
  client: GraphQLClient,
): Promise<HealthEvent[]> {
  const query = `
    query CriticalHealthEvents {
      criticalHealthEvents {
        id
        batchId
        tankId
        eventType
        severity
        status
        title
        description
        diseaseCategory
        eventDate
        isQuarantined
        isUnderTreatment
        notes
        createdAt
      }
    }
  `;

  const data = await client.query<{ criticalHealthEvents: HealthEvent[] }>(query);
  return data.criticalHealthEvents;
}

/**
 * Sağlık olayı istatistiklerini getirir.
 *
 * Kullanım: Dashboard özeti, genel sağlık durumu skorlaması.
 * Aktif/kritik/tedavide/karantinada olay sayıları ve
 * olay tipi ile şiddet dağılımları.
 */
export async function fetchHealthEventStats(
  client: GraphQLClient,
): Promise<HealthEventStats> {
  const query = `
    query HealthEventStats {
      healthEventStats {
        total
        active
        critical
        underTreatment
        quarantined
        resolved
        byEventType
        bySeverity
      }
    }
  `;

  const data = await client.query<{ healthEventStats: HealthEventStats }>(query);
  return data.healthEventStats;
}
