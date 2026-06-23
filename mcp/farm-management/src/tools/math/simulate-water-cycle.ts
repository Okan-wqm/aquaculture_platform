// ─── 24-Saat Su Kimyası Simülasyonu ──────────────────────────────────────
//
// AMAÇ:
//   Sabah TAN ölçümünden başlayarak, saatlik yemleme planına ve biyofiltre
//   performansına göre günün her saati için TAN, NH₃, alkalinite, pH ve
//   CO₂ projeksiyonu yapar. Toksik eşik aşımlarını tespit eder ve
//   saatlik reagent ihtiyacını hesaplar.
//
// NASIL ÇALIŞIR:
//   Saat saat (t=0...23) simülasyon döngüsü:
//
//   1. YEMLEME → TAN ÜRETİMİ
//      - O saatte verilen yem miktarı (feedSchedule[t])
//      - TAN üretimi = 0.092 × protein% × yem_kg
//      - TAN artışı = üretim_g / hacim_m3 (g/m³ = mg/L)
//      - NOT: Yem sonrası TAN artışı anlık değil, ~2-4 saat gecikir
//        Basitleştirme: üretimin %30'u o saat, %40'ı +1h, %20'si +2h, %10'u +3h
//
//   2. BİYOFİLTRE → TAN GİDERİMİ
//      - Biyofiltre verimlilik oranı (% removal per hour)
//      - tanRemoved = currentTAN × (biofilterRate / 100) × (flowRate / tankVolume)
//      - Basitleştirme: saatlik giderim = currentTAN × hourlyRemovalFraction
//      - Varsayılan: %5-10 saatlik giderim (verimli RAS)
//
//   3. NET TAN = önceki + üretim - giderim
//
//   4. NH₃ TOKSİSİTE KONTROLÜ
//      - calcNH3(netTAN, pH, T, S) ile toksik NH₃ hesapla
//      - Limit aşımı → ALARM
//
//   5. ALKALİNİTE TÜKETİMİ
//      - Nitrifikasyonla tüketilen: tanRemoved_mg × 7.14 mg CaCO₃
//      - Yeni alkalinite = önceki - tüketim
//
//   6. pH DEĞİŞİMİ
//      - Alkalinite düşerse → pH düşer (tampon kapasitesi azalır)
//      - CO₂ birikimi → pH düşer
//      - Basitleştirilmiş: pH shift ~ f(alkalinite değişimi, CO₂ değişimi)
//
//   7. REAGENT İHTİYACI
//      - Alkalinite eşik altına düşerse → NaHCO₃ dozlama planı
//      - pH güvenli aralık dışına çıkarsa → müdahale önerisi
//      - Mevcut reagent stoğuna göre plan
//
//   8. EKİPMAN DURUMU
//      - CO₂ hattı: pH düşürmek için / CO₂ dozlama
//      - Degassing: pH yükseltmek için / CO₂ giderme
//      - AI bu ekipmanları hesaba katarak optimal strateji belirler
//
// ÇIKTI:
//   - 24 satırlık saatlik tablo (TAN, NH₃, pH, ALK, CO₂, durum)
//   - Alarm saatleri (toksik eşik aşımları)
//   - Reagent programı (saat + miktar + beklenen etki)
//   - Ekipman programı (CO₂/degassing açma/kapama saatleri)
//   - Günlük toplam reagent ihtiyacı
//
// EXTENSIBLE: Yeni biyofiltre modeli eklemek için biofilterRemoval() fonksiyonunu genişletin.
//

import { z } from 'zod';
import {
  fractionNH3, calcNH3, criticalPHforNH3,
  fractionH2S, calcH2S,
  co2Level, criticalPHforCO2,
  calcDicOfAlk, calcAlkOfDicPh,
  REAGENTS, alkMgToMeq, alkMeqToMg,
} from '@platform/aquaculture-engines';
import { round } from '../../utils/formatters.js';

