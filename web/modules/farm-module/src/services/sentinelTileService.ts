/**
 * Sentinel Tile Service
 *
 * WMTS/XYZ tile URL generation for Sentinel Hub.
 * Provides seamless satellite imagery coverage across the entire map.
 *
 * Copernicus Data Space Ecosystem WMTS endpoints:
 * - https://sh.dataspace.copernicus.eu/ogc/wmts
 * - Requires Configuration Instance ID for custom evalscripts
 */

import { LayerType, getValidToken, invalidateToken } from './sentinelHubService';

// CDSE Sentinel Hub endpoints
const CDSE_PROCESS_URL = 'https://sh.dataspace.copernicus.eu/api/v1/process';

// =============================================================================
// Rate Limiting - 429 Too Many Requests önleme
// =============================================================================

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Request Queue - Sıralı istek kuyruğu
 * Rate limiting'i önlemek için istekleri sıraya koyar
 */
class RequestQueue {
  private queue: Array<{
    request: () => Promise<any>;
    resolve: (value: any) => void;
    reject: (error: any) => void;
  }> = [];
  private activeRequests = 0;
  private maxConcurrent: number;
  private minDelay: number;
  private lastRequestTime = 0;
  private isProcessing = false;

  constructor(maxConcurrent = 3, minDelay = 200) {
    this.maxConcurrent = maxConcurrent;
    this.minDelay = minDelay;
  }

  /**
   * İsteği kuyruğa ekle ve sonucu bekle
   */
  async enqueue<T>(request: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ request, resolve, reject });
      this.processQueue();
    });
  }

  /**
   * Kuyruğu işle
   */
  private async processQueue(): Promise<void> {
    // Zaten işleniyorsa veya limit aşıldıysa bekle
    if (this.isProcessing) return;

    this.isProcessing = true;

    while (this.queue.length > 0 && this.activeRequests < this.maxConcurrent) {
      const item = this.queue.shift();
      if (!item) continue;

      // Minimum delay kontrolü
      const timeSinceLastRequest = Date.now() - this.lastRequestTime;
      if (timeSinceLastRequest < this.minDelay) {
        await sleep(this.minDelay - timeSinceLastRequest);
      }

      this.activeRequests++;
      this.lastRequestTime = Date.now();

      // İsteği başlat (await etmeden devam et)
      this.executeRequest(item);
    }

    this.isProcessing = false;
  }

  /**
   * Tek bir isteği çalıştır
   */
  private async executeRequest(item: {
    request: () => Promise<any>;
    resolve: (value: any) => void;
    reject: (error: any) => void;
  }): Promise<void> {
    try {
      const result = await item.request();
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    } finally {
      this.activeRequests--;
      // Bir sonraki isteği başlat
      setTimeout(() => this.processQueue(), this.minDelay);
    }
  }

  /**
   * Kuyruk durumunu getir
   */
  getStatus(): { pending: number; active: number } {
    return {
      pending: this.queue.length,
      active: this.activeRequests,
    };
  }

  /**
   * Kuyruğu temizle
   */
  clear(): void {
    // Bekleyen istekleri iptal et
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (item) {
        item.reject(new Error('Queue cleared'));
      }
    }
  }
}

// Global request queue instance
// IMPORTANT: Sentinel Hub Processing API has strict rate limits (~10-30 requests/minute)
// Using conservative settings to prevent 429 errors:
// - maxConcurrent: 1 (only one request at a time)
// - minDelay: 1000ms (1 second between requests)
const requestQueue = new RequestQueue(1, 1000);

/**
 * Export queue status for debugging
 */
export function getQueueStatus(): { pending: number; active: number } {
  return requestQueue.getStatus();
}

/**
 * Clear the request queue
 */
export function clearRequestQueue(): void {
  requestQueue.clear();
}

/**
 * Fetch with retry and exponential backoff
 * 429 hatası alındığında bekleyip tekrar dener
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      // 429 Too Many Requests - rate limited
      if (response.status === 429) {
        if (attempt === maxRetries) {
          console.error(`[TileService] 429 Rate Limited - max retries exceeded`);
          return response;
        }

        // Retry-After header'ı kontrol et
        const retryAfter = response.headers.get('Retry-After');
        let delay: number;

        if (retryAfter) {
          // Retry-After değeri saniye cinsinden
          delay = parseInt(retryAfter, 10) * 1000;
        } else {
          // Exponential backoff: 1s, 2s, 4s, 8s...
          delay = Math.pow(2, attempt) * 1000;
        }

        console.warn(
          `[TileService] 429 Rate Limited - attempt ${attempt + 1}/${maxRetries + 1}, waiting ${delay}ms...`
        );
        await sleep(delay);
        continue;
      }

      return response;
    } catch (error) {
      if (attempt === maxRetries) {
        throw error;
      }

      // Network hatası için de exponential backoff
      const delay = Math.pow(2, attempt) * 1000;
      console.warn(
        `[TileService] Network error - attempt ${attempt + 1}/${maxRetries + 1}, waiting ${delay}ms...`
      );
      await sleep(delay);
    }
  }

  throw new Error('Max retries exceeded');
}
const CDSE_CATALOG_URL = 'https://sh.dataspace.copernicus.eu/api/v1/catalog/1.0.0/search';
const CDSE_WMTS_URL = 'https://sh.dataspace.copernicus.eu/ogc/wmts';

// Tile size (standard web map tile)
export const TILE_SIZE = 256;

// PU cost per tile (approximate)
export const PU_PER_TILE = 0.1;

// WMTS layer name mapping (must match Configuration Instance layer names)
// NOTE: WMTS can only use predefined layers in Configuration Instance
// For custom water quality algorithms, use Processing API instead
const WMTS_LAYER_NAMES: Record<LayerType, string> = {
  'TRUE-COLOR': 'TRUE_COLOR',
  'CHLOROPHYLL': 'CHL_RED_EDGE',      // Proxy - Gerçek Chl-a için Processing API kullan
  'CYANOBACTERIA': 'NDWI',            // Proxy - Gerçek siyanobakteri için Processing API kullan
  'TURBIDITY': 'FALSE_COLOR',         // Proxy - Gerçek bulanıklık için Processing API kullan
  'CDOM': 'BATHYMETRIC',              // Proxy - Gerçek CDOM için Processing API kullan
  'TSS': 'FALSE_COLOR_URBAN',         // Proxy - Gerçek TSS için Processing API kullan
  'NDWI': 'NDWI',                     // Configuration Instance'da mevcut
  'SECCHI': 'BATHYMETRIC',            // Proxy - Gerçek Secchi için Processing API kullan
  'NDVI': 'NDVI',
  'MOISTURE': 'MOISTURE_INDEX',
};

// Water quality layers that require Processing API for accurate results
const WATER_QUALITY_LAYERS: LayerType[] = [
  'CHLOROPHYLL',
  'CYANOBACTERIA',
  'TURBIDITY',
  'CDOM',
  'TSS',
  'SECCHI',
];

/**
 * Check if a layer requires Processing API for accurate results
 * Water quality layers need Processing API with custom evalscripts
 */
