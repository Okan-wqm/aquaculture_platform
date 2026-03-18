// ─── Tür Bazlı Optimal Aralıklar ─────────────────────────────────────────────
//
// NASIL ÇALIŞIR:
//   1. Her su ürünü türünün yaşam koşulları farklıdır — sıcaklık, pH, çözünmüş oksijen,
//      amonyak toleransı, stocking yoğunluğu ve yem dönüşüm oranı (FCR) türe göre değişir.
//   2. Bu dosya, GraphQL'den species.optimalConditions verisi ALINAMADIĞINDA kullanılacak
//      varsayılan eşik değerlerini tanımlar. Yani bu bir "fallback" mekanizmasıdır.
//   3. Anomali tespiti şu mantıkla çalışır:
//        - Sensörden gelen ölçüm → DEFAULT_THRESHOLDS[tür] ile karşılaştırılır
//        - Ölçüm min-max aralığının DIŞINDAYSA → anomali tetiklenir
//        - criticalMin/criticalMax aşılırsa → ACİL seviye anomali tetiklenir
//   4. getThresholds() fonksiyonu tür adını normalize eder (lowercase, trim, space→underscore)
//      ve eşleşen tür bulamazsa güvenli "default" değerlerini döndürür.
//
// Bilimsel Kaynaklar:
//   - FAO Technical Paper No. 407: "Freshwater fish culture" (2000)
//   - FAO Fisheries Circular No. 815 Rev. 1: "Aquaculture species profiles"
//   - Boyd, C.E. (2015). "Water Quality: An Introduction" — Springer
//   - Timmons & Ebeling (2013). "Recirculating Aquaculture Systems" — 3rd Ed.
//   - species.entity.ts → OptimalConditions yapısı ile uyumlu alan adları
//
// EXTENSIBLE: Yeni tür eklemek için DEFAULT_THRESHOLDS map'ine yeni satır ekleyin.
//   Anahtar formatı: lowercase, boşluk yerine underscore (ör: 'european_eel').
//   Tüm alanlar zorunludur; salinity ve co2 opsiyoneldir (tatlı su türlerinde olmayabilir).
// ──────────────────────────────────────────────────────────────────────────────

// ─── Tip Tanımları ───────────────────────────────────────────────────────────

/**
 * Bir su ürünü türü için tüm kritik eşik değerlerini barındıran arayüz.
 *
 * Sıcaklık (temperature):
 *   - min/max: türün tolere edebileceği alt/üst sınır (°C)
 *   - optimal: en iyi büyüme performansı sağlanan sıcaklık (°C)
 *   - criticalMin/criticalMax: bu değerlerin altında/üstünde ACİL durum (°C)
 *     Bu eşikler aşıldığında balıklar kısa sürede ölebilir.
 *
 * pH:
 *   - min/max: türün tolere edebileceği pH aralığı
 *   - optimal: en iyi fizyolojik performans pH'ı
 *   Asidik sular (pH < 6) solungaçlarda mukus birikimine neden olur;
 *   bazik sular (pH > 9) amonyak toksisitesini artırır.
 *
 * Çözünmüş Oksijen (dissolvedOxygen) — mg/L:
 *   - min: türün hayatta kalabileceği minimum DO seviyesi
 *   - optimal: en iyi metabolik verim sağlanan DO seviyesi
 *   - critical: bu seviyenin altında balıklar yüzeye çıkarak nefes almaya çalışır (gasping)
 *
 * Amonyak (ammonia) — mg/L (UIA: Un-Ionized Ammonia, NH₃):
 *   - max: akut toksisite eşiği — bu değerin üstünde hızlı mortalite riski
 *   - warning: kronik stres eşiği — uzun süreli maruziyette büyüme yavaşlar
 *   NOT: Toplam amonyak azotu (TAN) değil, iyonize olmamış amonyak (UIA) değeridir.
 *   UIA = TAN × (pH ve sıcaklığa bağlı fraksiyon). pH↑ → UIA↑ (çok önemli!)
 *
 * Nitrit (nitrite) — mg/L:
 *   - max: akut toksisite — methemoglobin oluşumuna neden olur ("kahverengi kan hastalığı")
 *   - warning: kronik stres eşiği
 *
 * Nitrat (nitrate) — mg/L:
 *   - max: yüksek nitrat seviyeleri alg patlamasına ve kronik strese yol açar
 *   - warning: su değişimi veya denitrifikasyon gerektiğini gösteren eşik
 *
 * Tuzluluk (salinity) — ppt (parts per thousand), opsiyonel:
 *   - Tatlı su türleri için tanımlanmaz
 *   - Deniz türleri için kritik osmoregülasyon parametresi
 *
 * CO₂ (co2) — mg/L, opsiyonel:
 *   - Kapalı devre sistemlerde (RAS) özellikle önemli
 *   - Yüksek CO₂ kan pH'ını düşürür → oksijen taşıma kapasitesi azalır (Bohr etkisi)
 *
 * Yoğunluk (density) — kg/m³:
 *   - maxDensity: mutlak üst sınır — aşılırsa WQ hızla bozulur, stres ve mortalite artar
 *   - optimalDensity: en iyi büyüme performansı sağlanan yoğunluk
 *
 * FCR (Feed Conversion Ratio):
 *   - targetFCR: beklenen yem dönüşüm oranı (kg yem / kg canlı ağırlık artışı)
 *   - Değer düşükse iyi demektir (1.0 = 1 kg yem ile 1 kg büyüme)
 *
 * SGR (Specific Growth Rate) — %/gün, opsiyonel:
 *   - targetSGR: türe ve yaşa bağlı beklenen günlük büyüme oranı
 *   - SGR = (ln(W2) - ln(W1)) / gün × 100
 */
