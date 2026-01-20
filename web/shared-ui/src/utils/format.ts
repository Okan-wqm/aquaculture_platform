/**
 * Format Utilities
 * Sayı, para birimi ve metin formatlama yardımcıları
 * Türkçe lokalizasyon desteği
 */

// ============================================================================
// Sayı Formatlama
// ============================================================================

/**
 * Sayıyı binlik ayraçlı formatla
 *
 * @example
 * formatNumber(1234567) // "1.234.567"
 * formatNumber(1234.56, 2) // "1.234,56"
 */
export function formatNumber(
  value: number,
  decimals: number = 0,
  locale: string = 'tr-TR'
): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

/**
 * Para birimini formatla
 *
 * @example
 * formatCurrency(1234.56) // "₺1.234,56"
 * formatCurrency(1234.56, 'USD') // "$1.234,56"
 */
export function formatCurrency(
  value: number,
  currency: string = 'TRY',
  locale: string = 'tr-TR'
): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * Yüzdeyi formatla
 *
 * @example
 * formatPercent(0.1234) // "%12,34"
 * formatPercent(0.1234, 0) // "%12"
 */
export function formatPercent(
  value: number,
  decimals: number = 2,
  locale: string = 'tr-TR'
): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

/**
 * Dosya boyutunu formatla
 *
 * @example
 * formatFileSize(1024) // "1 KB"
 * formatFileSize(1234567) // "1,18 MB"
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  const value = bytes / Math.pow(k, i);
  const formatted = value < 10 ? value.toFixed(2) : value < 100 ? value.toFixed(1) : value.toFixed(0);

  return `${formatted.replace('.', ',')} ${units[i]}`;
}

/**
 * Büyük sayıları kısalt
 *
 * @example
 * formatCompact(1234) // "1,23K"
 * formatCompact(1234567) // "1,23M"
 */
