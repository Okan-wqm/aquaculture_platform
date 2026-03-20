// ============================================================================
// MCP Farm Intelligence — Site (Tesis) Sorguları
// ============================================================================
//
// Çiftlik lokasyonlarını (site) sorgulayan GraphQL query'leri.
//
// NEDEN GEREKLİ:
//   - Anomali tespitinde hangi tesislerin aktif olduğunu bilmek gerekir
//   - Cross-domain korelasyon için site bazlı gruplama yapılır
//   - Hava durumu verileri site'a bağlıdır (koordinat bazlı)
//   - Günlük operasyon özeti site bazında hazırlanır
//
// GraphQL Endpoint: sites, site, activeSites
// ============================================================================

import type { GraphQLClient } from '../client.js';

// ── Tip Tanımları ──────────────────────────────────────────────────

/** Konum bilgisi — enlem/boylam koordinatları */
export interface SiteLocation {
  latitude: number;
  longitude: number;
  altitude?: number;
}

/** Adres bilgisi */
export interface SiteAddress {
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

/**
 * Site temel bilgileri.
 * Analitik araçları için gereken minimum alan seti.
 */
export interface SiteInfo {
  id: string;
  name: string;
  code: string;
  type: string;
  status: string;
  isActive: boolean;
  location?: SiteLocation;
  address?: SiteAddress;
  country?: string;
  region?: string;
  timezone: string;
  totalArea?: number;
  siteManager?: string;
  contactEmail?: string;
  createdAt: string;
}

/** Sayfalanmış site listesi yanıtı */
export interface PaginatedSitesResponse {
  items: SiteInfo[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Hafif site bilgisi — dropdown, gruplama ve hızlı listeleme için.
 * location, address, totalArea, siteManager, createdAt gibi ağır alanlar dahil değildir.
 */
export interface SiteLightInfo {
  id: string;
  name: string;
  type: string;
  status: string;
}

// ── Sorgular ────────────────────────────────────────────────────────

/**
 * Tüm aktif site'ları getirir.
 *
 * Kullanım: Dropdown listeleri, genel durum tablosu, site bazlı raporlar.
 * Gateway'de activeSites query'si isActive=true filtreli ListSitesQuery çalıştırır.
 */
export async function fetchActiveSites(client: GraphQLClient): Promise<SiteInfo[]> {
  const query = `
    query ActiveSites {
      activeSites {
        id
        name
        code
        type
        status
        isActive
        location {
          latitude
          longitude
        }
        country
        region
        timezone
        totalArea
        siteManager
        createdAt
      }
    }
  `;

  const data = await client.query<{ activeSites: SiteInfo[] }>(query);
  return data.activeSites;
}

/**
 * Belirli bir site'ı detaylarıyla getirir.
 *
 * includeRelations=true ile departman ve tank ilişkileri dahil edilir.
 * Anomali tespitinde spesifik bir site'ın tam bilgisine ihtiyaç duyulur.
 *
 * @param id - Site UUID'si
 */
export async function fetchSite(client: GraphQLClient, id: string): Promise<SiteInfo> {
  const query = `
    query GetSite($id: ID!, $includeRelations: Boolean) {
      site(id: $id, includeRelations: $includeRelations) {
        id
        name
        code
        type
        status
        isActive
        location {
          latitude
          longitude
          altitude
        }
        address {
          street
          city
          state
          postalCode
          country
        }
        country
        region
        timezone
        totalArea
        siteManager
        contactEmail
        createdAt
      }
    }
  `;

  const data = await client.query<{ site: SiteInfo }>(query, {
    id,
    includeRelations: true,
  });
  return data.site;
}

/**
 * Tüm site'ları filtreli ve sayfalanmış olarak getirir.
 *
 * Analitik araçları tüm tesislerin genel durumunu görmek için kullanır.
 * Varsayılan limit: 100 (küçük-orta ölçekli işletmeler için yeterli).
 *
 * @param filter - Opsiyonel filtre (isActive gibi)
 */
export async function fetchSites(
  client: GraphQLClient,
  filter?: { isActive?: boolean },
): Promise<PaginatedSitesResponse> {
  const query = `
    query ListSites($filter: SiteFilterInput, $pagination: FarmPaginationInput) {
      sites(filter: $filter, pagination: $pagination) {
        items {
          id
          name
          code
          type
          status
          isActive
          location {
            latitude
            longitude
          }
          country
          region
          timezone
          totalArea
          siteManager
          createdAt
        }
        total
        page
        limit
        totalPages
      }
    }
  `;

  const data = await client.query<{ sites: PaginatedSitesResponse }>(query, {
    filter: filter ?? null,
    pagination: { page: 1, limit: 100 },
  });
  return data.sites;
}

// ── Hafif Sorgular ──────────────────────────────────────────────────

/**
 * Aktif site'ları hafif alanlarla getirir — dropdown, gruplama ve hızlı listeleme için.
 *
 * location, address, totalArea, siteManager, createdAt gibi detaylar dahil değildir.
 * Site bazlı gruplama veya filtreleme yapılacak analizlerde ağır sorgu yerine
 * bu variant tercih edilmelidir.
 */
export async function fetchActiveSitesLight(client: GraphQLClient): Promise<SiteLightInfo[]> {
  const query = `
    query ActiveSitesLight {
      activeSites {
        id
        name
        type
        status
      }
    }
  `;

  const data = await client.query<{ activeSites: SiteLightInfo[] }>(query);
  return data.activeSites;
}
