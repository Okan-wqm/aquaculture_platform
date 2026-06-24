// ============================================================================
// MCP Farm Intelligence Server — Formatlama Yardımcıları
// ============================================================================
//
// MCP tool çıktıları için formatlama fonksiyonları.
// Tarih, sayı, yüzde, süre ve ciddiyet (severity) formatlamaları sağlar.
//
// NASIL ÇALIŞIR:
//   Tüm fonksiyonlar saf (pure) ve yan etkisizdir.
//   Date nesneleri veya ISO string'ler kabul eder.
//   Çıktılar insanlar (ve LLM'ler) için okunabilir formattadır.
//
// EXTENSIBLE:
//   - Yeni format fonksiyonu eklemek için bu dosyaya ekleyin
//   - Türkçe'ye özel formatlamalar (binlik ayracı vb.) eklenebilir
//   - Birim dönüşümleri (mg/L → ppm vb.) eklenebilir
// ============================================================================

/**
 * Tarihi ISO 8601 formatına dönüştürür.
 *
 * NASIL ÇALIŞIR:
 *   1. Girdi string ise Date nesnesine çevrilir
 *   2. Geçerli bir tarih mi kontrol edilir (isNaN)
 *   3. ISO string formatında döndürülür: "2026-03-16T14:30:45.123Z"
 *
 * @param date - Date nesnesi veya tarih string'i
 * @returns ISO 8601 formatında tarih string'i
 */
export function formatDate(date: Date | string): string {
  // String ise Date nesnesine çevir
  const d = typeof date === 'string' ? new Date(date) : date;

  // Geçersiz tarih kontrolü — isNaN(Date) = geçersiz
  if (isNaN(d.getTime())) {
    return 'Geçersiz tarih';
  }

  return d.toISOString();
}

/**
 * Sayıyı belirli ondalık basamağa yuvarlar.
 *
 * NASIL ÇALIŞIR:
 *   1. decimals parametresi varsayılan 2
 *   2. Number.toFixed() yerine matematik yuvarlama kullanılır
 *      (toFixed string döner, biz number dönmek istiyoruz)
 *   3. Math.round(value * 10^n) / 10^n formülü
 *
 * Neden toFixed() kullanmıyoruz?
 *   toFixed() string döner. Biz number istiyoruz ki
 *   sonraki hesaplamalarda kullanılabilsin.
 *
 * @param value - Yuvarlanacak sayı
 * @param decimals - Ondalık basamak sayısı (varsayılan: 2)
 * @returns Yuvarlanmış sayı
 */
export function formatNumber(value: number, decimals = 2): number {
  // NaN veya Infinity kontrolü
  if (!Number.isFinite(value)) return value;

  // Çarpan: 10^decimals (örn: decimals=2 → 100)
  const factor = Math.pow(10, decimals);

  // Yuvarlama: Math.round(x * 100) / 100
  return Math.round(value * factor) / factor;
}

/**
 * Değeri yüzde formatına dönüştürür.
 *
 * Çıktı formatı: "45.2%" (bir ondalık basamak)
 *
 * NASIL ÇALIŞIR:
 *   1. Değer zaten yüzde olarak gelir (0-100 arası beklenir)
 *   2. Bir ondalık basamağa yuvarlanır
 *   3. "%" eki eklenir
 *
 * Dikkat: Bu fonksiyon 0-1 aralığını 0-100'e ÇEVIRMEZ.
 *   Girdi zaten yüzde değeridir.
 *   0.452 → "0.5%" (YANLIŞ — girdinin 45.2 olması gerekir)
 *   45.2  → "45.2%" (DOĞRU)
 *
 * @param value - Yüzde değeri (örn: 45.2 → "45.2%")
 * @returns Formatlanmış yüzde string'i
 */
export function formatPercent(value: number): string {
  return `${formatNumber(value, 1)}%`;
}

/**
 * Saat değerini okunabilir Türkçe süre formatına dönüştürür.
 *
 * NASIL ÇALIŞIR:
 *   1. Saat değeri kategorize edilir:
 *      - < 1 saat → dakika cinsinden ("~45 dakika")
 *      - < 24 saat → saat cinsinden ("6 saat")
 *      - >= 24 saat → gün + saat cinsinden ("2 gün 6 saat")
 *   2. Uygun Türkçe birimler eklenir
 *
 * Örnek çıktılar:
 *   0.5   → "~30 dakika"
 *   3     → "3 saat"
 *   6.5   → "6 saat 30 dakika"
 *   30    → "1 gün 6 saat"
 *   48    → "2 gün"
 *   72.5  → "3 gün 30 dakika"
 *   0     → "0 dakika"
 *
 * @param hours - Süre (saat cinsinden, ondalıklı olabilir)
 * @returns Okunabilir Türkçe süre string'i
 */
export function formatDuration(hours: number): string {
  // Negatif değer koruması
  const absHours = Math.abs(hours);

  // 1 saatten az → dakika cinsinden göster
  if (absHours < 1) {
    const minutes = Math.round(absHours * 60);
    return `~${minutes} dakika`;
  }

  // 24 saatten az → saat (ve varsa dakika) cinsinden göster
  if (absHours < 24) {
    const fullHours = Math.floor(absHours);
    const minutes = Math.round((absHours - fullHours) * 60);

    if (minutes === 0) {
      return `${fullHours} saat`;
    }
    return `${fullHours} saat ${minutes} dakika`;
  }

  // 24 saat ve üzeri → gün + saat cinsinden göster
  const days = Math.floor(absHours / 24);
  const remainingHours = Math.floor(absHours % 24);
  const remainingMinutes = Math.round((absHours - Math.floor(absHours)) * 60);

  // Sadece gün (saat ve dakika kalmadıysa)
  if (remainingHours === 0 && remainingMinutes === 0) {
    return `${days} gün`;
  }

  // Gün + saat (dakika kalmadıysa)
  if (remainingMinutes === 0) {
    return `${days} gün ${remainingHours} saat`;
  }

  // Gün + dakika (tam saat kalmadıysa)
  if (remainingHours === 0) {
    return `${days} gün ${remainingMinutes} dakika`;
  }

  // Gün + saat + dakika
  return `${days} gün ${remainingHours} saat`;
}

