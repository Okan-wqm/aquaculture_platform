// ============================================================================
// MCP Farm Intelligence — Taşıma Kapasitesi Hesaplama Aracı
// ============================================================================
//
// Bir tankın maksimum güvenli taşıma kapasitesini iki kısıt temelinde hesaplar:
//   1. Yoğunluk kısıtı (kg/m³ — fiziksel alan sınırı)
//   2. Oksijen kısıtı (DO doygunluk → metabolik O2 talebi dengesi)
//
// HANGİ KISIT DAHA DÜŞÜKse O BASKINDDIR (sınırlayıcı faktör).
//
// NASIL ÇALIŞIR:
//   1. Yoğunluk limiti: maxBiyokütle = maxYoğunluk × hacim
//   2. Oksijen limiti:
//      a) Weiss (1970) ile DO doygunluğunu hesapla
//      b) Kullanılabilir DO = DO_sat - minGüvenliDO
//      c) 1 kg biyokütle başına günlük O2 tüketimini hesapla
//      d) maxBiyokütle_O2 = kullanılabilir_DO_kg / O2_tüketim_per_kg_per_gün
//   3. Sınırlayıcı faktörü belirle (min)
//   4. Maksimum balık sayısını hesapla
//   5. Öneriler oluştur
//
// REFERANSLAR:
//   - Yoğunluk sınırları: Wedemeyer (1996), Ellis et al. (2002)
//   - Oksijen bütçesi: Colt (2006), Timmons & Ebeling (2013)
//   - DO doygunluk: Weiss (1970) — Deep-Sea Research 17:721-735
//
// SAF HESAPLAMA — GraphQL çağrısı veya yan etki YOKTUR.
// ============================================================================

import { z } from 'zod';
import { round } from '../../utils/formatters.js';
import { calcDOSaturation } from '../../utils/formulas.js';

// ============================================================================
// GİRDİ ŞEMASI (Zod Doğrulama)
// ============================================================================
//
// Parametreler:
//   - tankVolumeM3: Tank su hacmi
//   - temperature: Su sıcaklığı (DO doygunluğu ve metabolizma hızı belirler)
//   - salinity: Tuzluluk (DO doygunluğunu düşürür)
//   - minDOMgL: Minimum güvenli DO (varsayılan 5 mg/L)
//   - maxDensityKgM3: Tür bazlı maksimum yoğunluk (varsayılan 20 kg/m³)
//   - avgFishWeightG: Ortalama bireysel balık ağırlığı (balık sayısı hesabı için)
//   - dailyFeedingRatePercent: Günlük yemleme oranı (%BW — O2 talebi belirler)
//   - hasBiofilter: Biyofiltre varlığı (nitrifikasyon O2 tüketimi ekler)
// ============================================================================

export const inputSchema = z.object({
  tankVolumeM3: z.number().positive()
    .describe('Tank su hacmi (m³)'),
  temperature: z.number().min(0).max(45)
    .describe('Su sıcaklığı (°C)'),
  salinity: z.number().min(0).max(45).default(0)
    .describe('Tuzluluk (ppt) — tatlı su için 0'),
  minDOMgL: z.number().min(0).default(5)
    .describe('Minimum güvenli DO seviyesi (mg/L) — varsayılan: 5'),
  maxDensityKgM3: z.number().positive().default(20)
    .describe('Maksimum stok yoğunluğu (kg/m³) — varsayılan: 20'),
  avgFishWeightG: z.number().positive()
    .describe('Ortalama bireysel balık ağırlığı (gram)'),
  dailyFeedingRatePercent: z.number().min(0).max(20).default(2)
    .describe('Günlük yemleme oranı (%BW) — varsayılan: 2'),
  hasBiofilter: z.boolean().default(false)
    .describe('Biyofiltre (RAS) sistemi mevcut mu?'),
});

// ============================================================================
// ARAÇ TANIMI (MCP Tool Definition)
// ============================================================================

export const definition = {
  name: 'calculate_carrying_capacity',
  description:
    'Tank taşıma kapasitesini yoğunluk ve oksijen kısıtlarına göre hesaplar. ' +
    'Maksimum güvenli biyokütle, balık sayısı ve sınırlayıcı faktörü belirler.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      tankVolumeM3: { type: 'number', description: 'Tank su hacmi (m³)' },
      temperature: { type: 'number', description: 'Su sıcaklığı (°C)' },
      salinity: { type: 'number', description: 'Tuzluluk (ppt), varsayılan: 0' },
      minDOMgL: { type: 'number', description: 'Minimum güvenli DO (mg/L), varsayılan: 5' },
      maxDensityKgM3: { type: 'number', description: 'Maks yoğunluk (kg/m³), varsayılan: 20' },
      avgFishWeightG: { type: 'number', description: 'Ortalama balık ağırlığı (gram)' },
      dailyFeedingRatePercent: { type: 'number', description: 'Yemleme oranı (%BW), varsayılan: 2' },
      hasBiofilter: { type: 'boolean', description: 'Biyofiltre var mı? varsayılan: false' },
    },
    required: ['tankVolumeM3', 'temperature', 'avgFishWeightG'],
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

