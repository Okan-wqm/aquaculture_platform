/**
 * Legacy → FeedingProtocolV2 dönüşüm mantığı (Faz 4 veri taşıma).
 *
 * SAF fonksiyonlar: NestJS/TypeORM bağımlılığı yok — migration
 * (`1806300000000-MigrateFeedingProgramsToProtocolV2`) ve birim testleri aynı
 * kodu paylaşır (dönüşüm matematiği fixture'larla test edilir, migration yalnız
 * okuma/yazma sıhhiyesi taşır).
 *
 * Temel kurallar (plan §9.1–9.2):
 *  - FeedingProgram (ACTIVE) → v2 ACTIVE; draft/paused → v2 DRAFT.
 *    Band oranı/FCR'ı `Feed.feedingMatrix2D`'den band-orta ağırlık +
 *    tenant-medyan sıcaklıkta örneklenir (motorun bugün hesaplayacağı değerler);
 *    tanklardaki batch v1 FeedingProtocol taşıyorsa oran/sıcaklık/öğün oradan
 *    zenginleştirilir.
 *  - Bağımsız v1 FeedingProtocol'ler: feedId çözülemeyen bantlar → protokol
 *    DRAFT (species growthStages.recommendedFeedType araması ara adımdır);
 *    `preMedicationFasting` `settings.adjustments`'a AYNEN taşınır.
 *  - Dönüşen HER protokol v2 doğrulama SSoT'sinden (ProtocolValidationService)
 *    geçirilir; geçemeyen ACTIVE adayı DRAFT'a düşürülür (sessiz geçersiz
 *    protokol imkânsız) ve gerekçe migrationNote'ta görünür.
 *
 * @module FeedingProtocol/Migration
 */
import {
  FcrMatrix,
  MealSchedule,
  ProtocolBand,
  ProtocolFcrSource,
  ProtocolSettings,
  TemperatureAdjustment,
  MIN_EXPECTED_FCR,
  MAX_EXPECTED_FCR,
  MAX_FEEDING_RATE_PERCENT,
  MIN_TEMP_MULTIPLIER,
  MAX_TEMP_MULTIPLIER,
} from '../entities/feeding-protocol-v2.entity';
import { ProtocolValidationService } from '../services/protocol-validation.service';

// ============================================================================
// LEGACY SHAPES (Baseline şemasının birebir aynası — okunan jsonb kolonları)
// ============================================================================

export interface LegacyFeedAssignment {
  feedId: string;
  feedCode: string;
  feedName: string;
  minWeightG: number;
  maxWeightG: number;
  /** 1 = en yüksek öncelik (örtüşme çözümünde kazanır). */
  priority: number;
  notes?: string;
}

/** v1 FCRTable / Feed.feedingMatrix2D ortak yönelimi: values[tempIndex][weightIndex]. */
export interface LegacyMatrix {
  temperatures: number[];
  weights: number[];
  values: number[][];
}

export interface LegacyProgramSettings {
  autoTransition?: boolean;
  transitionBuffer?: number;
  fcrSource?: 'program' | 'feed';
  growthApplicationMode?: 'per_feeding' | 'daily';
  defaultMealsPerDay?: number;
  minFeedingRatePercent?: number;
  maxFeedingRatePercent?: number;
}

export interface LegacyProgramRow {
  id: string;
  tenantId: string;
  name: string;
  description?: string | null;
  status: 'draft' | 'active' | 'paused' | 'completed' | 'cancelled';
  feedAssignments: LegacyFeedAssignment[];
  fcrTable?: { temperatures: number[]; weights: number[]; fcrValues: number[][] } | null;
  settings: LegacyProgramSettings;
}

export interface LegacyScheduleEntry {
  time: string;
  percentOfDaily: number;
}

export interface LegacyFeedingSchedule {
  totalMealsPerDay?: number;
  schedule?: LegacyScheduleEntry[];
  adjustments?: {
    lowOxygenReduction?: number;
    postStressReduction?: number;
    preMedicationFasting?: number;
  };
}

export interface LegacyGrowthStageProtocol {
  minWeight: number;
  maxWeight: number;
  weightUnit?: string;
  feedPercent: number;
  schedule?: LegacyFeedingSchedule;
  notes?: string;
}

export interface LegacyTemperatureRange {
  min: number;
  max: number;
  feedingMultiplier: number;
}

