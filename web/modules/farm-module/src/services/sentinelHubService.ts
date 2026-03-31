/**
 * Sentinel Hub Service
 * Copernicus Data Space Ecosystem API wrapper
 *
 * Su kalitesi analizi katmanları:
 * - TRUE-COLOR: Gerçek renk görüntüsü
 * - CHLOROPHYLL: Klorofil-a (fitoplankton)
 * - CYANOBACTERIA: Siyanobakteri (mavi-yeşil alg)
 * - TURBIDITY: Bulanıklık
 * - CDOM: Çözünmüş organik madde
 * - TSS: Askıda katı madde
 * - NDVI: Bitki indeksi
 * - MOISTURE: Nem indeksi
 */

import { graphqlClient } from '@aquaculture/shared-ui';

/**
 * SEC-C14: Token query now only returns expiresIn (accessToken is @HideField).
 * This query is used solely to verify that Sentinel Hub credentials are working.
 * All actual API calls go through the backend proxy (/api/sentinel-hub/*).
 */
const SENTINEL_HUB_TOKEN_CHECK_QUERY = `
  query SentinelHubToken {
    sentinelHubToken {
      expiresIn
    }
  }
`;

/**
 * SEC-C14: Verify that Sentinel Hub credentials are configured and working.
 * Returns the expiresIn value if credentials are valid. The actual OAuth token
 * is never sent to the browser — it lives only on the backend.
 */
async function verifyCredentialsWithBackend(): Promise<number> {
  const data = await graphqlClient.request<{
    sentinelHubToken: { expiresIn: number } | null;
  }>(SENTINEL_HUB_TOKEN_CHECK_QUERY);

  if (!data.sentinelHubToken?.expiresIn) {
    throw new Error('Sentinel Hub yapılandırılmamış');
  }

  return data.sentinelHubToken.expiresIn;
}

// SentinelConfig is kept for type compatibility but the clientSecret
// must NEVER be included — the backend proxies OAuth token exchange.
export interface SentinelConfig {
  clientId?: string;
}

export interface ImageParams {
  bbox: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
  fromDate: Date;
  toDate: Date;
  width?: number;
  height?: number;
  layer?: LayerType;
}

export type LayerType =
  | 'TRUE-COLOR'
  | 'CHLOROPHYLL'
  | 'CYANOBACTERIA'
  | 'TURBIDITY'
  | 'CDOM'
  | 'TSS'
  | 'NDWI'
  | 'SECCHI'
  | 'NDVI'
  | 'MOISTURE';

export interface LayerInfo {
  id: LayerType;
  name: string;
  nameEn: string;
  icon: string;
  category: 'base' | 'water' | 'analysis';
  description: string;
}

// Available layers
export const SENTINEL_LAYERS: LayerInfo[] = [
  // Base layers
  {
    id: 'TRUE-COLOR',
    name: 'Gerçek Renk',
    nameEn: 'True Color',
    icon: '🌍',
    category: 'base',
    description: 'RGB görüntü - B04, B03, B02 bantları',
  },

  // Water quality layers (Aquaculture için kritik!)
  {
    id: 'CHLOROPHYLL',
    name: 'Klorofil-a',
    nameEn: 'Chlorophyll-a',
    icon: '🌿',
    category: 'water',
    description: 'Fitoplankton yoğunluğu göstergesi (mg/m³)',
  },
  {
    id: 'CYANOBACTERIA',
    name: 'Siyanobakteri',
    nameEn: 'Cyanobacteria',
    icon: '🦠',
    category: 'water',
    description: 'Mavi-yeşil alg blomu tespiti (HAB)',
  },
  {
    id: 'TURBIDITY',
    name: 'Bulanıklık',
    nameEn: 'Turbidity',
    icon: '🌫️',
    category: 'water',
    description: 'Su berraklığı ölçümü (NTU)',
  },
  {
    id: 'CDOM',
    name: 'Çözünmüş Organik Madde',
    nameEn: 'CDOM',
    icon: '🟤',
    category: 'water',
    description: 'Colored Dissolved Organic Matter',
  },
  {
    id: 'TSS',
    name: 'Askıda Katı Madde',
    nameEn: 'TSS',
    icon: '⚪',
    category: 'water',
    description: 'Total Suspended Solids (mg/L)',
  },
  {
    id: 'NDWI',
    name: 'Su İndeksi',
    nameEn: 'NDWI',
    icon: '💧',
    category: 'water',
    description: 'Normalized Difference Water Index - Su kütlesi tespiti',
  },
  {
    id: 'SECCHI',
    name: 'Şeffaflık Derinliği',
    nameEn: 'Secchi Depth',
    icon: '🔍',
    category: 'water',
    description: 'Su şeffaflığı derinlik tahmini (metre)',
  },

  // Analysis layers
  {
    id: 'NDVI',
    name: 'Bitki İndeksi',
    nameEn: 'NDVI',
    icon: '🌱',
    category: 'analysis',
    description: 'Normalized Difference Vegetation Index',
  },
  {
    id: 'MOISTURE',
    name: 'Nem İndeksi',
    nameEn: 'Moisture Index',
    icon: '💧',
    category: 'analysis',
    description: 'Normalized Difference Moisture Index',
  },
];