export function requiresProcessingAPI(layer: LayerType): boolean {
  return WATER_QUALITY_LAYERS.includes(layer);
}

/**
 * Get the recommended API for a layer
 */
export function getRecommendedAPI(layer: LayerType): 'WMTS' | 'PROCESSING' {
  return requiresProcessingAPI(layer) ? 'PROCESSING' : 'WMTS';
}

/**
 * Generate WMTS tile URL for Leaflet TileLayer
 * Uses CDSE (Copernicus Data Space Ecosystem) WMTS endpoint
 *
 * IMPORTANT: This requires a Configuration Instance to be created in Sentinel Hub Dashboard
 * with layers matching the WMTS_LAYER_NAMES above.
 *
 * NOTE: For water quality layers, WMTS uses proxy layers which may not be accurate.
 * Use Processing API for accurate water quality results.
 *
 * @param instanceId - Configuration Instance ID from Sentinel Hub Dashboard
 * @param layer - Layer type to display
 * @param date - Date for satellite imagery
 * @param token - Access token from CDSE
 * @returns URL template for Leaflet TileLayer (with {z}, {x}, {y} placeholders)
 */
export function getWMTSTileUrl(
  instanceId: string,
  layer: LayerType,
  date: Date,
  token: string
): string {
  const layerName = WMTS_LAYER_NAMES[layer];

  // Calculate date range: 30 days before the selected date
  // This ensures we get best available imagery within that period
  const endDate = date.toISOString().split('T')[0];
  const startDate = new Date(date);
  startDate.setDate(startDate.getDate() - 30);
  const startDateStr = startDate.toISOString().split('T')[0];

  // WMTS GetTile URL with Leaflet placeholder format
  // Note: Token is optional for public Configuration Instances
  // Using date range instead of single date for better mosaic selection
  const baseUrl = `${CDSE_WMTS_URL}/${instanceId}` +
    `?layer=${layerName}` +
    `&tilematrixset=PopularWebMercator256` +
    `&Service=WMTS&Request=GetTile&Version=1.0.0` +
    `&Format=image/png` +
    `&TileMatrix={z}&TileCol={x}&TileRow={y}` +
    `&TIME=${startDateStr}/${endDate}` +
    `&showLogo=false`;

  // Add token if provided (for private instances)
  return token ? `${baseUrl}&token=${token}` : baseUrl;
}

/**
 * Convert tile coordinates (x, y, z) to bounding box (EPSG:4326)
 * Note: This is used for backward compatibility but not recommended for tile rendering
 */
export function tileToBBox(x: number, y: number, z: number): [number, number, number, number] {
  const n = Math.pow(2, z);
  const minLon = (x / n) * 360 - 180;
  const maxLon = ((x + 1) / n) * 360 - 180;

  const minLatRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)));
  const maxLatRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));

  const minLat = minLatRad * (180 / Math.PI);
  const maxLat = maxLatRad * (180 / Math.PI);

  return [minLon, minLat, maxLon, maxLat];
}

/**
 * Convert tile coordinates (x, y, z) to bounding box (EPSG:3857 - Web Mercator)
 * This is the correct format for Leaflet tile alignment
 */
export function tileToBBox3857(x: number, y: number, z: number): [number, number, number, number] {
  const n = Math.pow(2, z);
  const WORLD_SIZE = 20037508.342789244; // Half of Web Mercator world extent

  const tileSize = (WORLD_SIZE * 2) / n;

  const minX = -WORLD_SIZE + x * tileSize;
  const maxX = minX + tileSize;
  const maxY = WORLD_SIZE - y * tileSize;
  const minY = maxY - tileSize;

  return [minX, minY, maxX, maxY];
}

/**
 * Convert lat/lng to tile coordinates
 */
export function latLngToTile(lat: number, lng: number, z: number): { x: number; y: number } {
  const n = Math.pow(2, z);
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * n);
  return { x, y };
}

/**
 * Get tiles visible in a viewport
 */
export function getVisibleTiles(
  bounds: { north: number; south: number; east: number; west: number },
  zoom: number
): Array<{ x: number; y: number; z: number; bbox: [number, number, number, number] }> {
  const z = Math.min(Math.floor(zoom), 18); // Max zoom level
  const tiles: Array<{ x: number; y: number; z: number; bbox: [number, number, number, number] }> = [];

  const topLeft = latLngToTile(bounds.north, bounds.west, z);
  const bottomRight = latLngToTile(bounds.south, bounds.east, z);

  for (let x = topLeft.x; x <= bottomRight.x; x++) {
    for (let y = topLeft.y; y <= bottomRight.y; y++) {
      tiles.push({
        x,
        y,
        z,
        bbox: tileToBBox(x, y, z),
      });
    }
  }

  return tiles;
}

/**
 * Evalscript definitions for different layers
 * Bilimsel referanslar:
 * - Chlorophyll-a: OC2/OC3 (NASA Ocean Color)
 * - Turbidity: Dogliotti et al. (2015)
 * - TSS: Nechad et al. (2010)
 * - Cyanobacteria: Mishra & Mishra (2012) NDCI
 * - CDOM: Lee et al. (2002) QAA
 * - Secchi: Doron et al. (2011)
 */