export interface LegacyV1ProtocolRow {
  id: string;
  tenantId: string;
  name: string;
  description?: string | null;
  feedId?: string | null;
  species: string;
  targetFcr?: number | null;
  minDissolvedOxygen?: number | null;
  temperatureRanges?: LegacyTemperatureRange[] | null;
  growthStageProtocols?: LegacyGrowthStageProtocol[] | null;
  defaultSchedule?: LegacyFeedingSchedule | null;
  isDefault: boolean;
}

export interface FeedRef {
  id: string;
  code: string;
  name: string;
  type: string;
  feedingMatrix2D?: {
    temperatures: number[];
    weights: number[];
    rates: number[][];
    fcrMatrix?: number[][];
  } | null;
}

export interface SpeciesGrowthStage {
  minWeight: number;
  maxWeight: number;
  weightUnit?: string;
  recommendedFeedType?: string;
  feedingFrequency?: number;
  feedingRate?: number;
  targetFCR?: number;
}

export interface SpeciesRef {
  id: string;
  commonName: string;
  scientificName?: string | null;
  localName?: string | null;
  growthStages?: SpeciesGrowthStage[] | null;
}

/** v1 protokolden alınan zenginleştirme (program dönüşümünde kullanılır). */
export interface V1Enrichment {
  temperatureRanges?: LegacyTemperatureRange[] | null;
  defaultSchedule?: LegacyFeedingSchedule | null;
  minDissolvedOxygen?: number | null;
  growthStageProtocols?: LegacyGrowthStageProtocol[] | null;
}

export interface ConvertedProtocol {
  name: string;
  description?: string;
  speciesId?: string;
  speciesName?: string;
  status: 'draft' | 'active';
  bands: ProtocolBand[];
  temperatureAdjustments?: TemperatureAdjustment[];
  defaultMealSchedule: MealSchedule;
  fcrMatrix?: FcrMatrix;
  settings: ProtocolSettings;
  isDefault: boolean;
  migrationNote: string;
  /** İnsan-okur dönüşüm notları (migrationNote içine katlanır + raporda görünür). */
  notes: string[];
}

// ============================================================================
// KÜÇÜK YARDIMCILAR
// ============================================================================

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const FALLBACK_EXPECTED_FCR = 1.2;
const FALLBACK_RATE_PERCENT = 2;
export const MIGRATED_PROGRAM_MARKER = (programId: string): string =>
  `[migrated:program:${programId}]`;
export const MIGRATED_V1_PROTOCOL_MARKER = (protocolId: string): string =>
  `[migrated:protocol-v1:${protocolId}]`;

/** Öğünleri 08:00–18:00 penceresine eşit dağıt; son öğün yüzde kalanını alır. */
export function buildEvenMealSchedule(mealsPerDay: number): MealSchedule {
  const count = clamp(Math.round(mealsPerDay) || 4, 1, 24);
  const startMinutes = 8 * 60;
  const endMinutes = 18 * 60;
  const step = count === 1 ? 0 : (endMinutes - startMinutes) / (count - 1);
  const basePercent = Math.floor((100 / count) * 100) / 100;
  const entries = Array.from({ length: count }, (_, i) => {
    const total = Math.round(startMinutes + step * i);
    const hh = String(Math.floor(total / 60)).padStart(2, '0');
    const mm = String(total % 60).padStart(2, '0');
    const percentOfDaily =
      i === count - 1 ? Math.round((100 - basePercent * (count - 1)) * 100) / 100 : basePercent;
    return { time: `${hh}:${mm}`, percentOfDaily };
  });
  return { mealsPerDay: count, entries };
}

/**
 * Kenarları clamp'li bilinear örnekleme — values[tempIndex][weightIndex].
 * Motorun bugünkü davranışıyla öz-tutarlı: alan dışı istek en yakın kenara iner.
 */