// Cache for images
const imageCache = new Map<string, { blob: Blob; expiry: Date }>();
const CACHE_DURATION_HOURS = 24;

/**
 * SEC-C14: CredentialManager replaces TokenManager.
 *
 * OAuth tokens no longer leave the backend. This manager tracks only whether
 * Sentinel Hub credentials are configured and valid by calling the backend's
 * token-check query (which returns expiresIn but NOT the accessToken itself).
 *
 * All Sentinel Hub API calls are now proxied through the backend endpoints
 * at /api/sentinel-hub/*, which inject the OAuth token server-side.
 */
class CredentialManager {
  private verified = false;
  private expiry: number = 0;
  private verifyPromise: Promise<void> | null = null;
  private refreshBuffer: number = 60000; // Refresh 60s before expiry

  /**
   * Check if credentials have been recently verified
   */
  private isVerified(): boolean {
    return this.verified && Date.now() < this.expiry - this.refreshBuffer;
  }

  /**
   * Ensure credentials are verified (backend has a working token)
   */
  async ensureVerified(): Promise<void> {
    if (this.isVerified()) return;

    if (this.verifyPromise) {
      return this.verifyPromise;
    }

    this.verifyPromise = this.verify();
    try {
      await this.verifyPromise;
    } finally {
      this.verifyPromise = null;
    }
  }

  /**
   * Verify credentials with the backend
   */
  private async verify(): Promise<void> {
    const maxRetries = 2;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const expiresIn = await verifyCredentialsWithBackend();
        this.verified = true;
        this.expiry = Date.now() + expiresIn * 1000;
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
        }
      }
    }

    throw lastError || new Error('Token alınamadı');
  }

  /**
   * Mark credentials as needing re-verification
   */
  invalidate(): void {
    this.verified = false;
    this.expiry = 0;
  }

  /**
   * Get credential status
   */
  getStatus(): { hasToken: boolean; expiresIn: number | null } {
    return {
      hasToken: this.verified,
      expiresIn: this.verified ? Math.max(0, Math.floor((this.expiry - Date.now()) / 1000)) : null,
    };
  }
}

/** Singleton instance */
const credentialManager = new CredentialManager();

/**
 * SEC-C14: Ensure backend credentials are verified.
 * Returns a placeholder string since the actual token lives on the backend.
 * Retained for API compatibility with sentinelTileService imports.
 */
export async function getValidToken(): Promise<string> {
  await credentialManager.ensureVerified();
  return 'proxy-managed';
}

/**
 * Invalidate cached credential verification (call on 401 errors from proxy)
 */
export function invalidateToken(): void {
  credentialManager.invalidate();
}

/**
 * Get credential status for debugging
 */
export function getTokenStatus(): { hasToken: boolean; expiresIn: number | null } {
  return credentialManager.getStatus();
}