// ─── Sabitler ────────────────────────────────────────────────────────────

// TAN sindirim gecikmesi profili
// Yem verildiğinde TAN üretimi anlık değil, 2-4 saat yayılır
// Kaynak: Timmons & Ebeling (2013), Ebeling et al. (2006)
const TAN_DELAY_PROFILE = [0.25, 0.35, 0.25, 0.15]; // saat 0, +1, +2, +3

// Nitrifikasyon alkalinite tüketimi: 7.14 mg CaCO₃ per mg TAN
const ALK_PER_MG_TAN = 7.14;

// TAN protein katsayısı
const TAN_PROTEIN_COEFF = 0.092;

// Minimum alkalinite eşiği (mg/L) — altına düşerse acil dozlama
const MIN_ALKALINITY = 40;

// ─── Zod Input Schema ────────────────────────────────────────────────────

export const inputSchema = z.object({
  // Sabah ölçüm değerleri (baseline)
  morningTANmgL: z.number().min(0).describe('Sabah TAN ölçümü (mg/L) — günün başlangıç noktası'),
  morningPH: z.number().min(4).max(12).describe('Sabah pH ölçümü'),
  alkalinity: z.number().min(0).describe('Alkalinite (mg/L CaCO₃)'),
  temperature: z.number().min(0).max(45).describe('Su sıcaklığı (°C)'),
  salinity: z.number().min(0).default(0).describe('Tuzluluk (ppt)'),
  totalSulfide: z.number().min(0).default(0).describe('Toplam sülfid (µg/L)'),

  // Yemleme planı
  feedSchedule: z.array(z.object({
    hour: z.number().int().min(0).max(23).describe('Saat (0-23)'),
    amountKg: z.number().min(0).describe('Yem miktarı (kg)'),
  })).describe('Saatlik yemleme planı — [{hour: 8, amountKg: 15}, {hour: 12, amountKg: 15}, ...]'),
  feedProteinPercent: z.number().min(0).max(100).default(42).describe('Yem protein oranı (%)'),

  // Tank bilgileri
  tankVolumeM3: z.number().positive().describe('Tank hacmi (m³)'),

  // Biyofiltre bilgileri
  biofilterHourlyRemovalPercent: z.number().min(0).max(100).default(8)
    .describe('Biyofiltre saatlik TAN giderim oranı (%). Örn: 8 = her saat TAN\'ın %8\'ini giderir'),

  // Toksin limitleri
  nh3LimitMgL: z.number().positive().default(0.02).describe('NH₃ güvenli limit (mg/L)'),
  h2sLimitUgL: z.number().positive().default(2).describe('H₂S güvenli limit (µg/L)'),
  co2CriticalMgL: z.number().positive().default(20).describe('CO₂ kritik limit (mg/L)'),
  minAlkalinityMgL: z.number().min(0).default(40).describe('Minimum kabul edilebilir alkalinite (mg/L)'),

  // İşletmedeki mevcut reagentler
  availableReagents: z.array(z.string()).default(['Sodium Bicarbonate'])
    .describe('İşletmede mevcut kimyasallar: "Sodium Bicarbonate", "Sodium Carbonate", "Calcium Hydroxide", "Calcium Oxide", "Sodium Hydroxide", "Muriatic Acid"'),

  // Ekipman durumu
  hasCO2Line: z.boolean().default(false).describe('CO₂ dozlama hattı var mı?'),
  hasDegassing: z.boolean().default(false).describe('Degassing ünitesi var mı?'),

  // Simülasyon süresi
  simulationHours: z.number().int().min(1).max(48).default(24).describe('Simülasyon süresi (saat)'),
});

// ─── Tool Definition ─────────────────────────────────────────────────────

