/**
 * K-5 cutover kapısı — legacy yemleme ÜRETİM/BİLDİRİM işleri.
 *
 * Faz 6 cutover'ında v2 motoru (FeedingCronV2Service) tek üretici olur;
 * legacy üretim ve bildirim işleri KAPALI-AMA-KODDA kalır (plan §11 Faz 6:
 * "anında re-gate rollback"). Kapıya tabi işler:
 *
 *   feeding-scheduler.service → 05:00 generateDailyFeedingPlan, saatlik
 *                               sendFeedingReminders, 20:00 dailyFeedingSummary,
 *                               18:00 analyzeFCR, 10:00 checkFeedStock,
 *                               haftalık weeklyFeedForecast
 *
 * Bu liste eskiden bir ikinci dosyayı — v1 yemleme cron sınıfını — de sayıyordu.
 * O dosya Faz 8'de silindi ve silinme gerekçesi rollback anlatısını DÜZELTİR:
 * sınıf hiçbir modülde provider değildi, yani `@Cron`'ları hiç ateşlenmiyordu.
 * `FEEDING_LEGACY_ENGINE_ENABLED=true` onun işlerini zaten geri getiremezdi —
 * rollback yolu YALNIZ `feeding-scheduler.service.ts` üzerinden yaşar. Silinen
 * simgeler `tests/invariants/feeding-v1-retired-symbols.spec.ts`'te pinlidir.
 *
 * `weeklyFeedForecast` W8'de (FARM-LOW-285) kapıya ALINDI: muafiyetin gerekçesi
 * "Faz 7 forecast'ı gelene dek tek kapsama sinyali" idi ve o gerekçe doldu —
 * v2'nin 07:00 kapsama süpürmesi artık durable `FeedStockoutForecast` /
 * `FeedTransitionUpcoming` üretiyor ve alert-engine onu tüketiyor. Gated
 * olmadan iş her Pazartesi TÜM tenant şemalarını tarayıp dinleyicisi olmayan
 * bir in-process `feeding.weeklyForecast` emit'i yapıyordu: bedeli olan,
 * karşılığı olmayan bir koşu.
 *
 * Kapıya TABİ OLMAYANLAR (drain penceresi ≥30 gün — pre-cutover execution'lar
 * yaşamaya devam eder): 05:00 applyDailyGrowthRollup (drain kayıtlarının
 * growth'u), aylık cleanupOldExecutions, `recordDailyFeeding` mutation'ı.
 * Faz 8'de kapı, gated işlerle birlikte silinir.
 *
 * Rollback: `FEEDING_LEGACY_ENGINE_ENABLED=true` + servis restart — migration
 * geri alınmadan legacy üretim anında geri açılır (çift planlama riski yalnız
 * rollback operatörünün bilinçli kararıdır; v2 atamaları ayrıca pause edilmeli).
 * Bu invariant `tests/invariants/feeding-legacy-cutover-gate.spec.ts` ile pinli.
 */
export function legacyFeedingEngineEnabled(): boolean {
  return process.env['FEEDING_LEGACY_ENGINE_ENABLED'] === 'true';
}
