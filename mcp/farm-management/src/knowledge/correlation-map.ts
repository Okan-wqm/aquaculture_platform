// ─── Bilinen Korelasyon Haritası ──────────────────────────────────────────────
//
// NASIL ÇALIŞIR:
//   1. Bu dosya, su ürünleri yetiştiriciliğinde BİLİNEN 12 domain-arası korelasyonu tanımlar.
//   2. Her korelasyon iki metrik arasındaki nedenssellik ilişkisini belirtir:
//        - domainA.metricA ↔ domainB.metricB
//        - expectedDirection: 'positive' (A↑→B↑) veya 'negative' (A↑→B↓)
//   3. Korelasyonlar iki kategoriye ayrılır:
//        - 'risk': Olumsuz sonuçlara yol açan ilişkiler (ör: aşırı besleme → amonyak artışı)
//        - 'optimization': İyileştirme fırsatı sunan ilişkiler (ör: optimal DO → büyüme artışı)
//   4. typicalLagHours: B metriğinin A'dan kaç saat sonra etkilendiğini gösterir.
//      Bu değer, kaskad tahminleri ve trend analizi için kritiktir.
//   5. strength: İstatistiksel korelasyon gücünü belirtir (weak/moderate/strong).
//      'strong' = r > 0.7, 'moderate' = 0.4-0.7, 'weak' = 0.2-0.4
//
// Kullanım Senaryoları:
//   - Anomali tespit edildiğinde: ilişkili metrikler de kontrol edilir
//   - Trend analizi: bir metrik değiştiğinde, ilişkili metriklerin de değişip
//     değişmediği korelasyon haritasından bakılarak doğrulanır
//   - Kök neden analizi: bir sorunun kaynağını bulmak için geriye doğru
//     korelasyon zinciri takip edilir
//
// Bilimsel Kaynaklar:
//   - Timmons & Ebeling (2013). "Recirculating Aquaculture Systems"
//   - Boyd, C.E. (2015). "Water Quality: An Introduction"
//   - Pillay & Kutty (2005). "Aquaculture: Principles and Practices"
//   - Wedemeyer (1996). "Physiology of Fish in Intensive Culture Systems"
//
// EXTENSIBLE: Yeni korelasyon eklemek için KNOWN_CORRELATIONS dizisine yeni eleman ekleyin.
//   Her korelasyonun benzersiz bir id'si olmalıdır (format: 'COR-XXX').
// ──────────────────────────────────────────────────────────────────────────────

// ─── Tip Tanımları ───────────────────────────────────────────────────────────

/**
 * İki domain/metrik arasındaki bilinen korelasyonu tanımlar.
 *
 * id: Benzersiz tanımlayıcı (ör: 'COR-001')
 *
 * domainA / metricA: İlk domain ve metrik.
 *   Domain değerleri: 'feeding', 'water_quality', 'growth', 'mortality',
 *                     'stocking', 'weather', 'equipment', 'health', 'environmental'
 *   Metrik değerleri: domain'e özgü (ör: feeding→'feed_amount', water_quality→'ammonia')
 *
 * domainB / metricB: İkinci domain ve metrik (etkilenen taraf).
 *
 * expectedDirection:
 *   'positive' → A artarsa B de artar (veya A azalırsa B de azalır)
 *   'negative' → A artarsa B azalır (veya A azalırsa B artar)
 *
 * category:
 *   'risk' → Bu korelasyon olumsuz bir sonucu temsil eder (dikkat edilmeli)
 *   'optimization' → Bu korelasyon bir iyileştirme fırsatını temsil eder
 *
 * mechanism: Bilimsel açıklama — NEDEN bu korelasyon var?
 *
 * typicalLagHours: B'nin A'dan kaç saat sonra tepki verdiği.
 *   0 = anlık etki, 168 = 7 gün sonra etki
 *
 * strength: Beklenen istatistiksel korelasyon gücü.
 *
 * referenceNote: Bilimsel kaynak veya deneysel gözlem notu.
 */
export interface KnownCorrelation {
  id: string;
  domainA: string;
  metricA: string;
  domainB: string;
  metricB: string;
  expectedDirection: 'positive' | 'negative';
  category: 'risk' | 'optimization';
  mechanism: string;
  typicalLagHours: number;
  strength: 'weak' | 'moderate' | 'strong';
  referenceNote: string;
}

// ─── 12 Bilinen Korelasyon ──────────────────────────────────────────────────
//
// --- NEGATİF (Risk) KORELASYONLAR (1-7) ---
//   Bu korelasyonlar olumsuz sonuçlara yol açar ve erken uyarı sinyalleri üretir.
//   Anomali tespitinde bu korelasyonlar "B metriğini de kontrol et" mantığıyla kullanılır.
//
// --- POZİTİF (Optimizasyon) KORELASYONLAR (8-12) ---
//   Bu korelasyonlar iyileştirme fırsatları sunar ve optimizasyon önerilerinde kullanılır.
// ──────────────────────────────────────────────────────────────────────────────