export interface SpeciesThresholds {
  temperature: {
    min: number;
    max: number;
    optimal: number;
    criticalMin?: number;
    criticalMax?: number;
  };
  ph: {
    min: number;
    max: number;
    optimal: number;
  };
  dissolvedOxygen: {
    min: number;     // mg/L — hayatta kalma alt sınırı
    optimal: number; // mg/L — en iyi performans
    critical: number; // mg/L — acil müdahale gerektiren seviye
  };
  ammonia: {
    max: number;     // mg/L (UIA) — akut toksisite eşiği
    warning: number; // mg/L (UIA) — kronik stres eşiği
  };
  nitrite: {
    max: number;     // mg/L — akut toksisite eşiği
    warning: number; // mg/L — kronik stres eşiği
  };
  nitrate: {
    max: number;     // mg/L — kabul edilebilir üst sınır
    warning: number; // mg/L — su değişimi öneri eşiği
  };
  salinity?: {
    min: number;     // ppt
    max: number;     // ppt
    optimal: number; // ppt
  };
  co2?: {
    max: number;     // mg/L — tehlikeli seviye
    warning: number; // mg/L — uyarı eşiği
  };
  maxDensity: number;     // kg/m³ — mutlak üst sınır
  optimalDensity: number; // kg/m³ — en iyi performans yoğunluğu
  targetFCR: number;      // hedef yem dönüşüm oranı (düşük = iyi)
  targetSGR?: number;     // %/gün — tür bazlı beklenen spesifik büyüme oranı
}

// ─── Varsayılan Eşik Değerleri ───────────────────────────────────────────────
//
// Her tür için bilimsel literatüre dayalı optimal aralıklar.
// Anahtar formatı: lowercase, boşluk→underscore (ör: 'atlantic_salmon')
//
// ÖNEMLİ: Bu değerler "genel" varsayılanlardır. Gerçek üretimde:
//   - Yaşa göre eşikler değişir (yavru vs yetişkin)
//   - Mevsime göre sıcaklık toleransı kayar
//   - Tesis tipine göre (açık kafes vs RAS) DO beklentisi farklıdır
//   - Genetik suş (strain) performansı değiştirir
// Bu nüanslar GraphQL'den species.optimalConditions ile override edilmelidir.
// ──────────────────────────────────────────────────────────────────────────────

