/**
 * K-5 cutover kapısı invariantı (feeding-protocol cycle, Faz 6).
 *
 * Cutover'da legacy yemleme ÜRETİM/BİLDİRİM işleri kapalı-ama-kodda kalır:
 * her gated işin gövdesi `legacyFeedingEngineEnabled()` kapısıyla BAŞLAMAK
 * zorundadır (default: kapalı; rollback = FEEDING_LEGACY_ENGINE_ENABLED=true).
 * Drain-penceresi işleri (growth rollup, aylık cleanup) kapıya TABİ DEĞİLDİR —
 * pre-cutover execution'lar ≥30 gün yaşamaya devam eder. Bu spec iki yönü de
 * pinler: kapı unutulamaz, kapı taşamaz.
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

/** K-5 listesi — legacy üretim + bildirim işleri (plan §11 Faz 6). */
const GATED_JOBS: Record<string, string[]> = {
  [CRON_FILE]: ['generateDailyPlans', 'checkFeedTransitions'],
  [SCHEDULER_FILE]: [
    'generateDailyFeedingPlan',
    'sendFeedingReminders',
    'dailyFeedingSummary',
    'analyzeFCR',
    'checkFeedStock',
  ],
};

/** Drain penceresi işleri — kapı bunlara TAŞAMAZ. */
const UNGATED_JOBS: Record<string, string[]> = {
  [CRON_FILE]: ['applyDailyGrowthRollup', 'cleanupOldExecutions'],
  [SCHEDULER_FILE]: ['weeklyFeedForecast'],
};

function methodBody(source: string, methodName: string): string {
  const start = source.indexOf(`async ${methodName}(): Promise<void> {`);
  expect(start).toBeGreaterThanOrEqual(0);
  // Kapı, gövdenin İLK ifadesi olmalı — ilk 250 karakter yeterli pencere.
  return source.slice(start, start + 250);
}

describe('K-5: legacy feeding engine cutover gate', () => {
  for (const [file, jobs] of Object.entries(GATED_JOBS)) {
    const source = readFileSync(file, 'utf8');
    for (const job of jobs) {
      it(`${file.split('/').pop()} → ${job} gövdesi kapıyla başlar`, () => {
        expect(methodBody(source, job)).toContain('legacyFeedingEngineEnabled()');
      });
    }
  }

  for (const [file, jobs] of Object.entries(UNGATED_JOBS)) {
    const source = readFileSync(file, 'utf8');
    for (const job of jobs) {
      it(`${file.split('/').pop()} → ${job} (drain penceresi) kapıya tabi DEĞİL`, () => {
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
});
