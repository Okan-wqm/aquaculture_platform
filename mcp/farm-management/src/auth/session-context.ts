// ============================================================================
// MCP Farm Intelligence Server — JWT Session Context Modülü
// ============================================================================
//
// JWT decode (doğrulama OLMADAN) ile tenant/user bilgisi çıkarma.
// Gateway zaten token'ı doğruladığı için burada verify gerekmez.
//
// NASIL ÇALIŞIR:
//   1. MCP_JWT_TOKEN ortam değişkeninden veya tool call parametresinden JWT alınır
//   2. JWT üç parçadan oluşur: header.payload.signature (base64url ile kodlanmış)
//   3. Ortadaki parça (payload) base64url decode edilir
//   4. JSON.parse() ile JwtPayload nesnesine çevrilir
//   5. tenantId, userId, roles gibi bilgiler SessionContext'e aktarılır
//   6. GraphQL client'a Authorization header olarak iletilir
//
// GÜVENLİK NOTU:
//   Bu modül JWT'yi DOĞRULAMAZ (verify etmez).
//   Doğrulama gateway tarafında yapılır — biz gateway'e güveniyoruz.
//   MCP server sadece token'ı proxy eder; gateway tüm güvenlik kontrollerini yapar.
//
// EXTENSIBLE:
//   - Token yenileme (refresh) mekanizması eklenebilir
//   - Çoklu session desteği (farklı tenant'lar arası geçiş)
//   - Token cache'leme (aynı token tekrar decode edilmez)
// ============================================================================

import { createLogger } from '../utils/logger.js';

/** Session context modülü için logger */
const logger = createLogger('Session');

// ── JWT Payload Yapısı ──────────────────────────────────────────
/**
 * JWT payload yapısı.
 * Gateway'in JwtPayload interface'inden türetilmiştir.
 *
 * Gateway JWT'yi oluştururken bu alanları doldurur:
 *   sub: User ID (UUID)
 *   email: Kullanıcı e-posta adresi
 *   tenantId: Kiracı ID'si (multi-tenant izolasyon)
 *   roles: Kullanıcı rolleri dizisi (admin, manager, operator vb.)
 *   permissions: İnce taneli izinler (opsiyonel)
 *   type: Token tipi (access veya refresh)
 *   iat: Oluşturulma zamanı (Unix timestamp, saniye)
 *   exp: Son kullanma zamanı (Unix timestamp, saniye)
 */
interface JwtPayload {
  /** Subject — Kullanıcı UUID'si */
  sub: string;

  /** Kullanıcı e-posta adresi (opsiyonel — bazı token'larda olmayabilir) */
  email?: string;

  /** Kiracı (tenant) ID'si — multi-tenant veri izolasyonu için kritik */
  tenantId: string;

  /** Kullanıcı rolleri — yetkilendirme kontrolü için */
  roles: string[];

  /** İnce taneli izinler (opsiyonel) */
  permissions?: string[];

  /** Token tipi: 'access' (API erişimi) veya 'refresh' (token yenileme) */
  type: 'access' | 'refresh';

  /** Issued At — token oluşturulma zamanı (Unix epoch, saniye) */
  iat: number;

  /** Expiration — token son kullanma zamanı (Unix epoch, saniye) */
  exp: number;
}

// ── Session Context Arayüzü ─────────────────────────────────────
/**
 * Oturum bağlamı — bir MCP session'ının kimlik bilgileri.
 * GraphQL client ve tool'lar tarafından kullanılır.
 */
export interface SessionContext {
  /** Ham JWT token string'i — Authorization header'ına eklenir */
  token: string;

  /** Kiracı ID'si — GraphQL sorgularında x-tenant-id header'ı olarak gönderilir */
  tenantId: string;

  /** Kullanıcı ID'si (UUID) — loglama ve audit için */
  userId: string;

  /** Kullanıcı e-posta adresi (opsiyonel) */
  email?: string;

