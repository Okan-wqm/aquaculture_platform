/**
 * GraphQL enum köprüsü — SSoT.
 *
 * WHY (2026-09-21 canlı olay zinciri): backend TS enum'ları küçük harf
 * DEĞERLERLE kayıtlı (`DISEASE = 'disease'`); GraphQL tel protokolü ise
 * enumun ADINI bekler (`DISEASE`) ve yanıtları AD olarak döndürür.
 * Formlar DEĞER tuttuğu için her seferinde ayrı yerlerde `toUpperCase`
 * yamaları çoğaldı (Chemicals, Mortality, Cull, Harvest) — hepsi bu tek
 * modüle indirgendi. Yeni bir enum alanı eklerken SADECE bu iki fonksiyon
 * kullanılmalı; yerel çevrim yazmak yasak.
 */

/** Form DEĞERİ → GraphQL enum ADI (istek gövdesi için). */
export function toGraphqlEnumName(value: string | null | undefined): string | undefined {
  return value ? value.toUpperCase() : undefined;
}

/** GraphQL enum ADI → form DEĞERİ (yanıt işleme için). */
export function fromGraphqlEnumName(value: string | null | undefined): string | undefined {
  return value ? value.toLowerCase() : undefined;
}
