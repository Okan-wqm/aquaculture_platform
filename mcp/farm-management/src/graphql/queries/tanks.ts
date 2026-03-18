// ============================================================================
// MCP Farm Intelligence — Tank (Havuz) Sorguları
// ============================================================================
//
// Yetiştirme tanklarını sorgulayan GraphQL query'leri.
//
// NEDEN GEREKLİ:
//   - Tank bazlı anomali tespiti (yoğunluk aşımı, kapasite kullanımı)
//   - Biomass hesaplamaları tank hacmine bağlıdır
//   - Su kalitesi ölçümleri tank'a bağlıdır
//   - Yemleme planları tank bazında oluşturulur
//
// GraphQL Endpoint: tanks, tank, tanksByDepartment, availableTanks
// ============================================================================

import type { GraphQLClient } from '../client.js';

// ── Tip Tanımları ──────────────────────────────────────────────────

/** Tank kapasite bilgileri — resolver tarafından hesaplanır */
export interface TankCapacityInfo {
  currentBiomass: number;
  maxBiomass: number;
  availableCapacity: number;
  utilizationPercent: number;
  currentDensity: number;
  maxDensity: number;
  hasCapacity: boolean;
}

/** Tank departman bilgisi — site ilişkisi dahil */
export interface TankDepartmentInfo {
  id: string;
  name: string;
  siteId?: string;
  site?: {
    id: string;
    name: string;
  };
}

/** Tank batch metrikleri — TankBatch entity'sinden hesaplanır */
export interface TankBatchMetrics {
  batchNumber?: string;
  batchId?: string;
  pieces?: number;
  avgWeight?: number;
  biomass?: number;
  density?: number;
  capacityUsedPercent?: number;
  isOverCapacity?: boolean;
  isMixedBatch?: boolean;
  lastFeedingAt?: string;
  lastSamplingAt?: string;
  lastMortalityAt?: string;
  daysSinceStocking?: number;
}

/**
 * Tank bilgileri.
 * Analitik araçları için kapasite, biomass ve departman bilgileri dahil.
 */
export interface TankInfo {
  id: string;
  name: string;
  code: string;
  tankType: string;
  status: string;
  isActive: boolean;
  volume: number;
  waterVolume?: number;
  effectiveVolume: number;
  currentBiomass: number;
  maxBiomass: number;
  maxDensity: number;
  departmentId?: string;
  department?: TankDepartmentInfo;
  capacityInfo: TankCapacityInfo;
  batchMetrics?: TankBatchMetrics;
}