export function sampleMatrix(matrix: LegacyMatrix, tempC: number, weightG: number): number | null {
  const { temperatures, weights, values } = matrix;
  if (!temperatures?.length || !weights?.length || !values?.length) return null;

  const axisIndex = (axis: number[], value: number): [number, number, number] => {
    if (value <= (axis[0] ?? 0)) return [0, 0, 0];
    const lastIndex = axis.length - 1;
    const last = axis[lastIndex] ?? 0;
    if (value >= last) return [lastIndex, lastIndex, 0];
    let low = 0;
    for (let i = 0; i < lastIndex; i++) {
      const current = axis[i] ?? 0;
      const next = axis[i + 1] ?? current;
      if (value >= current && value <= next) {
        low = i;
        const span = next - current;
        return [i, i + 1, span === 0 ? 0 : (value - current) / span];
      }
    }
    return [low, low, 0];
  };

  const [t1, t2, tf] = axisIndex(temperatures, tempC);
  const [w1, w2, wf] = axisIndex(weights, weightG);
  const v11 = values[t1]?.[w1];
  const v12 = values[t1]?.[w2];
  const v21 = values[t2]?.[w1];
  const v22 = values[t2]?.[w2];
  if (
    typeof v11 !== 'number' ||
    typeof v12 !== 'number' ||
    typeof v21 !== 'number' ||
    typeof v22 !== 'number'
  ) {
    return null;
  }
  const top = v11 + (v12 - v11) * wf;
  const bottom = v21 + (v22 - v21) * wf;
  return top + (bottom - top) * tf;
}

interface NormalizedRange {
  minWeightG: number;
  maxWeightG: number;
  assignment: LegacyFeedAssignment;
}

/**
 * v1 feedAssignments → bitişik yarı-açık aralıklar.
 * Örtüşme: düşük `priority` değeri (1 = en yüksek) kazanır.
 * Boşluk: önceki aralık bir sonrakinin başlangıcına UZATILIR (belgeli kural;
 * not üretilir — sessiz boşluk yok).
 */
export function normalizeAssignmentsToRanges(assignments: LegacyFeedAssignment[]): {
  ranges: NormalizedRange[];
  notes: string[];
} {
  const notes: string[] = [];
  const valid = (assignments ?? []).filter(
    (a) =>
      a &&
      typeof a.minWeightG === 'number' &&
      typeof a.maxWeightG === 'number' &&
      a.minWeightG < a.maxWeightG &&
      typeof a.feedId === 'string' &&
      a.feedId.length > 0,
  );
  if (valid.length === 0) return { ranges: [], notes: ['feedAssignments boş veya geçersiz'] };

  // Sınır noktalarında süpürme: her parçada en yüksek öncelikli (min priority,
  // eşitlikte dar aralık) atama kazanır.
  const boundaries = [...new Set(valid.flatMap((a) => [a.minWeightG, a.maxWeightG]))].sort(
    (x, y) => x - y,
  );
  const segments: NormalizedRange[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const lo = boundaries[i] ?? 0;
    const hi = boundaries[i + 1] ?? lo;
    if (hi <= lo) continue;
    const covering = valid.filter((a) => a.minWeightG <= lo && a.maxWeightG >= hi);
    if (covering.length === 0) continue; // boşluk — aşağıda kapatılır
    covering.sort(
      (a, b) =>
        (a.priority ?? 99) - (b.priority ?? 99) ||
        a.maxWeightG - a.minWeightG - (b.maxWeightG - b.minWeightG),
    );
    const winner = covering[0]!;
    if (covering.length > 1) {
      notes.push(
        `${lo}–${hi}g örtüşmesi priority ile çözüldü → ${winner.feedCode ?? winner.feedId}`,
      );
    }
    const previous = segments[segments.length - 1];
    if (previous && previous.assignment.feedId === winner.feedId && previous.maxWeightG === lo) {
      previous.maxWeightG = hi; // aynı yem — birleştir
    } else {
      segments.push({ minWeightG: lo, maxWeightG: hi, assignment: winner });
    }
  }

  // Boşlukları önceki aralığı uzatarak kapat (ilk aralık öncesi boşluk: min'e çek).
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    const next = segments[i + 1];
    if (next && segment.maxWeightG < next.minWeightG) {
      notes.push(
        `${segment.maxWeightG}–${next.minWeightG}g boşluğu önceki band uzatılarak kapatıldı`,
      );
      segment.maxWeightG = next.minWeightG;
    }
  }
  const first = segments[0];
  if (first && first.minWeightG > 0) {
    notes.push(`0–${first.minWeightG}g kapsam dışıydı; ilk band 0g'a çekildi`);
    first.minWeightG = 0;
  }

  return { ranges: segments, notes };
}

