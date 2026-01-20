/**
 * Date Utilities
 * Tarih ve zaman işlemleri için yardımcı fonksiyonlar
 * Türkçe lokalizasyon desteği
 */

// ============================================================================
// Tip Tanımlamaları
// ============================================================================

type DateInput = Date | string | number;

interface FormatOptions {
  /** Dil kodu */
  locale?: string;
  /** Zaman dilimi */
  timeZone?: string;
}

interface RelativeTimeOptions extends FormatOptions {
  /** "önce/sonra" eklensin mi */
  addSuffix?: boolean;
}

// ============================================================================
// Sabitler
// ============================================================================

const DEFAULT_LOCALE = 'tr-TR';
const DEFAULT_TIMEZONE = 'Europe/Istanbul';

/**
 * Türkçe ay isimleri
 */
const TURKISH_MONTHS = [
  'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
  'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık',
];

/**
 * Türkçe kısa ay isimleri
 */
const TURKISH_MONTHS_SHORT = [
  'Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz',
  'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara',
];

/**
 * Türkçe gün isimleri
 */
const TURKISH_DAYS = [
  'Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi',
];

/**
 * Türkçe kısa gün isimleri
 */
const TURKISH_DAYS_SHORT = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];

/**
 * Zaman aralıkları (milisaniye)
 */
const TIME_UNITS = {
  year: 365 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  hour: 60 * 60 * 1000,
  minute: 60 * 1000,
  second: 1000,
};

// ============================================================================
// Temel Fonksiyonlar
// ============================================================================

/**
 * Girdiyi Date objesine dönüştür
 */
export function toDate(input: DateInput): Date {
  if (input instanceof Date) {
    return input;
  }

  if (typeof input === 'number') {
    return new Date(input);
  }

  return new Date(input);
}

/**
 * Tarihin geçerli olup olmadığını kontrol et
 */
export function isValidDate(input: DateInput): boolean {
  const date = toDate(input);
  return !isNaN(date.getTime());
}

// ============================================================================
// Formatlama Fonksiyonları
// ============================================================================

/**
 * Tarihi formatla
 *
 * @example
 * formatDate(new Date()) // "25 Kasım 2024"
 * formatDate(new Date(), 'short') // "25.11.2024"
 * formatDate(new Date(), 'long') // "25 Kasım 2024 Pazartesi"
 */
export function formatDate(
  input: DateInput,
  format: 'short' | 'medium' | 'long' | 'full' = 'medium',
  options: FormatOptions = {}
): string {
  const date = toDate(input);
  const { locale = DEFAULT_LOCALE, timeZone = DEFAULT_TIMEZONE } = options;

  if (!isValidDate(date)) {
    return 'Geçersiz tarih';
  }

  const formatOptions: Intl.DateTimeFormatOptions = { timeZone };

  switch (format) {
    case 'short':
      formatOptions.day = '2-digit';
      formatOptions.month = '2-digit';
      formatOptions.year = 'numeric';
      break;

    case 'medium':
      formatOptions.day = 'numeric';
      formatOptions.month = 'long';
      formatOptions.year = 'numeric';
      break;

    case 'long':
      formatOptions.day = 'numeric';
      formatOptions.month = 'long';
      formatOptions.year = 'numeric';
      formatOptions.weekday = 'long';
      break;

    case 'full':
      formatOptions.day = 'numeric';
      formatOptions.month = 'long';
      formatOptions.year = 'numeric';
      formatOptions.weekday = 'long';
      formatOptions.hour = '2-digit';
      formatOptions.minute = '2-digit';
      break;
  }

  return new Intl.DateTimeFormat(locale, formatOptions).format(date);
}

/**
 * Saati formatla
 *
 * @example
 * formatTime(new Date()) // "14:30"
 * formatTime(new Date(), true) // "14:30:45"
 */
export function formatTime(
  input: DateInput,
  showSeconds: boolean = false,
  options: FormatOptions = {}
): string {
  const date = toDate(input);
  const { locale = DEFAULT_LOCALE, timeZone = DEFAULT_TIMEZONE } = options;

  if (!isValidDate(date)) {
    return 'Geçersiz saat';
  }

  const formatOptions: Intl.DateTimeFormatOptions = {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    ...(showSeconds && { second: '2-digit' }),
  };

  return new Intl.DateTimeFormat(locale, formatOptions).format(date);
}

