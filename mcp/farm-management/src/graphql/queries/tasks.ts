// ============================================================================
// MCP Farm Intelligence — Tasks (Görev) Sorguları
// ============================================================================
//
// Günlük operasyonel görevleri sorgulayan GraphQL query'leri.
// İş emirleri (workOrders) üzerinden görev yönetimi yapılır.
//
// NEDEN GEREKLİ:
//   - Günlük operasyon özeti hazırlanırken bugünkü görevler listelenir
//   - Gecikmiş görevler operasyonel risk oluşturur
//   - MCP Intelligence aracı "bugün ne yapılmalı?" sorusuna yanıt verir
//   - Görev tamamlanma oranı çiftlik verimliliğinin göstergesidir
//
// NOT: Bu modül workOrders query'sini kullanır — ayrı bir "tasks" endpoint'i yoktur.
// İş emirleri farklı statülerle (SCHEDULED, IN_PROGRESS, APPROVED) görev olarak
// değerlendirilir.
//
// GraphQL Endpoint: workOrders (filtreli), overdueWorkOrders
// ============================================================================

import type { GraphQLClient } from '../client.js';

// ── Tip Tanımları ──────────────────────────────────────────────────

/**
 * Görev bilgisi.
 * İş emrinin günlük operasyon perspektifinden görünümü.
 * Sadece görev takibi için gereken alanlar seçilmiştir.
 */
export interface TaskInfo {
  id: string;
  /** İş emri kodu — şemadaki `workOrderCode` (eski adı `code`). */
  workOrderCode: string;
  title: string;
  description?: string;
  status: string;
  priority: string;
  /**
   * İş emri tipi — şemadaki `type` (WorkOrderType enum). Eski `workOrderType`
   * adı şemada yoktur; drift önerisi `workOrderCode` anlamsal olarak hatalıydı.
   */
  type: string;
  assetType?: string;
  /** Varlık kimliği — şemadaki `assetId` (eski `siteId`; saha ile aynı anlamda değildir). */
  assetId?: string;
  /** Atanan kişi — şemadaki `assignedTo` (eski `assigneeId`). */
  assignedTo?: string;
  dueDate?: string;
  /** Planlanan başlangıç — şemadaki `plannedStartDate` (eski `scheduledStartDate`). */
  plannedStartDate?: string;
  createdAt: string;
}

/** Görev listesi sayfalanmış yanıt */
export interface TaskListResponse {
  items: TaskInfo[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

// ── Sorgular ────────────────────────────────────────────────────────

/**
 * Bugünkü görevleri getirir.
 *
 * NASIL ÇALIŞIR:
 *   workOrders query'si kullanılır ve statü filtresi uygulanır.
 *   "Bugünkü görevler" = planlanan/onaylanan/devam eden iş emirleri.
 *   Statüler: APPROVED, SCHEDULED, IN_PROGRESS
 *
 * Kullanım: Günlük operasyon brifingi, "bugün ne yapılmalı?" sorusu.
 * Due date filtresi uygulanmaz çünkü resolver tarafında
 * aktif görevlerin tümü gösterilmek istenir.
 */
export async function fetchTodaysTasks(
  client: GraphQLClient,
): Promise<TaskListResponse> {
  // Aktif görevleri getir: onaylanmış, planlanmış veya devam eden iş emirleri.
  // Bu statüler "yapılacak iş" anlamına gelir.
  // Duedate yerine statü bazlı filtreleme yapılır çünkü
  // tüm aktif görevler günlük brifingde görünmelidir.
  const query = `
    query TodaysTasks($filter: WorkOrderFilterInput, $page: Int, $limit: Int, $sortBy: String, $sortOrder: String) {
      workOrders(filter: $filter, page: $page, limit: $limit, sortBy: $sortBy, sortOrder: $sortOrder) {
        items {
          id
          workOrderCode
          title
          description
          status
          priority
          type
          assetType
          assetId
          assignedTo
          dueDate
          plannedStartDate
          createdAt
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

  const data = await client.query<{ workOrders: TaskListResponse }>(query, {
    filter: {
      // Aktif görev statüleri — henüz tamamlanmamış iş emirleri
      // WorkOrderFilterInput.status alanı dizi kabul eder (WorkOrderStatus[])
      status: ['IN_PROGRESS', 'APPROVED', 'SCHEDULED'],
    },
    page: 1,
    limit: 100,
    sortBy: 'dueDate',
    sortOrder: 'ASC',
  });
  return data.workOrders;
}

/**
 * Gecikmiş görevleri getirir.
 *
 * Kullanım: Operasyonel risk tespiti — vadesi geçmiş görevler
 * ekipman arızasına ve üretim kaybına yol açabilir.
 *
 * overdueWorkOrders query'si doğrudan gateway tarafında
 * dueDate < now ve status != COMPLETED/CANCELLED filtresi uygular.
 */
export async function fetchOverdueTasks(
  client: GraphQLClient,
): Promise<TaskInfo[]> {
  const query = `
    query OverdueTasks {
      overdueWorkOrders {
        id
        workOrderCode
        title
        description
        status
        priority
        type
        assetType
        assetId
        assignedTo
        dueDate
        plannedStartDate
        createdAt
      }
    }
  `;

  const data = await client.query<{ overdueWorkOrders: TaskInfo[] }>(query);
  return data.overdueWorkOrders;
}