  /** Kullanıcı rolleri — yetki kontrolü için */
  roles: string[];
}

// ── Base64url Decode ────────────────────────────────────────────
/**
 * Base64url kodlamasını standart base64'e çevirip decode eder.
 *
 * NASIL ÇALIŞIR:
 *   1. Base64url → standart base64 dönüşümü:
 *      - '-' → '+' (62. karakter)
 *      - '_' → '/' (63. karakter)
 *   2. Padding ekleme: base64 string uzunluğu 4'ün katı olmalı
 *      Eksik padding '=' ile tamamlanır
 *   3. Node.js Buffer ile decode: Buffer.from(str, 'base64') → UTF-8 string
 *
 * Neden base64url?
 *   JWT standart base64 yerine URL-safe base64url kullanır.
 *   '+' ve '/' karakterleri URL'lerde sorun çıkarır, bu yüzden
 *   '-' ve '_' ile değiştirilir. Padding ('=') da URL'de sorunlu
 *   olduğu için genellikle atılır.
 *
 * @param base64url - Base64url kodlanmış string
 * @returns Decode edilmiş UTF-8 string
 */
function base64urlDecode(base64url: string): string {
  // Adım 1: URL-safe karakterleri standart base64 karakterlerine çevir
  let base64 = base64url
    .replace(/-/g, '+')    // '-' → '+'
    .replace(/_/g, '/');   // '_' → '/'

  // Adım 2: Padding ekleme — uzunluk 4'ün katı olmalı
  // Eksik karakter sayısı: 4 - (uzunluk % 4), mod 4
  const paddingNeeded = (4 - (base64.length % 4)) % 4;
  base64 += '='.repeat(paddingNeeded);

  // Adım 3: Buffer ile decode
  return Buffer.from(base64, 'base64').toString('utf-8');
}

// ── JWT Decode ──────────────────────────────────────────────────
/**
 * JWT'yi doğrulama YAPMADAN decode eder.
 *
 * NASIL ÇALIŞIR:
 *   1. JWT'yi '.' karakteriyle 3 parçaya böl: [header, payload, signature]
 *   2. Parça sayısı 3 değilse hata fırlat (geçersiz JWT formatı)
 *   3. Ortadaki parçayı (payload) base64url decode et
 *   4. JSON.parse() ile JwtPayload nesnesine çevir
 *   5. Zorunlu alanları kontrol et (sub, tenantId)
 *
 * JWT Yapısı:
 *   eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c
 *   ├─── header ────────┤├─── payload ────────┤├─── signature ───────────────┤
 *
 * GÜVENLİK: Signature doğrulanmaz! Gateway'e güveniyoruz.
 *
 * @param token - JWT token string'i
 * @returns Decode edilmiş JWT payload
 * @throws Error — Geçersiz JWT formatı veya parse hatası
 */
export function decodeJwt(token: string): JwtPayload {
  // Adım 1: JWT'yi parçalara ayır
  const parts = token.split('.');

  // Adım 2: JWT her zaman 3 parçadan oluşmalı
  if (parts.length !== 3) {
    throw new Error(
      `Geçersiz JWT formatı: 3 parça bekleniyor, ${parts.length} parça bulundu`
    );
  }

  try {
    // Adım 3: Payload'ı (ortadaki parça) decode et
    const payloadStr = base64urlDecode(parts[1]!);

    // Adım 4: JSON'a çevir
    const payload = JSON.parse(payloadStr) as JwtPayload;

    // Adım 5: Zorunlu alan kontrolü
    if (!payload.sub) {
      throw new Error('JWT payload\'da "sub" (user ID) alanı bulunamadı');
    }
    if (!payload.tenantId) {
      throw new Error('JWT payload\'da "tenantId" alanı bulunamadı');
    }

    logger.debug(`JWT decode başarılı — user: ${payload.sub}, tenant: ${payload.tenantId}`);
    return payload;
  } catch (error) {
    // JSON.parse veya decode hatası
    if (error instanceof SyntaxError) {
      throw new Error(`JWT payload JSON parse hatası: ${error.message}`);
    }
    // Zaten Error ise tekrar fırlat
    throw error;
  }
}