const EVALSCRIPTS: Record<LayerType, string> = {
  'TRUE-COLOR': `
    //VERSION=3
    function setup() {
      return { input: ["B04", "B03", "B02", "dataMask"], output: { bands: 4 } };
    }
    function evaluatePixel(sample) {
      // Contrast enhancement for satellite imagery
      let gain = 2.5;
      return [gain * sample.B04, gain * sample.B03, gain * sample.B02, sample.dataMask];
    }
  `,

  // Chlorophyll-a - OC2 Algorithm (NASA Ocean Color)
  // Chl = 10^(a0 + a1*R + a2*R² + a3*R³ + a4*R⁴)
  // R = log10(Rrs443/Rrs555) ≈ log10(B02/B03)
  // SCL band kullanarak kara maskeleme (SCL=6 su)
  'CHLOROPHYLL': `
    //VERSION=3
    function setup() {
      return { input: ["B02", "B03", "B04", "B05", "B08", "SCL", "dataMask"], output: { bands: 4 } };
    }
    function evaluatePixel(sample) {
      // SCL ile su tespiti (6 = su)
      // SCL değerleri: 0=no_data, 1=saturated, 2=dark_area, 3=cloud_shadow,
      // 4=vegetation, 5=bare_soil, 6=WATER, 7=unclassified, 8=cloud_medium, 9=cloud_high, 10=cirrus, 11=snow
      if (sample.SCL !== 6) {
        // NDWI ile ek kontrol (göller için SCL bazen hatalı olabiliyor)
        let ndwi = (sample.B03 - sample.B08) / (sample.B03 + sample.B08 + 0.0001);
        if (ndwi < 0.2) return [0, 0, 0, 0]; // Kara - şeffaf
      }

      // OC2 algoritması
      let R = Math.log10(Math.max(sample.B02, 0.001) / Math.max(sample.B03, 0.001));

      // OC2 katsayıları (NASA)
      let a0 = 0.2424, a1 = -2.7423, a2 = 1.8017, a3 = 0.0015, a4 = -1.2280;
      let chl = Math.pow(10, a0 + a1*R + a2*R*R + a3*R*R*R + a4*R*R*R*R);
      chl = Math.max(0.01, Math.min(chl, 200)); // 0.01-200 mg/m³

      // Renk skalası: Düşük (mavi) -> Orta (yeşil) -> Yüksek (kırmızı)
      let r, g, b;
      if (chl < 2) { r = 0.05; g = 0.2; b = 0.9; }       // Oligotrofik - Koyu mavi
      else if (chl < 5) { r = 0.1; g = 0.4; b = 0.8; }   // Düşük - Mavi
      else if (chl < 10) { r = 0.2; g = 0.7; b = 0.6; }  // Orta-düşük - Turkuaz
      else if (chl < 20) { r = 0.3; g = 0.8; b = 0.3; }  // Orta - Yeşil
      else if (chl < 50) { r = 0.8; g = 0.8; b = 0.2; }  // Yüksek - Sarı
      else if (chl < 100) { r = 0.9; g = 0.5; b = 0.1; } // Çok yüksek - Turuncu
      else { r = 0.9; g = 0.2; b = 0.2; }                // Bloom - Kırmızı
      return [r, g, b, sample.dataMask];
    }
  `,

  // Cyanobacteria - NDCI + CyanoIndex (Mishra & Mishra 2012)
  // NDCI = (B05 - B04) / (B05 + B04)
  // CyanoIndex = 115530 * ((B03*B04)/B02)^2.38
  // SCL band kullanarak kara maskeleme (SCL=6 su)
  'CYANOBACTERIA': `
    //VERSION=3
    function setup() {
      return { input: ["B02", "B03", "B04", "B05", "B08", "SCL", "dataMask"], output: { bands: 4 } };
    }
    function evaluatePixel(sample) {
      // SCL ile su tespiti (6 = su)
      if (sample.SCL !== 6) {
        // NDWI ile ek kontrol (göller için SCL bazen hatalı olabiliyor)
        let ndwi = (sample.B03 - sample.B08) / (sample.B03 + sample.B08 + 0.0001);
        if (ndwi < 0.2) return [0, 0, 0, 0]; // Kara - şeffaf
      }

      // NDCI (Normalized Difference Chlorophyll Index)
      let ndci = (sample.B05 - sample.B04) / (sample.B05 + sample.B04 + 0.0001);

      // Siyanobakteri indeksi (cells/mL tahmini)
      let cya = 115530.31 * Math.pow(Math.max((sample.B03 * sample.B04) / Math.max(sample.B02, 0.001), 0.0001), 2.38);
      cya = Math.min(cya, 2000000); // Max 2M cells/mL

      // FAI (Floating Algae Index) - Yüzey blomu tespiti
      let fai = sample.B05 - (sample.B04 + (sample.B08 - sample.B04) * 0.5);

      // Renk skalası (WHO guidelines)
      let r, g, b;
      if (cya < 10000) { r = 0.1; g = 0.4; b = 0.8; }         // Güvenli - Mavi
      else if (cya < 20000) { r = 0.2; g = 0.6; b = 0.6; }    // Düşük risk - Turkuaz
      else if (cya < 100000) { r = 0.4; g = 0.8; b = 0.3; }   // Orta risk - Yeşil
      else if (cya < 500000) { r = 0.9; g = 0.8; b = 0.2; }   // Yüksek risk - Sarı
      else if (cya < 1000000) { r = 0.9; g = 0.5; b = 0.1; }  // Ciddi risk - Turuncu
      else { r = 0.9; g = 0.1; b = 0.1; }                     // BLOOM! - Kırmızı
      return [r, g, b, sample.dataMask];
    }
  `,

  // Turbidity - Dogliotti Algorithm (2015)
  // T = 378.46 * ρw(645) / (1 - ρw(645)/0.1728)
  // SCL band kullanarak kara maskeleme (SCL=6 su)
  'TURBIDITY': `
    //VERSION=3
    function setup() {
      return { input: ["B03", "B04", "B05", "B08", "SCL", "dataMask"], output: { bands: 4 } };
    }
    function evaluatePixel(sample) {
      // SCL ile su tespiti (6 = su)
      if (sample.SCL !== 6) {
        // NDWI ile ek kontrol
        let ndwi = (sample.B03 - sample.B08) / (sample.B03 + sample.B08 + 0.0001);
        if (ndwi < 0.2) return [0, 0, 0, 0]; // Kara - şeffaf
      }

      // Dogliotti algoritması (NTU)
      let rho = sample.B04; // Red band ~665nm
      let A = 378.46;
      let C = 0.1728;

      let turb = A * rho / (1 - rho/C);
      turb = Math.max(0, Math.min(turb, 1000)); // 0-1000 NTU

      // Renk skalası
      let r, g, b;
      if (turb < 5) { r = 0.1; g = 0.5; b = 0.9; }        // Berrak - Mavi
      else if (turb < 10) { r = 0.2; g = 0.7; b = 0.8; }  // Hafif bulanık - Açık mavi
      else if (turb < 25) { r = 0.4; g = 0.8; b = 0.5; }  // Orta - Yeşil
      else if (turb < 50) { r = 0.7; g = 0.7; b = 0.3; }  // Bulanık - Sarı
      else if (turb < 100) { r = 0.8; g = 0.5; b = 0.2; } // Çok bulanık - Turuncu
      else { r = 0.6; g = 0.4; b = 0.3; }                 // Aşırı - Kahve
      return [r, g, b, sample.dataMask];
    }
  `,

  // CDOM - Colored Dissolved Organic Matter
  // QAA-based approach (Lee et al. 2002)
  // SCL band kullanarak kara maskeleme (SCL=6 su)
  'CDOM': `
    //VERSION=3
    function setup() {
      return { input: ["B02", "B03", "B04", "B08", "SCL", "dataMask"], output: { bands: 4 } };
    }
    function evaluatePixel(sample) {
      // SCL ile su tespiti (6 = su)
      if (sample.SCL !== 6) {
        let ndwi = (sample.B03 - sample.B08) / (sample.B03 + sample.B08 + 0.0001);
        if (ndwi < 0.2) return [0, 0, 0, 0]; // Kara - şeffaf
      }

      // CDOM absorption proxy (443nm bant oranı)
      // a_cdom(443) ≈ (B02 - B04) / B03
      let cdom = (sample.B02 - sample.B04) / Math.max(sample.B03, 0.001);
      // Normalize 0-1 arası
      cdom = Math.max(0, Math.min((cdom + 0.5) / 1.5, 1));

      // Renk skalası
      let r, g, b;
      if (cdom < 0.2) { r = 0.1; g = 0.5; b = 0.9; }      // Düşük - Mavi
      else if (cdom < 0.4) { r = 0.3; g = 0.7; b = 0.7; } // Orta-düşük - Turkuaz
      else if (cdom < 0.6) { r = 0.5; g = 0.7; b = 0.4; } // Orta - Yeşil-sarı
      else if (cdom < 0.8) { r = 0.7; g = 0.5; b = 0.2; } // Yüksek - Kahverengi
      else { r = 0.5; g = 0.3; b = 0.1; }                 // Çok yüksek - Koyu kahve
      return [r, g, b, sample.dataMask];
    }
  `,

  // TSS - Total Suspended Solids (Nechad et al. 2010)
  // TSS = A * ρw / (1 - ρw/C)
  // SCL band kullanarak kara maskeleme (SCL=6 su)
  'TSS': `
    //VERSION=3
    function setup() {
      return { input: ["B03", "B04", "B05", "B08", "SCL", "dataMask"], output: { bands: 4 } };
    }
    function evaluatePixel(sample) {
      // SCL ile su tespiti (6 = su)
      if (sample.SCL !== 6) {
        let ndwi = (sample.B03 - sample.B08) / (sample.B03 + sample.B08 + 0.0001);
        if (ndwi < 0.2) return [0, 0, 0, 0]; // Kara - şeffaf
      }

      // Nechad algoritması (mg/L)
      let rho = sample.B04; // Red band
      let A = 355.85;
      let C = 0.1728;

      let tss = A * rho / (1 - rho/C);
      tss = Math.max(0, Math.min(tss, 500)); // 0-500 mg/L

      // Renk skalası
      let r, g, b;
      if (tss < 10) { r = 0.1; g = 0.4; b = 0.8; }        // Temiz - Mavi
      else if (tss < 25) { r = 0.3; g = 0.6; b = 0.7; }   // Normal - Açık mavi
      else if (tss < 50) { r = 0.5; g = 0.7; b = 0.4; }   // Orta - Yeşil
      else if (tss < 100) { r = 0.7; g = 0.6; b = 0.3; }  // Yüksek - Sarı-kahve
      else { r = 0.6; g = 0.4; b = 0.2; }                 // Çok yüksek - Kahve
      return [r, g, b, sample.dataMask];
    }
  `,

  // NDWI - Normalized Difference Water Index (McFeeters 1996)
  // NDWI = (Green - NIR) / (Green + NIR)
  'NDWI': `
    //VERSION=3
    function setup() {
      return { input: ["B03", "B08", "dataMask"], output: { bands: 4 } };
    }
    function evaluatePixel(sample) {
      let ndwi = (sample.B03 - sample.B08) / (sample.B03 + sample.B08 + 0.0001);

      // Renk skalası
      let r, g, b;
      if (ndwi > 0.5) { r = 0.0; g = 0.2; b = 0.8; }       // Derin su - Koyu mavi
      else if (ndwi > 0.3) { r = 0.1; g = 0.4; b = 0.9; }  // Su - Mavi
      else if (ndwi > 0.1) { r = 0.3; g = 0.6; b = 0.9; }  // Sığ su - Açık mavi
      else if (ndwi > 0) { r = 0.5; g = 0.8; b = 0.9; }    // Su kenarı - Turkuaz
      else if (ndwi > -0.2) { r = 0.8; g = 0.9; b = 0.7; } // Nemli - Açık yeşil
      else { r = 0.6; g = 0.5; b = 0.4; }                  // Kara - Kahve
      return [r, g, b, sample.dataMask];
    }
  `,

  // Secchi Depth - Su Şeffaflığı (Doron et al. 2011)
  // SD = exp(a - b * ln(Rrs490/Rrs560))
  // SCL band kullanarak kara maskeleme (SCL=6 su)
  'SECCHI': `
    //VERSION=3
    function setup() {
      return { input: ["B02", "B03", "B04", "B08", "SCL", "dataMask"], output: { bands: 4 } };
    }
    function evaluatePixel(sample) {
      // SCL ile su tespiti (6 = su)
      if (sample.SCL !== 6) {
        let ndwi = (sample.B03 - sample.B08) / (sample.B03 + sample.B08 + 0.0001);
        if (ndwi < 0.2) return [0, 0, 0, 0]; // Kara - şeffaf
      }

      // Secchi derinliği tahmini (metre)
      // Blue/Red oranı şeffaflık ile ilişkili
      let ratio = Math.log(Math.max(sample.B02, 0.001) / Math.max(sample.B04, 0.001));
      let secchi = 1.47 * Math.exp(1.22 * ratio);
      secchi = Math.max(0.1, Math.min(secchi, 30)); // 0.1-30m

      // Renk skalası
      let r, g, b;
      if (secchi > 10) { r = 0.0; g = 0.3; b = 0.9; }      // Çok berrak - Koyu mavi
      else if (secchi > 5) { r = 0.1; g = 0.5; b = 0.9; }  // Berrak - Mavi
      else if (secchi > 2) { r = 0.3; g = 0.7; b = 0.8; }  // Orta - Açık mavi
      else if (secchi > 1) { r = 0.5; g = 0.8; b = 0.5; }  // Düşük - Yeşil
      else if (secchi > 0.5) { r = 0.8; g = 0.7; b = 0.3; }// Bulanık - Sarı
      else { r = 0.6; g = 0.4; b = 0.2; }                  // Çok bulanık - Kahve
      return [r, g, b, sample.dataMask];
    }
  `,

  // NDVI - Vegetation Index
  'NDVI': `
    //VERSION=3
    function setup() {
      return { input: ["B04", "B08", "dataMask"], output: { bands: 4 } };
    }
    function evaluatePixel(sample) {
      let ndvi = (sample.B08 - sample.B04) / (sample.B08 + sample.B04 + 0.001);

      let r, g, b;
      if (ndvi < 0) { r = 0.5; g = 0; b = 0; }
      else if (ndvi < 0.2) { r = 0.8; g = 0.4; b = 0.2; }
      else if (ndvi < 0.4) { r = 1; g = 0.8; b = 0; }
      else if (ndvi < 0.6) { r = 0.6; g = 0.9; b = 0.2; }
      else { r = 0.1; g = 0.6; b = 0.1; }
      return [r, g, b, sample.dataMask];
    }
  `,

  // MOISTURE - Nem İndeksi (NDMI)
  'MOISTURE': `
    //VERSION=3
    function setup() {
      return { input: ["B8A", "B11", "dataMask"], output: { bands: 4 } };
    }
    function evaluatePixel(sample) {
      let ndmi = (sample.B8A - sample.B11) / (sample.B8A + sample.B11 + 0.001);

      let r, g, b;
      if (ndmi < -0.4) { r = 0.8; g = 0.2; b = 0.2; }
      else if (ndmi < 0) { r = 0.9; g = 0.6; b = 0.3; }
      else if (ndmi < 0.2) { r = 1; g = 0.9; b = 0.5; }
      else if (ndmi < 0.4) { r = 0.5; g = 0.8; b = 0.5; }
      else { r = 0.2; g = 0.4; b = 0.8; }
      return [r, g, b, sample.dataMask];
    }
  `,
};