/** Tank listesi yanıtı */
export interface TankListResponse {
  items: TankInfo[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

/**
 * Hafif tank bilgisi — analitik özet ve listeleme için.
 * capacityInfo ve batchMetrics gibi ağır alt-sorgular dahil değildir.
 */
export interface TankLightInfo {
  id: string;
  name: string;
  code: string;
  status: string;
  isActive: boolean;
  volume: number;
  effectiveVolume: number;
  currentBiomass: number;
  maxBiomass: number;
  maxDensity: number;
  department?: {
    site?: {
      id: string;
    };
  };
}

/** Hafif tank listesi yanıtı */
export interface TankLightListResponse {
  items: TankLightInfo[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

// ── Ortak Fragment ──────────────────────────────────────────────────

/**
 * Tank alanları fragment'ı — tüm tank sorgularında tekrarlanan alanlar.
 * GraphQL fragment olarak değil, string interpolation ile kullanılır
 * çünkü gateway inline fragment desteği daha güvenilirdir.
 */
const TANK_FIELDS = `
  id
  name
  code
  tankType
  status
  isActive
  volume
  waterVolume
  effectiveVolume
  currentBiomass
  maxBiomass
  maxDensity
  departmentId
  department {
    id
    name
    siteId
    site {
      id
      name
    }
  }
  capacityInfo {
    currentBiomass
    maxBiomass
    availableCapacity
    utilizationPercent
    currentDensity
    maxDensity
    hasCapacity
  }
  batchMetrics {
    batchNumber
    batchId
    pieces
    avgWeight
    biomass
    density
    capacityUsedPercent
    isOverCapacity
    isMixedBatch
    daysSinceStocking
  }
`;

// ── Hafif Fragment ──────────────────────────────────────────────────

/**
 * Hafif tank alanları — analitik özet ve listeleme sorguları için.
 * capacityInfo, batchMetrics, department.name gibi ağır alanlar çıkarıldı.
 * Sadece site.id korundu (site bazlı gruplama için yeterli).
 */
const TANK_FIELDS_LIGHT = `
  id
  name
  code
  status
  isActive
  volume
  effectiveVolume
  currentBiomass
  maxBiomass
  maxDensity
  department {
    site {
      id
    }
  }
`;

// ── Sorgular ────────────────────────────────────────────────────────

/**
 * Tüm tankları filtreli olarak getirir.
 *
 * Kullanım: Tesis genelinde tank durumu, kapasite analizi, yoğunluk kontrolü.
 * Varsayılan olarak tüm tanklar (aktif/pasif) döner.
 *
 * @param filter - Opsiyonel filtre (departmentId, isActive, status gibi)
 */
export async function fetchTanks(
  client: GraphQLClient,
  filter?: { departmentId?: string; isActive?: boolean; status?: string },
): Promise<TankListResponse> {
  const query = `
    query ListTanks($filter: TankFilterInput) {
      tanks(filter: $filter) {
        items {
          ${TANK_FIELDS}
        }
        total
        offset
        limit
        hasMore
      }
    }
  `;

  const data = await client.query<{ tanks: TankListResponse }>(query, {
    filter: filter ?? null,
  });
  return data.tanks;
}

/**
 * Belirli bir tank'ı detaylarıyla getirir.
 *
 * Tank bazlı anomali analizi için spesifik tank bilgisi.
 * Kapasite, biomass metrikleri ve departman bilgisi dahildir.
 *
 * @param id - Tank UUID'si
 */
export async function fetchTank(client: GraphQLClient, id: string): Promise<TankInfo> {
  const query = `
    query GetTank($id: ID!) {
      tank(id: $id) {
        ${TANK_FIELDS}
      }
    }
  `;

  const data = await client.query<{ tank: TankInfo }>(query, { id });
  return data.tank;
}

/**
 * Belirli bir departmandaki tankları getirir.
 *
 * Site/departman bazlı gruplama için kullanılır.
 * Sadece aktif tankları döndürür (resolver tarafında isActive: true filtresi).
 *
 * @param departmentId - Departman UUID'si
 */
export async function fetchTanksByDepartment(
  client: GraphQLClient,
  departmentId: string,
): Promise<TankInfo[]> {
  const query = `
    query TanksByDepartment($departmentId: ID!) {
      tanksByDepartment(departmentId: $departmentId) {
        ${TANK_FIELDS}
      }
    }
  `;

  const data = await client.query<{ tanksByDepartment: TankInfo[] }>(query, {
    departmentId,
  });
  return data.tanksByDepartment;
}

// ── Hafif Sorgular ──────────────────────────────────────────────────

/**
 * Tankları hafif alanlarla getirir — analitik özet ve listeleme için.
 *
 * capacityInfo ve batchMetrics alt-sorguları dahil değildir.
 * Yoğunluk aşımı taraması, kapasite kullanım özeti gibi toplu analizlerde
 * ağır sorgu yerine bu variant tercih edilmelidir.
 *
 * @param filter - Opsiyonel filtre (departmentId, isActive, status gibi)
 */
export async function fetchTanksLight(
  client: GraphQLClient,
  filter?: { departmentId?: string; isActive?: boolean; status?: string },
): Promise<TankLightListResponse> {
  const query = `
    query ListTanksLight($filter: TankFilterInput) {
      tanks(filter: $filter) {
        items {
          ${TANK_FIELDS_LIGHT}
        }
        total
        offset
        limit
        hasMore
      }
    }
  `;

  const data = await client.query<{ tanks: TankLightListResponse }>(query, {
    filter: filter ?? null,
  });
  return data.tanks;
}
