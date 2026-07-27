/**
 * K-5 cutover kapısı invariantı (feeding-protocol cycle, Faz 6 + W8).
 *
 * Cutover'da legacy yemleme ÜRETİM/BİLDİRİM işleri kapalı-ama-kodda kalır:
 * her gated işin gövdesi `legacyFeedingEngineEnabled()` kapısıyla BAŞLAMAK ve
 * kapı kapalıyken ERKEN DÖNMEK zorundadır (default: kapalı; rollback =
 * FEEDING_LEGACY_ENGINE_ENABLED=true). Drain-penceresi işleri (growth rollup,
 * aylık cleanup) kapıya TABİ DEĞİLDİR — pre-cutover execution'lar ≥30 gün
 * yaşamaya devam eder.
 *
 * W8 / FARM-LOW-280 — bu spec eskiden gövdenin İLK 250 KARAKTERİNDE bir string
 * arıyordu. O kontrol iki şeyi kaçırıyordu:
 *
 *   1. Kapının ne YAPTIĞINI hiç doğrulamıyordu.
 *      `if (!legacyFeedingEngineEnabled()) { this.logger.warn(...) }` — `return`
 *      YOK — spec'i GEÇİYOR ve iş yine de koşuyordu. Yani "kapısı var" diye
 *      raporlanan bir işin kapısı hiçbir şey kapatmıyor olabilirdi.
 *   2. Uzun bir docblock ya da birkaç değişken tanımı 250 karakteri doldurunca
 *      GERÇEK bir kapı da kaçabilirdi (yanlış pozitif ihlal).
 *
 * Artık gövde dengeli süslü parantezle çıkarılıyor ve kapının ŞEKLİ
 * doğrulanıyor: ilk ifade guard'dır ve guard bloğu `return` içerir.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');

const CRON_FILE = join(
  ROOT,
  'apps/farm-service/src/feeding/services/feeding-cron.service.ts',
);
const SCHEDULER_FILE = join(
  ROOT,
  'apps/farm-service/src/scheduler/feeding-scheduler.service.ts',
);

/** K-5 listesi — legacy üretim + bildirim işleri (plan §11 Faz 6 + W8). */
const GATED_JOBS: Record<string, string[]> = {
  [CRON_FILE]: ['generateDailyPlans', 'checkFeedTransitions'],
  [SCHEDULER_FILE]: [
    'generateDailyFeedingPlan',
    'sendFeedingReminders',
    'dailyFeedingSummary',
    'analyzeFCR',
    'checkFeedStock',
    // W8/FARM-LOW-285: muafiyetin gerekçesi ("Faz 7 forecast'ı gelene dek tek
    // kapsama sinyali") doldu — v2'nin 07:00 süpürmesi durable sinyali üretiyor.
    'weeklyFeedForecast',
  ],
};

/** Drain penceresi işleri — kapı bunlara TAŞAMAZ. */
const UNGATED_JOBS: Record<string, string[]> = {
  [CRON_FILE]: ['applyDailyGrowthRollup', 'cleanupOldExecutions'],
  [SCHEDULER_FILE]: [],
};

/**
 * Metodun TAM gövdesini dengeli süslü parantezle çıkarır. String/şablon ve
 * yorum içeriği atlanır — aksi hâlde bir log mesajındaki `}` gövdeyi erken
 * kapatır ve spec sessizce yanlış metni denetlerdi.
 */
function methodBody(source: string, methodName: string): string {
  const signature = `async ${methodName}(): Promise<void> {`;
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThanOrEqual(0);

  let index = start + signature.length;
  let depth = 1;
  while (index < source.length && depth > 0) {
    const char = source[index];
    const next = source[index + 1];

    if (char === '/' && next === '/') {
      const newline = source.indexOf('\n', index);
      if (newline === -1) break;
      index = newline;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      index += 1;
      while (index < source.length) {
        if (source[index] === '\\') {
          index += 2;
          continue;
        }
        if (source[index] === quote) break;
        index += 1;
      }
      index += 1;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    index += 1;
  }

  return source.slice(start + signature.length, Math.max(index - 1, start));
}

/** Gövdeyi anlamlı satırlara indirger (yorumlar ve boş satırlar atılır). */
function significantLines(body: string): string {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

describe('K-5: legacy feeding engine cutover gate', () => {
  for (const [file, jobs] of Object.entries(GATED_JOBS)) {
    const source = readFileSync(file, 'utf8');
    for (const job of jobs) {
      const label = `${file.split('/').pop() ?? file} → ${job}`;

      it(`${label} gövdesinin İLK ifadesi kapı guard'ıdır`, () => {
        const body = significantLines(methodBody(source, job));
        expect(body.startsWith('if (!legacyFeedingEngineEnabled()) {')).toBe(true);
      });

      it(`${label} kapı kapalıyken ERKEN DÖNER (log-and-continue değil)`, () => {
        const body = significantLines(methodBody(source, job));
        // Guard bloğu gövdenin başındadır; ilk sütun-0 `}` onu kapatır. O bloğun
        // içinde `return` YOKSA iş kapı kapalıyken de koşuyor demektir.
        const guardEnd = body.indexOf('\n}');
        expect(guardEnd).toBeGreaterThan(0);
        expect(body.slice(0, guardEnd)).toMatch(/\breturn\b/);
      });
    }
  }

  for (const [file, jobs] of Object.entries(UNGATED_JOBS)) {
    const source = readFileSync(file, 'utf8');
    for (const job of jobs) {
      it(`${file.split('/').pop() ?? file} → ${job} (drain penceresi) kapıya tabi DEĞİL`, () => {
        expect(methodBody(source, job)).not.toContain('legacyFeedingEngineEnabled()');
      });
    }
  }

  it('kapı default KAPALIDIR — yalnız açık "true" legacy motoru geri açar', () => {
    const gateSource = readFileSync(
      join(ROOT, 'apps/farm-service/src/feeding/constants/legacy-engine-gate.ts'),
      'utf8',
    );
    expect(gateSource).toContain("process.env['FEEDING_LEGACY_ENGINE_ENABLED'] === 'true'");
  });

  it('gövde çıkarıcının kendisi doğru çalışır (spec sessizce boşa düşemez)', () => {
    // Kendi kendini doğrulayan kontrol: çıkarıcı bozulup boş/kısa gövde
    // döndürürse yukarıdaki testler anlamsız bir metni denetleyip yeşil
    // kalırdı. Uzunluk + guard varlığı bunu yakalar.
    const source = readFileSync(SCHEDULER_FILE, 'utf8');
    const body = methodBody(source, 'weeklyFeedForecast');
    expect(body.length).toBeGreaterThan(400);
    expect(body).toContain('legacyFeedingEngineEnabled()');
    // Log metinlerindeki süslü parantezler gövdeyi erken kapatmamalı.
    expect(body).toContain('listTenantSchemas');
  });
});
