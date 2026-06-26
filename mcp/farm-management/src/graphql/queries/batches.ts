// ============================================================================
// MCP Farm Intelligence — Batch (Parti/Stok) Sorguları
// ============================================================================
//
// Balık partilerini sorgulayan GraphQL query'leri.
//
// NEDEN GEREKLİ:
//   - Batch, çiftlik yönetiminin temel birimi — her analiz batch'e dayanır
//   - Performans analizi (FCR, SGR, mortalite) batch bazında yapılır
//   - Büyüme projeksiyonları batch geçmişine göre hesaplanır
//   - Anomali tespiti batch performansını referans alır
//
// GraphQL Endpoint: batches, batch, batchPerformance, batchHistory
// ============================================================================

import type { GraphQLClient } from '../client.js';

// ── Tip Tanımları ──────────────────────────────────────────────────

/**
 * Batch yerleşim (lokasyon) bilgisi.
 *
 * NEDEN: Supergraph şeması `tankAllocations` (nested tank objesi) alanını
 * `locations: [BatchLocation!]!` ile değiştirdi. BatchLocation iç içe bir
 * `tank { name }` objesi DÖNDÜRMEZ — yalnızca `tankId` (string) taşır.
 * Tank adı gerekiyorsa ayrı tank sorgusundan eşleştirilmelidir.
 */
export interface BatchLocation {
  id: string;
  tankId?: string;
  pondId?: string;
  locationType: string;
  isCurrentLocation: boolean;
}

/**
 * Batch temel bilgileri.
 * Listeleme ve genel durum tablosu için.
 */
export interface BatchInfo {
  id: string;
  batchNumber: string;
  name?: string;
  status: string;
  inputType: string;
  /**
   * Tür kimliği (UUID). Supergraph şeması tür adı yerine yalnızca
   * `speciesId` döndürür; insan-okunur tür adı için ayrı bir tür sorgusu gerekir.
   */
  speciesId: string;
  initialQuantity: number;
  currentQuantity: number;
  currentAvgWeightG: number;
  currentBiomassKg: number;
  mortalityRate: number;
  survivalRate: number;
  daysInProduction: number;
  stockedAt: string;
  expectedHarvestDate?: string;
  notes?: string;
  locations?: BatchLocation[];
}

