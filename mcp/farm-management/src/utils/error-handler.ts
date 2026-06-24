// ============================================================================
// MCP Farm Intelligence Server — Hata Yönetimi Modülü
// ============================================================================
//
// MCP protokolüne uygun hata sınıfları ve hata işleme yardımcıları.
//
// NASIL ÇALIŞIR:
//   1. McpError: Genel MCP hataları için temel sınıf (kod + detaylar)
//   2. GraphQLError: Gateway iletişim hataları (ağ, timeout, GraphQL hataları)
//   3. handleToolError(): Herhangi bir hatayı MCP uyumlu yanıt formatına çevirir
//
// MCP Hata Yanıt Formatı:
//   { content: [{ type: 'text', text: '...' }], isError: true }
//   Claude bu formatı algılayıp kullanıcıya uygun mesaj gösterir
//
// Hata Kodları:
//   - INVALID_INPUT: Geçersiz parametre / eksik alan
//   - UNAUTHORIZED: JWT token eksik veya süresi dolmuş
//   - NOT_FOUND: İstenen kaynak bulunamadı
//   - GATEWAY_ERROR: GraphQL Gateway iletişim hatası
//   - TIMEOUT: İstek zaman aşımına uğradı
//   - INTERNAL: Beklenmeyen iç hata
//
// EXTENSIBLE:
//   - Yeni hata kodu eklemek için McpErrorCode union type'a ekleyin
//   - Özel hata sınıfları McpError'dan türetilebilir
//   - handleToolError() içinde yeni hata türleri tanınabilir
// ============================================================================

import { ZodError } from 'zod';

import { createLogger } from './logger.js';

/** Hata yönetimi modülü için logger */
const logger = createLogger('ErrorHandler');

// ── Hata Kodları ────────────────────────────────────────────────
/**
 * MCP hata kodları.
 * Her kod belirli bir hata kategorisini temsil eder.
 */
export type McpErrorCode =
  | 'INVALID_INPUT'    // Geçersiz veya eksik parametre
  | 'UNAUTHORIZED'     // Kimlik doğrulama hatası
  | 'NOT_FOUND'        // Kaynak bulunamadı
  | 'GATEWAY_ERROR'    // GraphQL Gateway iletişim sorunu
  | 'TIMEOUT'          // İstek zaman aşımı
  | 'INTERNAL';        // Beklenmeyen dahili hata

// ── MCP Hata Yanıt Tipi ────────────────────────────────────────
/**
 * MCP protokolüne uygun hata yanıt yapısı.
 * Tool çağrısının hata ile sonuçlandığını belirtir.
 *
 * content[]: Hata mesajını taşıyan içerik dizisi
 * isError: true — Claude'a bunun bir hata olduğunu bildirir
 */
export interface McpErrorResponse {
  // The MCP SDK Result base carries an open `[key: string]: unknown` index
  // signature (plus optional _meta); without it this interface is not
  // assignable to the SDK CallToolResult/ServerResult union, which breaks the
  // setRequestHandler(CallToolRequestSchema, ...) call site (TS2345).
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
}

// ── McpError Sınıfı ────────────────────────────────────────────
/**
 * MCP özel hata sınıfı.
 * Standart Error'ı genişletir; hata kodu ve ek detaylar ekler.
 *
 * Kullanım örneği:
 *   throw new McpError('INVALID_INPUT', 'Havuz ID zorunludur', { field: 'poolId' });
 *   throw new McpError('NOT_FOUND', 'Havuz bulunamadı: abc-123');
 *
 * @param code - Hata kategori kodu (McpErrorCode)
 * @param message - İnsan okunabilir hata mesajı
 * @param details - Opsiyonel ek bilgiler (hata ayıklama için)
 */
export class McpError extends Error {
  /** Hata kategori kodu */
  public readonly code: McpErrorCode;

  /** Opsiyonel ek detaylar — hata ayıklama ve bağlam bilgisi */
  public readonly details?: Record<string, unknown>;