/** Zenginleştirme protokolünün band-orta ağırlığı kapsayan aşamasından oran/FCR. */
function enrichmentStageFor(
  enrichment: V1Enrichment | undefined,
  midWeightG: number,
): LegacyGrowthStageProtocol | undefined {
  return (enrichment?.growthStageProtocols ?? undefined)?.find((stage) => {
    const factor = stage.weightUnit === 'kg' ? 1000 : 1;
    return midWeightG >= stage.minWeight * factor && midWeightG < stage.maxWeight * factor;
  });
}

/** v1 öğün planı → v2 MealSchedule; toplam %100±0.01 ve artan saat şartı sağlanmazsa null. */
export function convertLegacySchedule(
  schedule: LegacyFeedingSchedule | null | undefined,
): MealSchedule | null {
  const entries = schedule?.schedule ?? [];
  if (!entries.length) return null;
  const mapped = entries
    .filter((entry) => /^([01]\d|2[0-3]):[0-5]\d$/.test(entry?.time ?? ''))
    .map((entry) => ({ time: entry.time, percentOfDaily: Number(entry.percentOfDaily) || 0 }));
  if (mapped.length !== entries.length || mapped.length === 0) return null;
  const sum = mapped.reduce((acc, entry) => acc + entry.percentOfDaily, 0);
  if (Math.abs(sum - 100) > 0.01) return null;
  for (let i = 1; i < mapped.length; i++) {
    if (mapped[i]!.time <= mapped[i - 1]!.time) return null;
  }
  return { mealsPerDay: mapped.length, entries: mapped };
}

function convertTemperatureRanges(
  ranges: LegacyTemperatureRange[] | null | undefined,
): TemperatureAdjustment[] | undefined {
  const converted = (ranges ?? [])
    .filter(
      (range) =>
        range &&
        typeof range.min === 'number' &&
        typeof range.max === 'number' &&
        range.min < range.max,
    )
    .map((range) => ({
      minC: clamp(range.min, -10, 50),
      maxC: clamp(range.max, -10, 50),
      rateMultiplier: clamp(
        Number(range.feedingMultiplier) || 1,
        MIN_TEMP_MULTIPLIER,
        MAX_TEMP_MULTIPLIER,
      ),
    }));
  return converted.length > 0 ? converted : undefined;
}

