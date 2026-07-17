/**
 * K-5 cutover kapısı — legacy yemleme ÜRETİM/BİLDİRİM işleri.
 *
 * Faz 6 cutover'ında v2 motoru (FeedingCronV2Service) tek üretici olur;
 * legacy üretim ve bildirim işleri KAPALI-AMA-KODDA kalır (plan §11 Faz 6:
 * "anında re-gate rollback"). Kapıya tabi işler:
 *
 *   feeding-cron.service.ts   → 06:00 generateDailyPlans, 07:00 checkFeedTransitions
 *   feeding-scheduler.service → 05:00 generateDailyFeedingPlan, saatlik
 *                               sendFeedingReminders, 20:00 dailyFeedingSummary,
 *                               18:00 analyzeFCR, 10:00 checkFeedStock
 *
 * Kapıya TABİ OLMAYANLAR (drain penceresi ≥30 gün — pre-cutover execution'lar
 * yaşamaya devam eder): 05:00 applyDailyGrowthRollup (drain kayıtlarının
 * growth'u), aylık cleanupOldExecutions, `recordDailyFeeding` mutation'ı,
 * haftalık weeklyFeedForecast (Faz 7 forecast'ı gelene dek tek kapsama
 * sinyali). Faz 8'de kapı, gated işlerle birlikte silinir.
 *
 * Rollback: `FEEDING_LEGACY_ENGINE_ENABLED=true` + servis restart — migration
 * geri alınmadan legacy üretim anında geri açılır (çift planlama riski yalnız
 * rollback operatörünün bilinçli kararıdır; v2 atamaları ayrıca pause edilmeli).
 * Bu invariant `tests/invariants/feeding-legacy-cutover-gate.spec.ts` ile pinli.
 */
export function legacyFeedingEngineEnabled(): boolean {
  return process.env['FEEDING_LEGACY_ENGINE_ENABLED'] === 'true';
}
