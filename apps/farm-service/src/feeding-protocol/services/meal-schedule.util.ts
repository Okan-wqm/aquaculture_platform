/**
 * Öğün planı türetme + saat maddileştirme SAF yardımcıları (Faz 5).
 *
 * Kurallar (plan §1.2 K-18/D-15 + §2 D-4):
 *  - Etkin öğün planı = band `mealSchedule` (varsa) > protokol
 *    `defaultMealSchedule`; üstüne atama override'ları uygulanır:
 *    `mealsPerDayOverride` öğün SAYISINI ezer ve saatler protokol planının
 *    ilk-son öğün penceresine eşit aralıkla, yüzdeler eşit dağıtılarak
 *    türetilir (belgeli kural — sessiz varsayım değil);
 *    `mealTimeOffsetMinutes` EN SON uygulanır (tüm saatleri kaydırır).
 *  - Protokoldeki `HH:mm` saatleri SITE saat diliminde yorumlanır ve üretim
 *    anında timestamptz'e maddileşir (D-4) — 15dk pencere cron'u saat dilimi
 *    hesabı yapmadan karşılaştırır. DST geçiş gecelerinde öğün ne atlanır ne
 *    çiftlenir (spec pinli): duvar saati o gün iki kez varsa İLK oluş, hiç
 *    yoksa kaydırılmış gerçek an kullanılır (Intl 2-geçiş çözümü).
 *
 * @module FeedingProtocol/Services
 */
import {
  MealSchedule,
  MealScheduleEntry,
  ProtocolBand,
} from '../entities/feeding-protocol-v2.entity';
import { AssignmentOverrides, AssignmentSuspension } from '../entities/protocol-assignment.entity';

/** Tek öğünün maddileşmiş hali — generator bunu FeedingMeal satırına çevirir. */
export interface MaterializedMeal {
  mealIndex: number;
  scheduledAt: Date;
  percentOfDaily: number;
}

const MINUTES_IN_DAY = 24 * 60;

function parseTimeToMinutes(time: string): number {
  const [hh = 0, mm = 0] = time.split(':').map(Number);
  return hh * 60 + mm;
}

function minutesToTime(totalMinutes: number): { dayOffset: number; time: string } {
  const normalized = ((totalMinutes % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY;
  const dayOffset = Math.floor(totalMinutes / MINUTES_IN_DAY);
  const hh = String(Math.floor(normalized / 60)).padStart(2, '0');
  const mm = String(normalized % 60).padStart(2, '0');
  return { dayOffset, time: `${hh}:${mm}` };
}

/**
 * Etkin öğün planı (offset HARİÇ — offset maddileştirmede en son uygulanır).
 * Öncelik: band planı > protokol default'u; `mealsPerDayOverride` sayıyı ezer.
 */
export function effectiveMealSchedule(
  defaultSchedule: MealSchedule,
  band: ProtocolBand | undefined,
  overrides: AssignmentOverrides | undefined,
): MealSchedule {
  const base = band?.mealSchedule ?? defaultSchedule;
  const overrideCount = overrides?.mealsPerDayOverride;
  if (!overrideCount || overrideCount === base.mealsPerDay) return base;

  // D-15: saatler taban planın ilk-son öğün penceresine eşit aralıkla,
  // yüzdeler eşit dağıtılarak türetilir.
  const firstEntry = base.entries[0];
  const lastEntry = base.entries[base.entries.length - 1];
  const windowStart = firstEntry ? parseTimeToMinutes(firstEntry.time) : 8 * 60;
  const windowEnd = lastEntry ? parseTimeToMinutes(lastEntry.time) : 18 * 60;
  const count = Math.max(1, Math.min(24, overrideCount));
  const step = count === 1 ? 0 : (windowEnd - windowStart) / (count - 1);
  const basePercent = Math.floor((100 / count) * 100) / 100;

  const entries: MealScheduleEntry[] = Array.from({ length: count }, (_, i) => {
    const { time } = minutesToTime(Math.round(windowStart + step * i));
    const percentOfDaily =
      i === count - 1 ? Math.round((100 - basePercent * (count - 1)) * 100) / 100 : basePercent;
    return { time, percentOfDaily };
  });
  return { mealsPerDay: count, entries };
}

/**
 * `planDate` (YYYY-MM-DD) + `HH:mm` duvar saatini verilen IANA saat diliminde
 * mutlak UTC anına çevirir (Intl 2-geçiş algoritması — ek bağımlılık yok).
 * DST ileri atlamasında (duvar saati yok) kaydırılmış gerçek an döner; geri
 * alınmada (duvar saati iki kez var) İLK oluş seçilir.
 */
/**
 * Verilen anın IANA zonundaki takvim günü + duvar saati — SAF (W5, D-B4).
 *
 * Yemleme tarafındaki TÜM "yerel gün / yerel saat" kararlarının tek matematiği
 * budur; `CURRENT_DATE`/`now()` gün semantiği için kullanılmaz (DB oturumunun
 * zonu tenant'ın zonu değildir).
 */
export function zonedPartsIn(
  timeZone: string,
  at: Date,
): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
    minute: Number(get('minute')),
  };
}

