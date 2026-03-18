// ─── Kötü Döngü Kalıpları (Vicious Cycles) ──────────────────────────────────
//
// NASIL ÇALIŞIR:
//   1. Kötü döngü (vicious cycle), birbirini BESLEYEN olumsuz geri bildirim döngüsüdür.
//      Kaskad zincirlerinden (cascade) farklı olarak, burada etkiler doğrusaldır ve
//      bir son noktası vardır. Kötü döngülerde ise etkiler daireseldir:
//        A kötüleşir → B kötüleşir → A DAHA DA kötüleşir → B DAHA DA kötüleşir → ...
//   2. Her döngü 3 aşamadan geçer:
//      - early: Döngü yeni başlıyor, müdahale penceresi geniş (~24 saat)
//      - active: Döngü hızlanıyor, müdahale penceresi daralıyor (~6 saat)
//      - critical: Döngü kontrolden çıkmış, acil müdahale gerekli
//   3. Döngüyü "kırmak" (break) için döngüdeki en zayıf halkaya müdahale edilir.
//      Her döngünün suggestedBreak alanında kırma stratejileri listelenir.
//   4. Tespit mekanizması: belirli koşulların (conditions) aynı anda mevcut olup
//      olmadığı kontrol edilir. Koşullar sırasıyla aktifleştikçe aşama (stage) ilerler.
//
// Neden Önemli:
//   - Kaskad zincirleri "doğrusal" tahmin yapar (A→B→C→D)
//   - Kötü döngüler "üstel" kötüleşme yapar (her tur daha hızlı)
//   - Erken müdahale çok daha etkilidir çünkü her tur sorunu katlar
//   - "Bekle ve gör" yaklaşımı kötü döngülerde ÇOK TEHLİKELİDİR
//
// Bilimsel Kaynaklar:
//   - Wedemeyer (1996). "Physiology of Fish in Intensive Culture Systems" — Ch. 9
//   - Barton (2002). "Stress in fishes: a diversity of responses" — Reviews in Fish Biology
//   - Boyd (2015). "Water Quality: An Introduction" — Ch. 7, 8, 11
//
// EXTENSIBLE: Yeni döngü eklemek için VICIOUS_CYCLES dizisine yeni eleman ekleyin.
//   Her döngünün benzersiz bir id'si olmalıdır.
//   conditions dizisindeki metric adları sensör verileriyle eşleşmelidir.
// ──────────────────────────────────────────────────────────────────────────────

// ─── Tip Tanımları ───────────────────────────────────────────────────────────

/**
 * Kötü döngünün tetiklenmesi için gerekli bir koşul.
 *
 * metric: Kontrol edilecek metrik veya anomali tipi.
 *   Sensör verisi veya hesaplanmış metrik adı (ör: 'ammonia', 'feeding_variance', 'sgr')
 *
 * check: Eşik kontrol yönü:
 *   'above' → metrik normalin ÜSTÜNDEyse koşul sağlanır (ör: amonyak yüksek)
 *   'below' → metrik normalin ALTINDAysa koşul sağlanır (ör: SGR düşük)
 *   'present' → metrik/anomali MEVCUTsa koşul sağlanır (ör: hastalık belirtisi var)
 *
 * description: İnsan-okunur Türkçe açıklama — döngü raporlarında gösterilir
 */
export interface ViciousCycleCondition {
  metric: string;
  check: 'above' | 'below' | 'present';
  description: string;
}

/**
 * Kötü döngünün bir aşaması.
 *
 * stage: Döngünün şiddeti/aşaması:
 *   'early' → Döngü yeni başlıyor — koşulların bir kısmı mevcut
 *   'active' → Döngü hızlanıyor — koşulların çoğu mevcut
 *   'critical' → Döngü kontrolden çıkmış — tüm koşullar mevcut
 *
 * conditions: Bu aşamada mevcut olması gereken koşulların metric adları.
 *   ViciousCycleCondition.metric ile eşleştirilir.
 *   Bir aşamanın aktif sayılması için listelenen TÜM koşulların mevcut olması gerekir.
 *
 * interventionWindow: Bu aşamada kalan tahmini müdahale süresi.
 *   early: ~24 saat → rahatlıkla müdahale edilebilir
 *   active: ~6 saat → hızlı müdahale gerekli
 *   critical: acil/0 → her dakika önemli
 *
 * description: İnsan-okunur Türkçe açıklama
 */
export interface ViciousCycleStage {
  stage: 'early' | 'active' | 'critical';
  conditions: string[];
  interventionWindow: string;
  suggestedBreak: string;
  description: string;
}

/**
 * Bir kötü döngü (vicious cycle) tanımı.
 *
 * id: Benzersiz tanımlayıcı
 * name: Türkçe döngü adı — kullanıcıya gösterilir
 * description: Detaylı Türkçe açıklama — döngünün mekanizması
 * conditions: Döngünün tüm koşulları (hangi metriklerin kontrol edileceği)
 * stages: Döngünün 3 aşaması (early, active, critical)
 * suggestedBreak: Döngüyü kırmak için önerilen müdahaleler (Türkçe)
 * affectedDomains: Bu döngünün etkilediği domain'ler
 */
export interface ViciousCycle {
  id: string;
  name: string;
  description: string;
  conditions: ViciousCycleCondition[];
  stages: ViciousCycleStage[];
  suggestedBreak: string[];
  affectedDomains: string[];
}