// ── Session Context Oluşturma ───────────────────────────────────
/**
 * JWT token'dan SessionContext oluşturur.
 *
 * NASIL ÇALIŞIR:
 *   1. Token parametresi verilmemişse MCP_JWT_TOKEN ortam değişkeninden alınır
 *   2. Token boşsa veya yoksa hata fırlatılır
 *   3. decodeJwt() ile payload çıkarılır
 *   4. Payload'dan SessionContext nesnesi oluşturulur
 *
 * Kullanım:
 *   // Ortam değişkeninden
 *   const session = createSessionContext();
 *
 *   // Parametreden (tool call meta'dan gelen token)
 *   const session = createSessionContext(userProvidedToken);
 *
 * @param token - Opsiyonel JWT token (verilmezse env'den okunur)
 * @returns Oturum bağlam nesnesi
 * @throws Error — Token bulunamadı veya geçersiz
 */
export function createSessionContext(token?: string): SessionContext {
  // Adım 1: Token kaynağını belirle
  const jwtToken = token || process.env.MCP_JWT_TOKEN || '';

  // Adım 2: Boş token kontrolü
  if (!jwtToken || jwtToken.trim() === '') {
    throw new Error(
      'JWT token bulunamadı. MCP_JWT_TOKEN ortam değişkenini ayarlayın ' +
      'veya token parametresi ile sağlayın.'
    );
  }

  // Adım 3: JWT'yi decode et
  const payload = decodeJwt(jwtToken);

  // Adım 4: SessionContext oluştur
  const session: SessionContext = {
    token: jwtToken,
    tenantId: payload.tenantId,
    userId: payload.sub,
    email: payload.email,
    roles: payload.roles || [],
  };

  logger.info(
    `Session oluşturuldu — tenant: ${session.tenantId}, user: ${session.userId}, ` +
    `roles: [${session.roles.join(', ')}]`
  );

  return session;
}

// ── Token Geçerlilik Kontrolü ───────────────────────────────────
/**
 * JWT token'ın süresinin dolup dolmadığını kontrol eder.
 *
 * NASIL ÇALIŞIR:
 *   1. Token'ı decode et (payload'dan exp alanını al)
 *   2. exp (Unix timestamp, saniye) ile şimdiki zamanı karşılaştır
 *   3. exp < now → token süresi dolmuş (expired)
 *
 * Tolerance (hoşgörü):
 *   Saat farkları ve ağ gecikmesi için 30 saniyelik hoşgörü uygulanır.
 *   Yani token'ın son kullanma zamanına 30 saniye eklenir.
 *
 * @param token - JWT token string'i
 * @returns true → token süresi dolmuş, false → hâlâ geçerli
 */
export function isTokenExpired(token: string): boolean {
  try {
    const payload = decodeJwt(token);

    // Şimdiki zaman (Unix timestamp, saniye cinsinden)
    const nowInSeconds = Math.floor(Date.now() / 1000);

    // 30 saniyelik hoşgörü (clock skew tolerance)
    // Token'ın exp zamanına 30 saniye eklenir
    const TOLERANCE_SECONDS = 30;

    // exp + tolerance < now → süresi dolmuş
    const isExpired = (payload.exp + TOLERANCE_SECONDS) < nowInSeconds;

    if (isExpired) {
      logger.warn(
        `Token süresi dolmuş — exp: ${new Date(payload.exp * 1000).toISOString()}, ` +
        `şimdi: ${new Date().toISOString()}`
      );
    }

    return isExpired;
  } catch {
    // Decode hatası → güvenli tarafta kal, süresi dolmuş say
    logger.error('Token geçerlilik kontrolünde decode hatası — süresi dolmuş kabul ediliyor');
    return true;
  }
}