/**
 * Build Processing API request body for a tile
 * Uses EPSG:3857 (Web Mercator) for proper Leaflet tile alignment
 */
export function buildTileRequest(
  bbox: [number, number, number, number],
  layer: LayerType,
  date: Date,
  maxCloudCoverage: number = 30,
  crs: 'EPSG:3857' | 'EPSG:4326' = 'EPSG:3857'
): object {
  const fromDate = new Date(date);
  fromDate.setDate(fromDate.getDate() - 30); // Look back 30 days for best image

  const crsUrl = crs === 'EPSG:3857'
    ? 'http://www.opengis.net/def/crs/EPSG/0/3857'
    : 'http://www.opengis.net/def/crs/EPSG/0/4326';

  return {
    input: {
      bounds: {
        bbox,
        properties: {
          crs: crsUrl,
        },
      },
      data: [
        {
          type: 'sentinel-2-l2a',
          dataFilter: {
            timeRange: {
              from: fromDate.toISOString(),
              to: date.toISOString(),
            },
            maxCloudCoverage,
            mosaickingOrder: 'leastCC', // Least cloud coverage first
          },
        },
      ],
    },
    output: {
      width: TILE_SIZE,
      height: TILE_SIZE,
      responses: [
        {
          identifier: 'default',
          format: {
            type: 'image/png',
          },
        },
      ],
    },
    evalscript: EVALSCRIPTS[layer],
  };
}

