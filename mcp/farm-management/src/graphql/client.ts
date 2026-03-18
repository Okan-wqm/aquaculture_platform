// ============================================================================
// MCP Farm Intelligence Server — GraphQL Client Modülü
// ============================================================================
//
// Fetch tabanlı GraphQL client — Gateway ile iletişim katmanı.
//
// NASIL ÇALIŞIR:
//   1. fetch() ile gateway'e HTTP POST isteği gönderir
//   2. Authorization header'ına JWT token eklenir (Bearer scheme)
//   3. x-tenant-id header'ı ile multi-tenant veri izolasyonu sağlanır
//   4. GraphQL response parse edilir, errors[] varsa GraphQLError fırlatılır
//   5. AbortController ile configurable timeout uygulanır
//
// İletişim Akışı:
//   MCP Server → HTTP POST (GraphQL) → API Gateway → Farm Service
//                                     ↓
//                                   JWT verify
//                                   Tenant isolation
//                                   Rate limiting
//                                     ↓
//                               ← JSON response ←
//
// GÜVENLİK:
//   - Gateway tüm güvenlik kontrollerini yapar (JWT verify, RBAC, tenant isolation)
//   - Bu client sadece token'ı iletir — kendi güvenlik kontrolü yapmaz
//   - x-tenant-id header'ı ek izolasyon katmanı sağlar
//
// EXTENSIBLE:
//   - Retry mekanizması eklenebilir (exponential backoff)
//   - Request/response interceptor'lar eklenebilir
//   - Batch query desteği (birden fazla sorguyu tek istekte gönderme)
//   - Subscription desteği (WebSocket üzerinden gerçek zamanlı veri)
//   - Cache katmanı (sık tekrarlanan sorgular için)
// ============================================================================

import { SessionContext } from '../auth/session-context.js';
import { McpConfig } from '../config.js';
import { GraphQLError } from '../utils/error-handler.js';
import { createLogger } from '../utils/logger.js';

/** GraphQL client modülü için logger */
const logger = createLogger('GraphQL');

// ── GraphQL Response Tipi ───────────────────────────────────────
/**
 * GraphQL yanıt yapısı (spec uyumlu).
 *
 * GraphQL spec'e göre bir yanıt şunları içerebilir:
 *   - data: Sorgu sonuç verisi (başarılı sorgularda)
 *   - errors: Hata dizisi (kısmi veya tam hata durumlarında)
 *
 * Kısmi hatalar mümkündür: hem data hem errors dolu olabilir.
 * Bu durumda bazı alanlar başarılı, bazıları hatalıdır.
 *
 * @typeParam T - data alanının tipi (sorguya özel)
 */
export interface GraphQLResponse<T = unknown> {
  /** Sorgu sonuç verisi — başarılı resolver'ların döndürdüğü veri */
  data?: T;

  /** Hata dizisi — bir veya birden fazla hata içerebilir */
  errors?: Array<{
    /** İnsan okunabilir hata mesajı */
    message: string;

    /** Hatanın sorgu metnindeki konumu (satır/sütun) */
    locations?: Array<{ line: number; column: number }>;

    /** Hatanın veri ağacındaki yolu (hangi alan hata verdi) */
    path?: string[];

    /** Ek bilgiler (hata kodu, stack trace vb.) */
    extensions?: Record<string, unknown>;
  }>;
}

// ─── Query Cache ─────────────────────────────────────────────
// Tool zincirinde aynı sorguların tekrarlanmasını önler
// TTL bazlı: domain'e göre farklı cache süresi
// NASIL ÇALIŞIR:
// 1. query() çağrıldığında cache key hesaplanır (query + variables hash)
// 2. Cache'te taze veri varsa direkt döner (network call yok)
// 3. Yoksa sorgu yapılır ve sonuç cache'e yazılır
// 4. TTL dolmuş entry'ler otomatik temizlenir

interface CacheEntry {
  data: unknown;
  timestamp: number;
  ttlMs: number;
}

/** TTL konfigürasyonu (ms cinsinden) — operation name'e göre */
const CACHE_TTL: Record<string, number> = {
  'ActiveSites': 15 * 60 * 1000,           // 15 dk — site bilgisi nadir değişir
  'ActiveSitesLight': 15 * 60 * 1000,      // 15 dk — light variant, aynı TTL
  'ListTanks': 5 * 60 * 1000,              // 5 dk — tank yapısı nadir değişir
  'ListTanksLight': 5 * 60 * 1000,         // 5 dk — light variant, aynı TTL
  'ActiveBatches': 5 * 60 * 1000,          // 5 dk
  'OverdueWorkOrders': 5 * 60 * 1000,      // 5 dk
  'OverdueWorkOrdersLight': 5 * 60 * 1000, // 5 dk — light variant, aynı TTL
  'HealthEventStats': 3 * 60 * 1000,       // 3 dk
  'CurrentWeather': 5 * 60 * 1000,         // 5 dk
  'default': 60 * 1000,                    // 1 dk — varsayılan (WQ, feeding gibi dinamik veriler)
};