export const definition = {
  name: 'simulate_water_cycle',
  description:
    'Sabah TAN ölçümünden başlayarak 24 saatlik su kimyası simülasyonu yapar. ' +
    'Saatlik yemleme planına ve biyofiltre performansına göre TAN, NH₃, pH, alkalinite projeksiyonu üretir. ' +
    'Toksik eşik aşımlarını tespit eder, saatlik reagent ihtiyacını ve ekipman programını belirler. ' +
    'Mevcut reagent stoğu ve ekipmanı (CO₂, degassing) hesaba katar.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      morningTANmgL: { type: 'number', description: 'Sabah TAN ölçümü (mg/L)' },
      morningPH: { type: 'number', description: 'Sabah pH' },
      alkalinity: { type: 'number', description: 'Alkalinite (mg/L CaCO₃)' },
      temperature: { type: 'number', description: 'Su sıcaklığı (°C)' },
      salinity: { type: 'number', description: 'Tuzluluk (ppt)', default: 0 },
      totalSulfide: { type: 'number', description: 'Toplam sülfid (µg/L)', default: 0 },
      feedSchedule: {
        type: 'array',
        items: { type: 'object', properties: { hour: { type: 'integer' }, amountKg: { type: 'number' } } },
        description: 'Yemleme planı: [{hour, amountKg}, ...]',
      },
      feedProteinPercent: { type: 'number', description: 'Yem protein %', default: 42 },
      tankVolumeM3: { type: 'number', description: 'Tank hacmi (m³)' },
      biofilterHourlyRemovalPercent: { type: 'number', description: 'Biyofiltre saatlik TAN giderim %', default: 8 },
      nh3LimitMgL: { type: 'number', description: 'NH₃ limit (mg/L)', default: 0.02 },
      h2sLimitUgL: { type: 'number', description: 'H₂S limit (µg/L)', default: 2 },
      co2CriticalMgL: { type: 'number', description: 'CO₂ limit (mg/L)', default: 20 },
      minAlkalinityMgL: { type: 'number', description: 'Min alkalinite (mg/L)', default: 40 },
      availableReagents: { type: 'array', items: { type: 'string' }, description: 'Mevcut reagentler', default: ['Sodium Bicarbonate'] },
      hasCO2Line: { type: 'boolean', description: 'CO₂ hattı var mı?', default: false },
      hasDegassing: { type: 'boolean', description: 'Degassing var mı?', default: false },
      simulationHours: { type: 'integer', description: 'Simülasyon süresi (saat)', default: 24 },
    },
    required: ['morningTANmgL', 'morningPH', 'alkalinity', 'temperature', 'tankVolumeM3', 'feedSchedule'],
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

// ─── Tipler ──────────────────────────────────────────────────────────────

interface HourlyState {
  hour: number;
  tanMgL: number;
  nh3MgL: number;
  nh3Status: 'SAFE' | 'WARNING' | 'DANGER';
  phEstimate: number;
  alkalinityMgL: number;
  co2MgL: number;
  co2Status: 'SAFE' | 'WARNING' | 'DANGER';
  h2sUgL: number | null;
  h2sStatus: string | null;
  feedingKg: number;
  tanProducedMgL: number;
  tanRemovedMgL: number;
  alkConsumedMgL: number;
  alerts: string[];
  interventions: string[];
}

interface ReagentDose {
  hour: number;
  reagentName: string;
  amountKg: number;
  reason: string;
  expectedAlkChange: number;
  expectedPHchange: number;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }> };

// ─── Handler ─────────────────────────────────────────────────────────────

