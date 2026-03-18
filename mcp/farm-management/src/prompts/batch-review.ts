// ============================================================================
// MCP Farm Intelligence Server — Batch İnceleme Prompt'u
// ============================================================================
//
// "Bu batch'in durumu ne?" sorusuna kapsamlı cevap üretir.
//
// NASIL ÇALIŞIR:
//   1. Kullanıcı belirli bir batch hakkında bilgi istediğinde tetiklenir
//   2. Prompt, AI'ya 4 aşamalı analiz süreci tanımlar
//   3. Her aşamada farklı bir tool çağrılır
//   4. Sonuçlar birleştirilerek detaylı Türkçe batch raporu oluşturulur
//
// TOOL ZİNCİRİ:
//   get_entity_timeline(batch): Batch'in olay geçmişini getirir (stocking, sampling, harvest vb.)
//   detect_anomalies(batch): Batch'e özgü anomalileri tespit eder
//   correlate_domains(batch): Domain'ler arası (sensor↔farm↔alert) korelasyonları bulur
//   assess_risk(batch): Batch'in risk profilini değerlendirir
//
// KULLANIM:
//   - batchId (zorunlu): İncelenecek batch'in UUID'si
//   - days (opsiyonel): İnceleme penceresi (gün cinsinden, varsayılan: 14)
//
// ÇIKTI FORMATI:
//   - BATCH BİLGİLERİ: Tür, stocking tarihi, ağırlık/miktar/biyokütle
//   - OLAY GEÇMİŞİ: Kronolojik özet
//   - ANOMALİLER: Tespit edilen sorunlar
//   - KORELASYONLAR: Domain'ler arası ilişkiler
//   - RİSK DEĞERLENDİRMESİ: Skor ve faktörler
//   - BÜYÜME ANALİZİ: SGR trend, FCR, mortalite oranı
//   - ÖNERİLER: Kısa ve uzun vadeli aksiyon önerileri
// ============================================================================

// ── Prompt Tanımı ────────────────────────────────────────────────
// MCP SDK'nın ListPrompts yanıtında döndürülecek meta bilgiler.
// Batch inceleme prompt'u, belirli bir batch'in tüm boyutlarıyla
// değerlendirilmesini sağlar.
export const batchReviewPrompt = {
  /** Prompt benzersiz adı — 'batch_review' olarak kayıtlıdır */
  name: 'batch_review',

  /** Prompt açıklaması — batch incelemesinin kapsamını belirtir */
  description: 'Batch detaylı inceleme — geçmiş olaylar, anomaliler, korelasyonlar ve risk değerlendirmesi',

  /** Prompt argümanları — batchId zorunlu, days opsiyonel */
  arguments: [
    {
      /** İncelenecek batch'in benzersiz tanımlayıcısı */
      name: 'batchId',
      /** Argüman açıklaması */
      description: 'İncelenecek batch ID',
      /** Zorunlu — her batch incelemesi bir batch ID gerektirir */
      required: true,
    },
    {
      /** İnceleme zaman penceresi — kaç gün geriye bakılacak */
      name: 'days',
      /** Argüman açıklaması — varsayılan değer belirtilir */
      description: 'İnceleme penceresi (gün), varsayılan: 14',
      /** Opsiyonel — belirtilmezse 14 gün kullanılır */
      required: false,
    },
  ],
};

// ── Prompt Mesajları Oluşturma ────────────────────────────────────
/**
 * Batch inceleme prompt'u için mesaj dizisini oluşturur.
 *
 * NASIL ÇALIŞIR:
 *   1. batchId parametresi zorunlu olarak alınır
 *   2. days parametresi opsiyonel — verilmezse '14' varsayılır
 *   3. AI'ya 5 adımlı analiz süreci tanımlanır:
 *      a) get_entity_timeline → olay geçmişi
 *      b) detect_anomalies → anomali tespiti
 *      c) correlate_domains → cross-domain korelasyon
 *      d) assess_risk → risk değerlendirmesi
 *      e) Sonuçları birleştir → yapılandırılmış rapor
 *   4. Çıktı formatı Türkçe ve detaylı olarak belirtilir
 *
 * Bu prompt, tek bir batch'in "360 derece" analizini sağlar.
 * Birden fazla domain'den veri çekerek kapsamlı bir değerlendirme yapar.
 *
 * @param args - Prompt argümanları (batchId zorunlu, days opsiyonel)
 * @returns MCP uyumlu mesaj dizisi
 */
export function getBatchReviewMessages(
  args: { batchId: string; days?: string },
): Array<{ role: 'user' | 'assistant'; content: { type: 'text'; text: string } }> {

  // ── Zaman Penceresi Belirleme ──────────────────────────────────
  // days parametresi string olarak gelir (MCP prompt arguments string'dir)
  // parseInt ile sayıya çevrilerek Zod şemasındaki number beklentisiyle uyumlu hale getirilir
  // Belirtilmemişse varsayılan 14 gün kullanılır
  // 14 gün, çoğu anomali ve trend analizi için yeterli bir penceredir
  const days = parseInt(args.days || '14', 10);

  // ── Mesaj Oluşturma ───────────────────────────────────────────
  // AI'ya sıralı ve detaylı talimatlar verilir.
  // Her adımda hangi tool'un hangi parametrelerle çağrılacağı belirtilir.
  // Son adımda tüm sonuçların nasıl birleştirileceği açıklanır.
  return [{
    role: 'user',
    content: {
      type: 'text',
      text: `Batch "${args.batchId}" için kapsamlı inceleme yap. Şu adımları takip et:

1. \`get_entity_timeline\`(entityId: "${args.batchId}", entityType: "batch", days: ${days}) ile batch'in olay geçmişini al.

2. \`detect_anomalies\`(scope: "batch", entityId: "${args.batchId}", timeWindowDays: ${days}) ile anomalileri tespit et.

3. \`correlate_domains\`(entityId: "${args.batchId}", entityType: "batch", timeWindowDays: ${days}) ile domain korelasyonlarını analiz et.

4. \`assess_risk\`(scope: "batch", entityId: "${args.batchId}", includeOpportunities: true) ile risk değerlendirmesi yap.

5. Tüm sonuçları birleştirerek Türkçe detaylı batch raporu hazırla:
   - BATCH BİLGİLERİ: Tür, stocking tarihi, mevcut ağırlık/miktar/biyokütle
   - OLAY GEÇMİŞİ: Son ${days} günün kronolojik özeti
   - ANOMALİLER: Tespit edilen sorunlar
   - KORELASYONLAR: Domain'ler arası önemli ilişkiler
   - RİSK DEĞERLENDİRMESİ: Skor ve kritik faktörler
   - BÜYÜME ANALİZİ: SGR trend, FCR, mortalite oranı
   - ÖNERİLER: Kısa ve uzun vadeli aksiyon önerileri`,
    },
  }];
}