  constructor(code: McpErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);

    // ── Prototip Zinciri Düzeltmesi ─────────────────────────
    // TypeScript'te Error'dan türetilen sınıflarda prototype zinciri
    // kırılabilir. Bu satır düzgün instanceof kontrolü sağlar.
    Object.setPrototypeOf(this, new.target.prototype);

    this.name = 'McpError';
    this.code = code;
    this.details = details;
  }
}

// ── GraphQLError Sınıfı ─────────────────────────────────────────
/**
 * GraphQL Gateway iletişim hatası sınıfı.
 * Gateway'den dönen hata mesajlarını ve ağ hatalarını temsil eder.
 *
 * NASIL ÇALIŞIR:
 *   1. GraphQL client bir istek gönderir
 *   2. Yanıtta errors[] dizisi varsa bu sınıf fırlatılır
 *   3. Ağ hatası (fetch reject) durumunda da bu sınıf kullanılır
 *   4. handleToolError() bu sınıfı tanıyıp uygun MCP yanıtı oluşturur
 *
 * @param message - Hata mesajı (ilk GraphQL hatası veya ağ hatası)
 * @param graphqlErrors - Gateway'den dönen tüm GraphQL hataları
 * @param statusCode - HTTP durum kodu (varsa)
 */
export class GraphQLError extends Error {
  /** Gateway'den dönen tüm GraphQL hata nesneleri */
  public readonly graphqlErrors: Array<{
    message: string;
    locations?: Array<{ line: number; column: number }>;
    path?: string[];
    extensions?: Record<string, unknown>;
  }>;

  /** HTTP yanıt durum kodu (varsa, yoksa undefined) */
  public readonly statusCode?: number;

  constructor(
    message: string,
    graphqlErrors: Array<{
      message: string;
      locations?: Array<{ line: number; column: number }>;
      path?: string[];
      extensions?: Record<string, unknown>;
    }> = [],
    statusCode?: number,
  ) {
    super(message);

    // ── Prototip Zinciri Düzeltmesi ─────────────────────────
    Object.setPrototypeOf(this, new.target.prototype);

    this.name = 'GraphQLError';
    this.graphqlErrors = graphqlErrors;
    this.statusCode = statusCode;
  }
}

// ── handleToolError Fonksiyonu ──────────────────────────────────
/**
 * Herhangi bir hatayı MCP uyumlu hata yanıtına dönüştürür.
 *
 * NASIL ÇALIŞIR:
 *   1. Hata tipini kontrol eder (McpError, GraphQLError, Error, bilinmeyen)
 *   2. Her tip için uygun formatta hata mesajı oluşturur
 *   3. MCP protokolüne uygun { content, isError } yapısını döner
 *   4. Tüm hatalar loglanır (debug seviyesinde detaylı, error seviyesinde özet)
 *
 * Tanınan hata türleri:
 *   - McpError → kod ve mesaj formatlanır
 *   - GraphQLError → Gateway hatası olarak raporlanır, tüm alt hatalar listelenir
 *   - AbortError (DOMException) → Zaman aşımı olarak raporlanır
 *   - TypeError (fetch) → Ağ bağlantı hatası olarak raporlanır
 *   - Diğer Error → Genel hata olarak raporlanır
 *   - Bilinmeyen → String'e çevrilip raporlanır
 *
 * @param error - Yakalanan hata nesnesi (herhangi bir tip olabilir)
 * @param toolName - Hatanın oluştuğu tool adı (log ve mesaj için)
 * @returns MCP uyumlu hata yanıtı nesnesi
 */
