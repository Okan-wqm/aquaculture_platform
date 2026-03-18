// ─── Kaskad Zincirleri (Domino Etkileri) ──────────────────────────────────────
//
// NASIL ÇALIŞIR:
//   1. Su ürünleri yetiştiriciliğinde bir sorun düzeltilmezse, zincirleme (kaskad) etkiler
//      oluşur. Bir domino taşı diğerini devirir gibi, ilk sorun saatler/günler içinde
//      giderek büyüyen ikincil ve üçüncül sorunlara yol açar.
//   2. Her kaskad zinciri bir "tetikleyici" (trigger) ile başlar ve ardından zamanla
//      gerçekleşecek etkileri (CascadeStep) sırasıyla tanımlar.
//   3. Her adımda:
//      - delay: etkinin tetikleyiciden kaç saat/gün sonra gerçekleşeceği
//      - effect: ne olacağı (metrik bazlı tanım)
//      - impact: etkinin şiddeti (low → critical)
//      - probability: gerçekleşme olasılığı (0-1)
//   4. recommendedActions: zinciri KIRMAK için önerilen müdahaleler ve aciliyet seviyeleri
//
// Kullanım Senaryoları:
//   - Bir anomali tespit edildiğinde: tetikleyici ile eşleşen kaskad zinciri bulunur
//   - Gelecekte ne olacağı tahmin edilir (predictCascadeEffects)
//   - Kullanıcıya "X saat içinde Y olabilir, Z yapmanız önerilir" şeklinde uyarı verilir
//   - Geçmiş veride bir kaskad gerçekleşmiş mi kontrolü yapılabilir
//
// Bilimsel Kaynaklar:
//   - Timmons & Ebeling (2013). "Recirculating Aquaculture Systems" — Bölüm 7, 8
//   - Boyd, C.E. (2015). "Water Quality: An Introduction"
//   - Wedemeyer (1996). "Physiology of Fish in Intensive Culture Systems"
//   - FAO Technical Guidelines for Responsible Fisheries No. 5, Suppl. 4
//
// EXTENSIBLE: Yeni kaskad zinciri eklemek için KNOWN_CASCADES dizisine yeni eleman ekleyin.
//   Her zincirin benzersiz bir id'si olmalıdır (format: 'CASCADE-XXX').
//   CascadeStep'ler delayHours'a göre artan sırada dizilmelidir.
// ──────────────────────────────────────────────────────────────────────────────

// ─── Tip Tanımları ───────────────────────────────────────────────────────────

/**
 * Kaskad zincirinin bir adımı — tetikleyiciden belirli bir süre sonra gerçekleşecek etki.
 *
 * delay: İnsan-okunur gecikme süresi (ör: '6h', '24h', '7d')
 *   Format kuralı: saatler için 'Xh', günler için 'Xd'
 *
 * delayHours: Gecikmenin saat cinsinden sayısal değeri.
 *   Kolay karşılaştırma ve filtreleme için kullanılır.
 *   Örnek: '7d' = 168 saat
 *
 * effect: Etkinin teknik tanımı (ör: 'ammonia_rise_150pct', 'mortality_spike').
 *   Bu değer programatik olarak kullanılabilir — sensör verisiyle eşleştirilebilir.
 *
 * impact: Etkinin şiddeti:
 *   'low' → takip edilmeli ama acil değil
 *   'medium' → 24 saat içinde müdahale edilmeli
 *   'high' → 6 saat içinde müdahale edilmeli
 *   'critical' → ACİL müdahale gerekli
 *
 * description: İnsan-okunur Türkçe açıklama — kullanıcıya gösterilir.
 *
 * probability: Bu etkinin gerçekleşme olasılığı (0-1 arası).
 *   1.0 = kesin, 0.8 = çok muhtemel, 0.5 = olası, 0.3 = düşük olasılık
 *   Olasılık, tetikleyicinin şiddetine ve çevre koşullarına göre değişebilir.
 */
export interface CascadeStep {
  delay: string;
  delayHours: number;
  effect: string;
  impact: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  probability: number;
}

/**
 * Bir kaskad zinciri — tetikleyici olay ve ardından gelecek etkilerin tam tanımı.
 *
 * id: Benzersiz tanımlayıcı (ör: 'CASCADE-001')
 * trigger: Tetikleyici olayın teknik adı (ör: 'biofilter_stress')
 * triggerDescription: İnsan-okunur Türkçe tetikleyici açıklaması
 * domain: Tetikleyicinin ait olduğu domain (ör: 'water_quality', 'equipment')
 * chain: Kronolojik sıralı etki adımları (CascadeStep dizisi)
 * recommendedActions: Zinciri kırmak/durdurmak için önerilen müdahaleler
 */
export interface CascadeChain {
  id: string;
  trigger: string;
  triggerDescription: string;
  domain: string;
  chain: CascadeStep[];
  recommendedActions: Array<{
    action: string;
    urgency: 'immediate' | 'within_6h' | 'within_24h' | 'within_week';
    expectedOutcome: string;
  }>;
}

// ─── 5 Bilinen Kaskad Zinciri ───────────────────────────────────────────────
//
// Her zincir gerçek dünya senaryolarına dayanır:
//   1. Biofiltre stresi — nitrifikasyon kaybı → amonyak birikmesi
//   2. Aeratör arızası — oksijen kaybı → akut mortalite
//   3. Sıcaklık spike — termal stres → bağışıklık çöküşü
//   4. Aşırı besleme — organik yük → su kalitesi bozulması
//   5. Yüksek yoğunluk — kronik stres → performans kaybı
// ──────────────────────────────────────────────────────────────────────────────