/**
 * Tile cache management
 */
interface CachedTile {
  blob: Blob;
  url: string;
  expiry: number;
}

const tileCache = new Map<string, CachedTile>();
const CACHE_DURATION_MS = 30 * 60 * 1000; // 30 minutes (satellite imagery rarely changes)
const MAX_CACHE_SIZE = 500; // Increased cache size for better hit rate

/**
 * Generate cache key for a tile
 */
function getTileCacheKey(x: number, y: number, z: number, layer: LayerType, dateStr: string): string {
  return `${z}/${x}/${y}/${layer}/${dateStr}`;
}

/**
 * Clean up expired cache entries and enforce max size
 */
function cleanupCache(): void {
  const now = Date.now();
  const entries = Array.from(tileCache.entries());

  // Remove expired entries
  for (const [key, value] of entries) {
    if (value.expiry < now) {
      URL.revokeObjectURL(value.url);
      tileCache.delete(key);
    }
  }

  // Enforce max size (remove oldest entries)
  if (tileCache.size > MAX_CACHE_SIZE) {
    const sorted = entries
      .filter(([_, v]) => v.expiry >= now)
      .sort((a, b) => a[1].expiry - b[1].expiry);

    const toRemove = sorted.slice(0, sorted.length - MAX_CACHE_SIZE);
    for (const [key, value] of toRemove) {
      URL.revokeObjectURL(value.url);
      tileCache.delete(key);
    }
  }
}

/**
 * Internal tile fetch implementation
 * Uses fetchWithRetry for 429 handling
 */