export const KNOWN_CORRELATIONS: KnownCorrelation[] = [

  // ═══════════════════════════════════════════════════════════════════════════
  // NEGATİF (RİSK) KORELASYONLAR
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── 1. Aşırı Besleme → Amonyak Artışı ────────────────────────────────────
  // NASIL ÇALIŞIR:
  //   1. Balıklar yediği proteini sindirirken amino asitleri deaminasyona uğratır
  //   2. Deaminasyon ürünü olarak amonyak (NH₃/NH₄⁺) solungaçlardan salınır
  //   3. Yenmemiş yem çürüyerek ek organik azot yükü oluşturur
  //   4. Biofiltre kapasitesi aşılırsa amonyak birikir
  //   Zaman gecikmesi: ~4-6 saat (sindirim + bakteriyel parçalanma süresi)
  //   Kuvvet: GÜÇLÜ — doğrudan biyokimyasal bağlantı
  {
    id: 'COR-001',
    domainA: 'feeding',
    metricA: 'feed_amount',
    domainB: 'water_quality',
    metricB: 'ammonia',
    expectedDirection: 'positive',    // besleme↑ → amonyak↑
    category: 'risk',
    mechanism:
      'Aşırı yem → yenmemiş yem çürümesi + protein metabolizması → NH₃ üretimi artar. ' +
      'Her 1 kg yemin ~30g azot içerdiği ve bunun ~%60-70\'inin suya salındığı kabul edilir. ' +
      'Biofiltre kapasitesi sabit olduğu için, aşırı besleme doğrudan amonyak birikimine yol açar.',
    typicalLagHours: 4,               // 4-6 saat — sindirim + parçalanma
    strength: 'strong',
    referenceNote:
      'Timmons & Ebeling (2013) Ch. 7: "Feed is the primary source of nitrogen loading in RAS. ' +
      'Each kg of feed produces approximately 30g TAN."',
  },

  // ─── 2. Düşük DO + Yüksek Sıcaklık → Mortalite ──────────────────────────
  // NASIL ÇALIŞIR:
  //   1. Sıcaklık arttığında suyun oksijen çözünürlüğü DÜŞER
  //      (Henry Yasası: 20°C'de ~9 mg/L, 30°C'de ~7.5 mg/L doygunluk)
  //   2. Aynı anda balıkların metabolik oksijen talebi ARTAR
  //      (Q10 kuralı: her 10°C artış metabolizma ~2x hızlandırır)
  //   3. Arz↓ + Talep↑ = oksijen açığı → stres → mortalite
  //   Bu "çifte darbe" etkisi yaz aylarında en tehlikeli senaryodur.
  //   Zaman gecikmesi: 2-6 saat — akut hipoksi hızla etkili
  //   Kuvvet: GÜÇLÜ — fizyolojik zorunluluk
  {
    id: 'COR-002',
    domainA: 'water_quality',
    metricA: 'dissolved_oxygen',
    domainB: 'mortality',
    metricB: 'mortality_rate',
    expectedDirection: 'negative',    // DO↓ → mortalite↑
    category: 'risk',
    mechanism:
      'Düşük DO + yüksek sıcaklık "çifte darbe" etkisi yaratır: ' +
      '(1) Sıcaklık↑ → O₂ çözünürlüğü↓ (Henry Yasası), ' +
      '(2) Sıcaklık↑ → metabolik O₂ talebi↑ (Q10 kuralı: her 10°C = ~2x metabolizma). ' +
      'Arz düşerken talep artınca akut hipoksi oluşur. ' +
      'Kritik DO eşiği altında balıklar gasping yapar ve 2-6 saat içinde mortalite başlar.',
    typicalLagHours: 4,               // 2-6 saat — akut etki
    strength: 'strong',
    referenceNote:
      'Wedemeyer (1996): "The interaction of temperature and DO is the single most ' +
      'important environmental factor affecting fish health." Boyd (2015) Ch. 8.',
  },

  // ─── 3. Amonyak Artışı → İştah Kaybı → Büyüme Düşüşü ───────────────────
  // NASIL ÇALIŞIR:
  //   1. Yüksek NH₃ seviyesi solungaç epitelini irrite eder
  //   2. Solungaç hasarı → oksijen alım kapasitesi düşer
  //   3. Balık strese girer → kortizol seviyesi artar → iştah baskılanır
  //   4. Yem alımı azalınca enerji açığı oluşur → büyüme yavaşlar
  //   Bu bir zincirleme etki: WQ → feeding behavior → growth performance
  //   Zaman gecikmesi: 12-48 saat (kronik maruziyet etkisi)
  //   Kuvvet: GÜÇLÜ — kanıtlanmış fizyolojik mekanizma
  {
    id: 'COR-003',
    domainA: 'water_quality',
    metricA: 'ammonia',
    domainB: 'growth',
    metricB: 'sgr',
    expectedDirection: 'negative',    // amonyak↑ → SGR↓
    category: 'risk',
    mechanism:
      'NH₃ toksisitesi → solungaç epiteli hasarı → O₂ alım kapasitesi↓ → ' +
      'kortizol salınımı↑ → iştah baskılanması → yem alımı↓ → enerji açığı → SGR↓. ' +
      'Kronik 0.02 mg/L UIA maruziyetinde bile somon büyümesi %20-30 yavaşlar. ' +
      'İştah kaybı genelde amonyak pikinden 12-24 saat sonra gözlenir.',
    typicalLagHours: 24,              // 12-48 saat — kronik etki
    strength: 'strong',
    referenceNote:
      'Randall & Tsui (2002): "Ammonia toxicity in fish." Environmental Toxicology and Chemistry. ' +
      'Sub-lethal NH₃ exposure reduces feed intake by 20-50% depending on species.',
  },

  // ─── 4. Yüksek Yoğunluk → Su Kalitesi Bozulması + Büyüme Düşüşü ───────
  // NASIL ÇALIŞIR:
  //   1. Yüksek stocking yoğunluğu → birim hacimde daha fazla metabolik atık
  //   2. Daha fazla atık → NH₃, CO₂, askıda katı madde artar
  //   3. Sosyal stres → kortizol↑ → bağışıklık↓ + iştah↓
  //   4. Fiziksel rekabet → yüzgeç hasarı, yem erişimi eşitsizliği
  //   5. Tüm bu faktörler birleşince: FCR↑ + SGR↓ + mortalite↑
  //   Zaman gecikmesi: 168 saat (7 gün) — kronik, kademeli bozulma
  //   Kuvvet: ORTA — çok faktörlü, yönetilebilir
  {
    id: 'COR-004',
    domainA: 'stocking',
    metricA: 'stocking_density',
    domainB: 'water_quality',
    metricB: 'overall_wq',
    expectedDirection: 'negative',    // yoğunluk↑ → WQ↓
    category: 'risk',
    mechanism:
      'Birim hacimde daha fazla balık → O₂ tüketimi↑ + NH₃/CO₂ üretimi↑ + ' +
      'askıda katı madde↑ → biofiltre yükü artar, WQ bozulur. ' +
      'Sosyal stres (kortizol↑) iştah ve bağışıklığı baskılar. ' +
      'Fiziksel rekabet yüzgeç hasarı ve yem erişimi eşitsizliği yaratır. ' +
      'Etki kademeli: ilk hafta WQ, ikinci hafta büyüme, üçüncü hafta sağlık etkilenir.',
    typicalLagHours: 168,             // 7 gün — kademeli bozulma
    strength: 'moderate',
    referenceNote:
      'Ellis et al. (2002): "The relationships between stocking density and welfare in farmed ' +
      'rainbow trout." Journal of Fish Biology. Density > 40 kg/m³ reduces growth by 15-25%.',
  },

  // ─── 5. pH Artışı → NH₃ Toksisite Artışı ────────────────────────────────
  // NASIL ÇALIŞIR:
  //   1. Toplam amonyak azotu (TAN) suda iki formda bulunur: NH₃ (toksik) + NH₄⁺ (düşük toksik)
  //   2. NH₃/NH₄⁺ dengesi pH ve sıcaklığa bağlıdır:
  //      pH 7.0'da: TAN'ın ~%0.5'i NH₃ formunda
  //      pH 8.0'da: TAN'ın ~%5'i NH₃ formunda (10x artış!)
  //      pH 9.0'da: TAN'ın ~%30'u NH₃ formunda (60x artış!)
  //   3. Yani TAN değişmese bile, pH 1 birim artarsa toksisite ~10x artar
  //   Bu "gizli tehlike": TAN ölçümü normal görünse bile pH yüksekse NH₃ kritik olabilir
  //   Zaman gecikmesi: 0 saat — ANI kimyasal denge
  //   Kuvvet: GÜÇLÜ — termodinamik zorunluluk
  {
    id: 'COR-005',
    domainA: 'water_quality',
    metricA: 'ph',
    domainB: 'water_quality',
    metricB: 'ammonia_toxicity',
    expectedDirection: 'positive',    // pH↑ → NH₃ toksisitesi↑
    category: 'risk',
    mechanism:
      'TAN ↔ NH₃ + NH₄⁺ dengesi pH\'a bağlıdır (Henderson-Hasselbalch denklemi). ' +
      'pH her 1 birim arttığında un-ionized NH₃ fraksiyonu ~10x artar: ' +
      'pH 7→%0.5, pH 8→%5, pH 9→%30. ' +
      'Sıcaklık da etkiler: 20°C vs 30°C\'de NH₃ fraksiyonu ~2x fark. ' +
      'Bu nedenle TAN ölçümü tek başına yeterli değil — pH ile birlikte değerlendirilmeli.',
    typicalLagHours: 0,               // Anlık — kimyasal denge
    strength: 'strong',
    referenceNote:
      'Emerson et al. (1975): "Aqueous ammonia equilibrium calculations" — the classic ' +
      'NH₃/NH₄⁺ equilibrium table. Boyd (2015) Ch. 11: "Nitrogen in Aquaculture Ponds."',
  },

  // ─── 6. Fırtına → DO Düşüşü + Bulanıklık Artışı ─────────────────────────
  // NASIL ÇALIŞIR:
  //   1. Şiddetli rüzgar ve yağış → sediment karışır, bulanıklık (türbidite) artar
  //   2. Bulanık su → fotosentez azalır → alg kaynaklı O₂ üretimi düşer
  //   3. Yağış → tatlı su girişi → tuzluluk değişimi (kafes çiftlikleri)
  //   4. Bulutlu hava → güneş ışığı azalır → fotosentez↓ → DO↓
  //   5. Rüzgar kaynaklı dalga → mekanik stres (kafes hasar riski)
  //   Açık kafes çiftliklerinde fırtına en büyük kontrol edilemeyen risktir.
  //   Zaman gecikmesi: 2-6 saat — hava durumu etkisi nispeten hızlı
  //   Kuvvet: ORTA — şiddete ve çiftlik tipine bağlı
  {
    id: 'COR-006',
    domainA: 'weather',
    metricA: 'storm_event',
    domainB: 'water_quality',
    metricB: 'dissolved_oxygen',
    expectedDirection: 'negative',    // fırtına → DO↓
    category: 'risk',
    mechanism:
      'Fırtına çok kanallı etki yapar: ' +
      '(1) Sediment karışımı → bulanıklık↑ → fotosentez↓ → alg O₂ üretimi↓, ' +
      '(2) Bulutlu hava → güneş ışığı↓ → fotosentez↓, ' +
      '(3) Yağış → tatlı su girişi → tuzluluk değişimi (osmoregülasyon stresi), ' +
      '(4) Dalga etkisi → mekanik stres + kafes hasar riski. ' +
      'Havuz tabanlı çiftliklerde sediment karışımı NH₃ salınımına da neden olabilir.',
    typicalLagHours: 3,               // 2-6 saat
    strength: 'moderate',
    referenceNote:
      'Boyd & Tucker (1998): "Pond Aquaculture Water Quality Management." ' +
      'Storm events can reduce DO by 2-4 mg/L within hours in shallow ponds.',
  },

  // ─── 7. Ekipman Arızası → Su Kalitesi Bozulması ──────────────────────────
  // NASIL ÇALIŞIR:
  //   1. Aeratör arızası → O₂ transferi durur → DO hızla düşer
  //   2. Biofiltre pompası arızası → NH₃ birikmeye başlar
  //   3. Isı değiştirici arızası → sıcaklık kontrolü kaybedilir
  //   4. UV/ozon arızası → patojen dezenfeksiyon durur → hastalık riski
  //   5. Otomatik yemleme arızası → aşırı/eksik besleme
  //   RAS (kapalı devre) sistemlerinde ekipman arızası ACİL DURUM'dur çünkü
  //   doğal su değişimi yoktur — her şey mekanik sistemlere bağlıdır.
  //   Zaman gecikmesi: 1-4 saat — RAS'ta çok hızlı etki
  //   Kuvvet: GÜÇLÜ — doğrudan mekanik bağlantı
  {
    id: 'COR-007',
    domainA: 'equipment',
    metricA: 'equipment_failure',
    domainB: 'water_quality',
    metricB: 'overall_wq',
    expectedDirection: 'negative',    // arıza → WQ↓
    category: 'risk',
    mechanism:
      'RAS sistemlerde su kalitesi tamamen mekanik ekipmana bağlıdır: ' +
      '(1) Aeratör/blower arızası → O₂ transferi durur → DO dakikalar içinde düşer, ' +
      '(2) Biofiltre dolaşım pompası → NH₃ birikimi 2-4 saat, ' +
      '(3) Isı değiştirici → sıcaklık kontrolü kaybolur, ' +
      '(4) UV/ozon → patojen kontrolü durur, ' +
      '(5) Drum filtre → askıda katı madde birikir → solungaç tıkanması. ' +
      'Açık kafeslerde ekipman bağımlılığı daha düşüktür (doğal su değişimi var).',
    typicalLagHours: 2,               // 1-4 saat — RAS'ta acil
    strength: 'strong',
    referenceNote:
      'Timmons & Ebeling (2013) Ch. 3: "In RAS, equipment failure is the #1 cause of ' +
      'catastrophic fish loss. Backup systems and alarms are essential."',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // POZİTİF (OPTİMİZASYON) KORELASYONLAR
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── 8. Optimal DO → İştah Artışı → Büyüme Artışı ────────────────────────
  // NASIL ÇALIŞIR:
  //   1. Yeterli DO → solungaçlarda verimli gaz değişimi → metabolizma optimal çalışır
  //   2. Optimal metabolizma → iştah artar → yem alımı↑
  //   3. Artan yem alımı + verimli sindirim → SGR↑ + FCR↓ (iyileşir)
  //   4. DO satürasyon seviyesine yakın olduğunda (%80-100) en iyi performans
  //   Bu "temel optimizasyon": DO yönetimi TÜM performans metriklerini etkiler.
  //   Zaman gecikmesi: 48-72 saat (büyüme etkisinin gözlenmesi)
  //   Kuvvet: GÜÇLÜ — en temel fizyolojik gereksinim
  {
    id: 'COR-008',
    domainA: 'water_quality',
    metricA: 'dissolved_oxygen',
    domainB: 'growth',
    metricB: 'sgr',
    expectedDirection: 'positive',    // DO↑ → SGR↑
    category: 'optimization',
    mechanism:
      'Optimal DO → verimli solungaç gaz değişimi → aerobik metabolizma↑ → ' +
      'iştah↑ → yem alımı↑ → SGR↑ + FCR↓. ' +
      'DO satürasyonun %80-100\'ü arasında en iyi performans elde edilir. ' +
      'Süper-oksijenasyon (>%100 satürasyon) bazı türlerde ek fayda sağlar. ' +
      'DO\'nun büyüme üzerindeki etkisi en temel optimizasyon parametresidir.',
    typicalLagHours: 48,              // 48-72 saat — büyüme etkisi
    strength: 'strong',
    referenceNote:
      'Brett & Groves (1979): "Physiological energetics" in Fish Physiology Vol. VIII. ' +
      'DO optimization can improve SGR by 10-20% compared to marginal DO levels.',
  },

  // ─── 9. Optimal Fotoperiod → Büyüme Artışı ───────────────────────────────
  // NASIL ÇALIŞIR:
  //   1. Işık süresi (fotoperiod) hormonal döngüleri düzenler:
  //      - Melatonin (karanlıkta): büyüme hormonu salınımını tetikler
  //      - GH-IGF eksen aktivasyonu → kas büyümesi
  //   2. Sürekli aydınlatma (LL) somon smoltlaşmasını tetikler/geciktirir
  //   3. Uzun gün (16L:8D) soğuk su türlerinde büyümeyi hızlandırır
  //   4. Fotoperiod + sıcaklık kombinasyonu üreme zamanlamasını kontrol eder
  //   Kapalı devre RAS'ta fotoperiod tam kontrol edilebilir → büyük optimizasyon fırsatı
  //   Zaman gecikmesi: 336 saat (14 gün) — hormonal adaptasyon süresi
  //   Kuvvet: ORTA — tür ve yaş dönemine bağlı
  {
    id: 'COR-009',
    domainA: 'environmental',
    metricA: 'photoperiod',
    domainB: 'growth',
    metricB: 'sgr',
    expectedDirection: 'positive',    // optimal fotoperiod → SGR↑
    category: 'optimization',
    mechanism:
      'Fotoperiod → melatonin döngüsü → GH-IGF eksen aktivasyonu → büyüme hormonu salınımı. ' +
      'Sürekli/uzun gün aydınlatması (LL veya 16L:8D) soğuk su türlerinde SGR\'yi %10-15 artırır. ' +
      'Etkisi hormonal olduğu için ~2 hafta adaptasyon süresi gerekir. ' +
      'Tropikal türlerde (tilapia) etkisi daha düşüktür (doğal fotoperiod zaten uzun). ' +
      'Kapalı devre RAS\'ta tam kontrol edilebilir — önemli optimizasyon aracı.',
    typicalLagHours: 336,             // 14 gün — hormonal adaptasyon
    strength: 'moderate',
    referenceNote:
      'Björnsson et al. (2000): "The effects of photoperiod on Atlantic salmon growth." ' +
      'Continuous light can increase growth by 10-15% in salmonids.',
  },

  // ─── 10. Besleme Frekansı Artışı → FCR İyileşmesi ────────────────────────
  // NASIL ÇALIŞIR:
  //   1. Az ve sık besleme → her öğünde sindirim sistemi aşırı yüklenmez
  //   2. Daha iyi besin emilimi → daha az atık üretimi → FCR↓ (iyileşir)
  //   3. Yem rekabeti azalır → tüm bireyler eşit erişir → homojen büyüme
  //   4. Yenmemiş yem miktarı azalır → su kalitesi de iyileşir (bonus etki)
  //   Optimal frekans türe ve yaşa bağlı: yavru 6-8x/gün, yetişkin 2-3x/gün
  //   Otomatik yemleme sistemleri → hassas frekans kontrolü mümkün
  //   Zaman gecikmesi: 72 saat (3 gün) — sindirim verimliliği adaptasyonu
  //   Kuvvet: ORTA — besleme yönetimi ile doğrudan kontrol edilebilir
  {
    id: 'COR-010',
    domainA: 'feeding',
    metricA: 'feeding_frequency',
    domainB: 'growth',
    metricB: 'fcr',
    expectedDirection: 'negative',    // frekans↑ → FCR↓ (düşük FCR = iyi)
    category: 'optimization',
    mechanism:
      'Sık ve küçük porsiyonlarla besleme → sindirim sistemi aşırı yüklenmez → ' +
      'besin emilimi verimliliği↑ → FCR↓. ' +
      'Ayrıca yem rekabeti azalır → homojen büyüme + yenmemiş yem↓ → WQ iyileşir. ' +
      'Optimal frekans: yavru/fingerling 6-8x/gün, juvenil 3-4x/gün, yetişkin 2-3x/gün. ' +
      'Demand feeder (talep bazlı yemleme) en iyi sonuçları verir.',
    typicalLagHours: 72,              // 3 gün — adaptasyon
    strength: 'moderate',
    referenceNote:
      'Cho & Bureau (2001): "A review of diet formulation strategies and feeding systems." ' +
      'Increasing feeding frequency from 1x to 4x/day improved FCR by 5-10% in salmon.',
  },

  // ─── 11. Temizleyici Balık → Stres Azalması ──────────────────────────────
  // NASIL ÇALIŞIR:
  //   1. Temizleyici balıklar (wrasse, lumpfish) dış parazitleri (sea lice) temizler
  //   2. Parazit yükü azalır → mekanik ve kimyasal ilaçlama ihtiyacı düşer
  //   3. Daha az handling (yakalama, ilaçlama) → stres↓ → kortizol↓
  //   4. Düşük stres → bağışıklık↑ + iştah↑ → genel sağlık ve büyüme iyileşir
  //   Bu "biyolojik kontrol" özellikle somon çiftliklerinde yaygınlaşmaktadır.
  //   Zaman gecikmesi: 336 saat (14 gün) — parazit popülasyonu azalma süresi
  //   Kuvvet: ZAYIF — birçok faktöre bağlı (temizleyici etkinliği, sıcaklık, vb.)
  {
    id: 'COR-011',
    domainA: 'health',
    metricA: 'cleaner_fish_ratio',
    domainB: 'health',
    metricB: 'stress_level',
    expectedDirection: 'negative',    // temizleyici balık↑ → stres↓
    category: 'optimization',
    mechanism:
      'Temizleyici balıklar (wrasse, lumpfish) dış parazitleri (Lepeophtheirus salmonis vb.) ' +
      'biyolojik olarak kontrol eder → parazit yükü↓ → ilaçlama ihtiyacı↓ → ' +
      'handling/stres↓ → kortizol↓ → bağışıklık↑ + iştah↑. ' +
      'Etkinlik sıcaklık, tür oranı (%5-10 temizleyici) ve kafes boyutuna bağlıdır. ' +
      'Alternatif: mekanik yöntemler (Hydrolicer, Thermolicer) ama bunlar da stres yaratır.',
    typicalLagHours: 336,             // 14 gün — parazit popülasyonu azalma
    strength: 'weak',
    referenceNote:
      'Skiftesvik et al. (2013): "Wrasse as cleaner fish in salmon aquaculture." ' +
      'Biological delousing can reduce lice counts by 50-90% in 2-4 weeks.',
  },

  // ─── 12. Sıcaklık Optimal → Metabolizma Artışı ───────────────────────────
  // NASIL ÇALIŞIR:
  //   1. Balıklar poikilotermdir (soğukkanlı) — vücut sıcaklığı = su sıcaklığı
  //   2. Enzim aktivitesi sıcaklığa bağlıdır (Arrhenius denklemi)
  //   3. Optimal sıcaklıkta → enzim aktivitesi maksimum → sindirim verimliliği↑
  //   4. Sindirim verimliliği↑ → besin emilimi↑ → büyüme↑ + FCR↓
  //   5. Optimal'in üstünde ise → protein denatürasyonu başlar → tersi etki
  //   Sıcaklık YÖNETİMİ en temel optimizasyon parametresidir (DO ile birlikte).
  //   Zaman gecikmesi: 24-48 saat (enzim aktivitesi adaptasyonu)
  //   Kuvvet: GÜÇLÜ — temel termodinamik/biyokimyasal ilişki
  {
    id: 'COR-012',
    domainA: 'water_quality',
    metricA: 'temperature',
    domainB: 'growth',
    metricB: 'metabolic_rate',
    expectedDirection: 'positive',    // sıcaklık optimal→↑ → metabolizma↑
    category: 'optimization',
    mechanism:
      'Balıklar poikilotermdir — metabolizma tamamen su sıcaklığına bağlıdır. ' +
      'Q10 kuralı: her 10°C artış metabolizmayı ~2x hızlandırır (optimal aralıkta). ' +
      'Optimal sıcaklıkta enzim aktivitesi maksimum → sindirim verimliliği↑ → SGR↑ + FCR↓. ' +
      'Optimal\'in ÜSTÜNDEYSE ters etki: protein denatürasyonu, oksijen açığı, stres. ' +
      'Bu nedenle bu korelasyon sadece tür-spesifik optimal aralık İÇİNDE geçerlidir.',
    typicalLagHours: 36,              // 24-48 saat — metabolik adaptasyon
    strength: 'strong',
    referenceNote:
      'Jobling (1994): "Fish Bioenergetics." Temperature is the master environmental factor ' +
      'controlling growth in ectotherms. Q10 values for fish metabolism range from 1.5 to 3.0.',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CROSS-DOMAIN KORELASYONLAR (correlate-domains aracı tarafından kullanılır)
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── 13. Sıcaklık ↔ Çözünmüş Oksijen (Fiziksel Çözünürlük) ─────────────
  {
    id: 'COR-013',
    domainA: 'water_quality',
    metricA: 'temperature',
    domainB: 'water_quality',
    metricB: 'dissolvedOxygen',
    expectedDirection: 'negative',
    category: 'risk',
    mechanism:
      'Sıcaklık arttıkça suyun oksijen çözünürlüğü azalır (Henry Yasası). ' +
      'Bu fiziksel bir zorunluluktur — anlık etki.',
    typicalLagHours: 0,
    strength: 'strong',
    referenceNote:
      'Boyd (2015) Ch. 8: O₂ solubility decreases ~0.3 mg/L per °C increase.',
  },

  // ─── 14. Amonyak → Mortalite ────────────────────────────────────────────
  {
    id: 'COR-014',
    domainA: 'water_quality',
    metricA: 'ammonia',
    domainB: 'mortality',
    metricB: 'daily_count',
    expectedDirection: 'positive',
    category: 'risk',
    mechanism:
      'Amonyak artışı solungaç hasarı yapar → gaz değişimi bozulur → mortalite artar. ' +
      'Akut toksisite 24 saat içinde mortaliteye yol açar.',
    typicalLagHours: 24,
    strength: 'strong',
    referenceNote:
      'Randall & Tsui (2002): Acute NH₃ toxicity causes gill damage and mortality within 24h.',
  },

  // ─── 15. Besleme Miktarı → Amonyak ─────────────────────────────────────
  {
    id: 'COR-015',
    domainA: 'feeding',
    metricA: 'daily_amount',
    domainB: 'water_quality',
    metricB: 'ammonia',
    expectedDirection: 'positive',
    category: 'risk',
    mechanism:
      'Fazla yem → protein metabolizması → NH₃ üretimi artar. ' +
      'Yenmemiş yem çürümesi ek amonyak yükü oluşturur.',
    typicalLagHours: 12,
    strength: 'strong',
    referenceNote:
      'Timmons & Ebeling (2013): Each kg feed produces ~30g TAN via protein catabolism.',
  },

  // ─── 16. DO ↔ Yem Tüketimi ─────────────────────────────────────────────
  {
    id: 'COR-016',
    domainA: 'water_quality',
    metricA: 'dissolvedOxygen',
    domainB: 'feeding',
    metricB: 'daily_amount',
    expectedDirection: 'positive',
    category: 'optimization',
    mechanism:
      'Düşük DO → iştah kaybı → yem tüketimi azalır. ' +
      'Yeterli DO → metabolizma optimal → iştah artar.',
    typicalLagHours: 6,
    strength: 'moderate',
    referenceNote:
      'Brett & Groves (1979): DO below 50% saturation reduces voluntary feed intake by 20-40%.',
  },

  // ─── 17. Sıcaklık → Büyüme (Ağırlık) ──────────────────────────────────
  {
    id: 'COR-017',
    domainA: 'water_quality',
    metricA: 'temperature',
    domainB: 'growth',
    metricB: 'weight',
    expectedDirection: 'positive',
    category: 'optimization',
    mechanism:
      'Optimal sıcaklık aralığında metabolizma hızlanır → büyüme artışı. ' +
      'Optimal üstünde ise ters etki başlar.',
    typicalLagHours: 48,
    strength: 'strong',
    referenceNote:
      'Jobling (1994): Temperature is the master factor controlling growth in ectotherms.',
  },

  // ─── 18. Yem Miktarı → Büyüme (Ağırlık) ───────────────────────────────
  {
    id: 'COR-018',
    domainA: 'feeding',
    metricA: 'daily_amount',
    domainB: 'growth',
    metricB: 'weight',
    expectedDirection: 'positive',
    category: 'optimization',
    mechanism:
      'Yem miktarı artışı → büyüme artışı (FCR oranında). ' +
      'Aşırı beslemede ise FCR bozulur ve WQ etkilenir.',
    typicalLagHours: 48,
    strength: 'strong',
    referenceNote:
      'Cho & Bureau (2001): Feed intake is the primary driver of growth in aquaculture.',
  },

  // ─── 19. Amonyak → Nitrit (Nitrifikasyon Zinciri) ──────────────────────
  {
    id: 'COR-019',
    domainA: 'water_quality',
    metricA: 'ammonia',
    domainB: 'water_quality',
    metricB: 'nitrite',
    expectedDirection: 'positive',
    category: 'risk',
    mechanism:
      'NH₃ yükseldiğinde nitrifikasyon zincirinde NO₂ de artar. ' +
      'Biofiltre kapasitesi aşılırsa her iki bileşen birikir.',
    typicalLagHours: 6,
    strength: 'moderate',
    referenceNote:
      'Timmons & Ebeling (2013): Nitrite accumulation follows ammonia spikes by 4-8 hours.',
  },

  // ─── 20. Hava Sıcaklığı → Su Sıcaklığı ────────────────────────────────
  {
    id: 'COR-020',
    domainA: 'weather',
    metricA: 'temperature',
    domainB: 'water_quality',
    metricB: 'temperature',
    expectedDirection: 'positive',
    category: 'risk',
    mechanism:
      'Hava sıcaklığı su sıcaklığını doğrudan etkiler. ' +
      'Açık sistemlerde etki 4-8 saat içinde gözlenir.',
    typicalLagHours: 6,
    strength: 'strong',
    referenceNote:
      'Boyd (2015): Air temperature is the primary driver of water temperature in open systems.',
  },
];

// ─── Yardımcı Fonksiyonlar ───────────────────────────────────────────────────

/**
 * Belirli bir domain'e ait tüm korelasyonları döndürür.
 *
 * NASIL ÇALIŞIR:
 *   1. KNOWN_CORRELATIONS dizisini filtreler
 *   2. domainA VEYA domainB verilen domain ile eşleşen tüm korelasyonları döndürür
 *   3. Yani bir domain hem "etkileyen" hem "etkilenen" tarafta olabilir
 *
 * Kullanım senaryosu:
 *   - 'water_quality' anomalisi tespit edildiğinde, ilişkili TÜM diğer domain'leri
 *     kontrol etmek için bu fonksiyon kullanılır.
 *
 * @param domain - Aranacak domain adı (ör: 'feeding', 'water_quality', 'growth')
 * @returns Eşleşen korelasyonlar dizisi (boş olabilir)
 */
export function findCorrelationsForDomain(domain: string): KnownCorrelation[] {
  return KNOWN_CORRELATIONS.filter(
    (c) => c.domainA === domain || c.domainB === domain,
  );
}

/**
 * İki domain arasındaki korelasyonu bulur.
 *
 * NASIL ÇALIŞIR:
 *   1. domainA → domainB yönünde arar
 *   2. Bulamazsa domainB → domainA yönünde arar (çift yönlü arama)
 *   3. İlk eşleşmeyi döndürür, yoksa undefined
 *
 * NOT: Aynı iki domain arasında birden fazla korelasyon olabilir
 * (farklı metrikler üzerinden). Bu fonksiyon İLK eşleşmeyi döndürür.
 * Tüm eşleşmeler için findCorrelationsForDomain() kullanılabilir.
 *
 * @param domainA - İlk domain
 * @param domainB - İkinci domain
 * @returns Bulunan korelasyon veya undefined
 */
export function findCorrelationBetween(
  domainA: string,
  domainB: string,
): KnownCorrelation | undefined {
  return KNOWN_CORRELATIONS.find(
    (c) =>
      (c.domainA === domainA && c.domainB === domainB) ||
      (c.domainA === domainB && c.domainB === domainA),
  );
}

/**
 * Tüm risk kategorisindeki korelasyonları döndürür.
 *
 * Risk korelasyonları: olumsuz sonuçlara yol açan ilişkiler.
 * Anomali tespitinde öncelikli olarak kontrol edilir.
 *
 * @returns Risk kategorisindeki korelasyonlar dizisi
 */
export function getRiskCorrelations(): KnownCorrelation[] {
  return KNOWN_CORRELATIONS.filter((c) => c.category === 'risk');
}

/**
 * Tüm optimizasyon kategorisindeki korelasyonları döndürür.
 *
 * Optimizasyon korelasyonları: iyileştirme fırsatı sunan ilişkiler.
 * Öneri motorunda kullanılır.
 *
 * @returns Optimizasyon kategorisindeki korelasyonlar dizisi
 */
export function getOptimizationCorrelations(): KnownCorrelation[] {
  return KNOWN_CORRELATIONS.filter((c) => c.category === 'optimization');
}