/** Cache boyut limiti — aşılırsa en eski entry evict edilir */
const MAX_CACHE_SIZE = 100;

// ── GraphQL Client Sınıfı ───────────────────────────────────────
/**
 * GraphQL Client — Gateway'e tipli sorgular gönderir.
 *
 * NASIL ÇALIŞIR:
 *   1. constructor: Config ve session bilgilerini alır
 *   2. query<T>(): Dış arayüz — tip güvenli sonuç döner, cache kontrolü yapar
 *   3. executeRequest<T>(): İç method — HTTP isteği yapar, response parse eder
 *
 * CACHE:
 *   - Her GraphQLClient instance'ının kendi cache'i vardır (multi-tenant güvenlik)
 *   - Cache key: query string + JSON.stringify(variables)
 *   - TTL: operation name'e göre belirlenir (CACHE_TTL tablosu)
 *   - Mutation'lar asla cache'lenmez
 *   - Hatalı sonuçlar (isError: true) cache'lenmez
 *
 * Kullanım örneği:
 *   ```typescript
 *   const client = new GraphQLClient(config, session);
 *
 *   interface PoolsData {
 *     pools: Array<{ id: string; name: string }>;
 *   }
 *
 *   const data = await client.query<PoolsData>(`
 *     query GetPools {
 *       pools { id name }
 *     }
 *   `);
 *
 *   console.log(data.pools); // tip güvenli erişim
 *   // Aynı sorgu tekrar çağrılırsa cache'ten döner
 *   ```
 */
export class GraphQLClient {
  /** Server konfigürasyonu (gateway URL, timeout vb.) */
  private config: McpConfig;

  /** Oturum bilgileri (JWT token, tenant ID) */
  private session: SessionContext;

  /** Request-scoped query cache — instance başına izole */
  private cache = new Map<string, CacheEntry>();

  /** Cache istatistikleri — debugging için */
  private cacheHits = 0;
  private cacheMisses = 0;

  /**
   * GraphQL client oluşturur.
   *
   * @param config - MCP server konfigürasyonu
   * @param session - JWT oturum bağlamı
   */
  constructor(config: McpConfig, session: SessionContext) {
    this.config = config;
    this.session = session;
    logger.debug(`GraphQL client oluşturuldu — gateway: ${config.gatewayUrl}`);
  }

  // ── Public Method: query ────────────────────────────────────
  /**
   * GraphQL sorgusu gönderir ve tipli sonuç döner.
   *
   * NASIL ÇALIŞIR:
   *   1. executeRequest() ile HTTP isteği yapılır
   *   2. Response'daki errors[] kontrol edilir
   *   3. Hatalar varsa GraphQLError fırlatılır
   *   4. data alanı tip güvenli olarak döndürülür
   *
   * Hata Durumları:
   *   - Ağ hatası → TypeError (fetch failed)
   *   - Timeout → DOMException (AbortError)
   *   - GraphQL hatası → GraphQLError (errors[] dolu)
   *   - HTTP hatası → GraphQLError (4xx/5xx status)
   *
   * @typeParam T - Beklenen data tipi
   * @param query - GraphQL sorgu string'i (query veya mutation)
   * @param variables - Opsiyonel sorgu değişkenleri
   * @returns Sorgu sonucu (T tipinde)
   * @throws GraphQLError — Gateway'den hata dönerse
   * @throws TypeError — Ağ bağlantı hatası
   * @throws DOMException — Timeout (AbortError)
   */
  async query<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    logger.debug(`Sorgu gönderiliyor — uzunluk: ${query.length} karakter`);

    // ── Mutation Kontrolü ─────────────────────────────────────
    // Mutation'lar asla cache'lenmez — sadece query'ler cache'lenir
    const isMutation = this.isMutation(query);

    // ── Cache Lookup ──────────────────────────────────────────
    if (!isMutation) {
      const cacheKey = this.buildCacheKey(query, variables);
      const cached = this.cache.get(cacheKey);

      if (cached && !this.isStale(cached)) {
        this.cacheHits++;
        const operationName = this.extractOperationName(query) ?? 'anonymous';
        logger.debug(`Cache HIT — operation: ${operationName}, key: ${cacheKey.substring(0, 40)}…`);
        return cached.data as T;
      }
    }