async function fetchTileInternal(
  x: number,
  y: number,
  z: number,
  layer: LayerType,
  date: Date,
  token?: string,
  maxCloudCoverage: number = 30
): Promise<string | null> {
  const dateStr = date.toISOString().split('T')[0];
  const cacheKey = getTileCacheKey(x, y, z, layer, dateStr);

  // Check cache
  const cached = tileCache.get(cacheKey);
  if (cached && cached.expiry > Date.now()) {
    return cached.url;
  }

  // Calculate bbox for tile in EPSG:3857 (Web Mercator) for proper Leaflet alignment
  const bbox = tileToBBox3857(x, y, z);

  // Build request with EPSG:3857 CRS
  const requestBody = buildTileRequest(bbox, layer, date, maxCloudCoverage, 'EPSG:3857');

  // Retry logic for 401 errors
  const maxRetries = 1;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Get token if not provided or on retry
      const authToken = attempt === 0 && token ? token : await getValidToken();

      // Use fetchWithRetry for 429 handling with exponential backoff
      const response = await fetchWithRetry(
        CDSE_PROCESS_URL,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify(requestBody),
        },
        3 // max 3 retries for 429
      );

      // Handle 401 - token expired
      if (response.status === 401) {
        console.warn(`[TileService] 401 Unauthorized - token expired (attempt ${attempt + 1})`);
        invalidateToken();
        if (attempt < maxRetries) {
          continue; // Retry with new token
        }
        return null;
      }

      // Handle 429 after retries exhausted
      if (response.status === 429) {
        console.error(`[TileService] Rate limit exceeded for tile ${z}/${x}/${y}`);
        return null;
      }

      if (!response.ok) {
        console.error(`Tile fetch failed: ${response.status}`);
        return null;
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);

      // Cache the tile
      tileCache.set(cacheKey, {
        blob,
        url,
        expiry: Date.now() + CACHE_DURATION_MS,
      });

      // Cleanup periodically
      if (Math.random() < 0.1) {
        cleanupCache();
      }

      return url;
    } catch (error) {
      console.error('Tile fetch error:', error);
      if (attempt < maxRetries) {
        invalidateToken();
        continue;
      }
      return null;
    }
  }

  return null;
}

/**
 * Fetch a single tile from Sentinel Hub Processing API
 * Token parameter is optional - will auto-fetch if not provided
 * Handles 401 errors with automatic token refresh and retry
 * Uses request queue to prevent 429 rate limiting
 */
export async function fetchTile(
  x: number,
  y: number,
  z: number,
  layer: LayerType,
  date: Date,
  token?: string,
  maxCloudCoverage: number = 30
): Promise<string | null> {
  const dateStr = date.toISOString().split('T')[0];
  const cacheKey = getTileCacheKey(x, y, z, layer, dateStr);

  // Check cache first (outside queue)
  const cached = tileCache.get(cacheKey);
  if (cached && cached.expiry > Date.now()) {
    return cached.url;
  }

  // Enqueue the request to prevent rate limiting
  return requestQueue.enqueue(() =>
    fetchTileInternal(x, y, z, layer, date, token, maxCloudCoverage)
  );
}

/**
 * Fetch tile with automatic token management
 * Preferred method - no token parameter needed
 */
export async function fetchTileAuto(
  x: number,
  y: number,
  z: number,
  layer: LayerType,
  date: Date,
  maxCloudCoverage: number = 30
): Promise<string | null> {
  const token = await getValidToken();
  return fetchTile(x, y, z, layer, date, token, maxCloudCoverage);
}

/**
 * Clear all cached tiles
 */
export function clearTileCache(): void {
  for (const [_, value] of tileCache) {
    URL.revokeObjectURL(value.url);
  }
  tileCache.clear();
}

/**
 * Get cache statistics
 */
export function getCacheStats(): { size: number; maxSize: number } {
  return {
    size: tileCache.size,
    maxSize: MAX_CACHE_SIZE,
  };
}

/**
 * Prefetch tiles for a viewport
 */
export async function prefetchTiles(
  bounds: { north: number; south: number; east: number; west: number },
  zoom: number,
  layer: LayerType,
  date: Date,
  token: string,
  maxCloudCoverage: number = 30,
  concurrency: number = 2 // Conservative to avoid rate limiting (queue handles serialization)
): Promise<Map<string, string | null>> {
  const tiles = getVisibleTiles(bounds, zoom);
  const results = new Map<string, string | null>();

  // Fetch tiles in batches
  for (let i = 0; i < tiles.length; i += concurrency) {
    const batch = tiles.slice(i, i + concurrency);
    const promises = batch.map(async (tile) => {
      const url = await fetchTile(tile.x, tile.y, tile.z, layer, date, token, maxCloudCoverage);
      const key = `${tile.z}/${tile.x}/${tile.y}`;
      results.set(key, url);
    });
    await Promise.all(promises);
  }

  return results;
}

/**
 * Estimate PU cost for visible tiles
 */
export function estimatePUCost(tileCount: number): number {
  return tileCount * PU_PER_TILE;
}

// =============================================================================
// POINT QUERY FUNCTIONS
// =============================================================================

/**
 * Sentinel Point Query Result
 */
export interface SentinelPointQueryResult {
  lat: number;
  lng: number;
  value: number | null;
  unit: string;
  layer: LayerType;
  timestamp?: string;
  quality: 'good' | 'cloud' | 'land' | 'no_data';
}

/**
 * Layer units for display
 */
const LAYER_UNITS: Record<LayerType, string> = {
  'TRUE-COLOR': '',
  'CHLOROPHYLL': 'mg/m³',
  'CYANOBACTERIA': 'cells/mL',
  'TURBIDITY': 'NTU',
  'CDOM': 'index',
  'TSS': 'mg/L',
  'NDWI': 'index',
  'SECCHI': 'm',
  'NDVI': 'index',
  'MOISTURE': 'index',
};

/**
 * Layer value ranges for decoding
 */
const LAYER_VALUE_RANGES: Record<LayerType, { min: number; max: number }> = {
  'TRUE-COLOR': { min: 0, max: 1 },
  'CHLOROPHYLL': { min: 0, max: 200 },      // mg/m³
  'CYANOBACTERIA': { min: 0, max: 2000000 }, // cells/mL
  'TURBIDITY': { min: 0, max: 1000 },       // NTU
  'CDOM': { min: 0, max: 1 },               // index
  'TSS': { min: 0, max: 500 },              // mg/L
  'NDWI': { min: -1, max: 1 },              // index
  'SECCHI': { min: 0, max: 30 },            // meters
  'NDVI': { min: -1, max: 1 },              // index
  'MOISTURE': { min: -1, max: 1 },          // index
};