function convertAdjustments(
  schedule: LegacyFeedingSchedule | null | undefined,
): ProtocolSettings['adjustments'] {
  const adjustments = schedule?.adjustments;
  if (!adjustments) return undefined;
  const result: NonNullable<ProtocolSettings['adjustments']> = {};
  if (typeof adjustments.lowOxygenReduction === 'number') {
    result.lowOxygenReduction = adjustments.lowOxygenReduction;
  }
  if (typeof adjustments.postStressReduction === 'number') {
    result.postStressReduction = adjustments.postStressReduction;
  }
  if (typeof adjustments.preMedicationFasting === 'number') {
    // Plan §9 / D-12: AYNEN taşınır — saat cinsinden alan adı v2'de açık.
    result.preMedicationFastingHours = adjustments.preMedicationFasting;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** ACTIVE adayını v2 doğrulama SSoT'sinden geçir; geçemezse DRAFT'a düşür. */
function finalizeStatus(
  candidate: Omit<ConvertedProtocol, 'migrationNote'>,
  marker: string,
): ConvertedProtocol {
  const validator = new ProtocolValidationService();
  const errors = validator.validateProtocol({
    bands: candidate.bands,
    defaultMealSchedule: candidate.defaultMealSchedule,
    settings: candidate.settings,
    temperatureAdjustments: candidate.temperatureAdjustments,
    fcrMatrix: candidate.fcrMatrix,
  });
  let { status } = candidate;
  const notes = [...candidate.notes];
  if (errors.length > 0 && status === 'active') {
    status = 'draft';
    notes.push(`v2 doğrulaması geçemedi, DRAFT'a düşürüldü: ${errors.join('; ')}`);
  } else if (errors.length > 0) {
    notes.push(`v2 doğrulama uyarıları: ${errors.join('; ')}`);
  }
  return {
    ...candidate,
    status,
    notes,
    migrationNote: [marker, ...notes].join(' | '),
  };
}

// ============================================================================
// PROGRAM → V2
// ============================================================================

export interface ConvertProgramOptions {
  feedsById: Map<string, FeedRef>;
  /** Tenant-medyan su sıcaklığı (°C); okuma yoksa null → 15°C örnekleme + not. */
  medianTempC: number | null;
  enrichment?: V1Enrichment;
  speciesId?: string;
  speciesName?: string;
}

export function convertProgramToProtocolV2(
  program: LegacyProgramRow,
  options: ConvertProgramOptions,
): ConvertedProtocol | null {
  if (program.status === 'completed' || program.status === 'cancelled') return null;

  const notes: string[] = [];
  const { ranges, notes: bandNotes } = normalizeAssignmentsToRanges(program.feedAssignments);
  notes.push(...bandNotes);
  if (ranges.length === 0) return null;

  const samplingTemp = options.medianTempC ?? 15;
  if (options.medianTempC === null) {
    notes.push('Tenant su sıcaklığı kaydı yok; örnekleme 15°C varsayımıyla yapıldı');
  } else {
    notes.push(`Oran/FCR örneklemesi tenant-medyan ${samplingTemp}°C üzerinden`);
  }

  const fcrTable = program.fcrTable;
  const useProgramFcr = program.settings?.fcrSource === 'program' && !!fcrTable;

  const bands: ProtocolBand[] = ranges.map(({ minWeightG, maxWeightG, assignment }) => {
    const feed = options.feedsById.get(assignment.feedId);
    const midWeight = (minWeightG + maxWeightG) / 2;
    const stage = enrichmentStageFor(options.enrichment, midWeight);

    let rate: number | null = typeof stage?.feedPercent === 'number' ? stage.feedPercent : null;
    if (rate === null && feed?.feedingMatrix2D?.rates) {
      rate = sampleMatrix(
        {
          temperatures: feed.feedingMatrix2D.temperatures,
          weights: feed.feedingMatrix2D.weights,
          values: feed.feedingMatrix2D.rates,
        },
        samplingTemp,
        midWeight,
      );
    }
    if (rate === null) {
      notes.push(
        `${assignment.feedCode ?? assignment.feedId}: oran örneklenemedi, %${FALLBACK_RATE_PERCENT} varsayıldı`,
      );
      rate = FALLBACK_RATE_PERCENT;
    }

    let fcr: number | null = null;
    if (useProgramFcr && fcrTable) {
      fcr = sampleMatrix(
        {
          temperatures: fcrTable.temperatures,
          weights: fcrTable.weights,
          values: fcrTable.fcrValues,
        },
        samplingTemp,
        midWeight,
      );
    }
    if (fcr === null && feed?.feedingMatrix2D?.fcrMatrix) {
      fcr = sampleMatrix(
        {
          temperatures: feed.feedingMatrix2D.temperatures,
          weights: feed.feedingMatrix2D.weights,
          values: feed.feedingMatrix2D.fcrMatrix,
        },
        samplingTemp,
        midWeight,
      );
    }
    if (fcr === null) {
      notes.push(
        `${assignment.feedCode ?? assignment.feedId}: FCR örneklenemedi, ${FALLBACK_EXPECTED_FCR} varsayıldı`,
      );
      fcr = FALLBACK_EXPECTED_FCR;
    }

    return {
      minWeightG,
      maxWeightG,
      feedId: assignment.feedId,
      feedCode: feed?.code ?? assignment.feedCode ?? '',
      feedName: feed?.name ?? assignment.feedName ?? '',
      feedingRatePercent: clamp(rate, 0, MAX_FEEDING_RATE_PERCENT),
      expectedFcr: clamp(fcr, MIN_EXPECTED_FCR, MAX_EXPECTED_FCR),
      notes: assignment.notes,
    };
  });

  const enrichedSchedule = convertLegacySchedule(options.enrichment?.defaultSchedule);
  const defaultMealSchedule =
    enrichedSchedule ?? buildEvenMealSchedule(program.settings?.defaultMealsPerDay ?? 4);
  if (!enrichedSchedule) {
    notes.push(
      `Öğün planı ${defaultMealSchedule.mealsPerDay} öğün / 08:00'den eşit dağıtım varsayımıyla üretildi`,
    );
  } else {
    notes.push('Öğün planı batch v1 protokolünden zenginleştirildi');
  }

  const fcrMatrix: FcrMatrix | undefined = fcrTable
    ? {
        temperatures: fcrTable.temperatures,
        weights: fcrTable.weights,
        fcrValues: fcrTable.fcrValues,
      }
    : undefined;

  const settings: ProtocolSettings = {
    autoTransition: program.settings?.autoTransition ?? true,
    transitionBufferG: clamp(program.settings?.transitionBuffer ?? 5, 0, 1000),
    growthApplicationMode:
      program.settings?.growthApplicationMode === 'daily' ? 'daily' : 'per_meal',
    underfeedAlertThresholdPercent: 15,
    fcrSource: useProgramFcr ? ProtocolFcrSource.MATRIX : ProtocolFcrSource.FEED,
    minDissolvedOxygen: options.enrichment?.minDissolvedOxygen ?? undefined,
    adjustments: convertAdjustments(options.enrichment?.defaultSchedule),
    minFeedingRatePercent: program.settings?.minFeedingRatePercent,
    maxFeedingRatePercent: program.settings?.maxFeedingRatePercent,
  };

  return finalizeStatus(
    {
      name: program.name,
      description: program.description ?? undefined,
      speciesId: options.speciesId,
      speciesName: options.speciesName,
      status: program.status === 'active' ? 'active' : 'draft',
      bands,
      temperatureAdjustments: convertTemperatureRanges(options.enrichment?.temperatureRanges),
      defaultMealSchedule,
      fcrMatrix: useProgramFcr ? fcrMatrix : undefined,
      settings,
      isDefault: false,
      notes,
    },
    MIGRATED_PROGRAM_MARKER(program.id),
  );
}

// ============================================================================
// V1 PROTOKOL → V2
// ============================================================================

export interface ConvertV1ProtocolOptions {
  feedsById: Map<string, FeedRef>;
  /** type (lowercase) → o tipteki feed'ler; tekil eşleşme çözülür. */
  feedsByType: Map<string, FeedRef[]>;
  species?: SpeciesRef;
}

export function convertV1ProtocolToV2(
  protocol: LegacyV1ProtocolRow,
  options: ConvertV1ProtocolOptions,
): ConvertedProtocol {
  const notes: string[] = [];
  let allResolved = true;

  const resolveFeedForWeight = (midWeightG: number): FeedRef | null => {
    if (protocol.feedId) {
      const direct = options.feedsById.get(protocol.feedId);
      if (direct) return direct;
      notes.push('Protokol feedId kataloğda bulunamadı');
    }
    const stage = (options.species?.growthStages ?? []).find((candidate) => {
      const factor = candidate.weightUnit === 'kg' ? 1000 : 1;
      return (
        midWeightG >= (candidate.minWeight ?? 0) * factor &&
        midWeightG < (candidate.maxWeight ?? Number.MAX_SAFE_INTEGER) * factor
      );
    });
    const recommendedType = stage?.recommendedFeedType?.toLowerCase();
    if (recommendedType) {
      const candidates = options.feedsByType.get(recommendedType) ?? [];
      if (candidates.length === 1) return candidates[0]!;
      if (candidates.length > 1) {
        notes.push(`'${recommendedType}' tipinde birden çok yem — otomatik seçim yapılmadı`);
      }
    }
    return null;
  };

  const stageBands = (protocol.growthStageProtocols ?? []).filter(
    (stage) =>
      stage &&
      typeof stage.minWeight === 'number' &&
      typeof stage.maxWeight === 'number' &&
      stage.minWeight < stage.maxWeight,
  );

  const rawBands =
    stageBands.length > 0
      ? stageBands.map((stage) => {
          const factor = stage.weightUnit === 'kg' ? 1000 : 1;
          return {
            minWeightG: stage.minWeight * factor,
            maxWeightG: stage.maxWeight * factor,
            feedPercent: stage.feedPercent,
            schedule: stage.schedule,
            notes: stage.notes,
          };
        })
      : [
          {
            minWeightG: 0,
            maxWeightG: 100000,
            feedPercent: FALLBACK_RATE_PERCENT,
            schedule: undefined,
            notes: undefined,
          },
        ];
  if (stageBands.length === 0) {
    notes.push('growthStageProtocols yok; tek kapsayıcı band (0–100000g) üretildi');
  }

  rawBands.sort((a, b) => a.minWeightG - b.minWeightG);
  // Bitişiklik: boşluk önceki bandın uzatılmasıyla kapanır, örtüşme kırpılır.
  for (let i = 0; i < rawBands.length; i++) {
    const band = rawBands[i]!;
    const next = rawBands[i + 1];
    if (next && band.maxWeightG !== next.minWeightG) {
      notes.push(`${band.maxWeightG}g/${next.minWeightG}g sınırı bitişikliğe normalize edildi`);
      band.maxWeightG = next.minWeightG;
    }
  }
  const firstBand = rawBands[0];
  if (firstBand && firstBand.minWeightG > 0) {
    notes.push(`0–${firstBand.minWeightG}g kapsam dışıydı; ilk band 0g'a çekildi`);
    firstBand.minWeightG = 0;
  }

  const speciesStageFcr = (midWeightG: number): number | null => {
    const stage = (options.species?.growthStages ?? []).find((candidate) => {
      const factor = candidate.weightUnit === 'kg' ? 1000 : 1;
      return (
        midWeightG >= (candidate.minWeight ?? 0) * factor &&
        midWeightG < (candidate.maxWeight ?? Number.MAX_SAFE_INTEGER) * factor
      );
    });
    return typeof stage?.targetFCR === 'number' ? stage.targetFCR : null;
  };

  const bands: ProtocolBand[] = rawBands
    .filter((band) => band.minWeightG < band.maxWeightG)
    .map((band) => {
      const midWeight = (band.minWeightG + band.maxWeightG) / 2;
      const feed = resolveFeedForWeight(midWeight);
      if (!feed) allResolved = false;
      const fcr =
        speciesStageFcr(midWeight) ??
        (typeof protocol.targetFcr === 'number' ? protocol.targetFcr : null) ??
        FALLBACK_EXPECTED_FCR;
      const bandSchedule = convertLegacySchedule(band.schedule);
      if (band.schedule?.schedule?.length && !bandSchedule) {
        notes.push(
          `${band.minWeightG}–${band.maxWeightG}g band öğün planı v2 kurallarını sağlamadı; protokol varsayılanı kullanılacak`,
        );
      }
      return {
        minWeightG: band.minWeightG,
        maxWeightG: band.maxWeightG,
        feedId: feed?.id ?? '',
        feedCode: feed?.code ?? '',
        feedName: feed?.name ?? '',
        feedingRatePercent: clamp(
          Number(band.feedPercent) || FALLBACK_RATE_PERCENT,
          0,
          MAX_FEEDING_RATE_PERCENT,
        ),
        expectedFcr: clamp(fcr, MIN_EXPECTED_FCR, MAX_EXPECTED_FCR),
        mealSchedule: bandSchedule ?? undefined,
        notes: band.notes,
      };
    });

  if (!allResolved) {
    notes.push('Bir veya daha çok bandın yemi çözülemedi — operatör onayına kadar DRAFT');
  }

  const defaultMealSchedule =
    convertLegacySchedule(protocol.defaultSchedule) ??
    buildEvenMealSchedule(protocol.defaultSchedule?.totalMealsPerDay ?? 4);

  const settings: ProtocolSettings = {
    autoTransition: true,
    transitionBufferG: 5,
    growthApplicationMode: 'per_meal',
    underfeedAlertThresholdPercent: 15,
    fcrSource: ProtocolFcrSource.BAND,
    minDissolvedOxygen: protocol.minDissolvedOxygen ?? undefined,
    adjustments: convertAdjustments(protocol.defaultSchedule),
  };

  return finalizeStatus(
    {
      name: protocol.name,
      description: protocol.description ?? undefined,
      speciesId: options.species?.id,
      speciesName: options.species?.commonName ?? protocol.species,
      status: allResolved ? 'active' : 'draft',
      bands,
      temperatureAdjustments: convertTemperatureRanges(protocol.temperatureRanges),
      defaultMealSchedule,
      settings,
      isDefault: protocol.isDefault,
      notes,
    },
    MIGRATED_V1_PROTOCOL_MARKER(protocol.id),
  );
}

/** Tenant içinde benzersiz protokol adı üret (çakışmada belirleyici sonek). */
export function resolveUniqueName(
  desired: string,
  takenNames: Set<string>,
  sourceId: string,
): string {
  if (!takenNames.has(desired.toLowerCase())) return desired;
  const withSuffix = `${desired} (migrated)`;
  if (!takenNames.has(withSuffix.toLowerCase())) return withSuffix;
  return `${desired} (migrated-${sourceId.slice(0, 8)})`;
}