    // ── İsteği Çalıştır ───────────────────────────────────────
    const response = await this.executeRequest<T>(query, variables);

    // ── Hata Kontrolü ─────────────────────────────────────────
    // GraphQL spec: errors[] doluysa bir veya birden fazla hata var
    if (response.errors && response.errors.length > 0) {
      if (response.data) {
        // Kısmi başarı — data mevcut ama hatalar da var, data'yı döndür
        logger.warn(`GraphQL kısmi hata — ${response.errors.length} hata, data mevcut`);
        // Kısmi hata sonuçlarını cache'leme — tutarsız veri riski
        return response.data;
      }
      // Tam hata — data yok, hata fırlat
      const primaryError = response.errors[0]!;

      logger.error(
        `GraphQL hata yanıtı — ${response.errors.length} hata, ` +
        `ilk hata: ${primaryError.message}`
      );

      throw new GraphQLError(
        primaryError.message,
        response.errors,
      );
    }

    // ── Data Kontrolü ─────────────────────────────────────────
    // Hem errors hem data boş olamaz — bu anormal bir durumdur
    if (!response.data) {
      throw new GraphQLError('Gateway boş yanıt döndürdü (data alanı yok)');
    }

    // ── Cache Write ───────────────────────────────────────────
    // Başarılı query sonuçlarını cache'e yaz (mutation hariç)
    if (!isMutation) {
      const cacheKey = this.buildCacheKey(query, variables);
      const operationName = this.extractOperationName(query) ?? 'default';
      const ttlMs = CACHE_TTL[operationName] ?? CACHE_TTL['default']!;

      // Eviction: MAX_CACHE_SIZE aşılırsa en eski entry'yi sil
      if (this.cache.size >= MAX_CACHE_SIZE) {
        this.evictOldest();
      }

      this.cache.set(cacheKey, {
        data: response.data,
        timestamp: Date.now(),
        ttlMs,
      });

      this.cacheMisses++;
      logger.debug(`Cache MISS — operation: ${operationName}, TTL: ${ttlMs / 1000}s, cache size: ${this.cache.size}`);
    }