export function handleToolError(error: unknown, toolName: string): McpErrorResponse {
  // ── Hata Loglama ──────────────────────────────────────────
  logger.error(`Tool hatası [${toolName}]:`, error);

  // ── ZodError İşleme ──────────────────────────────────────
  // Zod doğrulama hataları — yapılandırılmış validasyon detaylarını korur.
  // instanceof ZodError ile tip-güvenli tanınır; issues dizisi tam tiplidir
  // (her issue: { path: PropertyKey[]; message: string }).
  if (error instanceof ZodError) {
    const issues = error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    return {
      content: [{ type: 'text', text: `Geçersiz parametreler: ${issues}` }],
      isError: true,
    };
  }

  // ── McpError İşleme ───────────────────────────────────────
  // Uygulama tarafından kasıtlı olarak fırlatılmış hatalar
  if (error instanceof McpError) {
    // Detaylar varsa mesaja ekle (hata ayıklama kolaylığı)
    const detailsStr = error.details
      ? `\nDetaylar: ${JSON.stringify(error.details)}`
      : '';

    return {
      content: [
        {
          type: 'text' as const,
          text: `Hata [${error.code}]: ${error.message}${detailsStr}`,
        },
      ],
      isError: true,
    };
  }

  // ── GraphQLError İşleme ───────────────────────────────────
  // Gateway iletişiminden dönen hatalar
  if (error instanceof GraphQLError) {
    if (error.statusCode === 401) {
      return {
        content: [{ type: 'text' as const, text: 'JWT token süresi dolmuş veya geçersiz. MCP_JWT_TOKEN ortam değişkenini güncel bir JWT ile güncelleyin. Math tool\'ları (hesaplama) JWT olmadan çalışmaya devam eder.' }],
        isError: true,
      };
    }
    if (error.statusCode === 403) {
      return {
        content: [{ type: 'text' as const, text: 'Yetki hatası: Bu işlem için gerekli izinlere sahip değilsiniz. Kullanıcının rolünü ve tenant erişimini kontrol edin.' }],
        isError: true,
      };
    }
    // Tüm GraphQL alt hatalarını listele
    const errorList = error.graphqlErrors
      .map((e, i) => `  ${i + 1}. ${e.message}${e.path ? ` (path: ${e.path.join('.')})` : ''}`)
      .join('\n');

    const statusStr = error.statusCode ? ` (HTTP ${error.statusCode})` : '';

    return {
      content: [
        {
          type: 'text' as const,
          text: `Gateway Hatası${statusStr}: ${error.message}${errorList ? `\n\nGraphQL hataları:\n${errorList}` : ''}`,
        },
      ],
      isError: true,
    };
  }

  // ── Zaman Aşımı Hatası ────────────────────────────────────
  // AbortController.abort() tarafından tetiklenen DOMException
  // Node.js'te AbortError name'i ile tanınır
  if (error instanceof DOMException && error.name === 'AbortError') {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Zaman aşımı: ${toolName} tool'u yanıt süresini aştı. Gateway yoğun olabilir, lütfen tekrar deneyin.`,
        },
      ],
      isError: true,
    };
  }

  // ── Ağ Bağlantı Hatası ───────────────────────────────────
  // fetch() gateway'e ulaşamadığında TypeError fırlatır
  // Örnek: "fetch failed", "ECONNREFUSED", "ENOTFOUND"
  if (error instanceof TypeError && error.message.includes('fetch')) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Ağ hatası: Gateway'e bağlanılamıyor. Servisin çalıştığından emin olun.\nDetay: ${error.message}`,
        },
      ],
      isError: true,
    };
  }

  // ── Genel Error İşleme ───────────────────────────────────
  // Standart JavaScript Error nesneleri
  if (error instanceof Error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `${toolName} tool'unda hata oluştu: ${error.message}`,
        },
      ],
      isError: true,
    };
  }

  // ── Bilinmeyen Hata Tipi ──────────────────────────────────
  // Error olmayan değerler fırlatılmış olabilir (string, number vb.)
  // String'e çevirip raporla
  return {
    content: [
      {
        type: 'text' as const,
        text: `${toolName} tool'unda beklenmeyen hata: ${String(error)}`,
      },
    ],
    isError: true,
  };
}
