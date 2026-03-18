// ============================================================================
// MCP Farm Intelligence Server — Logger (Kayıt Tutma) Modülü
// ============================================================================
//
// Yapılandırılabilir seviyeli basit bir loglama sistemi.
//
// NASIL ÇALIŞIR:
//   1. setLogLevel() ile global minimum log seviyesi ayarlanır
//   2. createLogger(prefix) ile modüle özel logger oluşturulur
//   3. Her log çağrısı seviye kontrolünden geçer (debug < info < warn < error)
//   4. Eşik altındaki mesajlar sessizce atılır (filtrelenir)
//   5. Geçen mesajlar [TIMESTAMP] [LEVEL] [PREFIX] formatında console'a yazılır
//
// Log seviyeleri hiyerarşisi:
//   debug (0) < info (1) < warn (2) < error (3)
//   Örnek: globalLevel='warn' → sadece warn ve error mesajları görünür
//
// EXTENSIBLE:
//   - Yeni seviye eklemek için LOG_LEVELS nesnesine ekleyin
//   - Dosyaya yazma desteği için write fonksiyonunu özelleştirin
//   - Yapılandırılmış (structured) JSON log için format'ı değiştirin
// ============================================================================

/**
 * Log seviye numaraları.
 * Düşük numara = daha detaylı (verbose), yüksek numara = daha kritik.
 */
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;

/** Log seviyesi tipi — sadece tanımlı anahtarlar geçerlidir */
type LogLevel = keyof typeof LOG_LEVELS;

/**
 * Logger arayüzü.
 * Her log seviyesi için bir metod sağlar.
 * İlk parametre mesaj string'i, sonraki parametreler ek veri (metadata).
 */
export interface Logger {
  /** Hata ayıklama mesajları — sadece logLevel='debug' iken görünür */
  debug(msg: string, ...args: unknown[]): void;
  /** Bilgi mesajları — normal işleyiş hakkında bilgi */
  info(msg: string, ...args: unknown[]): void;
  /** Uyarı mesajları — potansiyel sorunlar, düzeltilmesi gereken durumlar */
  warn(msg: string, ...args: unknown[]): void;
  /** Hata mesajları — ciddi sorunlar, işlem başarısızlıkları */
  error(msg: string, ...args: unknown[]): void;
}

// ── Global Seviye ───────────────────────────────────────────────
// Tüm logger instance'ları bu global seviyeyi paylaşır.
// Uygulama başlangıcında config'den ayarlanır.
let globalLevel: LogLevel = 'info';

/**
 * Global log seviyesini ayarlar.
 * Bu seviyenin altındaki tüm mesajlar filtrelenir.
 *
 * Örnek kullanım:
 *   setLogLevel('debug');  // tüm mesajları göster
 *   setLogLevel('error');  // sadece hataları göster
 *
 * @param level - Minimum log seviyesi
 */
export function setLogLevel(level: LogLevel): void {
  globalLevel = level;
}

/**
 * Zaman damgası oluşturur.
 * ISO 8601 formatında: "2026-03-16T14:30:45.123Z"
 *
 * @returns Formatlanmış zaman damgası string'i
 */
function getTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Seviye etiketini büyük harfle ve sabit genişlikte formatlar.
 * Konsol çıktısında hizalama için kullanılır.
 *
 * @param level - Log seviyesi
 * @returns 5 karakter genişliğinde büyük harfli seviye etiketi
 */
function formatLevel(level: LogLevel): string {
  // padEnd(5) ile hizalama: "DEBUG", "INFO ", "WARN ", "ERROR"
  return level.toUpperCase().padEnd(5);
}

/**
 * Modüle özel bir logger instance'ı oluşturur.
 *
 * NASIL ÇALIŞIR:
 *   1. prefix parametresi her mesajın başına eklenir (modül tanımlayıcı)
 *   2. Her metod çağrısında global seviye kontrolü yapılır
 *   3. Seviye eşiğini geçen mesajlar formatlanıp console'a yazılır
 *   4. Ek argümanlar (args) mesajın ardından console'a iletilir
 *
 * Çıktı formatı: [2026-03-16T14:30:45.123Z] [INFO ] [GraphQL] Sorgu gönderiliyor...
 *
 * @param prefix - Logger ön eki (modül adı, örn: "GraphQL", "Anomaly")
 * @returns Logger arayüzünü uygulayan nesne
 */
export function createLogger(prefix: string): Logger {
  /**
   * Dahili log fonksiyonu — tüm seviyeler bunu kullanır.
   *
   * Akış:
   *   1. Seviye numarası global seviye numarasıyla karşılaştırılır
   *   2. Eşiğin altındaysa fonksiyon erken döner (mesaj atılır)
   *   3. Eşiği geçtiyse formatlanmış mesaj ilgili console metoduyla yazılır
   *
   * @param level - Log seviyesi
   * @param msg - Log mesajı
   * @param args - Ek veri (nesneler, hatalar vb.)
   */
  function log(level: LogLevel, msg: string, ...args: unknown[]): void {
    // ── Seviye Filtresi ─────────────────────────────────────
    // LOG_LEVELS[level] → mesajın seviye numarası
    // LOG_LEVELS[globalLevel] → minimum eşik numarası
    // Eşiğin altındaki mesajlar sessizce atılır
    if (LOG_LEVELS[level] < LOG_LEVELS[globalLevel]) {
      return;
    }

    // ── Mesaj Formatlama ────────────────────────────────────
    // Format: [ISO_TIMESTAMP] [LEVEL] [PREFIX] mesaj
    const formattedMessage = `[${getTimestamp()}] [${formatLevel(level)}] [${prefix}] ${msg}`;

    // ── Konsola Yazma ───────────────────────────────────────
    // MCP stdio modunda stdout JSON-RPC stream'i için ayrılmıştır.
    // Tüm log çıktıları stderr'e yönlendirilmelidir (console.error).
    // console.info ve console.debug Node.js'te stdout'a yazar,
    // bu da MCP JSON-RPC stream'ini bozar!
    switch (level) {
      case 'debug':
        console.error(formattedMessage, ...args);
        break;
      case 'info':
        console.error(formattedMessage, ...args);
        break;
      case 'warn':
        console.error(formattedMessage, ...args);
        break;
      case 'error':
        console.error(formattedMessage, ...args);
        break;
    }
  }

  // ── Logger Nesnesi ──────────────────────────────────────────
  // Her metod, seviye parametresini bind ederek log() fonksiyonuna delege eder
  return {
    debug: (msg: string, ...args: unknown[]) => log('debug', msg, ...args),
    info: (msg: string, ...args: unknown[]) => log('info', msg, ...args),
    warn: (msg: string, ...args: unknown[]) => log('warn', msg, ...args),
    error: (msg: string, ...args: unknown[]) => log('error', msg, ...args),
  };
}
