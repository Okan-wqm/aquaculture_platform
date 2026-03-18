// ============================================================================
// MCP Farm Intelligence Server — Konfigürasyon Modülü
// ============================================================================
//
// Çevre değişkenleri konfigürasyonu
// Tüm MCP server ayarları tek noktadan yönetilir.
//
// NASIL ÇALIŞIR:
//   1. Uygulama başlatılırken loadConfig() çağrılır
//   2. process.env üzerinden çevre değişkenleri okunur
//   3. Tanımlı olmayan değişkenler için varsayılan değerler kullanılır
//   4. Tip güvenli McpConfig nesnesi döndürülür
//
// EXTENSIBLE:
//   - Yeni ayar eklemek için McpConfig interface'ine alan ekleyin
//   - loadConfig() içinde process.env'den okuyun ve varsayılan atayın
//   - .env.example dosyasına yeni değişkeni ekleyin
// ============================================================================

/**
 * MCP Server konfigürasyon arayüzü.
 *
 * Tüm MCP çalışma parametrelerini tanımlar:
 * - gatewayUrl: GraphQL Gateway adresi (farm verilerine erişim noktası)
 * - jwtToken: Kullanıcı kimlik doğrulama token'ı
 * - transport: İletişim modu — stdio (CLI) veya sse (web)
 * - port: SSE modunda dinlenecek port
 * - logLevel: Minimum log seviyesi
 * - requestTimeout: GraphQL istek zaman aşımı (ms)
 */
export interface McpConfig {
  /** GraphQL Gateway URL'i — farm-service verilerine erişim noktası */
  gatewayUrl: string;

  /** JWT Bearer token — stdio modunda ortam değişkeninden gelir */
  jwtToken: string;

  /**
   * Transport modu:
   * - 'stdio': Claude Desktop / Claude Code entegrasyonu (stdin/stdout)
   * - 'sse': Server-Sent Events — web tarayıcı entegrasyonu
   */
  transport: 'stdio' | 'sse';

  /** SSE modu dinleme portu (sadece transport='sse' iken kullanılır) */
  port: number;

  /**
   * Log seviyesi — minimum çıktı seviyesini belirler
   * debug < info < warn < error sıralaması geçerlidir
   */
  logLevel: 'debug' | 'info' | 'warn' | 'error';

  /**
   * GraphQL istek zaman aşımı (milisaniye cinsinden)
   * Bu süre aşılırsa AbortController isteği iptal eder
   */
  requestTimeout: number;
}

/**
 * Çevre değişkenlerinden konfigürasyonu yükler.
 *
 * Her alan için varsayılan değer tanımlıdır:
 * - GATEWAY_URL → 'http://localhost:3000/graphql' (yerel geliştirme)
 * - MCP_JWT_TOKEN → '' (boş — başlatılmadan önce ayarlanmalı)
 * - MCP_TRANSPORT → 'stdio' (varsayılan CLI modu)
 * - MCP_PORT → 3009 (SSE modu portu)
 * - MCP_LOG_LEVEL → 'info' (debug mesajları gizlenir)
 * - MCP_REQUEST_TIMEOUT → 30000 (30 saniye)
 *
 * @returns Tip güvenli McpConfig nesnesi
 */
export function loadConfig(): McpConfig {
  return {
    // ── Gateway Bağlantısı ──────────────────────────────────────
    // GraphQL Gateway'e HTTP POST ile sorgu gönderilir
    // Yerel geliştirmede localhost:3000, production'da gateway servis adresi
    gatewayUrl: process.env.GATEWAY_URL || 'http://localhost:3000/graphql',

    // ── Kimlik Doğrulama ────────────────────────────────────────
    // JWT token — gateway bu token'ı doğrular ve tenant izolasyonu sağlar
    // stdio modunda env'den okunur, sse modunda client gönderir
    jwtToken: process.env.MCP_JWT_TOKEN || '',

    // ── Transport Modu ──────────────────────────────────────────
    // 'stdio': stdin/stdout üzerinden JSON-RPC (Claude Desktop uyumlu)
    // 'sse': HTTP SSE endpoint (tarayıcı/web client uyumlu)
    transport: (process.env.MCP_TRANSPORT as 'stdio' | 'sse') || 'stdio',

    // ── SSE Port ────────────────────────────────────────────────
    // Sadece transport='sse' modunda kullanılır
    // parseInt ile sayıya çevrilir, geçersiz değerde NaN olur (dikkat!)
    port: parseInt(process.env.MCP_PORT || '3009', 10),

    // ── Log Seviyesi ────────────────────────────────────────────
    // debug: tüm mesajlar, info: bilgi+uyarı+hata, warn: uyarı+hata, error: sadece hata
    logLevel: (process.env.MCP_LOG_LEVEL as McpConfig['logLevel']) || 'info',

    // ── İstek Zaman Aşımı ──────────────────────────────────────
    // Gateway'e gönderilen GraphQL istekleri için maksimum bekleme süresi
    // Ağır sorgularda (anomali taraması vb.) artırılması gerekebilir
    requestTimeout: parseInt(process.env.MCP_REQUEST_TIMEOUT || '30000', 10),
  };
}