export const KNOWN_CASCADES: CascadeChain[] = [

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. BİOFİLTRE STRESİ KASKADI
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // NASIL ÇALIŞIR:
  //   Biofiltre, nitrifikasyon bakterileri (Nitrosomonas, Nitrobacter) ile amonyağı
  //   nitrite, sonra nitrata dönüştürür. Biofiltre "stres altında" olduğunda
  //   (pH kayması, ilaçlama, enerji kesintisi, aşırı organik yük vb.) nitrifikasyon
  //   kapasitesi düşer ve amonyak birikmeye başlar.
  //
  //   Zincir:
  //     T+0h  : Biofiltre stres altına girer (trigger)
  //     T+6h  : NH₃ seviyesi %150 artar (nitrifikasyon yavaşladığı için)
  //     T+12h : Balıklarda iştah kaybı başlar (%30 düşüş — NH₃ etkisi)
  //     T+24h : Yemleme varyansı yükselir (bazı balıklar yiyor, bazıları yemiyor)
  //     T+48h : Mortalite riski %60'a çıkar (kronik NH₃ maruziyeti)
  //     T+7d  : Hayatta kalan balıklarda büyüme kaybı (ortalama 15g/balık)
  //
  //   Bu zincir RAS sistemlerinde EN YAYGIN kaskaddır çünkü biofiltre hassastır:
  //     - pH < 6.5 veya > 8.5 → nitrifikasyon durur
  //     - Antibiyotik/kimyasal → faydalı bakteri ölümü
  //     - Organik aşırı yük → heterotrofik bakteriler nitrifikantları bastırır
  //     - Enerji kesintisi → oksijensiz ortam → nitrifikant ölümü
  {
    id: 'CASCADE-001',
    trigger: 'biofilter_stress',
    triggerDescription:
      'Biofiltre nitrifikasyon kapasitesinde düşüş — pH kayması, antibiyotik kullanımı, ' +
      'aşırı organik yük veya enerji kesintisi sonucu nitrifikasyon bakterileri stres altında.',
    domain: 'water_quality',
    chain: [
      {
        delay: '6h',
        delayHours: 6,
        effect: 'ammonia_rise_150pct',
        impact: 'high',
        description:
          'Amonyak (NH₃) seviyesi mevcut değerin %150\'sine yükselir. ' +
          'Nitrifikasyon kapasitesi düştüğü için TAN birikmeye başlar. ' +
          'Bu noktada TAN > 1 mg/L olması muhtemeldir (tür eşiğine bağlı tehlike).',
        probability: 0.9,
      },
      {
        delay: '12h',
        delayHours: 12,
        effect: 'appetite_decline_30pct',
        impact: 'medium',
        description:
          'Balıklarda iştah kaybı başlar — yem alımı ortalama %30 düşer. ' +
          'NH₃ solungaç epitelini irrite eder → kortizol salınımı → iştah baskılanması. ' +
          'Otomatik yemleme verilerinde net düşüş gözlenir.',
        probability: 0.85,
      },
      {
        delay: '24h',
        delayHours: 24,
        effect: 'feeding_variance_increase',
        impact: 'medium',
        description:
          'Yemleme varyansı yükselir — bireyler arası yem alımı farkı artar. ' +
          'Bazı balıklar hiç yemezken bazıları normal yiyor → CV (varyasyon katsayısı) artar. ' +
          'Bu durum büyüme homojenliğini bozar ve grading ihtiyacı doğurur.',
        probability: 0.75,
      },
      {
        delay: '48h',
        delayHours: 48,
        effect: 'mortality_risk_60pct',
        impact: 'critical',
        description:
          'Mortalite riski %60\'a çıkar. 48 saatlik kronik NH₃ maruziyeti solungaç ' +
          'hasarını kalıcı hale getirir. Özellikle küçük bireyler (fingerling) ve ' +
          'zayıf bireyler etkilenir. Günlük mortalite sayısı normal seviyenin 5-10x\'ine çıkabilir.',
        probability: 0.6,
      },
      {
        delay: '7d',
        delayHours: 168,
        effect: 'growth_loss_15g_per_fish',
        impact: 'high',
        description:
          'Hayatta kalan balıklarda ortalama 15g/balık büyüme kaybı. ' +
          'Bir haftalık iştah kaybı + metabolik stres → SGR sıfıra yaklaşır. ' +
          'Bu kayıp telafi edilmesi güç bir büyüme açığı yaratır (compensatory growth sınırlı).',
        probability: 0.7,
      },
    ],
    recommendedActions: [
      {
        action:
          'Acil su değişimi (%30-50) yaparak NH₃ konsantrasyonunu seyreltme. ' +
          'Mümkünse taze su ile sürekli akış (flow-through) moduna geç.',
        urgency: 'immediate',
        expectedOutcome:
          'NH₃ seviyesi birkaç saat içinde güvenli aralığa döner. ' +
          'Bu "zaman kazandırma" müdahalesidir — biofiltre toparlanana kadar.',
      },
      {
        action:
          'Yem miktarını %50 azalt. Protein metabolizması azaltılarak NH₃ üretimi düşürülür.',
        urgency: 'immediate',
        expectedOutcome:
          'TAN üretim hızı yarıya düşer → biofiltre üzerindeki yük azalır → toparlanma hızlanır.',
      },
      {
        action:
          'Biofiltre pH\'ını kontrol et ve 7.0-7.8 arasına ayarla (soda kül veya asit ile). ' +
          'Nitrifikasyon bakterileri bu aralıkta en verimli çalışır.',
        urgency: 'within_6h',
        expectedOutcome:
          'Nitrifikasyon kapasitesi 24-48 saat içinde %50-70 seviyesine geri döner.',
      },
      {
        action:
          'Biofiltre medyasını kontrol et — tıkanma veya bakteri kaybı varsa ' +
          'yedek medya ile destekle veya ticari nitrifikasyon bakteri kültürü ekle.',
        urgency: 'within_24h',
        expectedOutcome:
          'Biofiltre kapasitesi 3-7 gün içinde normal seviyesine döner.',
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. AERATÖR ARIZASI KASKADI
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // NASIL ÇALIŞIR:
  //   Aeratör/blower, suya oksijen transfer eden ana ekipmandır. Arıza durumunda
  //   DO hızla düşer çünkü:
  //     - Balıklar sürekli O₂ tüketir (metabolik ihtiyaç)
  //     - Biofiltre bakteri de O₂ tüketir (nitrifikasyon aerobik süreçtir)
  //     - Organik madde oksidasyonu O₂ tüketir
  //   Doğal difüzyon (yüzey transferi) bu talebi karşılamaya YETMEZ.
  //
  //   Bu kaskad EN ACİL olanıdır — saatler içinde toplu ölüm riski vardır.
  //   RAS'ta yedek aeratör (jeneratör + yedek blower) ZORUNLUDUR.
  //
  //   Zincir:
  //     T+0h : Aeratör durur (trigger)
  //     T+1h : DO kritik seviyeye düşer (tüketim > doğal difüzyon)
  //     T+3h : Balıklar yüzeyde gasping yapar (hipoksi davranışı)
  //     T+6h : Mortalite spike — toplu ölüm başlar
  {
    id: 'CASCADE-002',
    trigger: 'aerator_failure',
    triggerDescription:
      'Ana aeratör/blower sistemi arızalanır veya enerji kesintisi nedeniyle durur. ' +
      'O₂ transferi tamamen kesilir veya ciddi şekilde azalır.',
    domain: 'equipment',
    chain: [
      {
        delay: '1h',
        delayHours: 1,
        effect: 'do_critical_level',
        impact: 'critical',
        description:
          'Çözünmüş oksijen (DO) kritik seviyeye düşer (<3-4 mg/L türe göre). ' +
          'Balıkların metabolik O₂ tüketimi + biofiltre tüketimi devam ederken ' +
          'arz sıfıra yaklaşır. Yüzey difüzyonu talebin sadece %10-20\'sini karşılar. ' +
          'Yüksek yoğunluklu tanklarda DO 1 saat içinde 2-3 mg/L düşebilir.',
        probability: 0.95,
      },
      {
        delay: '3h',
        delayHours: 3,
        effect: 'fish_gasping',
        impact: 'critical',
        description:
          'Balıklar yüzeyde "gasping" yapar — su yüzeyinden hava almaya çalışır. ' +
          'Bu, akut hipoksinin en belirgin davranışsal göstergesidir. ' +
          'Solungaç kapak frekansı (operkül hareketi) 2-3x artar. ' +
          'Zayıf bireyler ve büyük bireyler (yüksek metabolik talep) ilk etkilenenlerdir.',
        probability: 0.9,
      },
      {
        delay: '6h',
        delayHours: 6,
        effect: 'mortality_spike',
        impact: 'critical',
        description:
          'Toplu mortalite başlar. DO < 1-2 mg/L seviyesinde aerobik metabolizma sürdürülemez. ' +
          'Soğuk su türleri (somon, alabalık) sıcak su türlerinden (tilapia, catfish) daha ' +
          'erken etkilenir. Mortalite oranı %20-80 arasında değişir (stocking yoğunluğuna bağlı). ' +
          'BU NOKTADA MÜDAHALENİN GECİKMESİ TELAFİSİ İMKANSIZ KAYIPLARA YOL AÇAR.',
        probability: 0.8,
      },
    ],
    recommendedActions: [
      {
        action:
          'ACİL: Yedek aeratör/blower devreye al. Jeneratör çalıştır. ' +
          'El ile havalandırma yap (su pompası ile su sirkülasyonu veya acil oksijen tüpü).',
        urgency: 'immediate',
        expectedOutcome:
          'DO 15-30 dakika içinde güvenli seviyeye yükselir. Mortalite önlenir.',
      },
      {
        action:
          'Yemi tamamen kes — sindirim oksijen tüketir. ' +
          'Balıkların metabolik oksijen talebini minimize et.',
        urgency: 'immediate',
        expectedOutcome:
          'O₂ tüketim hızı %15-25 azalır (sindirim spesifik dinamik aksiyonu ortadan kalkar).',
      },
      {
        action:
          'Mümkünse taze su girişi aç (musluk, yangın hortumu, vb.) — ' +
          'akan su doğal olarak oksijen taşır.',
        urgency: 'immediate',
        expectedOutcome:
          'Her litre taze su ~7-9 mg/L DO taşır — kısmi oksijen desteği sağlar.',
      },
      {
        action:
          'Arıza giderildikten sonra: 6 saat boyunca DO ve balık davranışını yakından takip et. ' +
          'Mortalite sayımı yap, stres belirtilerini (renk solması, yüzme bozukluğu) kontrol et.',
        urgency: 'within_6h',
        expectedOutcome:
          'Olası gecikmeli mortalite erken tespit edilir. Hasarlı bireylerin ayrılması sağlanır.',
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. SICAKLIK SPIKE KASKADI
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // NASIL ÇALIŞIR:
  //   Ani sıcaklık artışı (termal spike) çok katmanlı etki yaratır:
  //     1. Fiziksel etki: sıcak suyun O₂ çözünürlüğü düşer (Henry Yasası)
  //     2. Metabolik etki: poikilotermik hayvanların metabolik hızı artar (Q10)
  //     3. Davranışsal etki: iştah değişimi (optimal'in üstünde iştah düşer)
  //     4. İmmünolojik etki: kronik termal stres bağışıklık sistemini baskılar
  //     5. Patolojik etki: bağışıklık düşünce patojen fırsatçı enfeksiyonlar artar
  //
  //   Sıcaklık spike'ın kaynakları:
  //     - Isı değiştirici arızası
  //     - Yaz sıcak dalgası (açık kafes/havuz)
  //     - Sıcak su girişi (endüstriyel kirlilik)
  //     - RAS'ta soğutma sistemi arızası
  //
  //   Bu kaskad "yavaş ama ölümcül"dür — ilk etki anlıktır ama kritik sonuçlar
  //   3-7 gün sonra ortaya çıkar (bağışıklık çöküşü + hastalık).
  {
    id: 'CASCADE-003',
    trigger: 'temperature_spike',
    triggerDescription:
      'Su sıcaklığı türün optimal aralığının 3-5°C üzerine çıkar — ısı değiştirici arızası, ' +
      'sıcak dalga veya soğutma sistemi arızası sonucu.',
    domain: 'water_quality',
    chain: [
      {
        delay: '0h',
        delayHours: 0,
        effect: 'do_solubility_drop',
        impact: 'medium',
        description:
          'ANLIK ETKİ: Sıcaklık artışıyla birlikte suyun O₂ çözünürlüğü düşer. ' +
          'Her 1°C artış → O₂ doygunluğu ~%2-3 azalır. ' +
          '5°C artışta mevcut DO %10-15 düşebilir (yeni denge noktası). ' +
          'Aeratörler aynı hızda çalışsa bile DO daha düşük kalır.',
        probability: 1.0,    // fiziksel zorunluluk — kesin gerçekleşir
      },
      {
        delay: '2h',
        delayHours: 2,
        effect: 'metabolic_demand_increase',
        impact: 'medium',
        description:
          'Metabolik O₂ talebi artar (Q10 kuralı). ' +
          'Her 10°C artış metabolizmayı ~2x hızlandırır → O₂ tüketimi↑. ' +
          'Arz düşerken talep artıyor — "çifte darbe" senaryosu oluşur. ' +
          'Balıkların operkül (solungaç kapağı) frekansı belirgin artar.',
        probability: 0.95,
      },
      {
        delay: '6h',
        delayHours: 6,
        effect: 'appetite_change',
        impact: 'low',
        description:
          'İştah değişimi gözlenir. Optimal sıcaklığın hafif üstünde iştah ARTABİLİR ' +
          '(metabolizma hızlandığı için), ama optimal\'in çok üstünde iştah DÜŞER ' +
          '(stres etkisi). Yemleme verilerinde bu değişim 6 saat içinde görülür. ' +
          'İştah artışı yanıltıcıdır — daha fazla yem → daha fazla NH₃ üretimi demektir.',
        probability: 0.8,
      },
      {
        delay: '24h',
        delayHours: 24,
        effect: 'immune_suppression',
        impact: 'high',
        description:
          'Kronik termal stres bağışıklık sistemini baskılar. ' +
          'Kortizol seviyesi yükselir → lenfosit üretimi azalır → ' +
          'humoral ve hücresel bağışıklık zayıflar. ' +
          'Mukus üretimi azalır → deri ve solungaç bariyeri zayıflar. ' +
          'Bu noktada bakteri/parazit enfeksiyonlarına karşı savunma düşer.',
        probability: 0.75,
      },
      {
        delay: '3d',
        delayHours: 72,
        effect: 'disease_susceptibility',
        impact: 'critical',
        description:
          'Hastalık duyarlılığı kritik seviyeye çıkar. Bağışıklık baskılanması + ' +
          'patojen çoğalma hızının artması (bakteriler de sıcaktan hızlanır) = ' +
          'fırsatçı enfeksiyon riski. Vibriosis, Aeromonas, Flexibacter ve ' +
          'ektoparazit (sea lice, trichodina) salgınları başlayabilir. ' +
          'Mortalite "sıcaklık kaynaklı" değil "hastalık kaynaklı" olarak görünür ' +
          'ama kök neden termal strestir.',
        probability: 0.6,
      },
    ],
    recommendedActions: [
      {
        action:
          'ACİL: Soğutma mekanizmasını devreye al — chiller, taze soğuk su girişi, ' +
          'gölgeleme (kafes üstü örtü), veya buz ekleme (son çare).',
        urgency: 'immediate',
        expectedOutcome:
          'Sıcaklık 2-4 saat içinde optimal aralığa yaklaşır. Metabolik stres azalır.',
      },
      {
        action:
          'Havalandırmayı artır — ek aeratör devreye al veya oksijen enjeksiyonu başlat. ' +
          'Sıcaklık kaynaklı DO düşüşünü kompanse et.',
        urgency: 'immediate',
        expectedOutcome:
          'DO güvenli seviyede kalır — "çifte darbe" senaryosu önlenir.',
      },
      {
        action:
          'Yem miktarını %30-50 azalt. Metabolizma zaten hızlanmış → ek sindirim yükü ' +
          'NH₃ üretimini aşırı artırır. Protein oranı düşük yemle geçici besle.',
        urgency: 'within_6h',
        expectedOutcome:
          'NH₃ üretimi azalır, metabolik oksijen talebi düşer, biofiltre yükü hafifler.',
      },
      {
        action:
          'Sıcaklık normale dönse bile 7 gün boyunca balık sağlığını yakından izle: ' +
          'davranış değişiklikleri, deri lezyonları, solungaç rengi, mortalite trendi. ' +
          'Gerekirse profilaktik tedavi (tuz banyosu, probiyotik) uygula.',
        urgency: 'within_24h',
        expectedOutcome:
          'Gecikmeli hastalık çıkışları erken tespit ve tedavi edilir. Mortalite minimize edilir.',
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. AŞIRI BESLEME (OVERFEEDING) KASKADI
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // NASIL ÇALIŞIR:
  //   Aşırı besleme, su kalitesini bozmanın en hızlı yoludur:
  //     1. Yenmemiş yem tank/havuz tabanına çöker → organik madde birikir
  //     2. Heterotrofik bakteriler bu organik maddeyi ayrıştırır → O₂ tüketir + NH₃ üretir
  //     3. Artan protein metabolizması → solungaçlardan NH₃ salınımı↑
  //     4. TAN yükü biofiltre kapasitesini aşarsa → amonyak birikir
  //     5. Uzun sürerse WQ genel olarak bozulur (bulanıklık, CO₂, bakteriyel yük)
  //
  //   Aşırı beslemenin kaynakları:
  //     - Otomatik yemleme kalibrasyonu yanlış
  //     - Büyüme modeli güncellenmemiş (eski ağırlık verisiyle yem hesabı)
  //     - Tatlı yem (talep bazlı yemleme) sensörü arızalı
  //     - Operatör hatası
  //
  //   Zincir nispeten hızlıdır — 24 saat içinde ciddi WQ bozulması olabilir.
  {
    id: 'CASCADE-004',
    trigger: 'overfeeding',
    triggerDescription:
      'Günlük yem miktarı, balık biyokütle × hedef yem oranının %130\'unu aşar. ' +
      'Yenmemiş yem birikimi ve aşırı protein metabolizması başlar.',
    domain: 'feeding',
    chain: [
      {
        delay: '2h',
        delayHours: 2,
        effect: 'organic_load_increase',
        impact: 'low',
        description:
          'Organik yük artar — yenmemiş yem tank tabanında birikir ve çürümeye başlar. ' +
          'Heterotrofik bakteriler organik maddeyi parçalar → biyokimyasal oksijen talebi (BOD) yükselir. ' +
          'Bulanıklık (türbidite) ve askıda katı madde (TSS) artar. ' +
          'Henüz kritik değil ama trendi tersine çevirmezseniz hızla kötüleşir.',
        probability: 0.9,
      },
      {
        delay: '6h',
        delayHours: 6,
        effect: 'ammonia_spike',
        impact: 'high',
        description:
          'Amonyak spike — TAN seviyesi normal değerin 2-3x\'ine çıkar. ' +
          'İki kaynak eş zamanlı: (1) yenmemiş yemin bakteriyel parçalanması → NH₃, ' +
          '(2) balıkların fazla proteini metabolize etmesi → solungaçlardan NH₃ salınımı. ' +
          'Her 1 kg fazla yemin ~30g ek TAN ürettiği hesaplanmalıdır.',
        probability: 0.85,
      },
      {
        delay: '12h',
        delayHours: 12,
        effect: 'biofilter_stress',
        impact: 'high',
        description:
          'Biofiltre stres altına girer — normal kapasitesinin üstünde TAN yükü işlemeye ' +
          'çalışır. Nitrifikasyon bakterileri aşırı yükle baş edemezse → NH₃ geçiş yapar ' +
          '(breakthrough). Bu noktada CASCADE-001 (biofiltre stresi kaskadı) da tetiklenebilir — ' +
          'çift kaskad senaryosu en tehlikeli durumdur.',
        probability: 0.7,
      },
      {
        delay: '24h',
        delayHours: 24,
        effect: 'wq_deterioration',
        impact: 'high',
        description:
          'Genel su kalitesi bozulması: NH₃↑, NO₂↑, DO↓, CO₂↑, bulanıklık↑. ' +
          'Çoklu parametre bozulması balıklarda akut stres yaratır. ' +
          'Solungaç irritasyonu + iştah kaybı + davranış değişikliği (letarji, yüzme bozukluğu). ' +
          '24 saat içinde müdahale edilmezse mortalite başlayabilir.',
        probability: 0.65,
      },
    ],
    recommendedActions: [
      {
        action:
          'Yemi derhal %50 azalt veya tamamen kes (24 saat açlık periyodu). ' +
          'Organik yük üretimini durdurmak en etkili ilk müdahaledir.',
        urgency: 'immediate',
        expectedOutcome:
          'Yeni TAN üretimi 4-6 saat içinde %50-70 azalır. Biofiltre rahatlar.',
      },
      {
        action:
          'Tank/havuz tabanındaki yenmemiş yemi temizle — sifon, vakum veya su değişimi ile. ' +
          'Organik madde kaynağını fiziksel olarak kaldır.',
        urgency: 'immediate',
        expectedOutcome:
          'Çürüme kaynaklı NH₃ üretimi birkaç saat içinde durur. BOD düşer.',
      },
      {
        action:
          'Havalandırmayı artır — organik madde oksidasyonu O₂ tüketir, DO düşüşünü kompanse et.',
        urgency: 'within_6h',
        expectedOutcome:
          'DO güvenli seviyede kalır. Aerobik parçalanma hızlanır (anaerobik çürüme önlenir).',
      },
      {
        action:
          'Otomatik yemleme kalibrasyonunu kontrol et ve güncelle. ' +
          'Mevcut biyokütle verisiyle yem oranını yeniden hesapla. ' +
          'Demand feeder sensörünü test et.',
        urgency: 'within_24h',
        expectedOutcome:
          'Tekrar aşırı besleme önlenir. Yem oranı doğru biyokütle verisine dayandırılır.',
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. YÜKSEK STOCKING YOĞUNLUĞU KASKADI
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // NASIL ÇALIŞIR:
  //   Yoğunluk kademeli bir stres kaynağıdır — aniden öldürmez ama zaman içinde
  //   performansı aşındırır. Balıklar büyüdükçe yoğunluk otomatik artar
  //   (biyokütle = birey sayısı × ortalama ağırlık).
  //
  //   Kronik yüksek yoğunluk etkileri:
  //     - Sosyal stres (hiyerarşi çatışması, dominans kavgası)
  //     - Fiziksel hasar (yüzgeç erozyonu, göz yaralanması)
  //     - WQ bozulması (birim hacimde daha fazla metabolik atık)
  //     - Yem rekabeti (baskın bireyler daha fazla yer → boyut varyansı artar)
  //
  //   Bu kaskad YAVAŞ ama SİNSİ'dir — günlük gözlemde fark edilmeyebilir
  //   ama haftalık/aylık trend analizinde belirgin olur.
  //
  //   Çözüm: grading + split (tank bölme) veya erken hasat
  {
    id: 'CASCADE-005',
    trigger: 'high_stocking_density',
    triggerDescription:
      'Stocking yoğunluğu türün maxDensity eşiğinin %85\'ini aşar. ' +
      'Büyüme devam ettikçe biyokütle artarak yoğunluk kötüleşir.',
    domain: 'stocking',
    chain: [
      {
        delay: '7d',
        delayHours: 168,
        effect: 'growth_decline',
        impact: 'medium',
        description:
          'Büyüme oranı (SGR) %15-25 düşer. Kronik sosyal stres → kortizol↑ → ' +
          'iştah baskılanması + enerji metabolizmasının stres tepkisine yönlendirilmesi. ' +
          'Yem alımı azalmasa bile besin kullanım verimliliği düşer.',
        probability: 0.85,
      },
      {
        delay: '14d',
        delayHours: 336,
        effect: 'fcr_degradation',
        impact: 'medium',
        description:
          'Yem dönüşüm oranı (FCR) %20-35 kötüleşir. Aynı miktarda yem tüketiliyor ' +
          'ama daha az büyüme elde ediliyor → ekonomik verimlilik düşer. ' +
          'Yem maliyeti toplam üretim maliyetinin %50-60\'ıdır, bu nedenle FCR bozulması ' +
          'doğrudan kârlılığı etkiler.',
        probability: 0.8,
      },
      {
        delay: '21d',
        delayHours: 504,
        effect: 'aggression_fin_damage',
        impact: 'high',
        description:
          'Agresyon artar ve yüzgeç hasarı (fin erosion) yaygınlaşır. ' +
          'Alan yetersizliği → dominans hiyerarşisi sertleşir → subordinate bireyler ' +
          'saldırıya uğrar. Yüzgeç hasarı sekonder bakteriyel enfeksiyon riski taşır. ' +
          'Grading yapılırsa boy varyasyonu belirgin şekilde artmış olarak gözlenir.',
        probability: 0.7,
      },
      {
        delay: '30d',
        delayHours: 720,
        effect: 'chronic_mortality',
        impact: 'high',
        description:
          'Kronik mortalite başlar — günlük ölüm oranı normal seviyenin 2-3x\'ine çıkar. ' +
          'Zayıf bireyler, yaralı bireyler ve stres kaynaklı immünosüpresyon sonucu ' +
          'hastalanıp ölenler artar. Mortalite dalgalanmalar gösterir (döngüsel). ' +
          'Toplu ölüm riski düşüktür ama süregelen kayıp ekonomik olarak yıkıcıdır.',
        probability: 0.6,
      },
    ],
    recommendedActions: [
      {
        action:
          'Grading + split (boyutlandırma + tank bölme) yap. Büyük ve küçük bireyleri ayır, ' +
          'her grubu ayrı tanka taşı. Her tankta yoğunluk optimalDensity altına düşmeli.',
        urgency: 'within_week',
        expectedOutcome:
          'Yoğunluk %40-50 düşer → stres azalır → 2 hafta içinde SGR ve FCR iyileşir.',
      },
      {
        action:
          'Erken hasat (partial harvest) düşün — pazar boyutuna ulaşmış bireyleri hasatla çıkar. ' +
          'Bu hem yoğunluğu azaltır hem nakit akışı sağlar.',
        urgency: 'within_week',
        expectedOutcome:
          'Yoğunluk anında düşer. Kalan balıklar daha iyi koşullarda büyümeye devam eder.',
      },
      {
        action:
          'Havalandırma ve su değişimini artır — yüksek yoğunlukta WQ bozulma hızı artar. ' +
          'Biofiltre kapasitesini kontrol et, gerekirse ek biofiltre medyası ekle.',
        urgency: 'within_24h',
        expectedOutcome:
          'WQ parametreleri (DO, NH₃) güvenli aralıkta tutulur. Kronik stres azaltılır.',
      },
      {
        action:
          'Yemleme stratejisini gözden geçir: daha sık, daha küçük porsiyonlar → ' +
          'yem rekabetini azalt. Birden fazla yemleme noktası kullan.',
        urgency: 'within_24h',
        expectedOutcome:
          'Homojen yem dağılımı → subordinate bireyler de beslenir → büyüme varyansı azalır.',
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. AMONYAK SPIKE KASKADI
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // CASCADE-001 (biofiltre stresi) ile ilişkili ama farklı tetikleyici:
  // Burada tetikleyici doğrudan NH3 spike'tır (kaynak ne olursa olsun).
  // Biofiltre stresi ise NH3'ün bir NEDENI'dir.
  //
  // Zincir:
  //   T+0h : NH3 seviyesi uyarı eşiğini aşıyor
  //   T+2h : Solungaç mukus birikimi → O2 alımı azalıyor
  //   T+6h : İştah kaybı başlıyor
  //   T+12h: Bağışıklık düşüyor → enfeksiyon riski
  //   T+24h: Mortalite artışı
  //   T+48h: Ölü balık organik yükü → NH3 daha da artıyor (kötü döngü)
  {
    id: 'CASCADE-006',
    trigger: 'ammonia_spike',
    triggerDescription:
      'Amonyak (NH3) seviyesi uyarı eşiğini aşıyor — kaynak biofiltre yetersizliği, ' +
      'aşırı besleme veya organik yük artışı olabilir.',
    domain: 'water_quality',
    chain: [
      {
        delay: '0h',
        delayHours: 0,
        effect: 'ammonia',
        impact: 'high',
        description: 'NH3 seviyesi uyarı eşiğini aşıyor — balıklar strese giriyor',
        probability: 1.0,
      },
      {
        delay: '2h',
        delayHours: 2,
        effect: 'dissolved_oxygen_uptake',
        impact: 'high',
        description: 'Solungaç mukus birikimi başlıyor — oksijen alımı azalıyor',
        probability: 0.85,
      },
      {
        delay: '6h',
        delayHours: 6,
        effect: 'feed_consumption',
        impact: 'medium',
        description: 'İştah kaybı başlıyor — yem tüketimi düşüyor',
        probability: 0.75,
      },
      {
        delay: '12h',
        delayHours: 12,
        effect: 'immune_response',
        impact: 'high',
        description: 'Bağışıklık sistemi zayıflıyor — fırsatçı enfeksiyon riski artıyor',
        probability: 0.6,
      },
      {
        delay: '24h',
        delayHours: 24,
        effect: 'mortality_rate',
        impact: 'critical',
        description: 'Mortalite artışı başlıyor — günlük ölüm sayısı yükseliyor',
        probability: 0.5,
      },
      {
        delay: '48h',
        delayHours: 48,
        effect: 'ammonia',
        impact: 'critical',
        description: 'Ölen balıkların organik yükü NH3 üretimini daha da artırıyor (kötü döngü)',
        probability: 0.4,
      },
    ],
    recommendedActions: [
      {
        action: 'Acil su değişimi (%30-50) — NH3 seviyesini seyrelt',
        urgency: 'immediate',
        expectedOutcome: 'NH3 konsantrasyonu hızla düşer',
      },
      {
        action: 'Yem miktarını %50 azalt veya beslenmeyi durdur',
        urgency: 'immediate',
        expectedOutcome: 'Protein metabolizması → NH3 üretim kaynağı kesilir',
      },
      {
        action: 'Biofiltre durumunu kontrol et — bakteri popülasyonu canlı mı?',
        urgency: 'within_6h',
        expectedOutcome: 'NH3 yükselmesinin kök nedeni belirlenir ve düzeltilir',
      },
      {
        action: 'Biofiltre kapasitesini artır veya stoklama yoğunluğunu azalt',
        urgency: 'within_week',
        expectedOutcome: 'Tekrarlayan NH3 sorunları için kalıcı çözüm sağlanır',
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. OKSİJEN DÜŞÜŞÜ KASKADI
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // CASCADE-002 (aeratör arızası) ile ilişkili ama farklı tetikleyici:
  // Burada tetikleyici genel DO düşüşü (nedeni ne olursa olsun).
  //
  // Zincir:
  //   T+0h : DO minimum eşiğin altına düştü
  //   T+1h : Yem tüketimi duruyor — gasping davranışı
  //   T+3h : Akut stres — kortizol yükseliyor
  //   T+6h : Zayıf bireyler ölmeye başlıyor
  //   T+12h: Hayatta kalanlar kronik stres altında — büyüme duruyor
  {
    id: 'CASCADE-007',
    trigger: 'dissolved_oxygen_drop',
    triggerDescription:
      'Çözünmüş oksijen (DO) seviyesi minimum eşiğin altına düşüyor — ' +
      'aeratör arızası, aşırı organik yük veya sıcaklık artışı kaynaklı olabilir.',
    domain: 'water_quality',
    chain: [
      {
        delay: '0h',
        delayHours: 0,
        effect: 'dissolved_oxygen',
        impact: 'critical',
        description: 'DO seviyesi minimum eşiğinin altına düştü — balıklar gasping yapıyor',
        probability: 1.0,
      },
      {
        delay: '1h',
        delayHours: 1,
        effect: 'feed_consumption',
        impact: 'high',
        description: 'Yem tüketimi tamamen duruyor — balıklar yüzeyden nefes almaya çalışıyor',
        probability: 0.9,
      },
      {
        delay: '3h',
        delayHours: 3,
        effect: 'stress_level',
        impact: 'high',
        description: 'Akut stres reaksiyonu — kortizol seviyeleri yükseliyor',
        probability: 0.85,
      },
      {
        delay: '6h',
        delayHours: 6,
        effect: 'mortality_rate',
        impact: 'critical',
        description: 'Zayıf bireyler ölmeye başlıyor — mortalite artışı',
        probability: 0.7,
      },
      {
        delay: '12h',
        delayHours: 12,
        effect: 'growth_rate',
        impact: 'high',
        description: 'Hayatta kalanlar kronik stres altında — büyüme duruyor',
        probability: 0.65,
      },
    ],
    recommendedActions: [
      {
        action: 'Acil havalandırma — ek aeratör devreye al veya oksijen enjeksiyonu yap',
        urgency: 'immediate',
        expectedOutcome: 'DO seviyesi hızla güvenli aralığa yükselir',
      },
      {
        action: 'Beslenmeyi tamamen durdur',
        urgency: 'immediate',
        expectedOutcome: 'Sindirim oksijen tüketimi durur — kısıtlı O2 hayatta kalmaya yönlendirilir',
      },
      {
        action: 'DO düşüşünün nedenini araştır (arın bozulması, alg patlaması, aşırı stoklama)',
        urgency: 'within_6h',
        expectedOutcome: 'Kök neden çözülerek DO tekrar düşmesi önlenir',
      },
      {
        action: 'Yedek havalandırma sistemi ve oksijen alarmı kur',
        urgency: 'within_week',
        expectedOutcome: 'Gelecekte DO düşüşü erken tespit ve önlem alınır',
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. SICAKLIK SAPMASI KASKADI
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // CASCADE-003 (sıcaklık spike) ile ilişkili ama farklı tetikleyici adı.
  // Genel sıcaklık sapması (hem yüksek hem düşük yönlü).
  {
    id: 'CASCADE-008',
    trigger: 'temperature_deviation',
    triggerDescription:
      'Sıcaklık optimal aralığın dışına çıkıyor — yüksek veya düşük yönlü sapma.',
    domain: 'water_quality',
    chain: [
      {
        delay: '0h',
        delayHours: 0,
        effect: 'temperature',
        impact: 'medium',
        description: 'Sıcaklık optimal aralığın dışına çıktı — metabolizma değişiyor',
        probability: 1.0,
      },
      {
        delay: '4h',
        delayHours: 4,
        effect: 'dissolved_oxygen',
        impact: 'high',
        description: 'Yüksek sıcaklıkta oksijen çözünürlüğü azalıyor → DO düşüyor',
        probability: 0.8,
      },
      {
        delay: '8h',
        delayHours: 8,
        effect: 'ammonia',
        impact: 'medium',
        description: 'Artan metabolizma NH3 üretimini artırıyor',
        probability: 0.7,
      },
      {
        delay: '12h',
        delayHours: 12,
        effect: 'ammonia_toxicity',
        impact: 'high',
        description: 'Yüksek sıcaklıkta pH → NH3 toksisitesi artıyor (double hit)',
        probability: 0.65,
      },
      {
        delay: '24h',
        delayHours: 24,
        effect: 'growth_rate',
        impact: 'medium',
        description: 'Stres kaynaklı iştah kaybı ve büyüme yavaşlaması',
        probability: 0.6,
      },
      {
        delay: '48h',
        delayHours: 48,
        effect: 'disease_risk',
        impact: 'high',
        description: 'Bağışıklık sistemi zayıflıyor — hastalık riski artıyor',
        probability: 0.5,
      },
    ],
    recommendedActions: [
      {
        action: 'Soğutma/ısıtma sistemini aktive et veya su değişimi yap',
        urgency: 'immediate',
        expectedOutcome: 'Sıcaklık optimal aralığa getirilir',
      },
      {
        action: 'Yem miktarını %25-50 azalt',
        urgency: 'within_6h',
        expectedOutcome: 'Yüksek sıcaklıkta metabolizma hızlanır, NH3 üretimi azaltılır',
      },
      {
        action: 'DO izleme sıklığını artır — saatlik ölçüm yap',
        urgency: 'within_6h',
        expectedOutcome: 'Sıcaklık → DO → NH3 kaskadı için erken uyarı sağlanır',
      },
      {
        action: 'Gölgeleme, izolasyon veya chiller sistemi değerlendir',
        urgency: 'within_week',
        expectedOutcome: 'Mevsimsel sıcaklık sorunları için kalıcı çözüm',
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 9. BESLEME FAZLASI KASKADI
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // CASCADE-004 (overfeeding) ile ilişkili ama farklı tetikleyici adı.
  // Planlanan yem miktarının %130'unu aşma senaryosu.
  {
    id: 'CASCADE-009',
    trigger: 'feeding_excess',
    triggerDescription:
      'Gerçek yem miktarı planlananın %130\'unu aşıyor — organik yük artışı başlıyor.',
    domain: 'feeding',
    chain: [
      {
        delay: '0h',
        delayHours: 0,
        effect: 'feed_waste',
        impact: 'low',
        description: 'Fazla yem verildi — yenmeyen yem tankın dibine çöküyor',
        probability: 1.0,
      },
      {
        delay: '4h',
        delayHours: 4,
        effect: 'dissolved_oxygen',
        impact: 'medium',
        description: 'Yenmeyen yem çürüyerek oksijen tüketiyor → DO düşüyor',
        probability: 0.75,
      },
      {
        delay: '8h',
        delayHours: 8,
        effect: 'ammonia',
        impact: 'medium',
        description: 'Organik madde parçalanması NH3 üretiyor → amonyak yükseliyor',
        probability: 0.7,
      },
      {
        delay: '12h',
        delayHours: 12,
        effect: 'biofilter_load',
        impact: 'high',
        description: 'Biofiltre yüklenmeye başlıyor — nitrifikasyon kapasitesi yetersiz',
        probability: 0.6,
      },
      {
        delay: '24h',
        delayHours: 24,
        effect: 'stress_level',
        impact: 'high',
        description: 'Kronik WQ bozulması — balıklar strese giriyor',
        probability: 0.5,
      },
    ],
    recommendedActions: [
      {
        action: 'Beslenmeyi durdur — en az 12 saat açlık uygula',
        urgency: 'immediate',
        expectedOutcome: 'Organik yük azalır ve biofiltre toparlanır',
      },
      {
        action: 'Yenmeyen yemi tank dibinden temizle (sifonlama)',
        urgency: 'within_6h',
        expectedOutcome: 'Çürüme kaynaklı NH3 üretimi ve O2 tüketimi durur',
      },
      {
        action: 'Besleme planını gözden geçir — otomatik besleyici kalibrasyonunu kontrol et',
        urgency: 'within_24h',
        expectedOutcome: 'Fazla beslemenin operasyonel nedeni düzeltilir',
      },
      {
        action: 'Yem sensörü/kamera ile iştah tabanlı besleme sistemine geç',
        urgency: 'within_week',
        expectedOutcome: 'Manuel besleme hataları ortadan kalkar',
      },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 10. YOĞUNLUK AŞIMI KASKADI
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // CASCADE-005 (yüksek stocking yoğunluğu) ile ilişkili ama farklı tetikleyici adı.
  // Tank yoğunluğu optimal aralık üzerindeyken kısa-orta vadeli etkiler.
  {
    id: 'CASCADE-010',
    trigger: 'density_overload',
    triggerDescription:
      'Tank yoğunluğu optimal aralığın %90 kapasitesinin üzerinde — birim hacim başına oksijen talebi yüksek.',
    domain: 'stocking',
    chain: [
      {
        delay: '0h',
        delayHours: 0,
        effect: 'stocking_density',
        impact: 'medium',
        description: 'Tank yoğunluğu %90 kapasitenin üzerinde — birim hacim başına oksijen talebi yüksek',
        probability: 1.0,
      },
      {
        delay: '6h',
        delayHours: 6,
        effect: 'water_quality_composite',
        impact: 'high',
        description: 'WQ parametreleri bozulmaya başlıyor — DO düşüyor, NH3 artıyor',
        probability: 0.8,
      },
      {
        delay: '12h',
        delayHours: 12,
        effect: 'stress_level',
        impact: 'medium',
        description: 'Balıklar arası rekabet artıyor — sınıfı düşüşü, stres',
        probability: 0.7,
      },
      {
        delay: '24h',
        delayHours: 24,
        effect: 'growth_rate',
        impact: 'medium',
        description: 'Büyüme yavaşlaması — FCR kötüleşmeye başlıyor',
        probability: 0.65,
      },
      {
        delay: '72h',
        delayHours: 72,
        effect: 'mortality_rate',
        impact: 'high',
        description: 'Kronik stres → hastalık riski → mortalite artışı',
        probability: 0.45,
      },
    ],
    recommendedActions: [
      {
        action: 'Acil hasat veya batch bölme (split) planlayın',
        urgency: 'immediate',
        expectedOutcome: 'Yoğunluk fiziksel olarak azaltılır',
      },
      {
        action: 'WQ izleme sıklığını artır — 2 saatlik ölçüm periyoduna geç',
        urgency: 'within_6h',
        expectedOutcome: 'Yüksek yoğunlukta WQ bozulması erken tespit edilir',
      },
      {
        action: 'Su değişim oranını artır',
        urgency: 'within_6h',
        expectedOutcome: 'Atık konsantrasyonu seyreltilir',
      },
      {
        action: 'Stoklama planını optimize et — büyüme projeksiyonu ile kapasite eşleştir',
        urgency: 'within_week',
        expectedOutcome: 'Gelecekte yoğunluk aşımı önlenir',
      },
    ],
  },
];

// ─── Yardımcı Fonksiyonlar ───────────────────────────────────────────────────

/**
 * Tetikleyici adına göre kaskad zincirini bulur.
 *
 * NASIL ÇALIŞIR:
 *   1. KNOWN_CASCADES dizisinde trigger alanı eşleşen zinciri arar
 *   2. İlk eşleşmeyi döndürür, yoksa undefined
 *
 * @param trigger - Tetikleyici olayın teknik adı (ör: 'biofilter_stress', 'aerator_failure')
 * @returns Bulunan kaskad zinciri veya undefined
 *
 * Kullanım örneği:
 *   const cascade = findCascadeByTrigger('aerator_failure');
 *   if (cascade) {
 *     console.log(`${cascade.chain.length} adımlı kaskad bulundu`);
 *     console.log(`İlk etki: ${cascade.chain[0].delay} sonra`);
 *   }
 */
export function findCascadeByTrigger(trigger: string): CascadeChain | undefined {
  return KNOWN_CASCADES.find((c) => c.trigger === trigger);
}

/**
 * Belirli bir tetikleyiciden sonra, verilen süre geçtikten sonra HÂLÂ GELEBİLECEK
 * etkileri döndürür.
 *
 * NASIL ÇALIŞIR:
 *   1. Tetikleyiciye ait kaskad zincirini bulur
 *   2. Zincirdeki adımları filtreler: sadece delayHours > hoursElapsed olanları döndürür
 *   3. Yani "zaten gerçekleşmiş" adımları hariç tutar, "henüz gerçekleşmemiş" olanları döndürür
 *
 * Bu fonksiyon "gelecek tahmin" aracıdır:
 *   - Sorun 4 saat önce başladıysa, bundan sonra ne olacak?
 *   - Kullanıcıya "Müdahale etmezseniz X saat sonra Y olabilir" denilebilir
 *
 * @param trigger - Tetikleyici olayın teknik adı
 * @param hoursElapsed - Tetikleyiciden bu yana geçen saat sayısı
 * @returns Gelecekte gerçekleşebilecek kaskad adımları (boş dizi = tüm etkiler zaten geçmiş)
 *
 * Kullanım örneği:
 *   // Biofiltre stresi 8 saat önce başladı — bundan sonra ne olacak?
 *   const upcoming = predictCascadeEffects('biofilter_stress', 8);
 *   // Sonuç: 12h, 24h, 48h ve 7d adımlarını döndürür (6h zaten geçti)
 *   for (const step of upcoming) {
 *     console.log(`T+${step.delay}: ${step.description} (olasılık: ${step.probability})`);
 *   }
 */
export function predictCascadeEffects(
  trigger: string,
  hoursElapsed: number,
): CascadeStep[] {
  const cascade = findCascadeByTrigger(trigger);
  if (!cascade) {
    return [];
  }

  // Henüz gerçekleşmemiş adımları döndür (delayHours > geçen süre)
  return cascade.chain.filter((step) => step.delayHours > hoursElapsed);
}
