/**
 * Yemleme motorunun ondalık yuvarlama SSoT'si (FARM-LOW-295).
 *
 * Aynı 3-hane yuvarlama dört dosyada kopyalanmıştı
 * (`biomass-growth-applier`, `feeding-cron-v2`, `meal-execution`,
 * `day-plan-recalc`). Kopyalar bugün birebir aynıydı; sorun sapma RİSKİydi:
 * biri değişirse biyokütle ile plan kg'ı sessizce ayrışırdı — ve bu ikisi
 * aynı mutabakat denklemine giriyor.
 *
 * 3 hane, kg ve gram alanlarının kolon hassasiyetiyle hizalıdır
 * (`numeric(12,3)` / `numeric(10,3)`).
 *
 * @module FeedingProtocol/Services
 */

/** kg/gram alanları için kanonik 3-hane yuvarlama. */
export function round3(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}