    logger.debug('Sorgu başarılı — data alındı');
    return response.data;
  }

  // ── Public Method: clearCache ──────────────────────────────
  /**
   * Tüm cache'i temizler. Tool zinciri sonunda veya
   * mutation sonrası stale data'yı önlemek için çağrılabilir.
   */
  clearCache(): void {
    const size = this.cache.size;
    this.cache.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
    logger.debug(`Cache temizlendi — ${size} entry silindi`);
  }

  // ── Public Method: getCacheStats ──────────────────────────
  /**
   * Cache istatistiklerini döner — debugging ve monitoring için.
   */
  getCacheStats(): { size: number; hits: number; misses: number } {
    return {
      size: this.cache.size,
      hits: this.cacheHits,
      misses: this.cacheMisses,
    };
  }

  // ── Private: Cache Helpers ────────────────────────────────

  /**
   * Cache key oluşturur — query string + variables birleşimi.
   * Basit string concat yeterli, crypto hash gereksiz.
   */
  private buildCacheKey(query: string, variables?: Record<string, unknown>): string {
    const varsStr = variables ? JSON.stringify(variables) : '';
    return `${query}::${varsStr}`;
  }

  /**
   * Cache entry'nin TTL'inin dolup dolmadığını kontrol eder.
   */
  private isStale(entry: CacheEntry): boolean {
    return Date.now() - entry.timestamp > entry.ttlMs;
  }

  /**
   * Query string'den operation name'i çıkarır.
   * "query ActiveSites {" → "ActiveSites"
   * "mutation CreateBatch {" → "CreateBatch"
   * Anonim sorgularda null döner.
   */
  private extractOperationName(query: string): string | null {
    const match = query.match(/(?:query|mutation|subscription)\s+(\w+)/);
    return match?.[1] ?? null;
  }

  /**
   * Sorgunun mutation olup olmadığını kontrol eder.
   * Mutation sonuçları asla cache'lenmemeli.
   */
  private isMutation(query: string): boolean {
    return /^\s*mutation\b/.test(query);
  }

  /**
   * Cache boyut limiti aşıldığında en eski entry'yi siler.
   */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTimestamp = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.timestamp < oldestTimestamp) {
        oldestTimestamp = entry.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      logger.debug('Cache eviction — en eski entry silindi');
    }
  }

  // ── Private Method: executeRequest ──────────────────────────
  /**
   * HTTP isteği yapar ve GraphQL yanıtını parse eder.
   *
   * NASIL ÇALIŞIR:
   *   1. AbortController oluştur (timeout mekanizması için)
   *   2. setTimeout ile timeout zamanlayıcısı başlat
   *   3. Request body'yi oluştur: { query, variables }
   *   4. Headers ayarla:
   *      - Content-Type: application/json (GraphQL standart)
   *      - Authorization: Bearer <token> (kimlik doğrulama)
   *      - x-tenant-id: <tenantId> (multi-tenant izolasyon)
   *   5. fetch() ile POST isteği gönder
   *   6. HTTP durum kodunu kontrol et
   *   7. Yanıtı JSON olarak parse et
   *   8. Timeout zamanlayıcısını temizle
   *   9. GraphQLResponse<T> olarak dön
   *
   * Timeout Mekanizması:
   *   AbortController + setTimeout kullanılır.
   *   Config'deki requestTimeout süre aşılırsa AbortController.abort()
   *   çağrılır ve fetch() DOMException (AbortError) fırlatır.
   *
   * @typeParam T - Beklenen data tipi
   * @param query - GraphQL sorgu string'i
   * @param variables - Opsiyonel sorgu değişkenleri
   * @returns Parse edilmiş GraphQL yanıtı
   * @throws TypeError — Ağ bağlantı hatası
   * @throws DOMException — Timeout (AbortError)
   * @throws GraphQLError — HTTP durum kodu hatası (4xx/5xx)
   */
  private async executeRequest<T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<GraphQLResponse<T>> {
    // ── AbortController — Timeout Mekanizması ─────────────────
    // AbortController, fetch isteğini iptal etmek için kullanılır
    // Signal nesnesi fetch'e verilir; abort() çağrılınca istek iptal olur
    const controller = new AbortController();

    // setTimeout ile timeout zamanlayıcısı başlat
    // Süre dolunca controller.abort() çağrılır → fetch DOMException fırlatır
    const timeoutId = setTimeout(() => {
      controller.abort();
      logger.warn(`İstek timeout — ${this.config.requestTimeout}ms aşıldı`);
    }, this.config.requestTimeout);

    try {
      // ── Request Body ────────────────────────────────────────
      // GraphQL over HTTP spec: { query: string, variables?: object }
      const body = JSON.stringify({
        query,
        ...(variables && { variables }),
      });

      // ── HTTP İsteği ─────────────────────────────────────────
      // Native fetch (Node 18+) kullanılır — ek kütüphane gereksiz
      const response = await fetch(this.config.gatewayUrl, {
        method: 'POST',
        headers: {
          // ── Content-Type ──────────────────────────────────
          // GraphQL standart medya tipi
          'Content-Type': 'application/json',

          // ── Authorization ─────────────────────────────────
          // Bearer scheme ile JWT token gönderimi
          // Gateway bu token'ı doğrular ve kullanıcı kimliğini belirler
          'Authorization': `Bearer ${this.session.token}`,

          // ── x-tenant-id ───────────────────────────────────
          // Multi-tenant izolasyon header'ı
          // Gateway bu değeri JWT'deki tenantId ile karşılaştırır
          // Uyuşmazlık durumunda istek reddedilir
          'x-tenant-id': this.session.tenantId,
        },
        body,
        signal: controller.signal,
      });

      // ── HTTP Durum Kodu Kontrolü ────────────────────────────
      // 2xx dışı durum kodları hata olarak işlenir
      // GraphQL spec'te 200 dışı kodlar da hata içerebilir
      if (!response.ok) {
        // Yanıt body'sini okumaya çalış (hata detayı içerebilir)
        let errorBody = '';
        try {
          errorBody = await response.text();
        } catch {
          // Body okunamazsa yoksay — zaten hata mesajımız var
        }

        logger.error(
          `HTTP hatası — status: ${response.status} ${response.statusText}, ` +
          `body: ${errorBody.substring(0, 200)}`
        );

        throw new GraphQLError(
          `Gateway HTTP hatası: ${response.status} ${response.statusText}`,
          [],
          response.status,
        );
      }

      // ── Yanıtı Parse Et ────────────────────────────────────
      // JSON parse — geçersiz JSON durumunda SyntaxError fırlatır
      const result = (await response.json()) as GraphQLResponse<T>;

      return result;
    } finally {
      // ── Timeout Zamanlayıcısını Temizle ─────────────────────
      // İstek başarılı veya hatalı bitse de timeout temizlenir
      // Aksi halde memory leak ve gereksiz abort çağrısı olur
      clearTimeout(timeoutId);
    }
  }
}