export function formatCompact(
  value: number,
  locale: string = 'tr-TR'
): string {
  return new Intl.NumberFormat(locale, {
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * Sayıyı kelime olarak yaz (Türkçe)
 */
export function numberToWords(num: number): string {
  if (num === 0) return 'sıfır';

  const ones = ['', 'bir', 'iki', 'üç', 'dört', 'beş', 'altı', 'yedi', 'sekiz', 'dokuz'];
  const tens = ['', 'on', 'yirmi', 'otuz', 'kırk', 'elli', 'altmış', 'yetmiş', 'seksen', 'doksan'];
  const thousands = ['', 'bin', 'milyon', 'milyar', 'trilyon'];

  if (num < 0) return 'eksi ' + numberToWords(-num);

  let word = '';
  let i = 0;

  while (num > 0) {
    const chunk = num % 1000;
    if (chunk !== 0) {
      let chunkWord = '';

      // Yüzler
      const h = Math.floor(chunk / 100);
      if (h > 0) {
        chunkWord += (h === 1 ? '' : ones[h]) + 'yüz ';
      }

      // Onlar
      const t = Math.floor((chunk % 100) / 10);
      if (t > 0) {
        chunkWord += tens[t] + ' ';
      }

      // Birler
      const o = chunk % 10;
      if (o > 0) {
        // "bir bin" yerine "bin" kullan
        if (!(i === 1 && chunk === 1)) {
          chunkWord += ones[o] + ' ';
        }
      }

      chunkWord += thousands[i] + ' ';
      word = chunkWord + word;
    }

    num = Math.floor(num / 1000);
    i++;
  }

  return word.trim();
}

// ============================================================================
// Metin Formatlama
// ============================================================================

/**
 * Metni büyük harfle başlat
 *
 * @example
 * capitalize('merhaba dünya') // "Merhaba dünya"
 */
export function capitalize(text: string): string {
  if (!text) return '';
  return text.charAt(0).toLocaleUpperCase('tr-TR') + text.slice(1).toLocaleLowerCase('tr-TR');
}

/**
 * Her kelimenin ilk harfini büyük yap
 *
 * @example
 * titleCase('merhaba dünya') // "Merhaba Dünya"
 */
export function titleCase(text: string): string {
  if (!text) return '';
  return text
    .split(' ')
    .map(word => capitalize(word))
    .join(' ');
}

/**
 * Metni kısalt
 *
 * @example
 * truncate('Uzun bir metin', 10) // "Uzun bir..."
 */
export function truncate(text: string, maxLength: number, suffix: string = '...'): string {
  if (!text || text.length <= maxLength) return text;
  return text.slice(0, maxLength - suffix.length).trim() + suffix;
}

/**
 * Kelime sayısına göre kısalt
 */
export function truncateWords(text: string, maxWords: number, suffix: string = '...'): string {
  if (!text) return '';
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(' ') + suffix;
}

/**
 * Slug oluştur (URL-friendly)
 *
 * @example
 * slugify('Merhaba Dünya!') // "merhaba-dunya"
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/ç/g, 'c')
    .replace(/ğ/g, 'g')
    .replace(/ı/g, 'i')
    .replace(/ö/g, 'o')
    .replace(/ş/g, 's')
    .replace(/ü/g, 'u')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * İnisiyaller oluştur
 *
 * @example
 * getInitials('Ahmet Yılmaz') // "AY"
 */
export function getInitials(name: string, maxLength: number = 2): string {
  if (!name) return '';

  return name
    .split(/\s+/)
    .filter(word => word.length > 0)
    .map(word => word.charAt(0).toLocaleUpperCase('tr-TR'))
    .slice(0, maxLength)
    .join('');
}

/**
 * Çoğul form oluştur
 *
 * @example
 * pluralize(1, 'çiftlik', 'çiftlik') // "1 çiftlik"
 * pluralize(5, 'çiftlik', 'çiftlik') // "5 çiftlik"
 */
export function pluralize(count: number, singular: string, plural: string): string {
  return `${formatNumber(count)} ${count === 1 ? singular : plural}`;
}

// ============================================================================
// Telefon ve Kimlik Formatlama
// ============================================================================

/**
 * Telefon numarasını formatla
 *
 * @example
 * formatPhone('5321234567') // "+90 532 123 45 67"
 */
export function formatPhone(phone: string): string {
  // Sadece rakamları al
  const digits = phone.replace(/\D/g, '');

  // Türkiye telefon formatı
  if (digits.length === 10) {
    return `+90 ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 8)} ${digits.slice(8)}`;
  }

  if (digits.length === 12 && digits.startsWith('90')) {
    return `+${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8, 10)} ${digits.slice(10)}`;
  }

  return phone;
}

/**
 * TC Kimlik numarasını maskele
 *
 * @example
 * maskTcKimlik('12345678901') // "123****8901"
 */
export function maskTcKimlik(tcKimlik: string): string {
  if (!tcKimlik || tcKimlik.length !== 11) return tcKimlik;
  return tcKimlik.slice(0, 3) + '****' + tcKimlik.slice(7);
}

/**
 * IBAN formatla
 *
 * @example
 * formatIBAN('TR123456789012345678901234') // "TR12 3456 7890 1234 5678 9012 34"
 */
export function formatIBAN(iban: string): string {
  const cleaned = iban.replace(/\s/g, '').toUpperCase();
  return cleaned.replace(/(.{4})/g, '$1 ').trim();
}

/**
 * Kredi kartı numarasını maskele
 *
 * @example
 * maskCreditCard('1234567890123456') // "**** **** **** 3456"
 */
export function maskCreditCard(cardNumber: string): string {
  const digits = cardNumber.replace(/\D/g, '');
  if (digits.length < 4) return cardNumber;
  return `**** **** **** ${digits.slice(-4)}`;
}

// ============================================================================
// Koordinat ve Konum Formatlama
// ============================================================================

/**
 * Koordinatları formatla
 *
 * @example
 * formatCoordinates(41.0082, 28.9784) // "41.0082°N, 28.9784°E"
 */
export function formatCoordinates(lat: number, lng: number, precision: number = 4): string {
  const latDir = lat >= 0 ? 'N' : 'S';
  const lngDir = lng >= 0 ? 'E' : 'W';

  return `${Math.abs(lat).toFixed(precision)}°${latDir}, ${Math.abs(lng).toFixed(precision)}°${lngDir}`;
}

/**
 * Mesafeyi formatla
 *
 * @example
 * formatDistance(1500) // "1,5 km"
 * formatDistance(500) // "500 m"
 */
export function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }
  return `${(meters / 1000).toFixed(1).replace('.', ',')} km`;
}

/**
 * Alan formatla (metrekare/dönüm/hektar)
 *
 * @example
 * formatArea(15000) // "1,5 hektar"
 */
export function formatArea(squareMeters: number): string {
  if (squareMeters < 1000) {
    return `${formatNumber(squareMeters)} m²`;
  }

  // 1 dönüm = 1000 m²
  const donum = squareMeters / 1000;
  if (donum < 10) {
    return `${formatNumber(donum, 1)} dönüm`;
  }

  // 1 hektar = 10000 m²
  const hektar = squareMeters / 10000;
  return `${formatNumber(hektar, 2)} hektar`;
}

// ============================================================================
// Sensör ve Ölçüm Formatlama
// ============================================================================

/**
 * Sıcaklığı formatla
 *
 * @example
 * formatTemperature(23.5) // "23,5°C"
 */
export function formatTemperature(celsius: number, decimals: number = 1): string {
  return `${formatNumber(celsius, decimals)}°C`;
}

/**
 * pH değerini formatla
 */
export function formatPH(value: number): string {
  return formatNumber(value, 2);
}

/**
 * Çözünmüş oksijeni formatla
 */
export function formatDissolvedOxygen(value: number): string {
  return `${formatNumber(value, 2)} mg/L`;
}

/**
 * Tuzluluğu formatla
 */
export function formatSalinity(value: number): string {
  return `${formatNumber(value, 1)} ppt`;
}

/**
 * Türbiditeyi formatla
 */
export function formatTurbidity(value: number): string {
  return `${formatNumber(value, 1)} NTU`;
}

/**
 * Genel sensör değeri formatla
 */
export function formatSensorValue(value: number, unit: string, decimals: number = 2): string {
  return `${formatNumber(value, decimals)} ${unit}`;
}
