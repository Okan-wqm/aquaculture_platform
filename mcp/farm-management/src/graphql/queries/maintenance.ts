// ============================================================================
// MCP Farm Intelligence — Maintenance (Bakım) Sorguları
// ============================================================================
//
// İş emirleri ve bakım istatistiklerini sorgulayan GraphQL query'leri.
//
// NEDEN GEREKLİ:
//   - Ekipman arızaları su kalitesi ve yemleme aksamasına neden olabilir
//   - Geciken iş emirleri operasyonel riskleri artırır
//   - Bakım maliyetleri toplam işletme giderlerinin önemli bileşenidir
//   - Cross-domain korelasyonda ekipman arızası ↔ su kalitesi düşüşü ↔ mortalite
//     zinciri kurulabilir
//
// GraphQL Endpoint: workOrders, overdueWorkOrders, workOrderStatistics
// ============================================================================

import type { GraphQLClient } from '../client.js';

// ── Tip Tanımları ──────────────────────────────────────────────────

/**
 * İş emri.
 * Bakım, onarım, temizlik gibi operasyonel görevlerin kaydı.
 * priority ve status alanları önceliklendirme için kritiktir.
 */
export interface WorkOrder {
  id: string;
  code: string;
  title: string;
  description?: string;
  status: string;
  priority: string;
  workOrderType: string;
  assetType?: string;
  assetId?: string;
  siteId?: string;
  departmentId?: string;
  assigneeId?: string;
  dueDate?: string;
  scheduledStartDate?: string;
  startedAt?: string;
  completedDate?: string;
  estimatedDurationHours?: number;
  actualDurationHours?: number;
  estimatedCost?: number;
  actualCost?: number;
  createdAt: string;
}

/** İş emri listesi sayfalanmış yanıt */
export interface WorkOrderListResponse {
  items: WorkOrder[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/**
 * İş emri istatistikleri.
 * Genel bakım durumu özeti — toplam, geciken, tamamlanan, maliyet.
 * Durum bazlı dağılım ile hangi aşamada kaç iş emri olduğu görülür.
 */
export interface WorkOrderStatistics {
  total: number;
  overdue: number;
  completedOnTime: number;
  avgCompletionTime: number;
  totalCost: number;
  /** Durum bazlı dağılım */
  draft: number;
  pendingApproval: number;
  approved: number;
  scheduled: number;
  inProgress: number;
  onHold: number;
  completed: number;
  verified: number;
  cancelled: number;
}

/**
 * Hafif iş emri bilgisi — geciken iş emirleri listesi ve dashboard özeti için.
 * description, assetType, cost, duration gibi detaylar dahil değildir.
 */
export interface WorkOrderLightInfo {
  id: string;
  code: string;
  title: string;
  status: string;
  priority: string;
  dueDate?: string;
}

/** İş emri filtresi */
export interface WorkOrderFilter {
  status?: string;
  priority?: string;
  workOrderType?: string;
  assetType?: string;
  siteId?: string;
  assigneeId?: string;
}

// ── Sorgular ────────────────────────────────────────────────────────

/**
 * İş emirlerini filtreli ve sayfalanmış olarak getirir.
 *
 * Kullanım: Bakım listesi, durum takibi, personel ataması.
 * Varsayılan sıralama: oluşturulma tarihine göre azalan (en yeni önce).
 *
 * @param filter - Opsiyonel filtre (status, priority, siteId gibi)
 * @param page - Sayfa numarası (varsayılan: 1)
 * @param limit - Sayfa başına kayıt (varsayılan: 50)
 */
export async function fetchWorkOrders(
  client: GraphQLClient,
  filter?: WorkOrderFilter,
  page = 1,
  limit = 50,
): Promise<WorkOrderListResponse> {
  const query = `
    query WorkOrders($filter: WorkOrderFilterInput, $page: Int, $limit: Int, $sortBy: String, $sortOrder: String) {
      workOrders(filter: $filter, page: $page, limit: $limit, sortBy: $sortBy, sortOrder: $sortOrder) {
        items {
          id
          code
          title
          description
          status
          priority
          workOrderType
          assetType
          assetId
          siteId
          departmentId
          assigneeId
          dueDate
          scheduledStartDate
          startedAt
          completedDate
          estimatedDurationHours
          actualDurationHours
          estimatedCost
          actualCost
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

  const data = await client.query<{ workOrders: WorkOrderListResponse }>(query, {
    filter: filter ?? null,
    page,
    limit,
    sortBy: 'createdAt',
    sortOrder: 'DESC',
  });
  return data.workOrders;
}

/**
 * Gecikmiş iş emirlerini getirir.
 *
 * Kullanım: Operasyonel risk tespiti — vadesi geçmiş bakımlar
 * ekipman arızasına ve dolaylı olarak üretim kaybına yol açabilir.
 * Tüm tenant genelinde tarama yapar.
 */
export async function fetchOverdueWorkOrders(
  client: GraphQLClient,
): Promise<WorkOrder[]> {
  const query = `
    query OverdueWorkOrders {
      overdueWorkOrders {
        id
        code
        title
        description
        status
        priority
        workOrderType
        assetType
        assetId
        siteId
        departmentId
        assigneeId
        dueDate
        estimatedCost
        createdAt
      }
    }
  `;

  const data = await client.query<{ overdueWorkOrders: WorkOrder[] }>(query);
  return data.overdueWorkOrders;
}

/**
 * Bakım istatistiklerini getirir.
 *
 * Kullanım: Dashboard özeti, bakım verimliliği analizi.
 * Durum bazlı dağılım, ortalama tamamlanma süresi ve toplam maliyet.
 *
 * @param dateFrom - Başlangıç tarihi filtresi (opsiyonel)
 * @param dateTo - Bitiş tarihi filtresi (opsiyonel)
 */
export async function fetchMaintenanceStats(
  client: GraphQLClient,
  dateFrom?: string,
  dateTo?: string,
): Promise<WorkOrderStatistics> {
  const query = `
    query WorkOrderStatistics($dateFrom: DateTime, $dateTo: DateTime) {
      workOrderStatistics(dateFrom: $dateFrom, dateTo: $dateTo) {
        total
        overdue
        completedOnTime
        avgCompletionTime
        totalCost
        draft
        pendingApproval
        approved
        scheduled
        inProgress
        onHold
        completed
        verified
        cancelled
      }
    }
  `;

  const data = await client.query<{ workOrderStatistics: WorkOrderStatistics }>(query, {
    dateFrom: dateFrom ?? null,
    dateTo: dateTo ?? null,
  });
  return data.workOrderStatistics;
}

// ── Hafif Sorgular ──────────────────────────────────────────────────

/**
 * Gecikmiş iş emirlerini hafif alanlarla getirir — dashboard özeti ve risk taraması için.
 *
 * description, assetType, cost, duration gibi detaylar dahil değildir.
 * Geciken bakım sayısı ve öncelik bazlı sıralama için bu variant yeterlidir.
 */
export async function fetchOverdueWorkOrdersLight(
  client: GraphQLClient,
): Promise<WorkOrderLightInfo[]> {
  const query = `
    query OverdueWorkOrdersLight {
      overdueWorkOrders {
        id
        code
        title
        status
        priority
        dueDate
      }
    }
  `;

  const data = await client.query<{ overdueWorkOrders: WorkOrderLightInfo[] }>(query);
  return data.overdueWorkOrders;
}