export const DEFAULT_THRESHOLDS: Record<string, SpeciesThresholds> = {

  // ─── Atlantik Somon (Salmo salar) ────────────────────────────────────────
  // Soğuk su türü, yüksek DO gereksinimi, düşük amonyak toleransı.
  // Norveç, İskoçya, Kanada ve Şili'de yoğun olarak yetiştirilir.
  // RAS ve açık kafes sistemlerinde üretilir.
  // Sıcaklık 14°C üzerine çıktığında büyüme hızı yavaşlar, 20°C üzerinde mortalite başlar.
  // Amonyak toleransı çok düşüktür — pH 8.0'da UIA fraksiyonu %5'e çıkar.
  'atlantic_salmon': {
    temperature: {
      min: 8,          // 8°C altında metabolizma belirgin yavaşlar
      max: 14,         // 14°C üzerinde stres başlar
      optimal: 12,     // 12°C'de en iyi SGR ve FCR elde edilir
      criticalMin: 2,  // 2°C altında soğuk şoku riski (cold shock)
      criticalMax: 22, // 22°C üzerinde termal stres kaynaklı mortalite
    },
    ph: {
      min: 6.5,        // 6.5 altında solungaç irritasyonu
      max: 8.0,        // 8.0 üzerinde NH₃ toksisitesi dramatik artar
      optimal: 7.2,    // nötr-hafif asidik ortam ideal
    },
    dissolvedOxygen: {
      min: 6,          // 6 mg/L altında büyüme durur, stres artar
      optimal: 9,      // 9 mg/L'de en iyi metabolik verim
      critical: 4,     // 4 mg/L altında gasping başlar, acil müdahale gerekir
    },
    ammonia: {
      max: 0.02,       // 0.02 mg/L UIA — akut toksisite eşiği (solungaç hasarı)
      warning: 0.012,  // 0.012 mg/L UIA — kronik stres, iştah kaybı başlar
    },
    nitrite: {
      max: 0.3,        // 0.3 mg/L — methemoglobin oluşumu hızlanır
      warning: 0.1,    // 0.1 mg/L — kronik maruziyet sınırı
    },
    nitrate: {
      max: 100,        // 100 mg/L — RAS sistemlerinde kabul edilebilir üst sınır
      warning: 50,     // 50 mg/L — su değişimi düşünülmeli
    },
    salinity: {
      min: 0,          // anadrom tür — tatlı suda da yaşar (smolt öncesi)
      max: 35,         // tam deniz tuzluluğu tolere eder
      optimal: 33,     // okyanus koşulları, smolt sonrası
    },
    co2: {
      max: 15,         // 15 mg/L üzerinde Bohr etkisi belirgin
      warning: 10,     // 10 mg/L — RAS'ta havalandırma artırılmalı
    },
    maxDensity: 25,      // kg/m³ — Norveç standartları
    optimalDensity: 18,  // kg/m³ — en iyi büyüme performansı
    targetFCR: 1.2,      // 1.2 kg yem / 1 kg büyüme — endüstri ortalaması
    targetSGR: 1.0,      // %1/gün — deniz fazında ortalama
  },

  // ─── Gökkuşağı Alabalığı (Oncorhynchus mykiss) ──────────────────────────
  // Soğuk su türü, somona göre biraz daha geniş sıcaklık toleransı.
  // Türkiye'de en yaygın yetiştirilen tatlı su balığı.
  // Yüksek DO gereksinimi (soğuk su = yüksek oksijen çözünürlüğü).
  // 18°C üzerinde stres, 25°C üzerinde mortalite hızla artar.
  // Düşük amonyak toleransı — tatlı su pH'ında UIA fraksiyonu genelde düşüktür
  // ama sıcaklık artışıyla birlikte risk katlanır.
  'rainbow_trout': {
    temperature: {
      min: 10,         // 10°C altında metabolizma yavaşlar ama hayatta kalır
      max: 18,         // 18°C üzerinde stres belirginleşir
      optimal: 14,     // 14°C'de en iyi büyüme ve FCR
      criticalMin: 1,  // 1°C altında metabolizma neredeyse durur
      criticalMax: 25, // 25°C üzerinde akut termal stres → mortalite
    },
    ph: {
      min: 6.5,        // 6.5 altında solungaç mukus birikimi
      max: 8.5,        // 8.5 üzerinde NH₃ riski
      optimal: 7.5,    // nötr ortam ideal
    },
    dissolvedOxygen: {
      min: 6,          // 6 mg/L minimum — stres sınırı
      optimal: 9,      // 9 mg/L — en iyi oksijen satürasyonu soğuk suda
      critical: 5,     // 5 mg/L — gasping ve mortalite riski
    },
    ammonia: {
      max: 0.02,       // 0.02 mg/L UIA — akut eşik
      warning: 0.015,  // 0.015 mg/L UIA — kronik stres
    },
    nitrite: {
      max: 0.3,        // salmonidler nitrite karşı hassastır
      warning: 0.1,
    },
    nitrate: {
      max: 80,
      warning: 40,
    },
    co2: {
      max: 12,         // somon gibi hassas, biraz daha düşük eşik
      warning: 8,
    },
    maxDensity: 30,      // kg/m³ — Türkiye'de yaygın uygulama
    optimalDensity: 22,  // kg/m³ — optimal performans
    targetFCR: 1.1,      // alabalık FCR'ı somona göre biraz daha iyi
    targetSGR: 1.2,      // %1.2/gün — tatlı su fazında, sıcaklığa bağlı
  },

  // ─── Levrek (Dicentrarchus labrax) ───────────────────────────────────────
  // Ilıman-sıcak deniz türü, Akdeniz havzasında yaygın yetiştirilir.
  // Türkiye'nin en önemli deniz balığı üretim türlerinden biri (Ege, Akdeniz kafesleri).
  // Soğuk sulara kısmen toleranslı ama optimal büyüme 22°C civarı.
  // Somon/alabalığa göre amonyak toleransı daha yüksek.
  'sea_bass': {
    temperature: {
      min: 18,         // 18°C altında büyüme belirgin yavaşlar
      max: 26,         // 26°C üzerinde stres artar
      optimal: 22,     // 22°C'de en iyi büyüme performansı
      criticalMin: 5,  // 5°C altında soğuk kaynaklı mortalite (Ege'de kış problemi)
      criticalMax: 30, // 30°C üzerinde ısı stresi kaynaklı mortalite
    },
    ph: {
      min: 7.0,        // deniz suyu genelde 7.8-8.3 arası
      max: 8.5,
      optimal: 8.0,
    },
    dissolvedOxygen: {
      min: 5,          // 5 mg/L — sıcak su türleri daha düşük DO tolere eder
      optimal: 7,      // 7 mg/L — deniz koşullarında iyi seviye
      critical: 3,     // 3 mg/L — acil müdahale
    },
    ammonia: {
      max: 0.05,       // deniz türleri tatlı su türlerine göre daha toleranslı
      warning: 0.025,
    },
    nitrite: {
      max: 1.0,        // tuzlu su nitrit toksisitesini azaltır (Cl⁻ rekabeti)
      warning: 0.5,
    },
    nitrate: {
      max: 200,        // deniz kafeslerinde nitrat genelde sorun olmaz (seyrelme)
      warning: 100,
    },
    salinity: {
      min: 15,         // eurihalin tür — geniş tuzluluk toleransı
      max: 40,
      optimal: 35,     // tam deniz suyu
    },
    maxDensity: 20,      // kg/m³ — Akdeniz kafes standartları
    optimalDensity: 15,  // kg/m³
    targetFCR: 1.8,      // levrek FCR'ı somon/alabalığa göre yüksek
    targetSGR: 0.8,      // %0.8/gün — deniz koşullarında
  },

  // ─── Çipura (Sparus aurata) ─────────────────────────────────────────────
  // Akdeniz'in diğer ana deniz balığı türü, levreke çok benzer koşullar.
  // Çipura biraz daha sıcak su sever (optimal 23°C vs levrek 22°C).
  // FCR levrekten biraz daha yüksek (2.0 vs 1.8).
  // Tuzluluk toleransı levreke benzer.
  'sea_bream': {
    temperature: {
      min: 18,
      max: 26,
      optimal: 23,     // çipura 1°C daha sıcak sever
      criticalMin: 5,
      criticalMax: 30,
    },
    ph: {
      min: 7.5,
      max: 8.5,
      optimal: 8.1,
    },
    dissolvedOxygen: {
      min: 5,
      optimal: 7,
      critical: 3,
    },
    ammonia: {
      max: 0.05,
      warning: 0.025,
    },
    nitrite: {
      max: 1.0,
      warning: 0.5,
    },
    nitrate: {
      max: 200,
      warning: 100,
    },
    salinity: {
      min: 15,
      max: 42,         // çipura yüksek tuzluluğa biraz daha toleranslı
      optimal: 35,
    },
    maxDensity: 18,      // kg/m³ — çipura biraz daha düşük yoğunluk ister
    optimalDensity: 13,  // kg/m³
    targetFCR: 2.0,      // çipura FCR'ı levrekten biraz yüksek
    targetSGR: 0.7,      // %0.7/gün
  },

  // ─── Tilapia (Oreochromis niloticus) ─────────────────────────────────────
  // Tropik tatlı su türü, düşük DO ve yüksek amonyak toleransı.
  // Dünyanın en yaygın 2. yetiştirilen balığı (karptan sonra).
  // 25-30°C arasında en iyi performans, 15°C altında beslenme durur.
  // Çok geniş pH toleransı (6.5-9.0) — bu özelliği ile RAS'a çok uygun.
  // Düşük oksijen koşullarına dayanıklı — yüzeyde hava solunum yapabilir.
  'tilapia': {
    temperature: {
      min: 25,         // 25°C altında büyüme yavaşlar
      max: 30,         // 30°C üzerinde metabolik stres
      optimal: 28,     // 28°C — tropikal ortam, maksimum büyüme
      criticalMin: 12, // 12°C altında soğuk kaynaklı mortalite başlar
      criticalMax: 36, // 36°C üzerinde termal mortalite
    },
    ph: {
      min: 6.5,        // geniş pH toleransı
      max: 9.0,        // bazik sulara bile dayanıklı
      optimal: 7.5,
    },
    dissolvedOxygen: {
      min: 3,          // tilapia düşük DO'ya çok dayanıklı
      optimal: 5,      // 5 mg/L — yeterli, somona göre çok düşük
      critical: 1.5,   // 1.5 mg/L — hava solunumu başlar (yüzeye çıkar)
    },
    ammonia: {
      max: 0.1,        // tilapia NH₃'e oldukça toleranslı
      warning: 0.05,
    },
    nitrite: {
      max: 2.0,        // yüksek nitrit toleransı
      warning: 1.0,
    },
    nitrate: {
      max: 300,        // yüksek nitrat bile tolere eder
      warning: 150,
    },
    co2: {
      max: 25,         // CO₂'ye de toleranslı
      warning: 15,
    },
    maxDensity: 20,      // kg/m³ — yoğun RAS sistemlerinde
    optimalDensity: 15,  // kg/m³
    targetFCR: 1.6,      // tilapia FCR'ı orta düzey
    targetSGR: 2.5,      // %2.5/gün — tropikal sıcaklıkta hızlı büyüme
  },

  // ─── Yayın Balığı / Kanal Yayını (Ictalurus punctatus) ──────────────────
  // Sıcak su tatlı su türü, ABD'de en yaygın yetiştirilen balık.
  // Düşük DO ve yüksek bulanıklık koşullarına toleranslı.
  // Geniş sıcaklık toleransı (5-35°C hayatta kalır, 24-30°C optimal).
  // Benthik yaşam tarzı — hava solunumu kabiliyeti var.
  'catfish': {
    temperature: {
      min: 24,
      max: 30,
      optimal: 27,     // 27°C — en iyi büyüme
      criticalMin: 5,  // 5°C altında kış uykusuna girer
      criticalMax: 35, // 35°C üzerinde termal stres
    },
    ph: {
      min: 6.0,        // asidik sulara toleranslı
      max: 8.5,
      optimal: 7.0,
    },
    dissolvedOxygen: {
      min: 3,          // düşük DO'ya dayanıklı
      optimal: 5,      // 5 mg/L — yeterli
      critical: 2,     // 2 mg/L — acil eşik
    },
    ammonia: {
      max: 0.05,       // somona göre toleranslı, tilapiaya göre hassas
      warning: 0.025,
    },
    nitrite: {
      max: 1.5,
      warning: 0.5,
    },
    nitrate: {
      max: 200,
      warning: 100,
    },
    co2: {
      max: 20,
      warning: 12,
    },
    maxDensity: 15,      // kg/m³ — yayın balığı düşük yoğunluk tercih eder
    optimalDensity: 10,  // kg/m³
    targetFCR: 1.5,      // iyi FCR
    targetSGR: 2.0,      // %2/gün — sıcak su koşullarında
  },

  // ─── Karides (Litopenaeus vannamei) ──────────────────────────────────────
  // Tropik/subtropik tuzlu su türü, dünyanın en çok yetiştirilen kabuklular türü.
  // Çok farklı yoğunluk metrikleri: kg/m³ değil, genelde PL/m² veya kg/m² kullanılır
  // ama bu sistemde tutarlılık için kg/m³ kullanıyoruz (havuz derinliği ~1.5m varsayımı).
  // Molting (kabuk değiştirme) dönemlerinde çok hassas — DO ve mineral dengesi kritik.
  // Tuzluluk toleransı geniş ama optimal 15-25 ppt arası (düşük tuzluluk = daha iyi büyüme).
  'shrimp': {
    temperature: {
      min: 26,         // 26°C altında büyüme yavaşlar
      max: 32,         // 32°C üzerinde stres
      optimal: 29,     // 29°C — beyaz karides için ideal
      criticalMin: 15, // 15°C altında mortalite başlar
      criticalMax: 35, // 35°C üzerinde toplu ölüm riski
    },
    ph: {
      min: 7.5,        // karides alkali suyu tercih eder
      max: 8.5,
      optimal: 8.0,
    },
    dissolvedOxygen: {
      min: 4,          // balıklara göre biraz daha hassas (solungaç yapısı farklı)
      optimal: 6,
      critical: 2,     // 2 mg/L altında toplu ölüm riski
    },
    ammonia: {
      max: 0.1,        // karides NH₃'e nispeten toleranslı
      warning: 0.05,
    },
    nitrite: {
      max: 1.0,        // tuzlu su nitrit etkisini azaltır
      warning: 0.5,
    },
    nitrate: {
      max: 150,
      warning: 75,
    },
    salinity: {
      min: 5,          // düşük tuzlulukta bile yaşar (vannamei eurihalin)
      max: 40,
      optimal: 20,     // 15-25 ppt arası en iyi büyüme
    },
    maxDensity: 5,       // kg/m³ — karides çok düşük yoğunluk gerektirir
    optimalDensity: 3,   // kg/m³
    targetFCR: 1.8,      // karides FCR'ı yüksek — kabuk ağırlığı dahil
    targetSGR: 3.0,      // %3/gün — hızlı büyüme döneminde
  },

  // ─── Varsayılan (Bilinmeyen Tür) ────────────────────────────────────────
  // Tür tanımlanamadığında kullanılan güvenli "orta yol" eşikleri.
  // Bu değerler kasıtlı olarak geniş tutulmuştur — yanlış alarm yerine
  // sessiz kalma tercih edilir, ama kritik eşikler yeterince dardır.
  // ÖNEMLİ: Gerçek üretimde bu eşiklerin kullanılması = tür bilgisi eksik demektir.
  // Tür bilgisi mümkün olan en kısa sürede tamamlanmalıdır.
  'default': {
    temperature: {
      min: 15,
      max: 25,
      optimal: 20,
      criticalMin: 3,
      criticalMax: 33,
    },
    ph: {
      min: 6.5,
      max: 8.5,
      optimal: 7.5,
    },
    dissolvedOxygen: {
      min: 5,
      optimal: 7,
      critical: 3,
    },
    ammonia: {
      max: 0.05,
      warning: 0.025,
    },
    nitrite: {
      max: 1.0,
      warning: 0.5,
    },
    nitrate: {
      max: 150,
      warning: 75,
    },
    co2: {
      max: 20,
      warning: 12,
    },
    maxDensity: 20,
    optimalDensity: 15,
    targetFCR: 1.5,
    targetSGR: 1.5,
  },
};

