/**
 * Yemleme motoru sabitleri (Faz 5).
 *
 * `MAX_FEED_KG` eskiden silinecek legacy execution servisinde inline yaşıyordu
 * (plan NFR notu) — SSoT artık burada: legacy servis drain penceresi boyunca
 * buradan okur, v2 girdi DTO'ları aynı sınırı doğrulamada kullanır. NFR girdi
 * tablosuyla birebir: 0 < kg ≤ 10000.
 *
 * @module FeedingProtocol
 */

/** Tek kayıtta/dökümde verilebilecek azami yem (kg) — NFR girdi sınırı. */
export const MAX_FEED_KG = 10000;

/** Tek kayıtta/dökümde anlamlı asgari yem (kg) — sıfır/negatif reddedilir. */
export const MIN_FEED_KG = 0.001;