/**
 * Tarih ve saati birlikte formatla
 *
 * @example
 * formatDateTime(new Date()) // "25 Kasım 2024 14:30"
 */
export function formatDateTime(
  input: DateInput,
  options: FormatOptions = {}
): string {
  const date = toDate(input);
  const { locale = DEFAULT_LOCALE, timeZone = DEFAULT_TIMEZONE } = options;

  if (!isValidDate(date)) {
    return 'Geçersiz tarih/saat';
  }

  const formatOptions: Intl.DateTimeFormatOptions = {
    timeZone,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  };

  return new Intl.DateTimeFormat(locale, formatOptions).format(date);
}

/**
 * ISO formatında tarih string'i döndür
 */
export function toISOString(input: DateInput): string {
  const date = toDate(input);
  return date.toISOString();
}

/**
 * Sadece tarih kısmını ISO formatında döndür (YYYY-MM-DD)
 */
export function toISODateString(input: DateInput): string {
  const date = toDate(input);
  return date.toISOString().split('T')[0];
}

// ============================================================================
// Göreceli Zaman
// ============================================================================

/**
 * Göreceli zaman formatla
 *
 * @example
 * formatRelativeTime(new Date(Date.now() - 60000)) // "1 dakika önce"
 * formatRelativeTime(new Date(Date.now() + 3600000)) // "1 saat sonra"
 */
export function formatRelativeTime(
  input: DateInput,
  options: RelativeTimeOptions = {}
): string {
  const date = toDate(input);
  const { addSuffix = true } = options;

  if (!isValidDate(date)) {
    return 'Geçersiz tarih';
  }

  const now = Date.now();
  const diff = date.getTime() - now;
  const absDiff = Math.abs(diff);
  const isFuture = diff > 0;

  // Birim ve değer hesapla
  let value: number;
  let unit: string;

  if (absDiff < TIME_UNITS.minute) {
    return 'Az önce';
  } else if (absDiff < TIME_UNITS.hour) {
    value = Math.round(absDiff / TIME_UNITS.minute);
    unit = 'dakika';
  } else if (absDiff < TIME_UNITS.day) {
    value = Math.round(absDiff / TIME_UNITS.hour);
    unit = 'saat';
  } else if (absDiff < TIME_UNITS.week) {
    value = Math.round(absDiff / TIME_UNITS.day);
    unit = 'gün';
  } else if (absDiff < TIME_UNITS.month) {
    value = Math.round(absDiff / TIME_UNITS.week);
    unit = 'hafta';
  } else if (absDiff < TIME_UNITS.year) {
    value = Math.round(absDiff / TIME_UNITS.month);
    unit = 'ay';
  } else {
    value = Math.round(absDiff / TIME_UNITS.year);
    unit = 'yıl';
  }

  const text = `${value} ${unit}`;

  if (addSuffix) {
    return isFuture ? `${text} sonra` : `${text} önce`;
  }

  return text;
}

/**
 * Bugünden itibaren gün farkını hesapla
 */
export function getDaysFromNow(input: DateInput): number {
  const date = toDate(input);
  const now = new Date();

  // Saat farkını yok say, sadece gün bazında hesapla
  const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const nowOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const diff = dateOnly.getTime() - nowOnly.getTime();
  return Math.round(diff / TIME_UNITS.day);
}

// ============================================================================
// Karşılaştırma Fonksiyonları
// ============================================================================

/**
 * Tarihleri karşılaştır
 */
export function compareDates(a: DateInput, b: DateInput): number {
  const dateA = toDate(a);
  const dateB = toDate(b);
  return dateA.getTime() - dateB.getTime();
}

/**
 * Tarih bugün mü?
 */
export function isToday(input: DateInput): boolean {
  const date = toDate(input);
  const today = new Date();

  return (
    date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear()
  );
}

/**
 * Tarih dün mü?
 */