// ─── Yardımcı Fonksiyonlar ───────────────────────────────────────────────────

/**
 * Verilen tür adına göre eşik değerlerini döndürür.
 *
 * NASIL ÇALIŞIR:
 *   1. Tür adı normalize edilir: küçük harfe çevrilir, baş/son boşluklar temizlenir,
 *      boşluklar underscore'a dönüştürülür.
 *   2. Normalize edilmiş ad DEFAULT_THRESHOLDS map'inde aranır.
 *   3. Eşleşme bulunamazsa 'default' eşikleri döndürülür.
 *
 * @param speciesName - Tür adı (ör: "Atlantic Salmon", "rainbow_trout", "Tilapia")
 *                      undefined verilirse 'default' döner.
 * @returns SpeciesThresholds — bulunan türün eşikleri veya default
 *
 * Kullanım örnekleri:
 *   getThresholds('Atlantic Salmon')  → atlantic_salmon eşikleri
 *   getThresholds('RAINBOW TROUT')    → rainbow_trout eşikleri
 *   getThresholds('unknown_fish')     → default eşikleri
 *   getThresholds()                   → default eşikleri
 */
export function getThresholds(speciesName?: string): SpeciesThresholds {
  if (!speciesName) {
    return DEFAULT_THRESHOLDS['default']!;
  }

  // Normalize: lowercase, trim, space → underscore
  const normalized = speciesName.trim().toLowerCase().replace(/\s+/g, '_');

  return DEFAULT_THRESHOLDS[normalized] ?? DEFAULT_THRESHOLDS['default']!;
}