/**
 * Initialize Sentinel Hub — verifies backend credentials are working.
 * SEC-C14: No tokens are stored in the browser.
 */
export async function initSentinelHub(_config?: SentinelConfig): Promise<void> {
  try {
    await credentialManager.ensureVerified();
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Sentinel Hub kimlik doğrulama başarısız');
  }
}

/**
 * SEC-C14: Proxy URL for backend Processing API calls.
 * The backend injects the OAuth token server-side.
 */
const PROXY_PROCESS_URL = '/api/sentinel-hub/process';

/**
 * Get satellite image for a bounding box via backend proxy.
 *
 * SEC-C14: The image request is sent to the backend proxy, which injects
 * the OAuth token server-side and forwards to Sentinel Hub. No token
 * is present in the browser.
 *
 * @param params Image request parameters
 * @param _accessToken Deprecated — tokens are managed server-side
 */
export async function getSatelliteImage(
  params: ImageParams,
  _accessToken?: string,
): Promise<Blob> {
  const cacheKey = `${params.bbox.join(',')}-${params.fromDate.toISOString()}-${params.layer}`;

  // Check cache
  const cached = imageCache.get(cacheKey);
  if (cached && cached.expiry > new Date()) {
    return cached.blob;
  }

  await credentialManager.ensureVerified();

  const evalscript = getEvalscript(params.layer || 'TRUE-COLOR');

  try {
    // SEC-C14: Route through backend proxy instead of direct CDSE call
    const queryParams = new URLSearchParams({
      bbox: params.bbox.join(','),
      fromDate: params.fromDate.toISOString(),
      toDate: params.toDate.toISOString(),
      width: String(params.width || 512),
      height: String(params.height || 512),
      evalscript: encodeURIComponent(evalscript),
    });

    const response = await fetch(`${PROXY_PROCESS_URL}?${queryParams.toString()}`);

    if (!response.ok) {
      throw new Error(`Proxy returned ${response.status}`);
    }

    const blob = await response.blob();

    // Cache result
    imageCache.set(cacheKey, {
      blob,
      expiry: new Date(Date.now() + CACHE_DURATION_HOURS * 3600 * 1000),
    });

    return blob;
  } catch (error) {
    if (import.meta.env.DEV) console.error('Failed to get satellite image:', error);
    throw new Error('Uydu görüntüsü alınamadı. Lütfen daha sonra tekrar deneyin.');
  }
}

/**
 * Get available satellite image dates for a location via backend proxy.
 *
 * SEC-C14: Catalog search is now proxied through the backend.
 * The backend injects the OAuth token server-side.
 *
 * @param _accessToken Deprecated — tokens are managed server-side
 */
export async function getAvailableDates(
  bbox: [number, number, number, number],
  fromDate: Date,
  toDate: Date,
  _accessToken?: string,
): Promise<Date[]> {
  await credentialManager.ensureVerified();

  try {
    const queryParams = new URLSearchParams({
      bbox: bbox.join(','),
      fromDate: fromDate.toISOString(),
      toDate: toDate.toISOString(),
      collections: 'sentinel-2-l2a',
    });

    const response = await fetch(`/api/sentinel-hub/catalog/search?${queryParams.toString()}`);

    if (!response.ok) {
      return [];
    }

    const data = await response.json();

    // Extract dates from STAC catalog features
    if (data.features && Array.isArray(data.features)) {
      const dates: Date[] = data.features
        .map((f: { properties?: { datetime?: string } }) => f.properties?.datetime)
        .filter(Boolean)
        .map((d: string) => new Date(d));
      return dates;
    }

    return [];
  } catch (error) {
    if (import.meta.env.DEV) console.error('Failed to get available dates:', error);
    return [];
  }
}

/**
 * Clear image cache
 */
export function clearCache(): void {
  imageCache.clear();
}

/**
 * Get evalscript for different visualizations
 * Kaynak: https://custom-scripts.sentinel-hub.com/
 */