/** Verilen IANA saat dilimindeki takvim günü (YYYY-MM-DD, D-4) — SAF. */
export function calendarDayIn(timeZone: string, at: Date = new Date()): string {
  return zonedPartsIn(timeZone, at).date;
}

/**
 * Yerel takvim gününün mutlak [başlangıç, bitiş) sınırları — SAF.
 * Sorgular `planDate`'i string olarak bağlar; bu yardımcı `scheduledAt` gibi
 * timestamptz alanlarını yerel güne süzmek için kullanılır.
 */
export function localDayBoundsUtc(
  planDate: string,
  timeZone: string,
): { startUtc: Date; endUtc: Date } {
  const startUtc = zonedWallTimeToUtc(planDate, '00:00', timeZone);
  const next = new Date(`${planDate}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const endUtc = zonedWallTimeToUtc(next.toISOString().slice(0, 10), '00:00', timeZone);
  return { startUtc, endUtc };
}

/**
 * Öğünün penceresi geçti mi — SAF, TEK tanım (FARM-MEDIUM-251).
 *
 * Sabah süpürmesi ve akşam özeti bu YARDIMCIYI paylaşır. Eskiden özet
 * `status = 'missed'` sayıyordu; damgayı ertesi sabahki süpürme bastığı için
 * `missedMealCount` gün özetinde YAPISAL OLARAK her zaman 0 çıkıyor, operatör
 * "bugün hiç öğün kaçmadı" raporu alıyordu. Damga bir SONUÇ; kaçırılmışlığın
 * tanımı zamandır.
 */
export const MEAL_OVERDUE_GRACE_MINUTES = 6 * 60;

export function isMealOverdue(
  meal: { scheduledAt: Date | string },
  at: Date,
  graceMinutes: number = MEAL_OVERDUE_GRACE_MINUTES,
): boolean {
  const scheduled =
    meal.scheduledAt instanceof Date ? meal.scheduledAt : new Date(meal.scheduledAt);
  return scheduled.getTime() + graceMinutes * 60_000 < at.getTime();
}

export function zonedWallTimeToUtc(planDate: string, time: string, timeZone: string): Date {
  const [year = 1970, month = 1, day = 1] = planDate.split('-').map(Number);
  const [hour = 0, minute = 0] = time.split(':').map(Number);
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  const offsetAt = (instantMs: number): number => {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = formatter.formatToParts(new Date(instantMs));
    const get = (type: string): number =>
      Number(parts.find((part) => part.type === type)?.value ?? 0);
    const asUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour'),
      get('minute'),
      get('second'),
    );
    return asUtc - instantMs; // pozitif = UTC'nin doğusu
  };

  // ±24 saat sondajı geçiş gecesinin HER İKİ offset'ini de yakalar; duvar
  // saatine gerçekten çözünen adaylar süzülür (round-trip doğrulaması).
  const DAY_MS = 24 * 60 * 60 * 1000;
  const offsets = [
    ...new Set([offsetAt(utcGuess - DAY_MS), offsetAt(utcGuess), offsetAt(utcGuess + DAY_MS)]),
  ];
  const validCandidates = offsets
    .map((offset) => utcGuess - offset)
    .filter((candidate) => candidate + offsetAt(candidate) === utcGuess);

  if (validCandidates.length > 0) {
    // Geri-alma gecesi iki geçerli an üretir — İLK (erken) oluş seçilir.
    return new Date(Math.min(...validCandidates));
  }
  // İleri-alma boşluğu: duvar saati yok — küçük offset (geçiş öncesi) ile
  // ileri kaydırılmış gerçek an kullanılır (öğün atlanmaz).
  return new Date(utcGuess - Math.min(...offsets));
}

/**
 * Etkin planı mutlak anlara maddileştirir; `mealTimeOffsetMinutes` EN SON
 * uygulanır ve gün sınırını taşarsa gerçek takvim kaymasıyla taşar.
 */
export function materializeMeals(
  schedule: MealSchedule,
  planDate: string,
  timeZone: string,
  offsetMinutes: number | undefined,
): MaterializedMeal[] {
  const offset = offsetMinutes ?? 0;
  return schedule.entries.map((entry, index) => {
    const withOffset = parseTimeToMinutes(entry.time) + offset;
    const { dayOffset, time } = minutesToTime(withOffset);
    const baseDate = new Date(`${planDate}T00:00:00Z`);
    baseDate.setUTCDate(baseDate.getUTCDate() + dayOffset);
    const shiftedDate = baseDate.toISOString().slice(0, 10);
    return {
      mealIndex: index,
      scheduledAt: zonedWallTimeToUtc(shiftedDate, time, timeZone),
      percentOfDaily: entry.percentOfDaily,
    };
  });
}

/**
 * Oruç/ilaç penceresi sınırını ÜNİTENİN YEREL takvim gününe çevirir (W5, ek-d).
 *
 * Sınırlar ISO datetime olarak kaydedilebiliyor (`2026-03-01T00:00:00+03:00`);
 * eski `slice(0, 10)` bunu UTC gününe değil, string'in ilk 10 karakterine
 * kesiyordu — zon farkı gün sınırını aştığında veteriner direktifinin ilk veya
 * son günü sessizce düşüyor, oruç günü olması gereken tanka plan üretiliyordu.
 * Salt tarih (`YYYY-MM-DD`) zaten zonsuzdur ve aynen kullanılır.
 */
function boundaryLocalDate(value: string, timeZone: string): string {
  if (!value.includes('T')) return value.slice(0, 10);
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? value.slice(0, 10) : calendarDayIn(timeZone, at);
}

/** planDate (YYYY-MM-DD) verilen pencereye düşüyor mu (D-12; sınırlar dahil). */
export function suspensionFor(
  suspensions: AssignmentSuspension[] | undefined,
  planDate: string,
  timeZone: string,
): AssignmentSuspension | undefined {
  return (suspensions ?? []).find((suspension) => {
    const from = boundaryLocalDate(suspension.from, timeZone);
    const to = boundaryLocalDate(suspension.to, timeZone);
    return planDate >= from && planDate <= to;
  });
}

/**
 * Kalan (beslenmemiş) öğünleri YENİ günlük toplam üzerinden yeniden fiyatlar
 * (gün içi recalc — P-31): her kalan öğün KENDİ yüzdesinin yeni günlük
 * toplamdaki karşılığını alır ("kalan %'lere göre" kuralı). Beslenmiş/missed
 * öğünlere dokunulmaz.
 */
export function repriceRemaining(
  meals: Array<{ percentOfDaily: number }>,
  newDailyTotalKg: number,
): number[] {
  return meals.map(
    (meal) =>
      Math.round(((Number(meal.percentOfDaily) / 100) * newDailyTotalKg + Number.EPSILON) * 1000) /
      1000,
  );
}

/** Telafi yüzdesi sınırları — protokol ayarı ve atama override'ı için ortak. */
export const MISSED_CATCH_UP_MIN_PERCENT = 0;
export const MISSED_CATCH_UP_MAX_PERCENT = 100;

/**
 * Kaçırılan öğünün kg'ının kalan öğünlere dağıtımı — SAF (W5, kullanıcı
 * kararı 3).
 *
 * **Varsayılan davranış dağıtım YAPMAMAKTIR** (`percent = 0` → sıfır dizi).
 * Balığın günlük sindirim kapasitesi sabittir; kaçan öğünü sonrakilere
 * eklemek aşırı besleme, yem israfı ve amonyak yüküdür. Telafi tenant'ın
 * bilinçli kararıdır ve yüzde olarak ifade edilir: `percent = 50` ise kaçan
 * kg'ın yarısı kalan öğünlere KENDİ yüzdeleri oranında paylaştırılır
 * (öğünlerin göreli ağırlığı korunur — sabah öğünü akşamınkinden büyükse
 * telafi de o oranda gelir).
 *
 * Dönen dizi kalan öğünlerle aynı sıradadır ve EKLENECEK kg'ı taşır.
 */
export function distributeCatchUp(
  missedKg: number,
  percent: number,
  remainingMeals: Array<{ percentOfDaily: number }>,
): number[] {
  const clamped = Math.min(
    MISSED_CATCH_UP_MAX_PERCENT,
    Math.max(MISSED_CATCH_UP_MIN_PERCENT, Number(percent) || 0),
  );
  const zeros = remainingMeals.map(() => 0);
  if (clamped === 0 || !(missedKg > 0) || remainingMeals.length === 0) return zeros;

  const catchUpKg = (missedKg * clamped) / 100;
  const weightTotal = remainingMeals.reduce((acc, meal) => acc + Number(meal.percentOfDaily), 0);
  if (!(weightTotal > 0)) {
    // Yüzdeler bilinmiyorsa eşit dağıtım — sessizce sıfırlamaktan iyidir.
    const share = Math.round((catchUpKg / remainingMeals.length + Number.EPSILON) * 1000) / 1000;
    return remainingMeals.map(() => share);
  }
  return remainingMeals.map(
    (meal) =>
      Math.round(
        ((Number(meal.percentOfDaily) / weightTotal) * catchUpKg + Number.EPSILON) * 1000,
      ) / 1000,
  );
}