export async function handler(params: unknown): Promise<ToolResult> {
  const input = inputSchema.parse(params);
  const {
    morningTANmgL, morningPH, alkalinity, temperature: T, salinity: S, totalSulfide,
    feedSchedule, feedProteinPercent, tankVolumeM3, biofilterHourlyRemovalPercent,
    nh3LimitMgL, h2sLimitUgL, co2CriticalMgL, minAlkalinityMgL,
    availableReagents, hasCO2Line, hasDegassing, simulationHours,
  } = input;

  const hasH2S = totalSulfide > 0;
  const removalFraction = biofilterHourlyRemovalPercent / 100;
  const tanCoeff = TAN_PROTEIN_COEFF * (feedProteinPercent / 100);

  // ── Yemleme planını saat dizisine dönüştür ────────────────────────
  // feedByHour[h] = o saatte verilen yem (kg)
  const feedByHour = new Array(simulationHours).fill(0);
  for (const entry of feedSchedule) {
    if (entry.hour < simulationHours) {
      feedByHour[entry.hour] = (feedByHour[entry.hour] ?? 0) + entry.amountKg;
    }
  }

  // ── TAN üretim gecikmesi — yem verildikten 0-3 saat sonra TAN yayılır ──
  // tanAdditionByHour[h] = o saat sudaki TAN artışı (mg/L)
  const tanAdditionByHour = new Array(simulationHours).fill(0);
  for (let h = 0; h < simulationHours; h++) {
    if (feedByHour[h]! > 0) {
      const tanKg = feedByHour[h]! * tanCoeff;
      const tanMgL = (tanKg * 1_000_000) / (tankVolumeM3 * 1000);
      // Gecikme profili: %25 aynı saat, %35 +1h, %25 +2h, %15 +3h
      for (let d = 0; d < TAN_DELAY_PROFILE.length; d++) {
        const targetHour = h + d;
        if (targetHour < simulationHours) {
          tanAdditionByHour[targetHour] = (tanAdditionByHour[targetHour] ?? 0) + tanMgL * TAN_DELAY_PROFILE[d]!;
        }
      }
    }
  }

  // ── Mevcut reagentleri REAGENTS listesinden bul ───────────────────
  const validReagents = REAGENTS.filter(r =>
    availableReagents.some(name =>
      r.name.toLowerCase().includes(name.toLowerCase()) ||
      name.toLowerCase().includes(r.name.toLowerCase())
    )
  );
  // Alkalinite artıran reagentler (NaHCO₃, Na₂CO₃, Ca(OH)₂, CaO, NaOH)
  const alkIncreasingReagents = validReagents.filter(r =>
    r.meqPerMol > 0 && r.radians > 0 && r.radians < Math.PI
  );
  // Tercih sırası: NaHCO₃ > Na₂CO₃ > CaO > Ca(OH)₂ > NaOH
  const preferredReagent = alkIncreasingReagents[0]; // İlk bulunan

  // ═══════════════════════════════════════════════════════════════════
  // SAAT BAZLI SİMÜLASYON DÖNGÜSÜ
  // ═══════════════════════════════════════════════════════════════════

  const hourlyStates: HourlyState[] = [];
  const reagentDoses: ReagentDose[] = [];
  const equipmentSchedule: Array<{ hour: number; equipment: string; action: string; reason: string }> = [];

  let currentTAN = morningTANmgL;
  let currentAlk = alkalinity;
  let currentPH = morningPH;

  for (let h = 0; h < simulationHours; h++) {
    const alerts: string[] = [];
    const interventions: string[] = [];

    // ── 1. TAN ÜRETİMİ (yemleme + gecikme) ────────────────────────
    const tanAdded = tanAdditionByHour[h] ?? 0;

    // ── 2. BİYOFİLTRE GİDERİMİ ────────────────────────────────────
    // Biyofiltre her saat mevcut TAN'ın bir yüzdesini giderir
    // TAN_removed = currentTAN × removalFraction
    // Ama önce eklemeyi yap, sonra giderimi hesapla
    const tanAfterFeeding = currentTAN + tanAdded;
    const tanRemoved = tanAfterFeeding * removalFraction;
    const newTAN = Math.max(0, tanAfterFeeding - tanRemoved);

    // ── 3. ALKALİNİTE TÜKETİMİ (nitrifikasyon) ───────────────────
    // Biyofiltrenin giderdiği TAN miktarı kadar alkalinite tüketilir
    // tanRemoved mg/L × 7.14 = mg/L CaCO₃ tüketimi
    const alkConsumed = tanRemoved * ALK_PER_MG_TAN;
    let newAlk = Math.max(0, currentAlk - alkConsumed);

    // ── 4. pH TAHMİNİ ─────────────────────────────────────────────
    // Alkalinite düştükçe tampon kapasitesi azalır → pH düşer
    // Basitleştirilmiş model: DIC sabit varsayılırsa, alk değişimi → pH değişimi
    let newPH = currentPH;
    if (currentAlk > 0) {
      try {
        const currentAlkMeq = alkMgToMeq(currentAlk);
        const newAlkMeq = alkMgToMeq(newAlk);
        const currentDIC = calcDicOfAlk(currentAlkMeq, currentPH, T, S);
        // Yeni alkalinite ile yeni pH'ı bul (iterasyon)
        // DIC yaklaşık sabit (kısa sürede değişmez), alk değişir → pH değişir
        for (let testPH = currentPH - 0.5; testPH <= currentPH + 0.5; testPH += 0.01) {
          const testAlk = calcAlkOfDicPh(currentDIC, testPH, T, S);
          if (Math.abs(testAlk - newAlkMeq) < 0.005) {
            newPH = round(testPH, 2);
            break;
          }
        }
      } catch {
        // Hesap başarısız — tahmini pH düşüşü
        const alkDropPercent = alkConsumed / (currentAlk + 0.001);
        newPH = round(currentPH - alkDropPercent * 0.3, 2);
      }
    }

    // ── 5. NH₃ TOKSİSİTE KONTROLÜ ─────────────────────────────────
    const nh3 = calcNH3(newTAN, newPH, T, S);
    const nh3Status: 'SAFE' | 'WARNING' | 'DANGER' =
      nh3 > nh3LimitMgL ? 'DANGER' :
      nh3 > nh3LimitMgL * 0.8 ? 'WARNING' : 'SAFE';

    if (nh3Status === 'DANGER') {
      alerts.push(`NH₃ ${round(nh3, 4)} mg/L — limit (${nh3LimitMgL}) aşıldı! TAN: ${round(newTAN, 2)}`);
    }

    // ── 6. CO₂ SEVİYESİ ───────────────────────────────────────────
    const alkMeq = alkMgToMeq(newAlk);
    let co2 = 0;
    try { co2 = co2Level(alkMeq, newPH, T, S); } catch { co2 = 0; }
    const co2Status: 'SAFE' | 'WARNING' | 'DANGER' =
      co2 > co2CriticalMgL ? 'DANGER' :
      co2 > co2CriticalMgL * 0.7 ? 'WARNING' : 'SAFE';

    if (co2Status === 'DANGER') {
      alerts.push(`CO₂ ${round(co2, 1)} mg/L — limit (${co2CriticalMgL}) aşıldı!`);
    }

    // ── 7. H₂S KONTROLÜ ───────────────────────────────────────────
    let h2s: number | null = null;
    let h2sStatus: string | null = null;
    if (hasH2S) {
      h2s = calcH2S(totalSulfide, newPH, T, S);
      h2sStatus = h2s > h2sLimitUgL ? 'DANGER — ANI OLUM RISKI' : 'SAFE';
      if (h2s > h2sLimitUgL) {
        alerts.push(`H₂S ${round(h2s, 2)} µg/L — ANI OLUM RISKI! pH ${newPH}'e dusmus`);
      }
    }

    // ── 8. ALKALİNİTE KONTROLÜ + REAGENT DOZLAMA ──────────────────
    if (newAlk < minAlkalinityMgL && preferredReagent) {
      // Alkalinite eşiğin altına düştü — dozlama gerekli
      const targetAlk = minAlkalinityMgL + 30; // Eşiğin 30 mg/L üstüne çıkar
      const deltaAlkMgL = targetAlk - newAlk;
      const deltaAlkMeq = alkMgToMeq(deltaAlkMgL);
      const volumeL = tankVolumeM3 * 1000;
      const molesNeeded = (deltaAlkMeq * volumeL) / (preferredReagent.meqPerMol * 1000);
      const kgNeeded = round((molesNeeded * preferredReagent.mw) / 1000, 2);

      // pH etkisi tahmini
      let phChangeEstimate = 0;
      if (preferredReagent.name.includes('Bicarbonate')) phChangeEstimate = 0.1;
      else if (preferredReagent.name.includes('Hydroxide')) phChangeEstimate = 0.3;
      else phChangeEstimate = 0.15;

      reagentDoses.push({
        hour: h,
        reagentName: preferredReagent.name,
        amountKg: kgNeeded,
        reason: `Alkalinite ${round(newAlk, 1)} mg/L — minimum (${minAlkalinityMgL}) altında`,
        expectedAlkChange: round(deltaAlkMgL, 1),
        expectedPHchange: round(phChangeEstimate, 2),
      });

      interventions.push(`${kgNeeded} kg ${preferredReagent.name} ekle (ALK ${round(newAlk, 1)} → ${targetAlk})`);

      // Dozlama sonrası alkaliniteyi güncelle (simülasyonda etkisini yansıt)
      newAlk = targetAlk;
      // pH de hafif yükselecek
      newPH = round(newPH + phChangeEstimate, 2);
    }

    // ── 9. EKİPMAN KARARLARI ──────────────────────────────────────
    // CO₂ yüksekse ve degassing varsa → degassing aç
    if (co2 > co2CriticalMgL * 0.7 && hasDegassing) {
      equipmentSchedule.push({
        hour: h,
        equipment: 'degassing',
        action: 'OPEN',
        reason: `CO₂ ${round(co2, 1)} mg/L — degassing ile giderme`,
      });
      interventions.push('Degassing unitesini ac');
    }

    // pH çok yükselirse ve CO₂ hattı varsa → CO₂ dozla
    if (newPH > 8.2 && hasCO2Line && nh3Status === 'DANGER') {
      // pH düşürmek NH₃'ü azaltır — ama H₂S riski kontrol edilmeli
      if (!hasH2S || (h2s !== null && h2s < h2sLimitUgL * 0.5)) {
        equipmentSchedule.push({
          hour: h,
          equipment: 'co2_line',
          action: 'DOSE',
          reason: `pH ${newPH} yuksek, NH₃ ${round(nh3, 4)} tehlikeli — CO₂ ile pH dusur`,
        });
        interventions.push('CO₂ dozlama hattini ac (pH dusurme)');
      } else {
        alerts.push(`pH ${newPH} yuksek ama CO₂ dozlama yapilamaz — H₂S riski!`);
      }
    }

    // ── Durumu kaydet ─────────────────────────────────────────────
    hourlyStates.push({
      hour: h,
      tanMgL: round(newTAN, 3),
      nh3MgL: round(nh3, 4),
      nh3Status,
      phEstimate: newPH,
      alkalinityMgL: round(newAlk, 1),
      co2MgL: round(co2, 2),
      co2Status,
      h2sUgL: h2s !== null ? round(h2s, 4) : null,
      h2sStatus,
      feedingKg: feedByHour[h] ?? 0,
      tanProducedMgL: round(tanAdded, 3),
      tanRemovedMgL: round(tanRemoved, 3),
      alkConsumedMgL: round(alkConsumed, 2),
      alerts,
      interventions,
    });

    // Sonraki saate geç
    currentTAN = newTAN;
    currentAlk = newAlk;
    currentPH = newPH;
  }

  // ═══════════════════════════════════════════════════════════════════
  // ÇIKTI OLUŞTURMA
  // ═══════════════════════════════════════════════════════════════════

  // Tüm alarm saatlerini topla
  const alertHours = hourlyStates
    .filter(s => s.alerts.length > 0)
    .map(s => ({ hour: s.hour, alerts: s.alerts }));

  // Günlük toplam
  const totalFeedKg = feedSchedule.reduce((sum, f) => sum + f.amountKg, 0);
  const totalTANproduced = hourlyStates.reduce((sum, s) => sum + s.tanProducedMgL, 0);
  const totalTANremoved = hourlyStates.reduce((sum, s) => sum + s.tanRemovedMgL, 0);
  const totalAlkConsumed = hourlyStates.reduce((sum, s) => sum + s.alkConsumedMgL, 0);
  const totalReagentKg = reagentDoses.reduce((sum, d) => sum + d.amountKg, 0);

  // Peak değerler
  const peakTAN = Math.max(...hourlyStates.map(s => s.tanMgL));
  const peakNH3 = Math.max(...hourlyStates.map(s => s.nh3MgL));
  const peakTANhour = hourlyStates.find(s => s.tanMgL === peakTAN)?.hour ?? 0;
  const minAlk = Math.min(...hourlyStates.map(s => s.alkalinityMgL));
  const minAlkHour = hourlyStates.find(s => s.alkalinityMgL === minAlk)?.hour ?? 0;

  // Biyofiltre verimlilik özeti
  const biofilterEfficiency = totalTANproduced > 0
    ? round((totalTANremoved / (totalTANproduced + morningTANmgL)) * 100, 1)
    : 0;

  // ── Insight cümlesi ─────────────────────────────────────────────
  const insightParts: string[] = [];
  insightParts.push(`${simulationHours} saatlik simulasyon: ${totalFeedKg} kg yem, ${round(totalTANproduced, 1)} mg/L TAN uretimi.`);
  insightParts.push(`Biyofiltre %${biofilterEfficiency} verimlilik — ${round(totalTANremoved, 1)} mg/L TAN giderdi.`);
  insightParts.push(`TAN zirve: ${round(peakTAN, 2)} mg/L (saat ${peakTANhour}), NH₃ zirve: ${round(peakNH3, 4)} mg/L.`);

  if (alertHours.length > 0) {
    insightParts.push(`${alertHours.length} saat alarm: ${alertHours.map(a => `saat ${a.hour}`).join(', ')}.`);
  } else {
    insightParts.push('Toksik esik asilmadi — gun guvenli.');
  }

  if (totalReagentKg > 0) {
    const reagentName = reagentDoses[0]?.reagentName ?? 'reagent';
    insightParts.push(`Toplam ${round(totalReagentKg, 2)} kg ${reagentName} gerekli (${reagentDoses.length} dozlama).`);
  }

  insightParts.push(`Alkalinite: ${alkalinity} → ${round(currentAlk, 1)} mg/L. Min: ${round(minAlk, 1)} (saat ${minAlkHour}).`);

  const insight = insightParts.join(' ');

  const result = {
    insight,
    summary: {
      simulationHours,
      totalFeedKg,
      feedProteinPercent,
      tanMethod: `0.092 x ${feedProteinPercent}% = ${round(tanCoeff, 4)}`,
      totalTANproducedMgL: round(totalTANproduced, 2),
      totalTANremovedMgL: round(totalTANremoved, 2),
      biofilterEfficiencyPercent: biofilterEfficiency,
      totalAlkConsumedMgL: round(totalAlkConsumed, 1),
      totalReagentKg: round(totalReagentKg, 2),
      reagentName: preferredReagent?.name ?? null,
      peakTANmgL: round(peakTAN, 3),
      peakTANhour,
      peakNH3mgL: round(peakNH3, 4),
      minAlkalinityMgL: round(minAlk, 1),
      minAlkalinityHour: minAlkHour,
      alertCount: alertHours.length,
      startState: { tanMgL: morningTANmgL, ph: morningPH, alkMgL: alkalinity },
      endState: { tanMgL: round(currentTAN, 3), ph: currentPH, alkMgL: round(currentAlk, 1) },
    },
    hourly: hourlyStates,
    alerts: alertHours,
    reagentSchedule: reagentDoses,
    equipmentSchedule,
  };

  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}