function getEvalscript(layer: LayerType): string {
  const scripts: Record<LayerType, string> = {
    // ============================================
    // TEMEL KATMAN
    // ============================================
    'TRUE-COLOR': `
      //VERSION=3
      function setup() {
        return { input: ["B04", "B03", "B02"], output: { bands: 3 } };
      }
      function evaluatePixel(sample) {
        return [2.5 * sample.B04, 2.5 * sample.B03, 2.5 * sample.B02];
      }
    `,

    // ============================================
    // SU KALİTESİ KATMANLARI (AQUACULTURE İÇİN!)
    // ============================================

    // Klorofil-a (Chl-a) - Fitoplankton yoğunluğu göstergesi
    // Referans: Se2WaQ Script
    'CHLOROPHYLL': `
      //VERSION=3
      function setup() {
        return { input: ["B02", "B03", "B04"], output: { bands: 3 } };
      }
      function evaluatePixel(sample) {
        // Chl-a = 4.26 * (B03/B01)^3.94 mg/m³
        let ratio = sample.B03 / sample.B02;
        let chl_a = 4.26 * Math.pow(ratio, 3.94);

        // Renk skalası: Düşük (mavi) -> Orta (yeşil) -> Yüksek (kırmızı)
        if (chl_a < 5) return [0.1, 0.3, 0.8];      // Düşük - Mavi
        if (chl_a < 10) return [0.2, 0.6, 0.8];     // Düşük-Orta - Açık Mavi
        if (chl_a < 20) return [0.3, 0.8, 0.3];     // Orta - Yeşil
        if (chl_a < 50) return [0.8, 0.8, 0.2];     // Yüksek - Sarı
        if (chl_a < 100) return [0.9, 0.5, 0.1];    // Çok Yüksek - Turuncu
        return [0.9, 0.2, 0.2];                      // Aşırı - Kırmızı (Bloom!)
      }
    `,

    // Siyanobakteri (Mavi-Yeşil Alg) - HAB Tespiti
    // Referans: CyanoLakes NDCI + Se2WaQ
    'CYANOBACTERIA': `
      //VERSION=3
      function setup() {
        return { input: ["B02", "B03", "B04", "B05"], output: { bands: 3 } };
      }
      function evaluatePixel(sample) {
        // NDCI = (B05 - B04) / (B05 + B04)
        let ndci = (sample.B05 - sample.B04) / (sample.B05 + sample.B04);

        // Siyanobakteri hücre yoğunluğu tahmini (10³ cells/ml)
        // Cya = 115530.31 * (B03 * B04 / B02)^2.38
        let cya = 115530.31 * Math.pow((sample.B03 * sample.B04) / sample.B02, 2.38);

        // Floating Algal Index (FAI) - Yüzey blomu tespiti
        let fai = sample.B05 - (sample.B04 + (sample.B03 - sample.B04) * 0.5);

        // Renk skalası
        if (cya < 10000) return [0.1, 0.4, 0.8];      // Güvenli - Mavi
        if (cya < 50000) return [0.3, 0.7, 0.4];      // Düşük - Yeşil
        if (cya < 100000) return [0.9, 0.9, 0.2];     // Dikkat - Sarı
        if (cya < 500000) return [0.9, 0.5, 0.1];     // Uyarı - Turuncu
        return [0.9, 0.1, 0.1];                        // TEHLİKE - Kırmızı (Bloom!)
      }
    `,

    // Bulanıklık (Turbidity) - NTU
    'TURBIDITY': `
      //VERSION=3
      function setup() {
        return { input: ["B01", "B03", "B04"], output: { bands: 3 } };
      }
      function evaluatePixel(sample) {
        // Turb = 8.93 * (B03/B01) - 6.39 NTU
        let turb = 8.93 * (sample.B03 / sample.B01) - 6.39;
        turb = Math.max(0, turb);

        // Renk skalası
        if (turb < 5) return [0.1, 0.5, 0.9];       // Berrak - Mavi
        if (turb < 10) return [0.3, 0.7, 0.8];      // Hafif - Açık Mavi
        if (turb < 25) return [0.5, 0.8, 0.5];      // Orta - Yeşil
        if (turb < 50) return [0.8, 0.7, 0.3];      // Bulanık - Sarı
        if (turb < 100) return [0.8, 0.5, 0.2];     // Çok Bulanık - Turuncu
        return [0.6, 0.4, 0.3];                      // Aşırı - Kahverengi
      }
    `,

    // Çözünmüş Organik Madde (CDOM)
    'CDOM': `
      //VERSION=3
      function setup() {
        return { input: ["B02", "B03", "B04"], output: { bands: 3 } };
      }
      function evaluatePixel(sample) {
        // CDOM indeksi
        let cdom = (sample.B04 - sample.B02) / sample.B03;

        // Renk skalası
        if (cdom < 0.1) return [0.2, 0.6, 0.9];     // Düşük - Mavi
        if (cdom < 0.3) return [0.4, 0.7, 0.6];     // Orta - Turkuaz
        if (cdom < 0.5) return [0.6, 0.6, 0.3];     // Yüksek - Olive
        return [0.5, 0.3, 0.1];                      // Çok Yüksek - Kahve
      }
    `,

    // Askıda Katı Madde (TSS - Total Suspended Solids)
    // Nechad algoritması: TSS = A * ρw / (1 - ρw/C)
    'TSS': `
      //VERSION=3
      function setup() {
        return { input: ["B02", "B04", "dataMask"], output: { bands: 4 } };
      }
      function evaluatePixel(sample) {
        // Nechad algoritması parametreleri (B04 için)
        let A = 355.85;
        let C = 0.1728;
        let rho = sample.B04;

        // TSS tahmini (mg/L)
        let tss = A * rho / (1 - rho/C);
        tss = Math.max(0, Math.min(tss, 500)); // 0-500 mg/L arası sınırla

        // Renk skalası
        let r, g, b;
        if (tss < 10) { r = 0.1; g = 0.4; b = 0.8; }       // Temiz - Mavi
        else if (tss < 25) { r = 0.3; g = 0.6; b = 0.7; }  // Normal - Açık Mavi
        else if (tss < 50) { r = 0.5; g = 0.7; b = 0.4; }  // Orta - Yeşil
        else if (tss < 100) { r = 0.7; g = 0.6; b = 0.3; } // Yüksek - Sarı-Kahve
        else { r = 0.6; g = 0.4; b = 0.2; }                // Çok Yüksek - Kahve
        return [r, g, b, sample.dataMask];
      }
    `,

    // Su İndeksi (NDWI) - McFeeters
    'NDWI': `
      //VERSION=3
      function setup() {
        return { input: ["B03", "B08", "dataMask"], output: { bands: 4 } };
      }
      function evaluatePixel(sample) {
        // NDWI = (Green - NIR) / (Green + NIR)
        let ndwi = (sample.B03 - sample.B08) / (sample.B03 + sample.B08 + 0.0001);

        // Renk skalası: Su pozitif, kara negatif
        let r, g, b;
        if (ndwi > 0.5) { r = 0.0; g = 0.2; b = 0.8; }      // Derin su - Koyu mavi
        else if (ndwi > 0.3) { r = 0.1; g = 0.4; b = 0.9; } // Su - Mavi
        else if (ndwi > 0.1) { r = 0.3; g = 0.6; b = 0.9; } // Sığ su - Açık mavi
        else if (ndwi > 0) { r = 0.5; g = 0.8; b = 0.9; }   // Su kenarı - Turkuaz
        else if (ndwi > -0.2) { r = 0.8; g = 0.9; b = 0.7; }// Nemli - Açık yeşil
        else { r = 0.6; g = 0.5; b = 0.4; }                 // Kara - Kahve
        return [r, g, b, sample.dataMask];
      }
    `,

    // Secchi Derinliği (Su Şeffaflığı)
    // Ampirik formül: SD = exp(a - b * ln(Rrs490/Rrs560))
    'SECCHI': `
      //VERSION=3
      function setup() {
        return { input: ["B02", "B03", "B04", "dataMask"], output: { bands: 4 } };
      }
      function evaluatePixel(sample) {
        // Basit şeffaflık indeksi (B02/B04 oranı)
        let ratio = Math.log(sample.B02 / (sample.B04 + 0.0001));

        // Secchi derinliği tahmini (metre)
        // Ampirik katsayılar kıyı suları için
        let secchi = 1.47 * Math.exp(1.22 * ratio);
        secchi = Math.max(0.1, Math.min(secchi, 30)); // 0.1-30m arası

        // Renk skalası
        let r, g, b;
        if (secchi > 10) { r = 0.0; g = 0.3; b = 0.9; }     // Çok berrak - Koyu mavi
        else if (secchi > 5) { r = 0.1; g = 0.5; b = 0.9; } // Berrak - Mavi
        else if (secchi > 2) { r = 0.3; g = 0.7; b = 0.8; } // Orta - Açık mavi
        else if (secchi > 1) { r = 0.5; g = 0.8; b = 0.5; } // Düşük - Yeşil
        else if (secchi > 0.5) { r = 0.8; g = 0.7; b = 0.3; }// Bulanık - Sarı
        else { r = 0.6; g = 0.4; b = 0.2; }                  // Çok bulanık - Kahve
        return [r, g, b, sample.dataMask];
      }
    `,

    // ============================================
    // DİĞER ANALİZLER
    // ============================================

    'NDVI': `
      //VERSION=3
      function setup() {
        return { input: ["B04", "B08"], output: { bands: 3 } };
      }
      function evaluatePixel(sample) {
        let ndvi = (sample.B08 - sample.B04) / (sample.B08 + sample.B04);
        if (ndvi < 0) return [0.5, 0, 0];           // Su/Çıplak - Kırmızı
        if (ndvi < 0.2) return [0.8, 0.4, 0.2];     // Çok Az - Turuncu
        if (ndvi < 0.4) return [1, 0.8, 0];         // Az - Sarı
        if (ndvi < 0.6) return [0.6, 0.9, 0.2];     // Orta - Açık Yeşil
        return [0.1, 0.6, 0.1];                      // Yoğun - Koyu Yeşil
      }
    `,

    'MOISTURE': `
      //VERSION=3
      function setup() {
        return { input: ["B8A", "B11"], output: { bands: 3 } };
      }
      function evaluatePixel(sample) {
        let ndmi = (sample.B8A - sample.B11) / (sample.B8A + sample.B11);
        if (ndmi < -0.4) return [0.8, 0.2, 0.2];    // Çok Kuru - Kırmızı
        if (ndmi < 0) return [0.9, 0.6, 0.3];       // Kuru - Turuncu
        if (ndmi < 0.2) return [1, 0.9, 0.5];       // Normal - Sarı
        if (ndmi < 0.4) return [0.5, 0.8, 0.5];     // Nemli - Yeşil
        return [0.2, 0.4, 0.8];                      // Çok Nemli - Mavi
      }
    `,
  };

  return scripts[layer] || scripts['TRUE-COLOR'];
}