/**
 * Evalscripts that encode numeric values into RGB for point queries
 * These return the actual computed value encoded in RGB channels:
 * - R,G channels: 16-bit value (high byte, low byte)
 * - B channel: quality flag (255=good, 200=cloud, 100=land, 0=no_data)
 */
const POINT_EVALSCRIPTS: Record<LayerType, string> = {
  'TRUE-COLOR': `
    //VERSION=3
    function setup() { return { input: ["B04", "B03", "B02", "dataMask"], output: { bands: 4 } }; }
    function evaluatePixel(sample) {
      if (sample.dataMask === 0) return [0, 0, 0, 0];
      let val = (sample.B04 + sample.B03 + sample.B02) / 3;
      let norm = Math.round(val * 65535);
      return [(norm >> 8) & 0xFF, norm & 0xFF, 255, 255].map(x => x/255);
    }
  `,

  'CHLOROPHYLL': `
    //VERSION=3
    function setup() { return { input: ["B02", "B03", "B04", "B05", "dataMask", "CLM"], output: { bands: 4 } }; }
    function evaluatePixel(sample) {
      if (sample.dataMask === 0) return [0, 0, 0, 0];
      if (sample.CLM > 0) return [0, 0, 200/255, 1]; // Cloud
      if (sample.B05 > 0.1) return [0, 0, 100/255, 1]; // Land

      let R = Math.log10(Math.max(sample.B02, 0.001) / Math.max(sample.B03, 0.001));
      let chl = Math.pow(10, 0.2424 - 2.7423*R + 1.8017*R*R);
      chl = Math.max(0, Math.min(chl, 200));

      let norm = Math.round((chl / 200) * 65535);
      return [(norm >> 8) & 0xFF, norm & 0xFF, 255, 255].map(x => x/255);
    }
  `,

  'CYANOBACTERIA': `
    //VERSION=3
    function setup() { return { input: ["B02", "B03", "B04", "B05", "B08", "dataMask", "CLM"], output: { bands: 4 } }; }
    function evaluatePixel(sample) {
      if (sample.dataMask === 0) return [0, 0, 0, 0];
      if (sample.CLM > 0) return [0, 0, 200/255, 1];
      let ndwi = (sample.B03 - sample.B08) / (sample.B03 + sample.B08 + 0.0001);
      if (ndwi < -0.1) return [0, 0, 100/255, 1];

      let cya = 115530.31 * Math.pow(Math.max((sample.B03 * sample.B04) / Math.max(sample.B02, 0.001), 0.0001), 2.38);
      cya = Math.min(cya, 2000000);

      let norm = Math.round((cya / 2000000) * 65535);
      return [(norm >> 8) & 0xFF, norm & 0xFF, 255, 255].map(x => x/255);
    }
  `,

  'TURBIDITY': `
    //VERSION=3
    function setup() { return { input: ["B04", "B08", "dataMask", "CLM"], output: { bands: 4 } }; }
    function evaluatePixel(sample) {
      if (sample.dataMask === 0) return [0, 0, 0, 0];
      if (sample.CLM > 0) return [0, 0, 200/255, 1];
      if (sample.B08 > 0.15) return [0, 0, 100/255, 1];

      let rho = sample.B04;
      let turb = 378.46 * rho / (1 - rho/0.1728);
      turb = Math.max(0, Math.min(turb, 1000));

      let norm = Math.round((turb / 1000) * 65535);
      return [(norm >> 8) & 0xFF, norm & 0xFF, 255, 255].map(x => x/255);
    }
  `,

  'CDOM': `
    //VERSION=3
    function setup() { return { input: ["B02", "B03", "B04", "B08", "dataMask", "CLM"], output: { bands: 4 } }; }
    function evaluatePixel(sample) {
      if (sample.dataMask === 0) return [0, 0, 0, 0];
      if (sample.CLM > 0) return [0, 0, 200/255, 1];
      if (sample.B08 > 0.1) return [0, 0, 100/255, 1];

      let cdom = (sample.B02 - sample.B04) / Math.max(sample.B03, 0.001);
      cdom = Math.max(0, Math.min((cdom + 0.5) / 1.5, 1));

      let norm = Math.round(cdom * 65535);
      return [(norm >> 8) & 0xFF, norm & 0xFF, 255, 255].map(x => x/255);
    }
  `,

  'TSS': `
    //VERSION=3
    function setup() { return { input: ["B04", "B08", "dataMask", "CLM"], output: { bands: 4 } }; }
    function evaluatePixel(sample) {
      if (sample.dataMask === 0) return [0, 0, 0, 0];
      if (sample.CLM > 0) return [0, 0, 200/255, 1];
      if (sample.B08 > 0.15) return [0, 0, 100/255, 1];

      let rho = sample.B04;
      let tss = 355.85 * rho / (1 - rho/0.1728);
      tss = Math.max(0, Math.min(tss, 500));

      let norm = Math.round((tss / 500) * 65535);
      return [(norm >> 8) & 0xFF, norm & 0xFF, 255, 255].map(x => x/255);
    }
  `,

  'NDWI': `
    //VERSION=3
    function setup() { return { input: ["B03", "B08", "dataMask"], output: { bands: 4 } }; }
    function evaluatePixel(sample) {
      if (sample.dataMask === 0) return [0, 0, 0, 0];

      let ndwi = (sample.B03 - sample.B08) / (sample.B03 + sample.B08 + 0.0001);
      let norm = Math.round(((ndwi + 1) / 2) * 65535);
      return [(norm >> 8) & 0xFF, norm & 0xFF, 255, 255].map(x => x/255);
    }
  `,

  'SECCHI': `
    //VERSION=3
    function setup() { return { input: ["B02", "B03", "B04", "B08", "dataMask", "CLM"], output: { bands: 4 } }; }
    function evaluatePixel(sample) {
      if (sample.dataMask === 0) return [0, 0, 0, 0];
      if (sample.CLM > 0) return [0, 0, 200/255, 1];
      let ndwi = (sample.B03 - sample.B08) / (sample.B03 + sample.B08 + 0.0001);
      if (ndwi < 0) return [0, 0, 100/255, 1];

      let ratio = Math.log(Math.max(sample.B02, 0.001) / Math.max(sample.B04, 0.001));
      let secchi = 1.47 * Math.exp(1.22 * ratio);
      secchi = Math.max(0.1, Math.min(secchi, 30));

      let norm = Math.round((secchi / 30) * 65535);
      return [(norm >> 8) & 0xFF, norm & 0xFF, 255, 255].map(x => x/255);
    }
  `,

  'NDVI': `
    //VERSION=3
    function setup() { return { input: ["B04", "B08", "dataMask"], output: { bands: 4 } }; }
    function evaluatePixel(sample) {
      if (sample.dataMask === 0) return [0, 0, 0, 0];

      let ndvi = (sample.B08 - sample.B04) / (sample.B08 + sample.B04 + 0.001);
      let norm = Math.round(((ndvi + 1) / 2) * 65535);
      return [(norm >> 8) & 0xFF, norm & 0xFF, 255, 255].map(x => x/255);
    }
  `,

  'MOISTURE': `
    //VERSION=3
    function setup() { return { input: ["B8A", "B11", "dataMask"], output: { bands: 4 } }; }
    function evaluatePixel(sample) {
      if (sample.dataMask === 0) return [0, 0, 0, 0];

      let ndmi = (sample.B8A - sample.B11) / (sample.B8A + sample.B11 + 0.001);
      let norm = Math.round(((ndmi + 1) / 2) * 65535);
      return [(norm >> 8) & 0xFF, norm & 0xFF, 255, 255].map(x => x/255);
    }
  `,
};