export function isYesterday(input: DateInput): boolean {
  const date = toDate(input);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  return (
    date.getDate() === yesterday.getDate() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getFullYear() === yesterday.getFullYear()
  );
}

/**
 * Tarih yarın mı?
 */
export function isTomorrow(input: DateInput): boolean {
  const date = toDate(input);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  return (
    date.getDate() === tomorrow.getDate() &&
    date.getMonth() === tomorrow.getMonth() &&
    date.getFullYear() === tomorrow.getFullYear()
  );
}

/**
 * Tarih geçmişte mi?
 */
export function isPast(input: DateInput): boolean {
  return toDate(input).getTime() < Date.now();
}

/**
 * Tarih gelecekte mi?
 */
export function isFuture(input: DateInput): boolean {
  return toDate(input).getTime() > Date.now();
}

/**
 * Tarih belirli aralıkta mı?
 */
export function isWithinRange(input: DateInput, start: DateInput, end: DateInput): boolean {
  const date = toDate(input).getTime();
  const startTime = toDate(start).getTime();
  const endTime = toDate(end).getTime();

  return date >= startTime && date <= endTime;
}

// ============================================================================
// Manipülasyon Fonksiyonları
// ============================================================================

/**
 * Tarihe gün ekle
 */
export function addDays(input: DateInput, days: number): Date {
  const date = toDate(input);
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * Tarihe hafta ekle
 */
export function addWeeks(input: DateInput, weeks: number): Date {
  return addDays(input, weeks * 7);
}

/**
 * Tarihe ay ekle
 */
export function addMonths(input: DateInput, months: number): Date {
  const date = toDate(input);
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

/**
 * Tarihe yıl ekle
 */
export function addYears(input: DateInput, years: number): Date {
  const date = toDate(input);
  const result = new Date(date);
  result.setFullYear(result.getFullYear() + years);
  return result;
}

/**
 * Günün başlangıcını al (00:00:00)
 */
export function startOfDay(input: DateInput): Date {
  const date = toDate(input);
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

/**
 * Günün sonunu al (23:59:59.999)
 */
export function endOfDay(input: DateInput): Date {
  const date = toDate(input);
  const result = new Date(date);
  result.setHours(23, 59, 59, 999);
  return result;
}

/**
 * Ayın başlangıcını al
 */
export function startOfMonth(input: DateInput): Date {
  const date = toDate(input);
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/**
 * Ayın sonunu al
 */
export function endOfMonth(input: DateInput): Date {
  const date = toDate(input);
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
}

// ============================================================================
// Yardımcı Fonksiyonlar
// ============================================================================

/**
 * Türkçe ay adını al
 */
export function getMonthName(monthIndex: number, short: boolean = false): string {
  const months = short ? TURKISH_MONTHS_SHORT : TURKISH_MONTHS;
  return months[monthIndex] || '';
}

/**
 * Türkçe gün adını al
 */
export function getDayName(dayIndex: number, short: boolean = false): string {
  const days = short ? TURKISH_DAYS_SHORT : TURKISH_DAYS;
  return days[dayIndex] || '';
}

/**
 * İki tarih arasındaki farkı hesapla
 */
export function getDifference(
  start: DateInput,
  end: DateInput,
  unit: 'days' | 'hours' | 'minutes' | 'seconds' = 'days'
): number {
  const startDate = toDate(start);
  const endDate = toDate(end);
  const diff = endDate.getTime() - startDate.getTime();

  switch (unit) {
    case 'days':
      return Math.floor(diff / TIME_UNITS.day);
    case 'hours':
      return Math.floor(diff / TIME_UNITS.hour);
    case 'minutes':
      return Math.floor(diff / TIME_UNITS.minute);
    case 'seconds':
      return Math.floor(diff / TIME_UNITS.second);
    default:
      return diff;
  }
}

/**
 * Tarih aralığı oluştur
 */
export function getDateRange(
  start: DateInput,
  end: DateInput
): Date[] {
  const startDate = startOfDay(start);
  const endDate = startOfDay(end);
  const dates: Date[] = [];

  let current = new Date(startDate);
  while (current <= endDate) {
    dates.push(new Date(current));
    current = addDays(current, 1);
  }

  return dates;
}