/**
 * Ciddiyet (severity) seviyesine emoji ön eki ekler.
 *
 * NASIL ÇALIŞIR:
 *   Severity string'i küçük harfe çevrilip eşleştirilir.
 *   Tanınmayan seviyeler varsayılan bilgi simgesiyle döner.
 *
 * Severity seviyeleri ve emojileri:
 *   critical → "🔴 CRITICAL" (kritik — acil müdahale gerekir)
 *   high     → "🟠 HIGH"     (yüksek — yakın zamanda müdahale)
 *   medium   → "🟡 MEDIUM"   (orta — planlanmış müdahale)
 *   low      → "🟢 LOW"      (düşük — bilgilendirme)
 *   info     → "ℹ️ INFO"      (bilgi — normal gözlem)
 *
 * @param severity - Ciddiyet seviyesi string'i
 * @returns Emoji ön ekli ciddiyet string'i
 */
export function formatSeverity(severity: string): string {
  // Büyük/küçük harf fark etmez — küçük harfe çevir
  const level = severity.toLowerCase();

  // ── Emoji Eşleştirme Tablosu ──────────────────────────────
  const severityMap: Record<string, string> = {
    critical: '🔴 CRITICAL',
    high: '🟠 HIGH',
    medium: '🟡 MEDIUM',
    low: '🟢 LOW',
    info: 'ℹ️ INFO',
  };

  // Tanınmayan seviye → orijinal string'i büyük harfle dön
  return severityMap[level] ?? `ℹ️ ${severity.toUpperCase()}`;
}

/**
 * Verilen tarihten bu yana geçen gün sayısını hesaplar.
 *
 * NASIL ÇALIŞIR:
 *   1. Tarih string ise Date'e çevir
 *   2. Şimdiki zaman ile farkı hesapla (ms cinsinden)
 *   3. Milisaniyeyi güne çevir (ms / 86400000)
 *   4. Aşağıya yuvarla (tamamlanmamış günler sayılmaz)
 *
 * @param date - Başlangıç tarihi (Date veya ISO string)
 * @returns Bu yana geçen tam gün sayısı (negatif olabilir — gelecek tarih)
 */
export function daysAgo(date: Date | string): number {
  const d = typeof date === 'string' ? new Date(date) : date;

  // Geçersiz tarih kontrolü
  if (isNaN(d.getTime())) return 0;

  // Fark hesabı: şimdi - tarih (ms cinsinden)
  const diffMs = Date.now() - d.getTime();

  // Milisaniye → gün dönüşümü: 1 gün = 24 × 60 × 60 × 1000 = 86400000 ms
  return Math.floor(diffMs / 86_400_000);
}

/**
 * Verilen tarihten bu yana geçen saat sayısını hesaplar.
 *
 * NASIL ÇALIŞIR:
 *   1. Tarih string ise Date'e çevir
 *   2. Şimdiki zaman ile farkı hesapla (ms cinsinden)
 *   3. Milisaniyeyi saate çevir (ms / 3600000)
 *   4. Bir ondalık basamağa yuvarla
 *
 * @param date - Başlangıç tarihi (Date veya ISO string)
 * @returns Bu yana geçen saat sayısı (bir ondalık, negatif olabilir)
 */
export function hoursAgo(date: Date | string): number {
  const d = typeof date === 'string' ? new Date(date) : date;

  // Geçersiz tarih kontrolü
  if (isNaN(d.getTime())) return 0;

  // Fark hesabı: şimdi - tarih (ms cinsinden)
  const diffMs = Date.now() - d.getTime();

  // Milisaniye → saat dönüşümü: 1 saat = 60 × 60 × 1000 = 3600000 ms
  // Bir ondalık basamağa yuvarla
  return formatNumber(diffMs / 3_600_000, 1);
}

/**
 * Şu andan geriye doğru N günlük tarih aralığı oluşturur.
 *
 * NASIL ÇALIŞIR:
 *   1. Şimdiki zaman "to" (bitiş) olarak alınır
 *   2. N gün geriye gidilerek "from" (başlangıç) hesaplanır
 *   3. Her iki tarih ISO 8601 formatında döndürülür
 *
 * Kullanım amacı:
 *   GraphQL sorgularında zaman filtresi olarak kullanılır.
 *   Örnek: "Son 7 gündeki anomalileri getir" → dateRange(7)
 *
 * @param days - Geriye gidilecek gün sayısı
 * @returns { from: ISO string, to: ISO string }
 */
/**
 * Sayıyı belirli ondalık basamağa yuvarlar.
 *
 * formatNumber'a benzer, ancak daha kısa isimli ve yaygın kullanıma uygun.
 * Math tool'ları ve analitik hesaplamalarda sıkça kullanılır.
 *
 * @param value - Yuvarlanacak sayı
 * @param decimals - Ondalık basamak sayısı (varsayılan: 2)
 * @returns Yuvarlanmış sayı
 */
export function round(value: number, decimals = 2): number {
  if (!Number.isFinite(value)) return value;
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

export function dateRange(days: number): { from: string; to: string } {
  const now = new Date();

  // Geriye doğru tarih hesabı
  const from = new Date(now);
  from.setDate(from.getDate() - days);

  return {
    from: from.toISOString(),
    to: now.toISOString(),
  };
}