/**
 * Bir değerin belirtilen min-max aralığının dışında olup olmadığını kontrol eder.
 *
 * NASIL ÇALIŞIR:
 *   1. value < range.min → true (aralık altı — tehlike)
 *   2. value > range.max → true (aralık üstü — tehlike)
 *   3. Aksi halde → false (değer güvenli aralıkta)
 *
 * @param value - Sensörden okunan değer
 * @param range - { min, max } aralığı
 * @returns true = aralık dışı (anomali), false = güvenli
 *
 * Kullanım örneği:
 *   isOutOfRange(26.5, { min: 18, max: 26 }) → true (0.5°C fazla!)
 *   isOutOfRange(22, { min: 18, max: 26 })   → false (güvenli)
 */
export function isOutOfRange(value: number, range: { min: number; max: number }): boolean {
  return value < range.min || value > range.max;
}

/**
 * Bir değerin optimal aralıktan ne kadar saptığını hesaplar.
 *
 * NASIL ÇALIŞIR:
 *   1. Değer min-max aralığı İÇİNDEYSE → 0 döner (sapma yok)
 *   2. Değer aralığın ALTINDAYSA → negatif sayı döner (value - min)
 *      Örnek: sıcaklık 6°C, min 8°C → -2 (2 derece düşük)
 *   3. Değer aralığın ÜSTÜNDEYSE → pozitif sayı döner (value - max)
 *      Örnek: sıcaklık 16°C, max 14°C → +2 (2 derece yüksek)
 *
 * Bu fonksiyon anomali "şiddetini" ölçmek için kullanılır:
 *   - |sapma| < 1 → hafif sapma
 *   - |sapma| 1-3 → orta sapma
 *   - |sapma| > 3 → ciddi sapma (parametre birimine göre yorumlanmalı)
 *
 * NOT: optimal parametresi şu anda kullanılmıyor ama gelecekte
 * "optimal'den uzaklık" skoru hesaplamak için genişletilebilir.
 * EXTENSIBLE: optimal parametresi ile ağırlıklı sapma skoru eklenebilir.
 *
 * @param value - Sensörden okunan değer
 * @param range - { min, max, optimal? } aralığı
 * @returns 0 = aralık içi, negatif = düşük sapma, pozitif = yüksek sapma
 */
export function deviationFromOptimal(
  value: number,
  range: { min: number; max: number; optimal?: number },
): number {
  if (value < range.min) {
    return value - range.min; // negatif — aralığın altında
  }
  if (value > range.max) {
    return value - range.max; // pozitif — aralığın üstünde
  }
  return 0; // aralık içinde — sapma yok
}
