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

import {
  setAuthToken,
  BBox,
  CRS_EPSG4326,
  MimeTypes,
  ApiType,
  S2L2ALayer,
} from '@sentinel-hub/sentinelhub-js';

// GraphQL query to get token from backend (proxied to avoid CORS)
const SENTINEL_HUB_TOKEN_QUERY = `
  query SentinelHubToken {
    sentinelHubToken {
      accessToken
      expiresIn
    }
  }
`;

/**
 * Request OAuth token from backend (which proxies to CDSE)
 * This avoids CORS issues since browser can't call CDSE directly
 */
async function requestTokenFromBackend(): Promise<string> {
  const authToken = localStorage.getItem('access_token');
  if (!authToken) {
    throw new Error('Oturum açmanız gerekiyor');
  }

  const response = await fetch('/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ query: SENTINEL_HUB_TOKEN_QUERY }),
  });

  if (!response.ok) {
    throw new Error(`HTTP error: ${response.status}`);
  }

  const result = await response.json();

  if (result.errors) {
    console.error('GraphQL errors:', result.errors);
    throw new Error(result.errors[0]?.message || 'Token alınamadı');
  }

  if (!result.data?.sentinelHubToken) {
    throw new Error('Sentinel Hub yapılandırılmamış');
  }

  return result.data.sentinelHubToken.accessToken;
}

// Types
export interface SentinelConfig {
  clientId: string;
  clientSecret: string;
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
 * TokenManager - Sentinel Hub CDSE token yönetimi
 * - Otomatik token yenileme (expiry öncesi)
 * - Thread-safe (birden fazla eşzamanlı istek için)
 * - Error retry mekanizması
 */
class TokenManager {
  private token: string | null = null;
  private expiry: number = 0;
  private refreshPromise: Promise<string> | null = null;
  private refreshBuffer: number = 60000; // 60 saniye önce yenile

  /**
   * Token geçerli mi kontrol et
   */
  private isTokenValid(): boolean {
    return !!(this.token && Date.now() < this.expiry - this.refreshBuffer);
  }

  /**
   * Geçerli bir token al (gerekirse yenile)
   */
  async getValidToken(): Promise<string> {
    // Token hala geçerliyse direkt döndür
    if (this.isTokenValid()) {
      return this.token!;
    }

    // Zaten bir yenileme işlemi varsa onu bekle
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    // Yeni token al
    this.refreshPromise = this.refreshToken();

    try {
      const token = await this.refreshPromise;
      return token;
    } finally {
      this.refreshPromise = null;
    }
  }

  /**
   * Backend'den yeni token al
   */
  private async refreshToken(): Promise<string> {
    const maxRetries = 2;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const token = await requestTokenFromBackend();

        // Token'ı kaydet
        this.token = token;
        this.expiry = Date.now() + 1800 * 1000; // 30 dakika

        // Sentinel Hub JS library için de ayarla
        setAuthToken(token);

        return token;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < maxRetries) {
          // Exponential backoff
          await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
        }
      }
    }

    throw lastError || new Error('Token alınamadı');
  }

  /**
   * Mevcut token'ı geçersiz kıl (401 hatasında kullanılır)
   */
  invalidate(): void {
    this.token = null;
    this.expiry = 0;
  }

  /**
   * Token durumu
   */
  getStatus(): { hasToken: boolean; expiresIn: number | null } {
    return {
      hasToken: !!this.token,
      expiresIn: this.token ? Math.max(0, Math.floor((this.expiry - Date.now()) / 1000)) : null,
    };
  }
}

// Singleton instance
const tokenManager = new TokenManager();

/**
 * Get valid token for Sentinel Hub API calls
 * Use this from other services (like sentinelTileService)
 */
export async function getValidToken(): Promise<string> {
  return tokenManager.getValidToken();
}

/**
 * Invalidate current token (call on 401 errors)
 */
export function invalidateToken(): void {
  tokenManager.invalidate();
}

/**
 * Get token status for debugging
 */
export function getTokenStatus(): { hasToken: boolean; expiresIn: number | null } {
  return tokenManager.getStatus();
}

/**
 * Initialize Sentinel Hub with credentials
 * Gets token from backend (which proxies to CDSE to avoid CORS)
 */
export async function initSentinelHub(_config?: SentinelConfig): Promise<void> {
  try {
    await tokenManager.getValidToken();
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Sentinel Hub kimlik doğrulama başarısız');
  }
}

/**
 * Ensure we have a valid token
 */
async function ensureValidToken(): Promise<void> {
  await tokenManager.getValidToken();
}

/**
 * Get satellite image for a bounding box
 */
export async function getSatelliteImage(
  params: ImageParams,
  _config?: SentinelConfig  // Config is no longer needed, kept for backward compatibility
): Promise<Blob> {
  const cacheKey = `${params.bbox.join(',')}-${params.fromDate.toISOString()}-${params.layer}`;

  // Check cache
  const cached = imageCache.get(cacheKey);
  if (cached && cached.expiry > new Date()) {
    console.log('Returning cached image for:', cacheKey);
    return cached.blob;
  }

  await ensureValidToken();

  const evalscript = getEvalscript(params.layer || 'TRUE-COLOR');

  const layer = new S2L2ALayer({
    evalscript,
  });

  const bbox = new BBox(
    CRS_EPSG4326,
    params.bbox[0], // minLon
    params.bbox[1], // minLat
    params.bbox[2], // maxLon
    params.bbox[3]  // maxLat
  );

  const getMapParams = {
    bbox,
    fromTime: params.fromDate,
    toTime: params.toDate,
    width: params.width || 512,
    height: params.height || 512,
    format: MimeTypes.PNG,
  };

  try {
    const blob = await layer.getMap(getMapParams, ApiType.PROCESSING);

    // Cache result
    imageCache.set(cacheKey, {
      blob,
      expiry: new Date(Date.now() + CACHE_DURATION_HOURS * 3600 * 1000),
    });

    return blob;
  } catch (error) {
    console.error('Failed to get satellite image:', error);
    throw new Error('Uydu görüntüsü alınamadı. Lütfen daha sonra tekrar deneyin.');
  }
}

/**
 * Get available satellite image dates for a location
 */
export async function getAvailableDates(
  bbox: [number, number, number, number],
  fromDate: Date,
  toDate: Date,
  _config?: SentinelConfig  // Config is no longer needed, kept for backward compatibility
): Promise<Date[]> {
  await ensureValidToken();

  const layer = new S2L2ALayer({});
  const bboxObj = new BBox(CRS_EPSG4326, bbox[0], bbox[1], bbox[2], bbox[3]);

  try {
    const dates = await layer.findDatesUTC(bboxObj, fromDate, toDate);
    return dates;
  } catch (error) {
    console.error('Failed to get available dates:', error);
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