/** Sayfalanmış batch listesi yanıtı */
export interface BatchListResponse {
  items: BatchInfo[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/** FCR (Yem Dönüşüm Oranı) bilgisi */
export interface FCRInfo {
  target: number;
  actual: number;
  theoretical: number;
  variance: number;
  status: string;
}

/**
 * Batch performans analizi.
 * Detaylı FCR, büyüme, maliyet ve projeksiyon verileri.
 */
export interface BatchPerformance {
  batchId: string;
  batchNumber: string;
  speciesName: string;
  initialQuantity: number;
  currentQuantity: number;
  initialBiomassKg: number;
  currentBiomassKg: number;
  initialAvgWeightG: number;
  currentAvgWeightG: number;
  weightGainG: number;
  weightGainPercent: number;
  totalMortality: number;
  mortalityRate: number;
  survivalRate: number;
  fcr: FCRInfo;
  sgr: number;
  daysInProduction: number;
  avgDailyGrowthG: number;
  totalFeedConsumedKg: number;
  totalFeedCost: number;
  costPerKg: number;
  costPerFish: number;
  performanceIndex: number;
  performanceStatus: string;
  projectedHarvestDate?: string;
  projectedHarvestWeightG?: number;
  daysToHarvest?: number;
}

/** Batch geçmiş olayı */
export interface BatchHistoryEntry {
  id: string;
  eventType: string;
  timestamp: string;
  description: string;
  details: Record<string, unknown>;
  performedBy?: string;
  tankId?: string;
  tankCode?: string;
  quantityChange?: number;
  biomassChangeKg?: number;
}

/** Batch filtre parametreleri */
export interface BatchFilter {
  status?: string[];
  speciesId?: string;
  inputType?: string;
  tankId?: string;
  isActive?: boolean;
  searchTerm?: string;
}

// ── Sorgular ────────────────────────────────────────────────────────

/**
 * Batch'leri filtreli ve sayfalanmış olarak getirir.
 *
 * Kullanım: Genel batch listesi, durum tablosu, filtreleme.
 * Varsayılan olarak son stoklanan batch'ler önce gelir (sortOrder: DESC).
 * Analitik için limit: 100 — çoğu işletmede yeterli.
 *
 * @param filter - Opsiyonel filtre (status, speciesId, isActive gibi)
 */
export async function fetchBatches(
  client: GraphQLClient,
  filter?: BatchFilter,
): Promise<BatchListResponse> {
  const query = `
    query ListBatches($filter: BatchFilterInput, $page: Int, $limit: Int, $sortBy: String, $sortOrder: String) {
      batches(filter: $filter, page: $page, limit: $limit, sortBy: $sortBy, sortOrder: $sortOrder) {
        items {
          id
          batchNumber
          name
          status
          inputType
          speciesId
          initialQuantity
          currentQuantity
          currentAvgWeightG
          currentBiomassKg
          mortalityRate
          survivalRate
          daysInProduction
          stockedAt
          expectedHarvestDate
          locations {
            id
            tankId
            pondId
            locationType
            isCurrentLocation
          }
        }
        total
        page
        limit
        totalPages
        hasNextPage
        hasPreviousPage
      }
    }
  `;

  const data = await client.query<{ batches: BatchListResponse }>(query, {
    filter: filter ?? null,
    page: 1,
    limit: 100,
    sortBy: 'stockedAt',
    sortOrder: 'DESC',
  });
  return data.batches;
}

/**
 * Belirli bir batch'i detaylarıyla getirir.
 *
 * Anomali analizi veya root cause incelemesinde
 * spesifik bir batch'in tam bilgisine ihtiyaç duyulur.
 *
 * @param id - Batch UUID'si
 */
export async function fetchBatch(client: GraphQLClient, id: string): Promise<BatchInfo> {
  const query = `
    query GetBatch($id: ID!) {
      batch(id: $id) {
        id
        batchNumber
        name
        status
        inputType
        speciesId
        initialQuantity
        currentQuantity
        currentAvgWeightG
        currentBiomassKg
        mortalityRate
        survivalRate
        daysInProduction
        stockedAt
        expectedHarvestDate
        notes
        locations {
          id
          tankId
          pondId
          locationType
          isCurrentLocation
        }
      }
    }
  `;

  const data = await client.query<{ batch: BatchInfo }>(query, { id });
  return data.batch;
}

/**
 * Batch performans analizini getirir.
 *
 * En kritik sorgu — FCR, SGR, büyüme hızı, maliyet analizi,
 * hasat projeksiyonu ve performans indeksi bu sorgudan gelir.
 * Anomali tespitinde benchmark olarak kullanılır.
 *
 * @param id - Batch UUID'si
 */
export async function fetchBatchPerformance(
  client: GraphQLClient,
  id: string,
): Promise<BatchPerformance> {
  const query = `
    query BatchPerformance($id: ID!) {
      batchPerformance(id: $id) {
        batchId
        batchNumber
        speciesName
        initialQuantity
        currentQuantity
        initialBiomassKg
        currentBiomassKg
        initialAvgWeightG
        currentAvgWeightG
        weightGainG
        weightGainPercent
        totalMortality
        mortalityRate
        survivalRate
        fcr {
          target
          actual
          theoretical
          variance
          status
        }
        sgr
        daysInProduction
        avgDailyGrowthG
        totalFeedConsumedKg
        totalFeedCost
        costPerKg
        costPerFish
        performanceIndex
        performanceStatus
        projectedHarvestDate
        projectedHarvestWeightG
        daysToHarvest
      }
    }
  `;

  const data = await client.query<{ batchPerformance: BatchPerformance }>(query, { id });
  return data.batchPerformance;
}

/**
 * Sadece aktif batch'leri getirir.
 *
 * Kullanım: Günlük operasyon özeti, aktif stok takibi.
 * status=['ACTIVE'] filtresi ile sadece üretimde olan batch'ler döner.
 */
export async function fetchActiveBatches(client: GraphQLClient): Promise<BatchListResponse> {
  return fetchBatches(client, { isActive: true });
}

/**
 * Batch geçmiş olaylarını getirir.
 *
 * Kullanım: Root cause analizi — bir batch'e ne olduğunun kronolojik takibi.
 * Stoklama, transfer, mortalite, yemleme değişiklikleri gibi olaylar.
 *
 * @param id - Batch UUID'si
 * @param eventTypes - Opsiyonel olay tipi filtresi
 * @param fromDate - Başlangıç tarihi (ISO string)
 * @param toDate - Bitiş tarihi (ISO string)
 * @param limit - Maksimum kayıt sayısı (varsayılan: 50)
 */
export async function fetchBatchHistory(
  client: GraphQLClient,
  id: string,
  eventTypes?: string[],
  fromDate?: string,
  toDate?: string,
  limit?: number,
): Promise<BatchHistoryEntry[]> {
  const query = `
    query BatchHistory($id: ID!, $eventTypes: [BatchHistoryEventType!], $fromDate: DateTime, $toDate: DateTime, $limit: Int) {
      batchHistory(id: $id, eventTypes: $eventTypes, fromDate: $fromDate, toDate: $toDate, limit: $limit) {
        id
        eventType
        timestamp
        description
        details
        performedBy
        tankId
        tankCode
        quantityChange
        biomassChangeKg
      }
    }
  `;

  const data = await client.query<{ batchHistory: BatchHistoryEntry[] }>(query, {
    id,
    eventTypes: eventTypes ?? null,
    fromDate: fromDate ?? null,
    toDate: toDate ?? null,
    limit: limit ?? 50,
  });
  return data.batchHistory;
}