/**
 * Decode RGB pixel value to numeric value
 */
function decodePixelValue(
  r: number,
  g: number,
  b: number,
  layer: LayerType
): { value: number | null; quality: 'good' | 'cloud' | 'land' | 'no_data' } {
  // Check quality flag (B channel)
  const qualityFlag = Math.round(b * 255);

  if (qualityFlag === 0) {
    return { value: null, quality: 'no_data' };
  }
  if (qualityFlag < 150) {
    return { value: null, quality: 'land' };
  }
  if (qualityFlag < 220) {
    return { value: null, quality: 'cloud' };
  }

  // Decode 16-bit value from R,G channels
  const highByte = Math.round(r * 255);
  const lowByte = Math.round(g * 255);
  const normalized = (highByte << 8) | lowByte;
  const normalizedFloat = normalized / 65535;

  // Scale to layer value range
  const range = LAYER_VALUE_RANGES[layer];
  const value = range.min + normalizedFloat * (range.max - range.min);

  return { value, quality: 'good' };
}

/**
 * Build Processing API request for single point query
 */
function buildPointRequest(
  lat: number,
  lng: number,
  layer: LayerType,
  date: Date,
  maxCloudCoverage: number = 50
): object {
  // Use small bbox around point (~50m buffer)
  const buffer = 0.0005; // ~50m at equator
  const bbox = [
    lng - buffer,
    lat - buffer,
    lng + buffer,
    lat + buffer,
  ];

  const fromDate = new Date(date);
  fromDate.setDate(fromDate.getDate() - 30);

  return {
    input: {
      bounds: {
        bbox,
        properties: {
          crs: 'http://www.opengis.net/def/crs/EPSG/0/4326',
        },
      },
      data: [
        {
          type: 'sentinel-2-l2a',
          dataFilter: {
            timeRange: {
              from: fromDate.toISOString(),
              to: date.toISOString(),
            },
            maxCloudCoverage,
            mosaickingOrder: 'leastCC',
          },
        },
      ],
    },
    output: {
      width: 1,
      height: 1,
      responses: [
        {
          identifier: 'default',
          format: {
            type: 'image/png',
          },
        },
      ],
    },
    evalscript: POINT_EVALSCRIPTS[layer],
  };
}

/**
 * Extract pixel values from PNG blob
 */
async function extractPixelFromPNG(blob: Blob): Promise<{ r: number; g: number; b: number; a: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);

    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d');

      if (!ctx) {
        URL.revokeObjectURL(url);
        resolve(null);
        return;
      }

      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, 1, 1);
      const [r, g, b, a] = imageData.data;

      URL.revokeObjectURL(url);
      resolve({
        r: r / 255,
        g: g / 255,
        b: b / 255,
        a: a / 255,
      });
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };

    img.src = url;
  });
}

/**
 * Get point value from Sentinel Hub Processing API
 *
 * @param lat - Latitude (WGS84)
 * @param lng - Longitude (WGS84)
 * @param layer - Sentinel layer type
 * @param date - Date for satellite imagery
 * @param maxCloudCoverage - Maximum cloud coverage (default 50%)
 * @returns Point query result or null if request fails
 */
export async function getSentinelPointValue(
  lat: number,
  lng: number,
  layer: LayerType,
  date: Date,
  maxCloudCoverage: number = 50
): Promise<SentinelPointQueryResult | null> {
  // Use request queue to prevent rate limiting
  return requestQueue.enqueue(async () => {
    try {
      const token = await getValidToken();
      const requestBody = buildPointRequest(lat, lng, layer, date, maxCloudCoverage);

      const response = await fetchWithRetry(
        CDSE_PROCESS_URL,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(requestBody),
        },
        3
      );

      if (response.status === 401) {
        invalidateToken();
        return null;
      }

      if (!response.ok) {
        console.error(`Sentinel point query failed: ${response.status}`);
        return null;
      }

      const blob = await response.blob();
      const pixel = await extractPixelFromPNG(blob);

      if (!pixel || pixel.a === 0) {
        return {
          lat,
          lng,
          value: null,
          unit: LAYER_UNITS[layer],
          layer,
          timestamp: date.toISOString(),
          quality: 'no_data',
        };
      }

      const decoded = decodePixelValue(pixel.r, pixel.g, pixel.b, layer);

      return {
        lat,
        lng,
        value: decoded.value,
        unit: LAYER_UNITS[layer],
        layer,
        timestamp: date.toISOString(),
        quality: decoded.quality,
      };
    } catch (error) {
      console.error('Sentinel point query error:', error);
      return null;
    }
  });
}

/**
 * Get multiple Sentinel parameters for a single point
 */
export async function getSentinelMultiPointValue(
  lat: number,
  lng: number,
  layers: LayerType[],
  date: Date
): Promise<Map<LayerType, SentinelPointQueryResult | null>> {
  const results = new Map<LayerType, SentinelPointQueryResult | null>();

  // Query all layers sequentially (to avoid rate limiting)
  for (const layer of layers) {
    const result = await getSentinelPointValue(lat, lng, layer, date);
    results.set(layer, result);
  }

  return results;
}