/**
 * Get layer legend info
 */
export function getLayerLegend(layer: LayerType): { color: string; label: string }[] {
  const legends: Record<LayerType, { color: string; label: string }[]> = {
    'TRUE-COLOR': [],
    'CHLOROPHYLL': [
      { color: 'rgb(26, 77, 204)', label: '< 5 mg/m³ (Düşük)' },
      { color: 'rgb(51, 153, 204)', label: '5-10 mg/m³' },
      { color: 'rgb(77, 204, 77)', label: '10-20 mg/m³' },
      { color: 'rgb(204, 204, 51)', label: '20-50 mg/m³' },
      { color: 'rgb(230, 128, 26)', label: '50-100 mg/m³' },
      { color: 'rgb(230, 51, 51)', label: '> 100 mg/m³ (Bloom!)' },
    ],
    'CYANOBACTERIA': [
      { color: 'rgb(26, 102, 204)', label: '< 10K cells/ml (Güvenli)' },
      { color: 'rgb(77, 179, 102)', label: '10K-50K cells/ml' },
      { color: 'rgb(230, 230, 51)', label: '50K-100K cells/ml (Dikkat)' },
      { color: 'rgb(230, 128, 26)', label: '100K-500K cells/ml (Uyarı)' },
      { color: 'rgb(230, 26, 26)', label: '> 500K cells/ml (TEHLİKE!)' },
    ],
    'TURBIDITY': [
      { color: 'rgb(26, 128, 230)', label: '< 5 NTU (Berrak)' },
      { color: 'rgb(77, 179, 204)', label: '5-10 NTU' },
      { color: 'rgb(128, 204, 128)', label: '10-25 NTU' },
      { color: 'rgb(204, 179, 77)', label: '25-50 NTU' },
      { color: 'rgb(204, 128, 51)', label: '50-100 NTU' },
      { color: 'rgb(153, 102, 77)', label: '> 100 NTU (Çok Bulanık)' },
    ],
    'CDOM': [
      { color: 'rgb(51, 153, 230)', label: '< 0.1 (Düşük)' },
      { color: 'rgb(102, 179, 153)', label: '0.1-0.3' },
      { color: 'rgb(153, 153, 77)', label: '0.3-0.5' },
      { color: 'rgb(128, 77, 26)', label: '> 0.5 (Yüksek)' },
    ],
    'TSS': [
      { color: 'rgb(26, 102, 204)', label: '< 10 mg/L (Temiz)' },
      { color: 'rgb(77, 153, 179)', label: '10-25 mg/L' },
      { color: 'rgb(128, 179, 102)', label: '25-50 mg/L' },
      { color: 'rgb(179, 153, 77)', label: '50-100 mg/L' },
      { color: 'rgb(153, 102, 51)', label: '> 100 mg/L (Yüksek)' },
    ],
    'NDWI': [
      { color: 'rgb(0, 51, 204)', label: '> 0.5 (Derin Su)' },
      { color: 'rgb(26, 102, 230)', label: '0.3-0.5 (Su)' },
      { color: 'rgb(77, 153, 230)', label: '0.1-0.3 (Sığ Su)' },
      { color: 'rgb(128, 204, 230)', label: '0-0.1 (Su Kenarı)' },
      { color: 'rgb(204, 230, 179)', label: '-0.2-0 (Nemli)' },
      { color: 'rgb(153, 128, 102)', label: '< -0.2 (Kara)' },
    ],
    'SECCHI': [
      { color: 'rgb(0, 77, 230)', label: '> 10m (Çok Berrak)' },
      { color: 'rgb(26, 128, 230)', label: '5-10m (Berrak)' },
      { color: 'rgb(77, 179, 204)', label: '2-5m (Orta)' },
      { color: 'rgb(128, 204, 128)', label: '1-2m (Düşük)' },
      { color: 'rgb(204, 179, 77)', label: '0.5-1m (Bulanık)' },
      { color: 'rgb(153, 102, 51)', label: '< 0.5m (Çok Bulanık)' },
    ],
    'NDVI': [
      { color: 'rgb(128, 0, 0)', label: '< 0 (Su/Çıplak)' },
      { color: 'rgb(204, 102, 51)', label: '0-0.2' },
      { color: 'rgb(255, 204, 0)', label: '0.2-0.4' },
      { color: 'rgb(153, 230, 51)', label: '0.4-0.6' },
      { color: 'rgb(26, 153, 26)', label: '> 0.6 (Yoğun Bitki)' },
    ],
    'MOISTURE': [
      { color: 'rgb(204, 51, 51)', label: '< -0.4 (Çok Kuru)' },
      { color: 'rgb(230, 153, 77)', label: '-0.4 - 0' },
      { color: 'rgb(255, 230, 128)', label: '0 - 0.2' },
      { color: 'rgb(128, 204, 128)', label: '0.2 - 0.4' },
      { color: 'rgb(51, 102, 204)', label: '> 0.4 (Çok Nemli)' },
    ],
  };

  return legends[layer] || [];
}
