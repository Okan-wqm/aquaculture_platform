// ============================================================================
// MCP Farm Intelligence Server — Günlük Operasyon Brifing Prompt'u
// ============================================================================
//
// "Bugün ne yapılmalı?" sorusuna kapsamlı cevap üretir.
//
// NASIL ÇALIŞIR:
//   1. Kullanıcı "günlük brifingimi hazırla" dediğinde bu prompt tetiklenir
//   2. Prompt, AI'ya hangi tool'ları sırayla çağırması gerektiğini söyler
//   3. Tool zinciri: get_farm_snapshot → detect_anomalies → assess_risk
//   4. Tüm sonuçlar birleştirilerek yapılandırılmış Türkçe brifing oluşturulur
//
// TOOL ZİNCİRİ:
//   get_farm_snapshot: Çiftliğin genel durumunu getirir (siteler, tanklar, batch'ler)
//   detect_anomalies(scope:'farm'): Tüm çiftlikteki anomalileri tarar
//   assess_risk(scope:'farm'): Genel risk değerlendirmesi yapar
//
// KULLANIM:
//   - siteId boş → tüm çiftlik brifingi
//   - siteId dolu → belirli bir site odaklı brifing
//
// ÇIKTI FORMATI:
//   - GENEL DURUM: Site/tank/batch sayıları
//   - BUGÜNKÜ GÖREVLER: Planlanan ve geciken görevler
//   - ANOMALİLER: Tespit edilen sorunlar (kritik öncelikli)
//   - RİSK DEĞERLENDİRMESİ: Skor ve faktörler
//   - OPTİMİZASYON FIRSATLARI: İyileştirme önerileri
//   - ÖNCELİKLİ AKSİYONLAR: Bugünkü en önemli 3-5 aksiyon
// ============================================================================

// ── Prompt Tanımı ────────────────────────────────────────────────
// MCP SDK'nın ListPrompts yanıtında döndürülecek meta bilgiler.
// name: Prompt'un benzersiz tanımlayıcısı (AI tarafından referans edilir)
// description: Prompt'un ne yaptığını açıklayan Türkçe metin
// arguments: Prompt'a geçilebilecek opsiyonel parametreler
export const dailyOperationsPrompt = {
  /** Prompt benzersiz adı — MCP istemcisi bu isimle çağırır */
  name: 'daily_operations',

  /** Prompt açıklaması — AI'ya ve kullanıcıya ne yapacağını anlatır */
  description: 'Günlük operasyon brifing — çiftliğin genel durumu, anomaliler, riskler ve öncelikli aksiyonlar',

  /** Prompt argümanları — kullanıcı tarafından sağlanabilir */
  arguments: [
    {
      /** Argüman adı */
      name: 'siteId',
      /** Argüman açıklaması */
      description: 'Belirli bir site için brifing (opsiyonel — boş bırakılırsa tüm çiftlik)',
      /** Zorunlu değil — boş bırakılabilir */
      required: false,
    },
  ],
};

// ── Prompt Mesajları Oluşturma ────────────────────────────────────
/**
 * Günlük operasyon brifing prompt'u için mesaj dizisini oluşturur.
 *
 * NASIL ÇALIŞIR:
 *   1. siteId parametresi kontrol edilir
 *   2. siteId varsa → scope: 'site' (belirli bir site)
 *   3. siteId yoksa → scope: 'farm' (tüm çiftlik)
 *   4. AI'ya adım adım hangi tool'ları çağırması gerektiğini söyleyen
 *      yapılandırılmış bir mesaj oluşturulur
 *   5. Mesaj, çıktı formatını da belirler (Türkçe, yapılandırılmış)
 *
 * Döndürülen mesaj formatı MCP SDK'nın GetPrompt yanıtına uyumludur:
 *   { role: 'user', content: { type: 'text', text: '...' } }
 *
 * @param args - Prompt argümanları (siteId opsiyonel)
 * @returns MCP uyumlu mesaj dizisi
 */
export function getDailyOperationsMessages(
  args: { siteId?: string },
): Array<{ role: 'user' | 'assistant'; content: { type: 'text'; text: string } }> {

  // ── Kapsam Belirleme ──────────────────────────────────────────
  // siteId verilmişse sadece o site incelenir ('site' scope)
  // siteId verilmemişse tüm çiftlik incelenir ('farm' scope)
  const scope = args.siteId ? 'site' : 'farm';

  // ── Entity Filtresi ───────────────────────────────────────────
  // site scope'unda entityId parametresi tool çağrılarına eklenir
  // farm scope'unda bu parametre boş bırakılır (tüm çiftlik taranır)
  const entityClause = args.siteId ? `, entityId: "${args.siteId}"` : '';

  // ── Mesaj Oluşturma ───────────────────────────────────────────
  // AI'ya sıralı talimatlar verilir:
  //   1. get_farm_snapshot → genel durum verisi
  //   2. detect_anomalies → anomali taraması
  //   3. assess_risk → risk değerlendirmesi
  //   4. Tüm sonuçları birleştir → Türkçe brifing
  return [{
    role: 'user',
    content: {
      type: 'text',
      text: `Günlük operasyon brifingimi hazırla. Şu adımları takip et:

1. Önce \`get_farm_snapshot\`${args.siteId ? `(siteId: "${args.siteId}")` : ''} tool'unu çağırarak çiftliğin genel durumunu al.

2. Sonra \`detect_anomalies\`(scope: "${scope}"${entityClause}) tool'unu çağırarak aktif anomalileri tespit et.

3. Son olarak \`assess_risk\`(scope: "${scope}"${entityClause}, includeOpportunities: true) tool'unu çağırarak risk değerlendirmesi yap.

4. Tüm sonuçları birleştirerek aşağıdaki formatta Türkçe brifing hazırla:
   - GENEL DURUM: Site/tank/batch sayıları, aktif üretim durumu
   - BUGÜNKÜ GÖREVLER: Planlanan ve geciken görevler
   - ANOMALİLER: Tespit edilen anomaliler (önce kritik olanlar)
   - RİSK DEĞERLENDİRMESİ: Genel risk skoru ve kritik faktörler
   - OPTİMİZASYON FIRSATLARI: Varsa iyileştirme önerileri
   - ÖNCELİKLİ AKSİYONLAR: Bugün yapılması gereken en önemli 3-5 aksiyon

Brifing kısa, net ve aksiyon odaklı olmalı.`,
    },
  }];
}