// ============================================================================
// ARAÇ İŞLEYİCİSİ (Handler)
// ============================================================================

type ToolResult = { content: Array<{ type: 'text'; text: string }> };

export async function handler(params: unknown): Promise<ToolResult> {
  const input = inputSchema.parse(params);

  const {
    tankVolumeM3,
    temperature,
    salinity,
    minDOMgL,
    maxDensityKgM3,
    avgFishWeightG,
    dailyFeedingRatePercent,
    hasBiofilter,
  } = input;

  // ════════════════════════════════════════════════════════════════
  // 1. YOĞUNLUK KISITI
  // ════════════════════════════════════════════════════════════════
  //
  // FORMÜL: maxBiyokütle_yoğunluk = maxYoğunluk × hacim
  //
  // BİRİM: kg/m³ × m³ = kg
  //
  // YOĞUNLUK SINIRLARI (referans değerler):
  //   Gökkuşağı alabalığı: 40-80 kg/m³ (RAS)
  //   Atlantik somon: 25-40 kg/m³ (RAS)
  //   Tilapia: 50-100 kg/m³ (intensif RAS)
  //   Levrek/Çipura: 15-25 kg/m³ (kafes)
  //   Genel varsayılan: 20 kg/m³
  //
  // Bu sınırlar havalandırma, su kalitesi yönetimi ve tür stres
  // toleransına bağlı olarak büyük ölçüde değişebilir.
  //
  // KAYNAK: Ellis et al. (2002) — "The relationships between stocking
  //         density and welfare in farmed rainbow trout"
  //
  const maxBiomassDensity = maxDensityKgM3 * tankVolumeM3;

  // ════════════════════════════════════════════════════════════════
  // 2. OKSİJEN KISITI
  // ════════════════════════════════════════════════════════════════
  //
  // Bu hesap şu soruyu yanıtlar:
  //   "Tankın O2 kapasitesi göz önüne alındığında, en fazla
  //    ne kadar biyokütle beslenebilir?"
  //
  // VARSAYIM: Tank doygunlukta tutulur (sürekli havalandırma).
  //           Kullanılabilir O2 = DO_sat - minGüvenliDO
  //           Bu O2'yi tankın hacmine yayarsak toplam kullanılabilir O2
  //           miktarını elde ederiz.
  //

  // ── A) DO Doygunluk Hesabı (Weiss 1970) ──────────────────────
  //
  // Aynı formül calculate-oxygen-budget'taki ile aynıdır.
  // Detaylı açıklama için o dosyaya bakınız.
  const doSaturation = calcDOSaturation(temperature, salinity);

  // ── B) Kullanılabilir DO ──────────────────────────────────────
  //
  // FORMÜL: DO_kullanılabilir = DO_doygunluk - min_güvenli_DO
  //
  // Bu, balıkların "harcayabileceği" oksijen miktarıdır.
  // DO, minGüvenliDO'nun altına düşmemelidir.
  //
  // Örnek (20°C, tatlı su):
  //   DO_sat = 9.09 mg/L
  //   minSafe = 5.00 mg/L
  //   DO_available = 4.09 mg/L
  //
  const doAvailableMgL = Math.max(0, doSaturation - minDOMgL);

  // ── C) Birim Biyokütle Başına O2 Tüketimi ────────────────────
  //
  // 1 kg balık biyokütlesi için günlük O2 tüketimini hesaplıyoruz.
  //
  // 1 kg balık için günlük yem = yemleme_oranı / 100 (kg yem)
  //
  // O2 tüketim kaynakları (her biri kg O2 cinsinden):
  //
  //   A) Balık solunumu: günlük_yem × 0.35
  //      → Her 1 kg yem metabolize edildiğinde 0.35 kg O2 tüketilir
  //      → Protein ve yağ oksidasyonunun oksijen maliyeti
  //
  //   B) Organik ayrışma: günlük_yem × 0.10
  //      → Yenmeyen yem + dışkı → heterotrofik bakteriler tarafından ayrıştırılır
  //      → Her 1 kg yem için 0.10 kg O2 harcanır
  //
  //   C) Biyofiltre nitrifikasyonu (sadece RAS): günlük_yem × TAN_katsayısı × 4.57
  //      → Yem → TAN üretimi → nitrifikasyon → O2 tüketimi
  //      → TAN katsayısı: 0.01 (varsayılan)
  //      → Nitrifikasyon: 4.57 g O2 / g NH4-N (stokiyometrik)
  //
  // FORMÜL (1 kg biyokütle için, kg O2/gün):
  //   dailyFeedPerKg = feedingRate / 100
  //   O2_fish    = dailyFeedPerKg × 0.35
  //   O2_organic = dailyFeedPerKg × 0.10
  //   O2_bio     = dailyFeedPerKg × 0.01 × 4.57 (eğer biyofiltre varsa)
  //   O2_total   = O2_fish + O2_organic + O2_bio
  //
  const dailyFeedPerKgBiomass = dailyFeedingRatePercent / 100;

  const o2FishPerKg = dailyFeedPerKgBiomass * 0.35;
  const o2OrganicPerKg = dailyFeedPerKgBiomass * 0.10;
  const o2BiofilterPerKg = hasBiofilter
    ? dailyFeedPerKgBiomass * 0.01 * 4.57
    : 0;

  // Toplam: 1 kg biyokütle başına günlük O2 tüketimi (kg O2)
  const o2PerKgPerDay = o2FishPerKg + o2OrganicPerKg + o2BiofilterPerKg;

  // ── D) Oksijen Bazlı Maksimum Biyokütle ──────────────────────
  //
  // MANTIK:
  //   Tankın tutabileceği toplam "kullanılabilir" O2 miktarı:
  //     DO_available_kg = DO_available_mgL × hacim_L / 1.000.000
  //
  //   Bu O2, tank tamamen doygunluktan minGüvenliDO'ya düşerse
  //   harcanacak toplam O2'dir. Ama sürekli havalandırma varsa,
  //   havalandırma O2'yi doygunluğa geri yükler.
  //
  //   Basitleştirilmiş model:
  //     Havalandırma, DO'yu doygunlukta tutar.
  //     O2 tüketim HIZI, DO_available'ı aşmamalıdır.
  //     Yani: O2 tüketim hızının 1 saatte DO_available'ı tüketmemesi gerekir.
  //
  //     Ama bu çok kısıtlayıcı. Gerçekte havalandırma sürekli O2 ekler.
  //
  //   DAHA İYİ MODEL:
  //     Günlük bazda düşünelim:
  //     Tank 1 günde yenileyebileceği O2 = DO_available × hacim × (yenileme sayısı)
  //     Ama yenileme sayısı belirsiz.
  //
  //   EN BASİT YAKLAŞIM (endüstri standardı):
  //     maxBiyokütle_O2 = (DO_available_mg/L × hacim_L) / (O2_per_kg_per_day_in_mg × 1/24)
  //
  //     Yani: 1 saatlik O2 bütçesi ile hesapla.
  //     O2_per_kg_per_hour_mg = O2_per_kg_per_day × 1e6 / 24
  //     DO_available_mg_per_L = doAvailableMgL
  //     maxBiomass = doAvailableMgL × hacim_L / (O2_per_kg_per_hour_mg)
  //
  //     Hmm, bu da birim sorunları yaratıyor.
  //
  //   DÜZGÜN FORMÜL:
  //     Toplam kullanılabilir O2 (kg): DO_available × volume_L / 1e6
  //     1 kg biyokütle 1 günde tükettiği O2 (kg): o2PerKgPerDay
  //     maxBiomass = toplam_O2_kg / o2PerKgPerDay
  //
  //     Bu, havalandırma OLMADAN 1 günde tükenecek O2 bazında hesaptır.
  //     Havalandırma varsa (ki genellikle vardır) bu çok koruyucu bir tahmindir.
  //
  const doAvailableKg = (doAvailableMgL * tankVolumeM3 * 1000) / 1_000_000;

  // O2PerKgPerDay = 0 olabilir (yem oranı 0 ise) — sonsuz kapasite döner
  // Bu durumu ele almamız gerekir.
  let maxBiomassOxygen: number;
  if (o2PerKgPerDay > 0) {
    maxBiomassOxygen = doAvailableKg / o2PerKgPerDay;
  } else {
    // Yem oranı 0 → O2 tüketimi yok → oksijen kısıtı yok
    maxBiomassOxygen = Infinity;
  }

  // ════════════════════════════════════════════════════════════════
  // 3. SINIRLANDIRICI FAKTÖR
  // ════════════════════════════════════════════════════════════════
  //
  // İki kısıttan düşük olanı geçerlidir:
  //   - Yoğunluk kısıtı (fiziksel alan)
  //   - Oksijen kısıtı (metabolik sınır)
  //
  // Sınırlayıcı faktör, sistemi büyütmek için
  // ilk çözülmesi gereken darboğazı gösterir.
  //
  const maxBiomassKg = Math.min(maxBiomassDensity, maxBiomassOxygen);
  const limitingFactor = maxBiomassDensity <= maxBiomassOxygen ? 'density' : 'oxygen';

  // ── Maksimum Balık Sayısı ─────────────────────────────────────
  //
  // FORMÜL: maxBalık = maxBiyokütle_kg × 1000 / ortalama_ağırlık_g
  //
  // Birim: kg × 1000 (kg→g) / g = adet
  const maxFishCount = Math.floor((maxBiomassKg * 1000) / avgFishWeightG);

  // ── Maksimum Yoğunluk (hesaplanan) ────────────────────────────
  const effectiveMaxDensity = maxBiomassKg / tankVolumeM3;

  // ════════════════════════════════════════════════════════════════
  // 4. ÖNERİLER
  // ════════════════════════════════════════════════════════════════

  const recommendations: string[] = [];

  if (limitingFactor === 'oxygen') {
    recommendations.push(
      'Oksijen sınırlayıcı faktör — havalandırma kapasitesini artırmayı değerlendirin.'
    );
    recommendations.push(
      'Saf oksijen enjeksiyonu ile DO doygunluğunun üzerine çıkılabilir (süpersatürasyon).'
    );
    if (!hasBiofilter) {
      recommendations.push(
        'Biyofiltre eklenmesi (RAS dönüşümü) su kalitesini iyileştirir ama ek O2 tüketimi yaratır.'
      );
    }
  }

  if (limitingFactor === 'density') {
    recommendations.push(
      'Yoğunluk sınırlayıcı faktör — daha büyük tank veya ek tank eklemeyi değerlendirin.'
    );
    recommendations.push(
      `Mevcut yoğunluk sınırı: ${maxDensityKgM3} kg/m³. ` +
      `Tür ve koşullara göre bu sınır ayarlanabilir.`
    );
  }

  if (temperature > 25) {
    recommendations.push(
      `Yüksek sıcaklık (${temperature}°C) DO doygunluğunu düşürür. ` +
      `Soğutma sistemleri O2 kapasitesini artırabilir.`
    );
  }

  if (doAvailableMgL < 2) {
    recommendations.push(
      `DİKKAT: Kullanılabilir O2 marjı çok düşük (${round(doAvailableMgL, 2)} mg/L). ` +
      `Havalandırma arızasında hızlı O2 düşüşü yaşanabilir.`
    );
  }

  // ════════════════════════════════════════════════════════════════
  // 5. SONUÇ YAPISI
  // ════════════════════════════════════════════════════════════════

  const result = {
    // ── Genel Sonuç ──────────────────────────────────────────────
    maxBiomassKg: round(maxBiomassKg, 2),
    maxFishCount,
    effectiveMaxDensityKgM3: round(effectiveMaxDensity, 2),
    limitingFactor,

    // ── Kısıt Detayları ─────────────────────────────────────────
    limits: {
      density: {
        maxBiomassKg: round(maxBiomassDensity, 2),
        maxDensityKgM3: maxDensityKgM3,
        tankVolumeM3,
        explanation:
          `Yoğunluk kısıtı: ${maxDensityKgM3} kg/m³ × ${tankVolumeM3} m³ = ${round(maxBiomassDensity, 2)} kg.`,
      },
      oxygen: {
        maxBiomassKg: isFinite(maxBiomassOxygen) ? round(maxBiomassOxygen, 2) : null,
        doSaturationMgL: round(doSaturation, 2),
        doAvailableMgL: round(doAvailableMgL, 2),
        minSafeDOMgL: minDOMgL,
        o2PerKgPerDayKg: round(o2PerKgPerDay, 6),
        o2BreakdownPerKg: {
          fishRespiration: round(o2FishPerKg, 6),
          organicDecomposition: round(o2OrganicPerKg, 6),
          biofilterNitrification: round(o2BiofilterPerKg, 6),
        },
        explanation:
          `Oksijen kısıtı: DO_sat=${round(doSaturation, 2)} mg/L, ` +
          `kullanılabilir=${round(doAvailableMgL, 2)} mg/L → ` +
          `${isFinite(maxBiomassOxygen) ? round(maxBiomassOxygen, 2) + ' kg maks biyokütle' : 'sınırsız (yem oranı 0)'}.`,
      },
    },

    // ── Parametreler ────────────────────────────────────────────
    parameters: {
      temperature,
      salinity,
      dailyFeedingRatePercent,
      hasBiofilter,
      avgFishWeightG,
    },

    // ── Öneriler ────────────────────────────────────────────────
    recommendations,
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
  };
}