// ─── 3 Bilinen Kötü Döngü ──────────────────────────────────────────────────
//
// 1. feed-wq-spiral: Besleme ↔ Su Kalitesi Spirali
//    Aşırı/düzensiz besleme → WQ bozulması → iştah kaybı → yemleme varyansı↑
//    → daha da düzensiz besleme → WQ DAHA DA kötüleşir → ...
//
// 2. density-stress-spiral: Yoğunluk ↔ Stres Spirali
//    Yüksek yoğunluk → büyüme yavaşlar → hasat gecikmesi → yoğunluk DAHA DA artar
//    → stres DAHA DA artar → büyüme DAHA DA yavaşlar → ...
//
// 3. temperature-oxygen-crisis: Sıcaklık ↔ Oksijen Krizi
//    Sıcaklık↑ → DO↓ (çözünürlük) + O₂ talebi↑ (metabolizma) → hipoksi
//    → metabolik stres → ısı toleransı↓ → daha düşük sıcaklıkta bile stres → ...
// ──────────────────────────────────────────────────────────────────────────────

export const VICIOUS_CYCLES: ViciousCycle[] = [

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. BESLEME ↔ SU KALİTESİ SPİRALİ (Feed-WQ Spiral)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // NASIL ÇALIŞIR (Döngü Mekanizması):
  //
  //   ┌─ Aşırı/düzensiz besleme ──────────┐
  //   │                                     │
  //   │   → Yenmemiş yem çürür              │
  //   │   → NH₃ üretimi artar               │
  //   │   → Su kalitesi bozulur             │
  //   │                                     │
  //   │   → Balıklar strese girer           │
  //   │   → İştah kaybı                     │
  //   │   → Yemleme davranışı değişir       │
  //   │   → Bazıları yiyor, bazıları yemiyor│
  //   │                                     │
  //   │   → Yemleme varyansı artar          │
  //   │   → Otomatik yemleme kalibrasyonu   │
  //   │     bozulur (talep belirsiz)        │
  //   │                                     │
  //   └───────────── ↑ ─────────────────────┘
  //         Döngü tekrarlanır!
  //
  //   Her turda:
  //     - NH₃ biraz daha yükselir (birikim)
  //     - İştah biraz daha düşer
  //     - Büyüme biraz daha yavaşlar
  //     - FCR biraz daha kötüleşir
  //   → Üstel bozulma!
  //
  //   Kırılma noktası: Beslemeyi kontrol altına al + su değişimi yap.
  //   En zayıf halka: BESLEME (doğrudan kontrol edilebilir).
  {
    id: 'feed-wq-spiral',
    name: 'Besleme–Su Kalitesi Spirali',
    description:
      'Düzensiz veya aşırı besleme → NH₃ artışı → su kalitesi bozulması → iştah kaybı → ' +
      'yemleme varyansı artışı → daha da düzensiz besleme → NH₃ DAHA DA artar → ... ' +
      'Bu döngü her turda katlanarak kötüleşir. Otomatik yemleme sistemleri bu döngüye ' +
      'özellikle duyarlıdır çünkü talep bazlı algoritma değişen iştahı "normal" olarak öğrenebilir. ' +
      'Döngü 2-3 gün içinde büyüme performansını ciddi şekilde bozar.',
    conditions: [
      {
        metric: 'feeding_variance',
        check: 'above',
        description:
          'Yemleme varyansı yüksek — günlük yem alımında normalin üstünde dalgalanma var. ' +
          'CV (varyasyon katsayısı) > %25 veya günler arası fark > %30.',
      },
      {
        metric: 'ammonia',
        check: 'above',
        description:
          'Amonyak (NH₃/TAN) yükseliyor — tür eşiğinin warning seviyesinin üzerinde. ' +
          'Trend yukarı yönlü (son 24 saatte artış).',
      },
      {
        metric: 'appetite',
        check: 'below',
        description:
          'İştah düşüyor — yem alımı beklenen miktarın %70\'inin altında. ' +
          'Talep bazlı yemleme sistemlerinde response time uzuyor.',
      },
      {
        metric: 'sgr',
        check: 'below',
        description:
          'Büyüme oranı (SGR) düşüyor — hedef SGR\'nin %70\'inin altında. ' +
          'Son 7 günlük ortalama önceki döneme göre belirgin düşük.',
      },
    ],
    stages: [
      // ─── Erken Aşama (Early) ─────────────────────────────────────────
      // Döngü yeni başlıyor: yemleme varyansı yüksek + amonyak yükseliyor
      // Henüz iştah ve büyüme belirgin etkilenmemiş
      // Müdahale penceresi: ~24 saat — rahatlıkla düzeltilebilir
      {
        stage: 'early',
        conditions: ['feeding_variance', 'ammonia'],
        interventionWindow: '~24 saat',
        suggestedBreak:
          'Beslemeyi %50 azalt — döngünün yakıtını (yenmemiş yem + protein metabolizması) kes. ' +
          'Bu ANINDA uygulanabilir ve etkisi 4-6 saat içinde görülür.',
        description:
          'Döngü yeni başlıyor: yemleme düzensizliği ve amonyak yükselişi tespit edildi. ' +
          'Henüz iştah kaybı ve büyüme düşüşü belirgin değil. ' +
          'Bu aşamada müdahale kolaydır — besleme düzenlemesi ve kısmi su değişimi yeterli. ' +
          'Geniş müdahale penceresi (~24 saat) var.',
      },
      // ─── Aktif Aşama (Active) ────────────────────────────────────────
      // Döngü hızlanıyor: yemleme varyansı + amonyak + iştah kaybı
      // Büyüme henüz ciddi etkilenmemiş ama trend negatif
      // Müdahale penceresi: ~6 saat — hızlı müdahale gerekli
      {
        stage: 'active',
        conditions: ['feeding_variance', 'ammonia', 'appetite'],
        interventionWindow: '~6 saat',
        suggestedBreak:
          '%30-50 su değişimi yap — birikmiş NH₃\'ü seyrelt. ' +
          'RAS\'ta bypass modu veya taze su girişi aç. ' +
          'Otomatik yemleme kalibrasyonunu sıfırla ve manuel moda geç.',
        description:
          'Döngü aktif: yemleme düzensizliği + amonyak yüksek + iştah kaybı başladı. ' +
          'Balıklar stres altında ve yem alımı düşüyor. Bu aşamada döngü kendi kendini ' +
          'besliyor — yenmemiş yem daha fazla NH₃ üretiyor, NH₃ iştahı daha da bastırıyor. ' +
          'Hızlı müdahale gerekli (~6 saat).',
      },
      // ─── Kritik Aşama (Critical) ────────────────────────────────────
      // Döngü kontrolden çıkmış: tüm koşullar mevcut
      // Büyüme ciddi şekilde etkilenmiş, mortalite riski var
      // ACİL müdahale gerekli
      {
        stage: 'critical',
        conditions: ['feeding_variance', 'ammonia', 'appetite', 'sgr'],
        interventionWindow: 'ACİL — her saat önemli',
        suggestedBreak:
          'ACİL müdahale: besleme %50 azaltma + %30-50 su değişimi. ' +
          'Biofiltre durumunu kontrol et — pH, DO, medya tıkanması. ' +
          'Gerekirse ek nitrifikasyon bakteri kültürü ekle.',
        description:
          'Döngü kontrolden çıkmış: tüm göstergeler kötü yönde. ' +
          'Yemleme düzensiz, amonyak yüksek, iştah düşük, büyüme durmuş. ' +
          'Mortalite riski artıyor. Her geçen saat döngüyü kırmak zorlaşıyor. ' +
          'ACİL müdahale: besleme %50 azaltma + %30-50 su değişimi.',
      },
    ],
    suggestedBreak: [
      // Döngünün en zayıf halkası BESLEMEdir çünkü doğrudan kontrol edilebilir.
      // Su kalitesi ve iştah dolaylı parametrelerdir — kontrol etmek daha zordur.
      'Beslemeyi %50 azalt — döngünün yakıtını (yenmemiş yem + protein metabolizması) kes. ' +
      'Bu ANINDA uygulanabilir ve etkisi 4-6 saat içinde görülür.',

      '%30-50 su değişimi yap — birikmiş NH₃\'ü seyrelt. ' +
      'RAS\'ta bypass modu veya taze su girişi aç. ' +
      'Havuz/kafes sistemlerinde mümkünse su sirkülasyonunu artır.',

      'Otomatik yemleme kalibrasyonunu sıfırla ve manuel moda geç. ' +
      'Talep bazlı algoritma bozulmuş iştah verisini "normal" olarak öğrenmiş olabilir. ' +
      '3-5 gün manuel besleme ile iştah normalleşene kadar devam et.',

      'Biofiltre durumunu kontrol et — pH, DO, medya tıkanması. ' +
      'Gerekirse ek nitrifikasyon bakteri kültürü ekle.',
    ],
    affectedDomains: ['feeding', 'water_quality', 'growth'],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. YOĞUNLUK ↔ STRES SPİRALİ (Density-Stress Spiral)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // NASIL ÇALIŞIR (Döngü Mekanizması):
  //
  //   ┌─ Yoğunluk > %85 maxDensity ───────┐
  //   │                                     │
  //   │   → Sosyal stres artar              │
  //   │   → Kortizol yükselir               │
  //   │   → İştah baskılanır                │
  //   │                                     │
  //   │   → Büyüme yavaşlar                 │
  //   │   → FCR kötüleşir                   │
  //   │   → Hedef ağırlığa ulaşım gecikir   │
  //   │                                     │
  //   │   → Hasat tarihi ertelenir           │
  //   │   → Balıklar tankta daha uzun kalır  │
  //   │   → Balıklar büyümeye devam eder     │
  //   │     (yavaş da olsa)                 │
  //   │   → Biyokütle = sayı × ağırlık ↑   │
  //   │                                     │
  //   └── → Yoğunluk DAHA DA artar! ────────┘
  //         Döngü tekrarlanır!
  //
  //   Bu döngü özellikle sinsidir çünkü:
  //     - Günlük değişim küçüktür (fark edilmez)
  //     - Haftalık trendde belirginleşir
  //     - Hasat kararı ekonomik baskılarla ertelenir ("biraz daha büyüsün")
  //     - Ama bekleme süresi uzadıkça ROI kötüleşir (FCR↑ + büyüme↓)
  //
  //   Kırılma noktası: Tank bölme (split) veya erken hasat.
  //   En zayıf halka: YOĞUNLUK (fiziksel olarak azaltılabilir).
  {
    id: 'density-stress-spiral',
    name: 'Yoğunluk–Stres Spirali',
    description:
      'Yoğunluk > %85 maxDensity → sosyal stres↑ → büyüme↓ → FCR↑ → ' +
      'hasat gecikmesi → balıklar tankta daha uzun kalır → biyokütle artar → ' +
      'yoğunluk DAHA DA artar → stres DAHA DA artar → ... ' +
      'Bu döngü "bekle ve gör" yaklaşımının en zararlı olduğu senaryodur çünkü ' +
      'bekledikçe sorun katlanır. Ekonomik kayıp her hafta büyür: yem maliyeti aynı ama ' +
      'büyüme karşılığı düşer.',
    conditions: [
      {
        metric: 'stocking_density',
        check: 'above',
        description:
          'Stocking yoğunluğu türün maxDensity eşiğinin %85\'inin üzerinde. ' +
          'Biyokütle = (hayatta kalan birey sayısı) × (ortalama canlı ağırlık). ' +
          'Büyüme devam ettikçe bu değer otomatik olarak artar.',
      },
      {
        metric: 'sgr',
        check: 'below',
        description:
          'Büyüme oranı (SGR) yavaşlıyor — hedef SGR\'nin %80\'inin altına düştü. ' +
          'Stres kaynaklı büyüme inhibisyonu başlamış.',
      },
      {
        metric: 'fcr',
        check: 'above',
        description:
          'Yem dönüşüm oranı (FCR) kötüleşiyor — hedef FCR\'nin %120\'sinin üzerinde. ' +
          'Aynı yem ile daha az büyüme elde ediliyor → ekonomik verimlilik düşüyor.',
      },
      {
        metric: 'aggression',
        check: 'present',
        description:
          'Agresyon/fiziksel hasar belirtileri mevcut — yüzgeç erozyonu, göz yaralanması, ' +
          'deri lezyonları gözleniyor. Dominans hiyerarşisi sertleşmiş.',
      },
    ],
    stages: [
      // ─── Erken Aşama (Early) ─────────────────────────────────────────
      // Yoğunluk yüksek + büyüme yavaşlıyor
      // Henüz FCR ciddi bozulmamış, agresyon belirtisi yok
      // Müdahale penceresi: ~1 hafta — planlı split/hasat yapılabilir
      {
        stage: 'early',
        conditions: ['stocking_density', 'sgr'],
        interventionWindow: '~1 hafta',
        suggestedBreak:
          'Tank bölme (split/grading): Balıkları boyuta göre ayır ve farklı tanklara dağıt. ' +
          'Her tankta yoğunluk optimalDensity\'nin altına düşmeli.',
        description:
          'Döngü erken aşamada: yoğunluk eşik üstünde ve büyüme yavaşlamaya başladı. ' +
          'FCR henüz ciddi bozulmamış. Planlı grading + split veya kısmi hasat için ' +
          'yeterli zaman var (~1 hafta). Bu aşamada müdahale en verimlidir.',
      },
      // ─── Aktif Aşama (Active) ────────────────────────────────────────
      // Yoğunluk + büyüme + FCR — üçü birden kötü
      // Ekonomik kayıp başlamış (yem maliyeti > büyüme karşılığı)
      // Müdahale penceresi: ~3 gün — acil split/hasat planlanmalı
      {
        stage: 'active',
        conditions: ['stocking_density', 'sgr', 'fcr'],
        interventionWindow: '~3 gün',
        suggestedBreak:
          'Kısmi hasat (partial harvest): Pazar boyutuna ulaşmış bireyleri hasatla çıkar. ' +
          'Yemleme stratejisini değiştir: daha sık, daha küçük porsiyonlar + ' +
          'birden fazla yemleme noktası → yem rekabetini azalt.',
        description:
          'Döngü aktif: yoğunluk yüksek, büyüme yavaş, FCR kötüleşiyor. ' +
          'Ekonomik kayıp her gün büyüyor — yem harcanıyor ama karşılığı alınamıyor. ' +
          'Acil split veya kısmi hasat planlanmalı (~3 gün). ' +
          'Bu aşamada her gün erteleme ~%2-3 ek FCR bozulması demektir.',
      },
      // ─── Kritik Aşama (Critical) ────────────────────────────────────
      // Tüm koşullar mevcut: yoğunluk + büyüme + FCR + agresyon
      // Sağlık sorunları başlamış, mortalite riski yüksek
      // ACİL müdahale — en geç 24 saat içinde split veya hasat
      {
        stage: 'critical',
        conditions: ['stocking_density', 'sgr', 'fcr', 'aggression'],
        interventionWindow: 'ACİL — en geç 24 saat',
        suggestedBreak:
          'ACİL split veya hasat yapılmalı. WQ yönetimini sıkılaştır: havalandırma artır + ' +
          'su değişimi artır. Yüksek yoğunlukta WQ toleransı çok dar.',
        description:
          'Döngü kritik: tüm göstergeler kötü + fiziksel hasar belirtileri var. ' +
          'Yüzgeç hasarı sekonder enfeksiyon riski taşır. Mortalite artabilir. ' +
          'ACİL split veya hasat yapılmalı. Her ek gün kalıcı hasar riski taşır.',
      },
    ],
    suggestedBreak: [
      // En zayıf halka: YOĞUNLUK — fiziksel olarak azaltılabilir.
      'Tank bölme (split/grading): Balıkları boyuta göre ayır ve farklı tanklara dağıt. ' +
      'Her tankta yoğunluk optimalDensity\'nin altına düşmeli. ' +
      'Büyük bireyleri ayrı tanka taşı (daha az rekabet, daha iyi büyüme).',

      'Kısmi hasat (partial harvest): Pazar boyutuna ulaşmış bireyleri hasatla çıkar. ' +
      'Bu hem yoğunluğu azaltır hem nakit akışı sağlar. ' +
      '"Biraz daha büyüsün" beklentisi bu döngüde ZARARLDIR — hemen hasat et.',

      'Yemleme stratejisini değiştir: daha sık, daha küçük porsiyonlar + ' +
      'birden fazla yemleme noktası → yem rekabetini azalt. ' +
      'Subordinate bireyler de beslenirse büyüme homojenliği artar.',

      'WQ yönetimini sıkılaştır: havalandırma artır + su değişimi artır + ' +
      'biofiltre kapasitesini kontrol et. Yüksek yoğunlukta WQ toleransı çok dar.',
    ],
    affectedDomains: ['stocking', 'growth', 'health', 'feeding'],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. SICAKLIK ↔ OKSİJEN KRİZİ (Temperature-Oxygen Crisis)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // NASIL ÇALIŞIR (Döngü Mekanizması):
  //
  //   ┌─ Sıcaklık yükseliyor ─────────────┐
  //   │                                     │
  //   │   → O₂ çözünürlüğü düşer           │
  //   │     (Henry Yasası: sıcak su =       │
  //   │      daha az O₂ tutabilir)          │
  //   │                                     │
  //   │   → Metabolik O₂ talebi artar       │
  //   │     (Q10 kuralı: sıcak = hızlı      │
  //   │      metabolizma = daha fazla O₂)   │
  //   │                                     │
  //   │   → Arz↓ + Talep↑ = Hipoksi        │
  //   │                                     │
  //   │   → Hipoksi → metabolik stres       │
  //   │   → Stres → ısı toleransı↓          │
  //   │     (zaten stres altındaki balık     │
  //   │      daha düşük sıcaklıkta bile     │
  //   │      termal stres gösterir)         │
  //   │                                     │
  //   │   → Daha düşük sıcaklıkta bile      │
  //   │     stres tepkisi → metabolizma↑    │
  //   │     → O₂ talebi↑                    │
  //   │                                     │
  //   └── → Oksijen açığı DAHA DA artar! ───┘
  //         Döngü tekrarlanır!
  //
  //   Bu döngü yaz aylarında EN TEHLİKELİDİR:
  //     - Gün uzun → daha fazla ısınma
  //     - Gece kısa → yetersiz soğuma
  //     - Alg patlaması → gece O₂ tüketimi↑ (gece respiration)
  //     - Bulutlu günler → alg ölümü → BOD artışı
  //
  //   Kırılma noktası: Oksijen arzını artır (aeratör) + metabolik talebi azalt (yem azalt)
  //   En zayıf halka: O₂ ARZI (mekanik olarak artırılabilir)
  {
    id: 'temperature-oxygen-crisis',
    name: 'Sıcaklık–Oksijen Krizi',
    description:
      'Sıcaklık↑ → DO çözünürlüğü↓ + metabolik O₂ talebi↑ → hipoksi → ' +
      'metabolik stres → ısı toleransı↓ → daha düşük sıcaklıkta bile stres → ' +
      'O₂ açığı DAHA DA büyür → ... ' +
      'Bu döngü "çifte darbe" (double whammy) olarak bilinir: arz düşerken talep artar. ' +
      'Yaz sıcak dalgalarında, özellikle gece soğumanın yetersiz olduğu dönemlerde ' +
      'bu döngü toplu ölümlere yol açabilir. Soğuk su türleri (somon, alabalık) en hassastır.',
    conditions: [
      {
        metric: 'temperature',
        check: 'above',
        description:
          'Su sıcaklığı türün optimal aralığının üzerinde. ' +
          'Trend yukarı yönlü veya optimal\'in 2+°C üstünde sabit.',
      },
      {
        metric: 'dissolved_oxygen',
        check: 'below',
        description:
          'Çözünmüş oksijen (DO) türün min eşiğine yaklaşıyor veya altında. ' +
          'Satürasyon oranı %60\'ın altına düştüyse endişe verici.',
      },
      {
        metric: 'metabolic_stress',
        check: 'present',
        description:
          'Metabolik stres belirtileri mevcut: artmış operkül frekansı (gasping), ' +
          'yüzeyde toplanma, iştah kaybı, letarjik yüzme. ' +
          'Balıklar oksijen aramak için aeratör çıkışlarına yaklaşıyor.',
      },
      {
        metric: 'mortality_increase',
        check: 'present',
        description:
          'Mortalite artışı gözleniyor — günlük ölüm sayısı normal seviyenin ' +
          '2x üzerine çıktı. Özellikle büyük bireyler ve zayıf bireyler etkileniyor.',
      },
    ],
    stages: [
      // ─── Erken Aşama (Early) ─────────────────────────────────────────
      // Sıcaklık yüksek + DO düşüyor
      // Henüz stres belirtileri ve mortalite yok
      // Müdahale penceresi: ~12-24 saat — havalandırma artırılabilir
      {
        stage: 'early',
        conditions: ['temperature', 'dissolved_oxygen'],
        interventionWindow: '~12-24 saat',
        suggestedBreak:
          'Havalandırmayı MAKSIMUMA çıkar: tüm yedek aeratörleri devreye al. ' +
          'Yemi tamamen kes (en az 12-24 saat) — SDA O₂ tüketimini %15-25 azaltır.',
        description:
          'Döngü erken aşamada: sıcaklık optimal üstünde ve DO düşmeye başladı. ' +
          'Henüz balıklarda belirgin stres belirtisi yok. ' +
          'Bu aşamada havalandırma artışı ve yem azaltma ile döngü kolayca kırılır. ' +
          'Geniş müdahale penceresi (~12-24 saat) var.',
      },
      // ─── Aktif Aşama (Active) ────────────────────────────────────────
      // Sıcaklık + DO + metabolik stres — üçü birden mevcut
      // Balıklar stres gösteriyor ama henüz mortalite başlamamış
      // Müdahale penceresi: ~4-6 saat — ACİL havalandırma
      {
        stage: 'active',
        conditions: ['temperature', 'dissolved_oxygen', 'metabolic_stress'],
        interventionWindow: '~4-6 saat',
        suggestedBreak:
          'ACİL havalandırma artışı + yem kesme. Soğutma uygula (mümkünse): ' +
          'taze soğuk su girişi, gölgeleme. Her 1°C düşüş → O₂ çözünürlüğü %2-3 artar.',
        description:
          'Döngü aktif: sıcaklık yüksek, DO düşük, balıklar stres belirtisi gösteriyor. ' +
          'Gasping (yüzeyde nefes alma) ve aeratör çıkışlarına toplanma gözleniyor. ' +
          'Mortalite henüz başlamamış ama çok yakın. ' +
          'ACİL havalandırma artışı + yem kesme gerekli (~4-6 saat).',
      },
      // ─── Kritik Aşama (Critical) ────────────────────────────────────
      // Tüm koşullar mevcut: sıcaklık + DO + stres + mortalite
      // Toplu ölüm başlamış
      // ACİL müdahale — dakikalar önemli
      {
        stage: 'critical',
        conditions: ['temperature', 'dissolved_oxygen', 'metabolic_stress', 'mortality_increase'],
        interventionWindow: 'ACİL — dakikalar önemli',
        suggestedBreak:
          'Tüm mevcut havalandırma kapasitesini devreye al + acil oksijen tüpü + ' +
          'soğuk su girişi + yemi tamamen kes. Gerekirse acil hasat düşün. ' +
          'Gece izleme yap — en kritik saatler gece yarısı-şafak arası.',
        description:
          'Döngü kritik: tüm göstergeler alarm veriyor ve mortalite başlamış. ' +
          'Her dakika geçtikçe kayıplar artıyor. ACİL müdahale: ' +
          'tüm mevcut havalandırma kapasitesini devreye al + acil oksijen tüpü + ' +
          'soğuk su girişi + yemi tamamen kes. Gerekirse acil hasat düşün.',
      },
    ],
    suggestedBreak: [
      // En zayıf halka: O₂ ARZI — mekanik olarak artırılabilir.
      // Sıcaklığı düşürmek genelde daha zordur (büyük su hacmi).
      'Havalandırmayı MAKSIMUMA çıkar: tüm yedek aeratörleri devreye al. ' +
      'Oksijen enjeksiyonu varsa başlat (LOX/PSA). Splash aeratörler çalıştır. ' +
      'O₂ transferi sıcak suda daha az verimlidir — ekstra kapasite gerekir.',

      'Yemi tamamen kes (en az 12-24 saat). Sindirim "spesifik dinamik aksiyon" (SDA) ' +
      'O₂ tüketiminin %15-25\'ini oluşturur. Yem kesilince metabolik O₂ talebi anında düşer.',

      'Soğutma uygula (mümkünse): taze soğuk su girişi, gölgeleme, chiller. ' +
      'Her 1°C düşüş → O₂ çözünürlüğü %2-3 artar + metabolik talep %7-10 düşer. ' +
      'Buz ekleme son çaredir (pH ve sıcaklık şoku riski).',

      'Gece izleme yap — en kritik saatler gece yarısı-şafak arası: ' +
      'fotosentez durur → alg O₂ ÜRETMİYOR ama TÜKETİYOR (respiration). ' +
      'Gece DO\'su gündüzden 2-4 mg/L düşük olabilir. Alarm eşiklerini ayarla.',
    ],
    affectedDomains: ['water_quality', 'health', 'mortality', 'feeding'],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. BİOFİLTRE ÇÖKÜŞ DÖNGÜSÜ (Biofilter Collapse Loop)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // NASIL ÇALIŞIR (Döngü Mekanizması):
  //
  //   ┌─ Biofiltre kapasitesi aşılır ──────────┐
  //   │                                         │
  //   │   → NH₃ ve NO₂ birlikte yükselir        │
  //   │   → Balıklar strese girer               │
  //   │   → Mortalite başlar                    │
  //   │                                         │
  //   │   → Ölen organik madde birikir          │
  //   │   → Organik yük biofiltre baskısını     │
  //   │     daha da artırır                     │
  //   │                                         │
  //   └── → Biofiltre DAHA DA yetersiz! ────────┘
  //         Döngü tekrarlanır!
  //
  //   Kırılma noktası: Beslemeyi durdur + acil su değişimi + yedek biofiltre
  //   En zayıf halka: ORGANİK YÜK (beslenme durdurularak azaltılabilir)
  {
    id: 'biofilter-collapse-loop',
    name: 'Biofiltre Çöküş Döngüsü',
    description:
      'Biofiltre kapasitesi aşılınca NH₃ ve NO₂ birlikte yükselir. Mortalite organik yükü artırır, ' +
      'bu da biofiltre üzerindeki baskıyı daha da artırır. RAS sistemlerinde özellikle tehlikelidir.',
    conditions: [
      {
        metric: 'ammonia',
        check: 'above',
        description:
          'Amonyak (NH₃/TAN) yükseliyor — biofiltre nitrifikasyon kapasitesi yetersiz. ' +
          'NH₃ birikiyor çünkü bakteri popülasyonu yükü karşılayamıyor.',
      },
      {
        metric: 'nitrite',
        check: 'above',
        description:
          'Nitrit (NO₂) yükseliyor — nitrifikasyonun ikinci aşaması da yetersiz. ' +
          'NH₃ + NO₂ birlikte yükselmesi biofiltre çöküşünün güçlü işareti.',
      },
      {
        metric: 'biofilter_status',
        check: 'present',
        description:
          'Biofiltre arızası/yetersizliği tespit edildi — medya tıkanması, pH düşüşü, ' +
          'akış hızı düşüşü veya bakteri ölümü belirtileri mevcut.',
      },
      {
        metric: 'mortality_increase',
        check: 'present',
        description:
          'Mortalite artışı gözleniyor — NH₃/NO₂ toksisitesine bağlı ölümler. ' +
          'Ölen organik madde biofiltre yükünü daha da artırıyor.',
      },
    ],
    stages: [
      {
        stage: 'early',
        conditions: ['ammonia', 'nitrite'],
        interventionWindow: '~24-48 saat',
        suggestedBreak:
          'Beslenmeyi tamamen durdur — organik yükün ana kaynağını kes. ' +
          'Biofiltre medya durumunu kontrol et — tıkanma varsa temizle.',
        description:
          'Döngü erken aşamada: NH₃ ve NO₂ birlikte yükseliyor. Henüz mortalite başlamamış. ' +
          'Biofiltre bakteri popülasyonu toparlanabilir. Yem azaltma + su değişimi yeterli.',
      },
      {
        stage: 'active',
        conditions: ['ammonia', 'nitrite', 'biofilter_status'],
        interventionWindow: '~12-24 saat',
        suggestedBreak:
          'Acil su değişimi (%40-50) — birikmiş NH₃ ve NO₂\'yi seyrelt. ' +
          'Yedek biofiltre devreye al veya ek nitrifikasyon bakteri kültürü ekle.',
        description:
          'Döngü aktif: NH₃ + NO₂ yüksek ve biofiltre yetersizliği doğrulandı. ' +
          'Kimyasal müdahale gerekebilir. Beslenmeyi durdur, yedek biofiltre devreye al.',
      },
      {
        stage: 'critical',
        conditions: ['ammonia', 'nitrite', 'biofilter_status', 'mortality_increase'],
        interventionWindow: 'ACİL — 6 saat',
        suggestedBreak:
          'Tam beslenme durdurma + masif su değişimi + kimyasal NH₃ bağlayıcı (zeolite) kullan. ' +
          'Acil balık transferi düşün. pH kontrolü yap — düşük pH nitrifikasyonu yavaşlatır.',
        description:
          'Döngü kritik: tüm göstergeler alarm veriyor ve mortalite başlamış. ' +
          'Tam beslenme durdurma + masif su değişimi + kimyasal NH₃ bağlayıcı kullan. ' +
          'Acil balık transferi düşün.',
      },
    ],
    suggestedBreak: [
      'Beslenmeyi tamamen durdur — organik yükün ana kaynağını kes. ' +
      'Protein metabolizmasından gelen NH₃ üretimini anında azaltır.',

      'Acil su değişimi (%40-50) — birikmiş NH₃ ve NO₂\'yi seyrelt. ' +
      'RAS\'ta bypass modu açarak taze su girişini maksimuma çıkar.',

      'Yedek biofiltre devreye al veya ek nitrifikasyon bakteri kültürü ekle. ' +
      'Biofiltre medya durumunu kontrol et — tıkanma varsa temizle.',

      'Kimyasal amonyak bağlayıcı (zeolite, klinoptilolite) kullan — geçici çözüm. ' +
      'pH kontrolü yap — düşük pH nitrifikasyonu yavaşlatır.',
    ],
    affectedDomains: ['water_quality', 'biofilter', 'mortality'],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. BAKIM İHMALİ DÖNGÜSÜ (Maintenance Neglect Loop)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // NASIL ÇALIŞIR (Döngü Mekanizması):
  //
  //   ┌─ Bakım gecikir ────────────────────────┐
  //   │                                         │
  //   │   → Ekipman bozulmaya başlar            │
  //   │   → WQ kontrolü zayıflar               │
  //   │   → Su kalitesi bozulur                 │
  //   │                                         │
  //   │   → Balıklar strese girer               │
  //   │   → Mortalite artabilir                 │
  //   │                                         │
  //   │   → Acil müdahale gerekir               │
  //   │   → Personel acil işlere yönelir        │
  //   │   → Planlanan bakımlar daha da ertelenir│
  //   │                                         │
  //   └── → Bakım borcu DAHA DA büyür! ─────────┘
  //         Döngü tekrarlanır!
  //
  //   Kırılma noktası: Bakım takvimini yakalayın, gerekirse dış destek alın
  //   En zayıf halka: BAKIM TAKVİMİ (organizasyonel karar)
  {
    id: 'maintenance-neglect-loop',
    name: 'Bakım İhmali Döngüsü',
    description:
      'Geciken bakımlar ekipman arızalarına, ekipman arızaları WQ kontrolü kaybına, ' +
      'WQ kaybı stres ve mortaliteye yol açar. Acil müdahaleler planlanan bakımları ' +
      'daha da erteler — döngü güçlenir.',
    conditions: [
      {
        metric: 'maintenance_overdue',
        check: 'present',
        description:
          'Geciken bakım görevi var — planlanan bakım tarihi geçmiş. ' +
          'Ekipman bakım takvimi gerisinde kalınmış.',
      },
      {
        metric: 'wq_degradation',
        check: 'present',
        description:
          'Su kalitesi genel bozulma — spesifik bir parametre değil, ' +
          'genel WQ skoru düşüyor veya birden fazla parametre normalin dışında.',
      },
      {
        metric: 'mortality_increase',
        check: 'present',
        description:
          'Mortalite artışı gözleniyor — WQ bozulmasına bağlı stres kaynaklı ölümler. ' +
          'Ekipman arızası → WQ kaybı → mortalite zinciri.',
      },
    ],
    stages: [
      {
        stage: 'early',
        conditions: ['maintenance_overdue'],
        interventionWindow: '~1-2 hafta',
        suggestedBreak:
          'Geciken bakımları önceliklendirin ve kritik olanları hemen tamamlayın. ' +
          'Bakım takvimini gözden geçirin ve gerçekçi bir plan yapın.',
        description:
          'Döngü erken aşamada: bakım gecikmeleri mevcut ama henüz WQ etkilenmemiş. ' +
          'Bakım takvimini yakalamak için yeterli süre var. Önceliklendirin ve bu hafta tamamlayın.',
      },
      {
        stage: 'active',
        conditions: ['maintenance_overdue', 'wq_degradation'],
        interventionWindow: '~3-7 gün',
        suggestedBreak:
          'Bakım ekibini genişletin veya dış destek (taşeron) alın. ' +
          'Kritik ekipman için yedek parça stoğu oluşturun.',
        description:
          'Döngü aktif: bakım gecikmeleri WQ\'yu etkilemeye başladı. ' +
          'Ekipman arızası riski artıyor. Bakım ekibini genişletin veya dış destek alın.',
      },
      {
        stage: 'critical',
        conditions: ['maintenance_overdue', 'wq_degradation', 'mortality_increase'],
        interventionWindow: '~1-3 gün',
        suggestedBreak:
          'Tüm diğer işleri askıya alın ve bakım/onarım odaklanın. ' +
          'Bakım bildirimi ve takip sistemini otomatikleştirin.',
        description:
          'Döngü kritik: bakım ihmali → WQ bozulması → mortalite zinciri oluşmuş. ' +
          'Tüm diğer işleri askıya alın ve bakım/onarım odaklanın. ' +
          'Ekipman arızası an meselesi.',
      },
    ],
    suggestedBreak: [
      'Geciken bakımları önceliklendirin ve kritik olanları hemen tamamlayın. ' +
      'Bakım takvimini gözden geçirin ve gerçekçi bir plan yapın.',

      'Bakım ekibini genişletin veya dış destek (taşeron) alın. ' +
      'Tek kişiye bağımlılığı ortadan kaldırın.',

      'Kritik ekipman için yedek parça stoğu oluşturun. ' +
      'Arıza anında bekleme süresini minimize edin.',

      'Bakım bildirimi ve takip sistemini otomatikleştirin. ' +
      'Gecikme uyarıları erkenden tetiklenmeli.',
    ],
    affectedDomains: ['maintenance', 'water_quality', 'mortality'],
  },
];

// ─── Yardımcı Fonksiyonlar ───────────────────────────────────────────────────

/**
 * Aktif koşullara göre bir kötü döngünün mevcut aşamasını tespit eder.
 *
 * NASIL ÇALIŞIR:
 *   1. Verilen cycleId ile döngüyü bulur
 *   2. Döngünün aşamalarını KRİTİKTEN ERKEN'e doğru kontrol eder (en kötü önce)
 *   3. Bir aşamanın TÜM koşulları activeConditions içinde mevcutsa → o aşama tespit edilir
 *   4. İlk eşleşen (en ciddi) aşamayı döndürür
 *   5. Hiçbir aşama eşleşmezse null döner (döngü aktif değil)
 *
 * Tespit mantığı:
 *   - critical aşamasının 4 koşulu da mevcutsa → critical
 *   - active aşamasının 3 koşulu mevcutsa → active
 *   - early aşamasının 2 koşulu mevcutsa → early
 *   - hiçbiri eşleşmezse → null (döngü yok)
 *
 * @param cycleId - Döngünün id'si (ör: 'feed-wq-spiral')
 * @param activeConditions - Şu anda aktif olan koşulların metric adları dizisi
 *                           (ör: ['feeding_variance', 'ammonia', 'appetite'])
 * @returns { cycle, stage } nesnesi veya null
 *
 * Kullanım örneği:
 *   const result = detectCycleStage('feed-wq-spiral', ['feeding_variance', 'ammonia', 'appetite']);
 *   if (result) {
 *     console.log(`${result.cycle.name}: ${result.stage.stage} aşamasında`);
 *     console.log(`Müdahale penceresi: ${result.stage.interventionWindow}`);
 *   }
 */
export function detectCycleStage(
  cycleId: string,
  activeConditions: string[],
): { cycle: ViciousCycle; stage: ViciousCycleStage } | null {
  const cycle = VICIOUS_CYCLES.find((c) => c.id === cycleId);
  if (!cycle) {
    return null;
  }

  // Aşamaları en ciddiden (critical) en hafife (early) doğru kontrol et.
  // Bu sıralama önemlidir: eğer tüm koşullar mevcutsa, critical döndürülmeli.
  // stages dizisi tanım sırasında early → active → critical şeklindedir,
  // bu yüzden TERS sırada döngüleriz.
  const stagesReversed = [...cycle.stages].reverse();

  for (const stage of stagesReversed) {
    // Bu aşamanın TÜM koşulları aktif mi?
    const allConditionsMet = stage.conditions.every((conditionMetric) =>
      activeConditions.includes(conditionMetric),
    );

    if (allConditionsMet) {
      return { cycle, stage };
    }
  }

  // Hiçbir aşama eşleşmedi → döngü aktif değil
  return null;
}

/**
 * Tüm tanımlı kötü döngüleri döndürür.
 *
 * Kullanım senaryoları:
 *   - Tüm döngüleri listelemek (dashboard görünümü)
 *   - Her döngü için activeConditions kontrolü yapmak (toplu tarama)
 *   - Döngü bilgilerini kullanıcıya sunmak
 *
 * @returns Tüm ViciousCycle nesnelerinin dizisi
 */
export function getAllCycles(): ViciousCycle[] {
  return VICIOUS_CYCLES;
}
