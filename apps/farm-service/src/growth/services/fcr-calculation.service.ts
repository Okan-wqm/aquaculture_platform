/**
 * FCR Calculation Service
 *
 * Feed Conversion Ratio (FCR) hesaplamalarını yapar.
 * FCR = Verilen Yem (kg) / Canlı Ağırlık Artışı (kg)
 *
 * Düşük FCR daha iyidir (daha az yemle daha fazla büyüme).
 *
 * Özellikler:
 * - Periyodik FCR hesaplama
 * - Kümülatif FCR hesaplama
 * - FCR trend analizi
 * - Performans karşılaştırması
 * - Anomali tespiti
 *
 * @module Growth
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, In } from 'typeorm';
import { TenantContextError } from '@aquaculture/backend-common/database';
import { FeedingRecord } from '../../feeding/entities/feeding-record.entity';
import {
  FeedingProgram,
  FeedingProgramStatus,
} from '../../feeding/entities/feeding-program.entity';
import { FeedingProgramTank } from '../../feeding/entities/feeding-program-tank.entity';
import { BatchLocation } from '../../batch/entities/batch-location.entity';
import { GrowthMeasurement, FCRAnalysis } from '../entities/growth-measurement.entity';
import { Batch } from '../../batch/entities/batch.entity';
import { TankOperation, OperationType } from '../../batch/entities/tank-operation.entity';
import { Species } from '../../species/entities/species.entity';
import { ProtocolRateService } from '../../feeding-protocol/services/protocol-rate.service';
import {
  FcrMatrix,
  FeedingProtocolStatus,
  ProtocolBand,
  ProtocolFcrSource,
  ProtocolSettings,
} from '../../feeding-protocol/entities/feeding-protocol-v2.entity';
import {
  AssignmentOverrides,
  ProtocolAssignmentStatus,
} from '../../feeding-protocol/entities/protocol-assignment.entity';

/** Ünitenin aktif v2 protokol satırı — hedef-FCR zincirinin 2. adımının girdisi. */
interface ProtocolFcrRow {
  overrides: AssignmentOverrides | null;
  bands: ProtocolBand[] | null;
  settings: ProtocolSettings | null;
  fcrMatrix: FcrMatrix | null;
}

/**
 * Hedef-FCR zincirinin okuduğu satırların toplu ön-yüklemesi (W5,
 * FARM-LOW-291). Zincirin KENDİSİ değişmez; yalnız satırların nereden
 * geldiği değişir — bu yüzden tekil ve toplu yol sapamaz.
 */
/** Legacy (v1) programın FCR tablosu — zincirin 3. adımı, Faz 8'de düşer. */
interface LegacyProgramFcrRow {
  batchId: string;
  fcrTable: { temperatures: number[]; weights: number[]; fcrValues: number[][] } | null;
}

interface TargetFcrPrefetch {
  batchById: Map<string, Batch>;
  /** null = "bu batch için aktif v2 protokol YOK" (eksik anahtar ≠ null). */
  protocolRowByBatch: Map<string, ProtocolFcrRow | null>;
  feedMatrixByFeedId: Map<string, FcrMatrix | undefined>;
  /**
   * Zincirin LEGACY bacağı, toplu (FARM-LOW-291). null = "aktif legacy program
   * yok"; eksik anahtar ≠ null.
   *
   * Bu bacak toplu değilken, dış iki çağrının toplulaştırılmış olması N+1'i
   * kapatmıyordu: adım 2 (v2 protokol) `null` dönen HER batch adım 3'e
   * düşüyor ve orada batch başına İKİ sorgu atıyordu — `batch_locations` ve
   * `feeding_program_tanks`. Cutover'ı tamamlamamış ya da üniteleri kısmen
   * atanmış bir tenant'ta bu, batch'lerin ÇOĞUNLUĞU demektir; yani "toplu"
   * API, bulgunun tarif ettiği tam sorguyu atmaya devam ediyordu.
   */
  legacyProgramByBatch: Map<string, LegacyProgramFcrRow['fcrTable']>;
}

/** Regresyon için yetersiz veri — tekil ve toplu yolun ORTAK dönüşü. */
const INSUFFICIENT_TREND: FCRTrendAnalysis = {
  trend: 'stable',
  slope: 0,
  correlation: 0,
  forecast7Days: 0,
  recommendations: ['Yeterli veri yok - daha fazla ölçüm gerekli'],
};

/** `Feed.feedingMatrix2D` → `FcrMatrix` — SAF (tekil ve toplu yol paylaşır). */
function toFcrMatrix(
  matrix: { temperatures: number[]; weights: number[]; fcrMatrix?: number[][] } | null,
): FcrMatrix | undefined {
  if (!matrix?.fcrMatrix?.length) return undefined;
  return {
    temperatures: matrix.temperatures,
    weights: matrix.weights,
    fcrValues: matrix.fcrMatrix,
  };
}

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * FCR hesaplama girdisi
 */
export interface FCRCalculationInput {
  batchId: string;
  tenantId: string;
  startDate: Date;
  endDate: Date;
  targetFCR?: number;
}

/**
 * FCR hesaplama sonucu
 */
export interface FCRCalculationResult {
  periodFCR: number;
  cumulativeFCR: number;
  analysis: FCRAnalysis;
  isValid: boolean;
  warnings: string[];
}

/**
 * FCR trend analizi
 */
export interface FCRTrendAnalysis {
  trend: 'improving' | 'stable' | 'declining';
  slope: number; // Günlük değişim oranı
  correlation: number; // R-squared
  forecast7Days: number; // 7 günlük tahmin
  recommendations: string[];
}

/**
 * FCR karşılaştırma sonucu
 */
export interface FCRComparison {
  currentFCR: number;
  targetFCR: number;
  industryAvgFCR: number;
  varianceFromTarget: number; // %
  varianceFromIndustry: number; // %
  performance: 'excellent' | 'good' | 'average' | 'below_average' | 'poor';
}

/**
 * Batch FCR özeti
 */
export interface BatchFCRSummary {
  batchId: string;
  batchCode: string;
  speciesName: string;

  // Miktar bilgileri
  totalFeedGiven: number; // kg
  totalGrowth: number; // kg
  startBiomass: number; // kg
  currentBiomass: number; // kg

  // FCR metrikleri
  currentFCR: number;
  bestFCR: number;
  worstFCR: number;
  avgFCR: number;
  targetFCR: number;

  // Trend
  trend: 'improving' | 'stable' | 'declining';
  measurementCount: number;

  // Performans
  performance: 'excellent' | 'good' | 'average' | 'below_average' | 'poor';
  recommendations: string[];
}

/**
 * Feed, realized growth and net removed biomass over one FCR window, as the
 * single computation (`computeFcrOverWindows`) returns them.
 */
interface FcrWindowTotals {
  readonly totalFeed: number;
  readonly totalGrowth: number;
  readonly removedBiomassKg: number;
}

/**
 * One batch's cumulative FCR from stocking to now (`calculateCumulativeFCR`).
 * Its window is the one FARM-MEDIUM-450 describes; the 18:00 sweep judges
 * FcrAtLastWeighing instead.
 */
export interface CumulativeFcr extends FcrWindowTotals {
  /** totalFeed / totalGrowth. 0 means no realized growth yet, not perfect conversion. */
  fcr: number;
}

/** The result for a batch that does not exist in the tenant: nothing fed, nothing grown. */
const NO_CUMULATIVE_FCR: CumulativeFcr = {
  fcr: 0,
  totalFeed: 0,
  totalGrowth: 0,
  removedBiomassKg: 0,
};

/** A weighed batch's window totals, and the weighing day the window ends on. */
type WeighedWindow = FcrWindowTotals & {
  /** The weighing day the window ends on (`weight.actual.lastMeasuredAt`). */
  readonly weighedOn: Date;
};

/**
 * A batch's FCR judged at its last weighing: feed and the removal ledger up to
 * the weighing day, against the biomass at the end of that day.
 *
 * WHY the weighing and not "now" (FARM-CRITICAL-444 review): feed is recorded
 * every day, but growth is known only when the batch is weighed. Feed up to
 * today over growth up to the last weighing rises every day between weighings,
 * so a batch converting exactly on target (1.5% of biomass fed per day) read
 * more than 10% over target about five days after each weighing and more than
 * 20% over about eleven days after. At the weighing, feed, ledger and biomass
 * describe the same moment.
 *
 * - `unweighed`: not weighed since stocking (`weight.actual.sampleSize` is 0,
 *   as CreateBatchHandler leaves it), or no such batch. The weight is still the
 *   stocking weight, so growth is unknown: any "growth" is only the rounding
 *   residue of the removal ledger, and FCR over it would be noise.
 * - `unfed`: weighed, but no feed recorded up to the weighing.
 * - `not-growing`: weighed and fed, but no realized growth. FCR is undefined,
 *   worse than any target, so this variant carries no `fcr` at all.
 * - `converting`: weighed, fed and grown; `fcr` = totalFeed / totalGrowth. Only
 *   this variant has an FCR, so a reader cannot take a 0 for "on target"
 *   (the FARM-MEDIUM-446 defect class) without narrowing on `kind` first.
 */
export type FcrAtLastWeighing =
  | { readonly kind: 'unweighed' }
  | (WeighedWindow & { readonly kind: 'unfed' | 'not-growing' })
  | (WeighedWindow & { readonly kind: 'converting'; readonly fcr: number });

const UNWEIGHED: FcrAtLastWeighing = { kind: 'unweighed' };

/** One batch's FCR window: everything recorded up to `endsOn`, against its end biomass. */
interface FcrWindow {
  readonly batch: Batch;
  /** Last calendar day counted (feed and ledger dated on or before it); null counts all. */
  readonly endsOn: Date | null;
  /**
   * The batch's live biomass at the end of the window, kg, given its head count
   * at the end of that day (see WINDOW_LEDGER_SQL). A window decides how the
   * count turns into biomass; the count itself comes from the same statement
   * as the ledger cut.
   */
  readonly endBiomassKg: (headCountAtEnd: number) => number;
}

/**
 * The TankOperation types that move biomass out of a batch (mortality, cull,
 * harvest, transfer-out) or into it without feed (transfer-in).
 */
const FCR_LEDGER_OPERATION_TYPES: readonly OperationType[] = [
  OperationType.MORTALITY,
  OperationType.CULL,
  OperationType.HARVEST,
  OperationType.TRANSFER_OUT,
  OperationType.TRANSFER_IN,
];

/**
 * Feed given to each batch up to its own window end. The windows are two
 * aligned arrays, so every batch gets its own end in one statement whatever
 * the batch count. A batch with no feeding record in its window has no row.
 *
 * Params: $1 tenantId, $2 batch ids (uuid[]), $3 window ends (date[], NULL =
 * no end).
 */
const WINDOW_FEED_TOTALS_SQL = `
  SELECT w."batchId"::text AS "batchId", SUM(fr."actualAmount") AS "totalFeed"
    FROM unnest($2::uuid[], $3::date[]) AS w("batchId", "endsOn")
    JOIN "feeding_records" fr
      ON fr."tenantId" = $1
     AND fr."batchId" = w."batchId"
     AND (w."endsOn" IS NULL OR fr."feedingDate" <= w."endsOn")
   GROUP BY w."batchId"`;

/**
 * For each batch's window, from the TankOperation ledger and the batch row:
 *
 * - `netRemovedKg`: the biomass that left the batch up to the window's end.
 *   Removals count positive and transfer-ins negative, so a move between two
 *   tanks of the same batch nets to zero.
 * - `headCountAtEnd`: the batch's head count at the end of the window's last
 *   day. It is the live count plus the fish the same ledger types moved out
 *   after that day, minus those moved in after it. Every handler that changes
 *   a production batch's `currentQuantity` writes such a row with the same
 *   quantity in the same transaction (mortality, cull, harvest), or
 *   soft-deletes it while restoring the count (harvest cancellation), so the
 *   count and the ledger cut describe the same moment whatever order the
 *   events were recorded in. An open window (no end) gets the live count.
 *   Cleaner-fish batches move through CLEANER_* rows, which neither term
 *   reads, as before.
 *
 * WHY the count comes from here and not from the weighing (FARM-CRITICAL-444
 * review, round 2): the growth-sample handlers store `populationSize x
 * average` as the weighed biomass, and `populationSize` is whatever the
 * operator typed, or the live count when the sample is entered. A removal
 * dated on the weighing day but entered after the sample was then in both the
 * biomass and the ledger, and a backdated sample lost every fish removed after
 * its date. Reading the live count in the same statement as the ledger also
 * means a removal committed while the sweep runs is in both terms or in
 * neither.
 *
 * Every window batch that exists in the tenant has exactly one row.
 *
 * Params: $1 tenantId, $2 batch ids (uuid[]), $3 window ends (date[], NULL =
 * no end), $4 ledger operation types, $5 OperationType.TRANSFER_IN. The types
 * are bound from the enum (FARM-HIGH-445).
 */
const WINDOW_LEDGER_SQL = `
  SELECT w."batchId"::text AS "batchId",
         COALESCE(SUM(CASE WHEN op."operationType" = $5 THEN -COALESCE(op."biomassKg", 0)
                           ELSE COALESCE(op."biomassKg", 0) END)
                    FILTER (WHERE w."endsOn" IS NULL OR op."operationDate" <= w."endsOn"),
                  0) AS "netRemovedKg",
         b."currentQuantity"
           + COALESCE(SUM(CASE WHEN op."operationType" = $5 THEN -op."quantity"
                               ELSE op."quantity" END)
                        FILTER (WHERE op."operationDate" > w."endsOn"),
                      0) AS "headCountAtEnd"
    FROM unnest($2::uuid[], $3::date[]) AS w("batchId", "endsOn")
    JOIN "batches_v2" b
      ON b."tenantId" = $1
     AND b."id" = w."batchId"
    LEFT JOIN "tank_operations" op
      ON op."tenantId" = $1
     AND op."batchId" = w."batchId"
     AND op."isDeleted" = false
     AND op."operationType" = ANY($4)
   GROUP BY w."batchId", b."currentQuantity"`;

/** Stocked biomass, kg: initialQuantity x the stocking average weight. */
function startBiomassKg(batch: Batch): number {
  const initialWeight = batch.weight?.initial?.avgWeight || 0;
  return (batch.initialQuantity * initialWeight) / 1000;
}

// ============================================================================
// SERVICE
// ============================================================================

@Injectable()
export class FCRCalculationService {
  private readonly logger = new Logger(FCRCalculationService.name);

  // Endüstri ortalama FCR değerleri (tür bazlı)
  private readonly industryAverageFCR: Record<string, number> = {
    atlantic_salmon: 1.2,
    rainbow_trout: 1.1,
    sea_bass: 1.8,
    sea_bream: 2.0,
    tilapia: 1.6,
    catfish: 1.5,
    shrimp: 1.8,
    default: 1.5,
  };

  constructor(
    @InjectRepository(FeedingRecord)
    private readonly feedingRecordRepository: Repository<FeedingRecord>,
    @InjectRepository(GrowthMeasurement)
    private readonly growthMeasurementRepository: Repository<GrowthMeasurement>,
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @InjectRepository(Species)
    private readonly speciesRepository: Repository<Species>,
    @InjectRepository(BatchLocation)
    private readonly batchLocationRepository: Repository<BatchLocation>,
    @InjectRepository(FeedingProgram)
    private readonly feedingProgramRepository: Repository<FeedingProgram>,
    @InjectRepository(FeedingProgramTank)
    private readonly feedingProgramTankRepository: Repository<FeedingProgramTank>,
    @InjectRepository(TankOperation)
    private readonly tankOperationRepository: Repository<TankOperation>,
    private readonly protocolRateService: ProtocolRateService,
  ) {}

  // -------------------------------------------------------------------------
  // ANA HESAPLAMA METODLARİ
  // -------------------------------------------------------------------------

  /**
   * Belirli bir periyot için FCR hesaplar
   */
  async calculatePeriodFCR(input: FCRCalculationInput): Promise<FCRCalculationResult> {
    const { batchId, tenantId, startDate, endDate, targetFCR } = input;
    const warnings: string[] = [];

    // Periyottaki yemleme kayıtlarını al
    const feedingRecords = await this.feedingRecordRepository.find({
      where: {
        tenantId,
        batchId,
        feedingDate: Between(startDate, endDate),
      },
    });

    // Periyot başı ve sonu büyüme ölçümlerini al
    const measurements = await this.growthMeasurementRepository.find({
      where: {
        tenantId,
        batchId,
        measurementDate: Between(startDate, endDate),
      },
      order: { measurementDate: 'ASC' },
    });

    if (measurements.length < 2) {
      warnings.push('Yetersiz büyüme ölçümü - en az 2 ölçüm gerekli');
      return this.createEmptyResult(warnings);
    }

    // Toplam verilen yem (kg)
    const totalFeed = feedingRecords.reduce((sum, record) => sum + Number(record.actualAmount), 0);

    // Büyüme hesabı (başlangıç vs son biomass)
    const startMeasurement = measurements[0];
    const endMeasurement = measurements[measurements.length - 1];

    if (!startMeasurement || !endMeasurement) {
      warnings.push('Yetersiz ölçüm verisi');
      return this.createEmptyResult(warnings);
    }

    const startBiomass = startMeasurement.estimatedBiomass;
    const endBiomass = endMeasurement.estimatedBiomass;
    const growthKg = endBiomass - startBiomass;

    if (growthKg <= 0) {
      warnings.push('Negatif veya sıfır büyüme tespit edildi');
      return this.createEmptyResult(warnings);
    }

    // Periyod FCR
    const periodFCR = totalFeed / growthKg;

    // Kümülatif FCR hesapla
    const cumulativeResult = await this.calculateCumulativeFCR(batchId, tenantId, endDate);

    // FCR trend analizi
    const trendAnalysis = await this.analyzeFCRTrend(batchId, tenantId);

    // Target FCR varsayılan
    const effectiveTargetFCR = targetFCR || (await this.getTargetFCR(batchId));

    // Analiz oluştur
    // Edge case: when effectiveTargetFCR=0, fcrVariance calculation would divide by zero; return 0
    const fcrVariance =
      effectiveTargetFCR === 0 || effectiveTargetFCR === null || effectiveTargetFCR === undefined
        ? 0
        : ((cumulativeResult.fcr - effectiveTargetFCR) / effectiveTargetFCR) * 100;

    const analysis: FCRAnalysis = {
      periodFeedGiven: totalFeed,
      periodGrowth: growthKg,
      periodFCR,
      cumulativeFeedGiven: cumulativeResult.totalFeed,
      cumulativeGrowth: cumulativeResult.totalGrowth,
      cumulativeFCR: cumulativeResult.fcr,
      targetFCR: effectiveTargetFCR,
      fcrVariance,
      fcrTrend: trendAnalysis.trend,
    };

    // Validasyonlar
    if (periodFCR < 0.5 || periodFCR > 5) {
      warnings.push(`Anormal FCR değeri: ${periodFCR.toFixed(2)} - veri doğruluğunu kontrol edin`);
    }

    return {
      periodFCR,
      cumulativeFCR: cumulativeResult.fcr,
      analysis,
      isValid: warnings.length === 0,
      warnings,
    };
  }

  /**
   * Kümülatif FCR hesaplar (batch başından bugüne).
   *
   * Realized growth is corrected with the TankOperation ledger: biomass that
   * left the system via mortality / cull / harvest / transfer-out also grew by
   * consuming feed, so a plain `current − start` difference undercounts it and
   * overstates FCR (masking the herd-health degradation FCR exists to surface).
   * Transfer-ins are feed-free biomass entering the batch and are subtracted.
   *
   *   realized growth = (current biomass + net removed biomass) − start
   *   net removed     = Σ(mortality + cull + harvest + transfer_out) − Σ(transfer_in)
   *
   * There is one FCR computation, computeFcrOverWindows; this builds the
   * batch's to-now window for it.
   */
  async calculateCumulativeFCR(
    batchId: string,
    tenantId: string,
    endDate?: Date,
  ): Promise<CumulativeFcr> {
    const batch = await this.batchRepository.findOne({ where: { tenantId, id: batchId } });
    if (batch === null) return NO_CUMULATIVE_FCR;

    const window: FcrWindow = {
      batch,
      endsOn: endDate ?? null,
      // The to-now window's end biomass is the current biomass whatever
      // `endDate` says: the derive-on-read value (currentQuantity ×
      // effectiveAvgWeightG / 1000) the GraphQL resolver and the removal
      // handlers read, or the stocked biomass once the count is 0. Its feed
      // and ledger are cut at `endDate` but its biomass is not, and an emptied
      // batch's growth is overstated: both are FARM-MEDIUM-450, which this
      // window keeps for its read paths and CloseBatchHandler. The 18:00 sweep
      // judges calculateFcrAtLastWeighingMany instead.
      endBiomassKg: () =>
        batch.currentQuantity > 0 ? batch.getCurrentBiomass() : startBiomassKg(batch),
    };
    const [computed] = await this.computeFcrOverWindows(tenantId, [window]);
    // No row: the batch is gone from the tenant between the two reads.
    if (computed === undefined) return NO_CUMULATIVE_FCR;
    const [, totals] = computed;
    return {
      ...totals,
      fcr: totals.totalGrowth > 0 ? totals.totalFeed / totals.totalGrowth : 0,
    };
  }

  /**
   * Each batch's FCR at its last weighing (see FcrAtLastWeighing), in three
   * queries whatever the batch count.
   *
   * WHY it exists: the 18:00 FCR sweep judges every live batch of a tenant
   * (FARM-CRITICAL-444). It needs a window in which feed and growth describe
   * the same moment, and it must not judge a batch nobody has weighed.
   *
   * The window ends on `weight.actual.lastMeasuredAt`, the weighing day. Its
   * biomass is the batch's head count at the end of that day (the live count
   * with the ledger's later removals added back, WINDOW_LEDGER_SQL) times the
   * weighed average `weight.actual.avgWeight`. The two growth-sample handlers
   * are the only writers of `avgWeight`, and they write it together with
   * `lastMeasuredAt` from the same sample, so the day and the average belong
   * to one weighing. The typed `populationSize`, and the `totalBiomass` the
   * handlers derive from it, are not read: they describe the moment the sample
   * was entered and whatever count the operator typed, not the batch on the
   * weighing day. Days are calendar days: feed and removals dated on the
   * weighing day count, and the fish they removed are not in the count.
   *
   * Every requested id gets an entry; an id with no batch row is `unweighed`.
   */
  async calculateFcrAtLastWeighingMany(
    tenantId: string,
    batchIds: readonly string[],
  ): Promise<Map<string, FcrAtLastWeighing>> {
    const ids = [...new Set(batchIds)];
    const results = new Map<string, FcrAtLastWeighing>(ids.map((id) => [id, UNWEIGHED]));
    if (ids.length === 0) return results;

    const batches = await this.batchRepository.find({
      where: { tenantId, id: In(ids) },
    });
    const windows = batches
      .filter((batch) => batch.weight.actual.sampleSize > 0)
      .map((batch) => {
        const weighedAvgWeightG = batch.weight.actual.avgWeight;
        return {
          batch,
          // JSONB hands the stored timestamp back as an ISO string, not a Date.
          endsOn: new Date(batch.weight.actual.lastMeasuredAt),
          endBiomassKg: (headCountAtEnd: number): number =>
            (headCountAtEnd * weighedAvgWeightG) / 1000,
        };
      });
    for (const [window, totals] of await this.computeFcrOverWindows(tenantId, windows)) {
      const weighed: WeighedWindow = { ...totals, weighedOn: window.endsOn };
      results.set(
        window.batch.id,
        totals.totalFeed <= 0
          ? { ...weighed, kind: 'unfed' }
          : totals.totalGrowth <= 0
            ? { ...weighed, kind: 'not-growing' }
            : { ...weighed, kind: 'converting', fcr: totals.totalFeed / totals.totalGrowth },
      );
    }
    return results;
  }

  /**
   * The one FCR computation: for each window, the feed given and the net
   * biomass removed up to its end, the head count at its end, and
   *
   *   realized growth = end biomass + net removed − stocked biomass
   *
   * where the window turns the head count into its end biomass. Two queries
   * whatever the window count (WINDOW_FEED_TOTALS_SQL, WINDOW_LEDGER_SQL);
   * every query filters on tenantId as defence in depth on top of the tenant
   * search_path routing (ADR-011). A window whose batch has no row in the
   * ledger statement (gone from the tenant since it was read) is left out.
   */
  private async computeFcrOverWindows<W extends FcrWindow>(
    tenantId: string,
    windows: readonly W[],
  ): Promise<Array<readonly [W, FcrWindowTotals]>> {
    if (windows.length === 0) return [];
    const batchIds = windows.map((window) => window.batch.id);
    const windowEnds = windows.map((window) => window.endsOn);

    const feedRows: Array<{ batchId: string; totalFeed: string | number }> =
      await this.feedingRecordRepository.manager.query(WINDOW_FEED_TOTALS_SQL, [
        tenantId,
        batchIds,
        windowEnds,
      ]);
    // A batch with no feeding record in its window has no row: it was fed 0 kg.
    const totalFeedByBatch = new Map(feedRows.map((row) => [row.batchId, Number(row.totalFeed)]));

    const ledgerRows: Array<{
      batchId: string;
      netRemovedKg: string | number;
      headCountAtEnd: string | number;
    }> = await this.tankOperationRepository.manager.query(WINDOW_LEDGER_SQL, [
      tenantId,
      batchIds,
      windowEnds,
      // Spread: the constant is readonly, the driver's parameter list is not.
      [...FCR_LEDGER_OPERATION_TYPES],
      OperationType.TRANSFER_IN,
    ]);
    const ledgerByBatch = new Map(
      ledgerRows.map((row) => [
        row.batchId,
        { removedBiomassKg: Number(row.netRemovedKg), headCountAtEnd: Number(row.headCountAtEnd) },
      ]),
    );

    return windows.flatMap((window) => {
      const ledger = ledgerByBatch.get(window.batch.id);
      if (ledger === undefined) return [];
      const totalFeed = totalFeedByBatch.get(window.batch.id) ?? 0;
      const { removedBiomassKg, headCountAtEnd } = ledger;
      // Realized growth includes the growth of biomass that exited the system.
      const totalGrowth =
        window.endBiomassKg(headCountAtEnd) + removedBiomassKg - startBiomassKg(window.batch);
      return [[window, { totalFeed, totalGrowth, removedBiomassKg }] as const];
    });
  }

  /**
   * FCR trend analizi yapar
   */
  async analyzeFCRTrend(batchId: string, tenantId: string): Promise<FCRTrendAnalysis> {
    const trends = await this.analyzeFCRTrendMany(tenantId, [batchId]);
    return trends.get(batchId) ?? INSUFFICIENT_TREND;
  }

  /**
   * FCR trend analizi — TOPLU (W5, FARM-LOW-291).
   *
   * 18:00 süpürmesi eşiği aşan HER batch için ayrı bir "son 10 ölçüm"
   * sorgusu atıyordu. Pencere fonksiyonu aynı satırları TEK sorguda getirir;
   * regresyon zaten saf hesap olduğu için bellekte koşar. Tekil yol bu
   * metoda delege eder — iki trend implementasyonu yok.
   */
  async analyzeFCRTrendMany(
    tenantId: string,
    batchIds: string[],
  ): Promise<Map<string, FCRTrendAnalysis>> {
    const trends = new Map<string, FCRTrendAnalysis>();
    if (batchIds.length === 0) return trends;

    const rows: Array<{ batchId: string; fcrAnalysis: FCRAnalysis | null }> =
      await this.growthMeasurementRepository.manager.query(
        `SELECT ranked."batchId", ranked."fcrAnalysis"
           FROM (
             SELECT gm."batchId",
                    gm."fcrAnalysis",
                    ROW_NUMBER() OVER (
                      PARTITION BY gm."batchId" ORDER BY gm."measurementDate" DESC
                    ) AS rn
               FROM "growth_measurements" gm
              WHERE gm."tenantId" = $1 AND gm."batchId" = ANY($2::uuid[])
           ) ranked
          WHERE ranked.rn <= 10
          ORDER BY ranked."batchId", ranked.rn ASC`,
        [tenantId, batchIds],
      );

    const byBatch = new Map<string, Array<{ fcrAnalysis: FCRAnalysis | null }>>();
    for (const row of rows) {
      const list = byBatch.get(row.batchId) ?? [];
      list.push({ fcrAnalysis: row.fcrAnalysis });
      byBatch.set(row.batchId, list);
    }
    for (const batchId of batchIds) {
      trends.set(batchId, this.computeFcrTrend(byBatch.get(batchId) ?? []));
    }
    return trends;
  }

  /**
   * Trend hesabı — ölçümler YENİDEN ESKİYE sıralı gelir (tekil sorgunun
   * eski davranışıyla birebir).
   */
  private computeFcrTrend(
    measurements: Array<{ fcrAnalysis?: FCRAnalysis | null }>,
  ): FCRTrendAnalysis {
    if (measurements.length < 3) {
      return INSUFFICIENT_TREND;
    }

    // FCR değerlerini çıkar
    const fcrValues = measurements
      .filter((m) => m.fcrAnalysis?.periodFCR)
      .map((m, index) => ({
        x: index,
        y: m.fcrAnalysis!.periodFCR,
      }))
      .reverse(); // Kronolojik sıra

    if (fcrValues.length < 3) {
      return {
        trend: 'stable',
        slope: 0,
        correlation: 0,
        forecast7Days: measurements[0]?.fcrAnalysis?.cumulativeFCR || 0,
        recommendations: ['FCR verileri eksik'],
      };
    }

    // Lineer regresyon
    const { slope, correlation } = this.linearRegression(fcrValues);

    // Trend belirleme
    let trend: 'improving' | 'stable' | 'declining';
    if (slope < -0.01) {
      trend = 'improving'; // FCR düşüyor = iyi
    } else if (slope > 0.01) {
      trend = 'declining'; // FCR artıyor = kötü
    } else {
      trend = 'stable';
    }

    // 7 günlük tahmin
    const lastFcrValue = fcrValues[fcrValues.length - 1];
    const lastFCR = lastFcrValue?.y ?? 0;
    const forecast7Days = lastFCR + slope * 7;

    // Öneriler
    const recommendations = this.generateTrendRecommendations(trend, slope, lastFCR);

    return {
      trend,
      slope,
      correlation,
      forecast7Days: Math.max(0.5, forecast7Days), // Minimum 0.5
      recommendations,
    };
  }

  /**
   * FCR karşılaştırması yapar
   */
  async compareFCR(
    batchId: string,
    tenantId: string,
    speciesType?: string,
  ): Promise<FCRComparison> {
    const batch = await this.batchRepository.findOne({
      where: { id: batchId, tenantId },
    });

    const cumulativeResult = await this.calculateCumulativeFCR(batchId, tenantId);
    const currentFCR = cumulativeResult.fcr;

    // Target FCR (batch'ten veya varsayılan)
    const targetFCR = (await this.getTargetFCR(batchId)) || 1.5;

    // Endüstri ortalaması
    const industryAvgFCR = this.industryAverageFCR[speciesType || 'default'] || 1.5;

    // Varyanslar
    // Edge case: when targetFCR=0, variance calculation would divide by zero; return 0
    const varianceFromTarget =
      targetFCR === 0 || targetFCR === null || targetFCR === undefined
        ? 0
        : ((currentFCR - targetFCR) / targetFCR) * 100;
    // Edge case: when industryAvgFCR=0, variance calculation would divide by zero; return 0
    const varianceFromIndustry =
      industryAvgFCR === 0 || industryAvgFCR === null || industryAvgFCR === undefined
        ? 0
        : ((currentFCR - industryAvgFCR) / industryAvgFCR) * 100;

    // Performans değerlendirmesi
    let performance: FCRComparison['performance'];
    if (varianceFromTarget <= -10) {
      performance = 'excellent';
    } else if (varianceFromTarget <= 0) {
      performance = 'good';
    } else if (varianceFromTarget <= 10) {
      performance = 'average';
    } else if (varianceFromTarget <= 20) {
      performance = 'below_average';
    } else {
      performance = 'poor';
    }

    return {
      currentFCR,
      targetFCR,
      industryAvgFCR,
      varianceFromTarget,
      varianceFromIndustry,
      performance,
    };
  }

  /**
   * Batch FCR özeti oluşturur
   */
  async getBatchFCRSummary(batchId: string, tenantId: string): Promise<BatchFCRSummary | null> {
    const batch = await this.batchRepository.findOne({
      where: { id: batchId, tenantId },
    });

    if (!batch) {
      return null;
    }

    // Tüm ölçümleri al
    const measurements = await this.growthMeasurementRepository.find({
      where: { tenantId, batchId },
      order: { measurementDate: 'ASC' },
    });

    // Kümülatif hesapla
    const cumulativeResult = await this.calculateCumulativeFCR(batchId, tenantId);

    // FCR değerlerini çıkar
    const fcrValues = measurements
      .filter((m) => m.fcrAnalysis?.periodFCR)
      .map((m) => m.fcrAnalysis!.periodFCR);

    const bestFCR = fcrValues.length > 0 ? Math.min(...fcrValues) : 0;
    const worstFCR = fcrValues.length > 0 ? Math.max(...fcrValues) : 0;
    const avgFCR =
      fcrValues.length > 0 ? fcrValues.reduce((a, b) => a + b, 0) / fcrValues.length : 0;

    // Trend analizi
    const trendAnalysis = await this.analyzeFCRTrend(batchId, tenantId);

    // Karşılaştırma
    const comparison = await this.compareFCR(batchId, tenantId);

    // Başlangıç biomass
    const initialWeightG = batch.weight?.initial?.avgWeight || 0;
    const startBiomass = (batch.initialQuantity * initialWeightG) / 1000;

    // Son ölçümden güncel biomass
    const latestMeasurement = measurements[measurements.length - 1];
    const currentBiomass = latestMeasurement?.estimatedBiomass || startBiomass;

    return {
      batchId,
      batchCode: batch.batchNumber,
      speciesName: '', // Species'ten alınacak
      totalFeedGiven: cumulativeResult.totalFeed,
      totalGrowth: cumulativeResult.totalGrowth,
      startBiomass,
      currentBiomass,
      currentFCR: cumulativeResult.fcr,
      bestFCR,
      worstFCR,
      avgFCR,
      targetFCR: comparison.targetFCR,
      trend: trendAnalysis.trend,
      measurementCount: measurements.length,
      performance: comparison.performance,
      recommendations: trendAnalysis.recommendations,
    };
  }

  // -------------------------------------------------------------------------
  // ANOMALY DETECTION
  // -------------------------------------------------------------------------

  /**
   * FCR anomalileri tespit eder
   */
  async detectFCRAnomalies(
    batchId: string,
    tenantId: string,
  ): Promise<{ hasAnomaly: boolean; anomalies: string[] }> {
    const anomalies: string[] = [];

    const cumulativeResult = await this.calculateCumulativeFCR(batchId, tenantId);
    const comparison = await this.compareFCR(batchId, tenantId);
    const trendAnalysis = await this.analyzeFCRTrend(batchId, tenantId);

    // Çok yüksek FCR
    if (cumulativeResult.fcr > 3) {
      anomalies.push(
        `Kritik: FCR çok yüksek (${cumulativeResult.fcr.toFixed(2)}) - yemleme veya ölçüm hatası olabilir`,
      );
    }

    // Çok düşük FCR (şüpheli)
    if (cumulativeResult.fcr < 0.7 && cumulativeResult.fcr > 0) {
      anomalies.push(
        `Uyarı: FCR çok düşük (${cumulativeResult.fcr.toFixed(2)}) - veri doğruluğunu kontrol edin`,
      );
    }

    // Hedeften %30+ sapma
    if (Math.abs(comparison.varianceFromTarget) > 30) {
      anomalies.push(
        `Önemli sapma: FCR hedeften %${comparison.varianceFromTarget.toFixed(1)} farklı`,
      );
    }

    // Hızlı kötüleşme
    if (trendAnalysis.trend === 'declining' && trendAnalysis.slope > 0.05) {
      anomalies.push(
        `Uyarı: FCR hızla kötüleşiyor (günlük +${(trendAnalysis.slope * 100).toFixed(2)}%)`,
      );
    }

    return {
      hasAnomaly: anomalies.length > 0,
      anomalies,
    };
  }

  // -------------------------------------------------------------------------
  // HELPER METHODS
  // -------------------------------------------------------------------------

  /**
   * Hedef FCR'ın public yüzeyi (P-14 zinciri) — 18:00 FCR alert süpürmesi
   * (`FeedingCronV2Service.fcrAlertSweep`) hedefi buradan okur: alert eşiği,
   * motorun plan/snapshot hesabıyla AYNI hedefe karşı ölçülür (C-1).
   */
  async getTargetFCRForBatch(batchId: string): Promise<number> {
    return this.getTargetFCR(batchId);
  }

  /**
   * Hedef FCR — TOPLU (W5, FARM-LOW-291).
   *
   * 18:00 süpürmesi bunu tenant'ın TÜM aktif batch'leri için tek çağrıda
   * kullanır. Zincir tek yerde kalır: bu metot yalnız zincirin okuduğu
   * satırları ÖN-YÜKLER ve aynı `getTargetFCR` fonksiyonunu besler — ikinci
   * bir "toplu hesap" implementasyonu YOKTUR, dolayısıyla tekil ve toplu yol
   * birbirinden sapamaz (tier-2: doğru davranış zero-effort varsayılan).
   *
   * Ön-yükleme üç toplu sorgudur (batch+species, ünitenin aktif v2 protokol
   * satırı, fcrSource=feed yem matrisleri); eskiden bunlar batch BAŞINA
   * atılıyordu ve 400 batch'lik bir tenant süpürmesi 1200+ round-trip
   * demekti.
   */
  async getTargetFCRForBatches(tenantId: string, batchIds: string[]): Promise<Map<string, number>> {
    const targets = new Map<string, number>();
    if (batchIds.length === 0) return targets;

    const prefetch = await this.prefetchTargetFcrContext(tenantId, batchIds);
    for (const batchId of batchIds) {
      targets.set(batchId, await this.getTargetFCR(batchId, prefetch));
    }
    return targets;
  }

  /** Zincirin okuduğu satırların toplu ön-yüklemesi (yukarıdaki docblock). */
  private async prefetchTargetFcrContext(
    tenantId: string,
    batchIds: string[],
  ): Promise<TargetFcrPrefetch> {
    const batches = await this.batchRepository.find({
      where: { tenantId, id: In(batchIds) },
      relations: ['species'],
    });
    const batchById = new Map(batches.map((batch) => [batch.id, batch]));

    // Ünite → aktif v2 atama → ACTIVE protokol; çok-üniteli batch'te dominant
    // (en yüksek biyokütle) ünite kazanır — tekil sorguyla BİREBİR kural.
    // Both statuses are bound from their enums, never typed as literals
    // (FARM-HIGH-445): PostgreSQL rejects a value the enum does not have, and
    // only at runtime.
    const protocolRows: Array<ProtocolFcrRow & { batchId: string }> =
      await this.batchRepository.manager.query(
        `SELECT b.id::text AS "batchId",
                x."overrides" AS overrides,
                x."bands" AS bands,
                x."settings" AS settings,
                x."fcrMatrix" AS "fcrMatrix"
           FROM unnest($2::uuid[]) AS b(id)
           JOIN LATERAL (
             SELECT pa."overrides", p."bands", p."settings", p."fcrMatrix"
               FROM "tank_batches" tb
               JOIN "feeding_protocol_assignments" pa
                 ON pa."tenantId" = tb."tenantId"
                AND pa."unitId" = tb."tankId"
                AND pa."status" = $3
               JOIN "feeding_protocols_v2" p
                 ON p."id" = pa."protocolId"
                AND p."tenantId" = pa."tenantId"
                AND p."status" = $4
                AND p."isDeleted" = false
              WHERE tb."tenantId" = $1
                AND (
                  tb."primaryBatchId" = b.id
                  OR EXISTS (
                    SELECT 1
                      FROM jsonb_array_elements(COALESCE(tb."batchDetails", '[]'::jsonb)) AS detail(value)
                     WHERE detail.value->>'batchId' = b.id::text
                  )
                )
              ORDER BY tb."totalBiomassKg" DESC
              LIMIT 1
           ) x ON true`,
        [tenantId, batchIds, ProtocolAssignmentStatus.ACTIVE, FeedingProtocolStatus.ACTIVE],
      );
    // Eksik anahtar "ön-yüklenmedi" demek olurdu; yokluk AÇIK null ile
    // temsil edilir ki zincir gereksiz tekil sorguya düşmesin.
    const protocolRowByBatch = new Map<string, ProtocolFcrRow | null>(
      batchIds.map((batchId) => [batchId, null]),
    );
    for (const row of protocolRows) {
      protocolRowByBatch.set(row.batchId, row);
    }

    const feedIds = [
      ...new Set(
        protocolRows
          .filter((row) => row.settings?.fcrSource === ProtocolFcrSource.FEED)
          .flatMap((row) => (row.bands ?? []).map((band) => band.feedId))
          .filter((feedId): feedId is string => typeof feedId === 'string' && feedId.length > 0),
      ),
    ];
    const feedMatrixByFeedId = new Map<string, FcrMatrix | undefined>();
    if (feedIds.length > 0) {
      const feedRows: Array<{
        id: string;
        matrix: { temperatures: number[]; weights: number[]; fcrMatrix?: number[][] } | null;
      }> = await this.batchRepository.manager.query(
        `SELECT "id", "feedingMatrix2D" AS matrix
           FROM "feeds" WHERE "tenantId" = $1 AND "id" = ANY($2::uuid[])`,
        [tenantId, feedIds],
      );
      for (const feedId of feedIds) feedMatrixByFeedId.set(feedId, undefined);
      for (const row of feedRows) {
        feedMatrixByFeedId.set(row.id, toFcrMatrix(row.matrix));
      }
    }

    // Legacy bacak, TEK sorguda (FARM-LOW-291). Tekil yolun iki `findOne`'ı ile
    // aynı kuralı taşır: batch'in GÜNCEL lokasyonu → o ekipmanın AKTİF program
    // bağlantısı → ACTIVE program. `fcrTable` yoksa satır null olarak yazılır,
    // böylece zincir yine tekil sorguya düşmez.
    //
    // The program status is BOUND from FeedingProgramStatus.ACTIVE, never typed
    // as a literal (FARM-HIGH-445): the enum's database values are lowercase
    // ('active'), and a hand-typed 'ACTIVE' made PostgreSQL reject the whole
    // query — invisible to the unit spec, which mocks manager.query.
    const legacyRows: LegacyProgramFcrRow[] = await this.batchRepository.manager.query(
      `SELECT b.id::text AS "batchId", x."fcrTable" AS "fcrTable"
         FROM unnest($2::uuid[]) AS b(id)
         JOIN LATERAL (
           SELECT fp."fcrTable"
             FROM "batch_locations" bl
             JOIN "feeding_program_tanks" fpt
               ON fpt."tenantId" = bl."tenantId"
              AND fpt."equipmentId" = bl."tankId"
              AND fpt."isActive" = true
             JOIN "feeding_programs" fp
               ON fp."id" = fpt."feedingProgramId"
              AND fp."tenantId" = fpt."tenantId"
              AND fp."status" = $3
            WHERE bl."tenantId" = $1
              AND bl."batchId" = b.id
              AND bl."isCurrentLocation" = true
              AND bl."tankId" IS NOT NULL
            LIMIT 1
         ) x ON true`,
      [tenantId, batchIds, FeedingProgramStatus.ACTIVE],
    );
    const legacyProgramByBatch = new Map<string, LegacyProgramFcrRow['fcrTable']>(
      batchIds.map((batchId) => [batchId, null]),
    );
    for (const row of legacyRows) {
      legacyProgramByBatch.set(row.batchId, row.fcrTable);
    }

    return { batchById, protocolRowByBatch, feedMatrixByFeedId, legacyProgramByBatch };
  }

  /**
   * Target FCR'ı getirir
   *
   * Öncelik sırası (P-14 zinciri — plan §3):
   * 1. Batch'in kendi FCR hedefi (batch.fcr.target, kullanıcı override)
   * 2. Ünitenin aktif v2 protokol ataması (ProtocolRateService SSoT çözümü)
   * 3. Batch'in aktif LEGACY yemleme programındaki FCR tablosu (Faz 8'de silinir)
   * 4. Species growthParameters.targetFCR
   * 5. Species commonName bazlı endüstri ortalaması
   * 6. Varsayılan 1.5
   */
  private async getTargetFCR(batchId: string, prefetch?: TargetFcrPrefetch): Promise<number> {
    try {
      // Batch'i species ilişkisiyle birlikte yükle (ön-yükleme varsa oradan).
      const batch =
        prefetch?.batchById.get(batchId) ??
        (await this.batchRepository.findOne({
          where: { id: batchId },
          relations: ['species'],
        }));

      if (!batch) {
        return 1.5;
      }

      // 1. Batch'in kendi FCR hedefi (kullanıcı tarafından override edilmişse)
      if (batch.fcr?.isUserOverride && batch.fcr?.target && batch.fcr.target > 0) {
        return batch.fcr.target;
      }

      // 2. Ünitenin aktif v2 protokol ataması — motorun plan/snapshot hesabıyla
      // aynı SSoT (ProtocolRateService); legacy programdan ÖNCE gelir (P-14).
      const fcrFromProtocolV2 = await this.getTargetFCRFromProtocolV2(batch, prefetch);
      if (fcrFromProtocolV2 !== null) {
        return fcrFromProtocolV2;
      }

      // 3. Batch'in aktif LEGACY yemleme programındaki FCR tablosundan
      // interpolasyon — v1 motoruyla birlikte Faz 8'de silinir (P-14).
      const fcrFromProgram = await this.getTargetFCRFromFeedingProgram(batch, prefetch);
      if (fcrFromProgram !== null) {
        return fcrFromProgram;
      }

      // 4. Species growthParameters.targetFCR
      // species ilişkisi lazy olabilir, yoksa ayrıca sorgula
      let species = batch.species;
      if (!species) {
        species =
          (await this.speciesRepository.findOne({
            where: { id: batch.speciesId },
          })) ?? undefined;
      }

      if (species?.growthParameters?.targetFCR && species.growthParameters.targetFCR > 0) {
        return species.growthParameters.targetFCR;
      }

      // 5. Species commonName bazlı endüstri ortalaması
      if (species?.commonName) {
        const key = species.commonName.toLowerCase().replace(/\s+/g, '_');
        const industryFCR = this.industryAverageFCR[key];
        if (industryFCR) {
          return industryFCR;
        }
      }

      // 6. Varsayılan
      return 1.5;
    } catch (error) {
      if (error instanceof TenantContextError) {
        throw error;
      }
      this.logger.warn(
        `Target FCR alınırken hata oluştu (batchId: ${batchId}), varsayılan 1.5 kullanılıyor: ${error instanceof Error ? error.message : error}`,
      );
      return 1.5;
    }
  }

  /**
   * Ünitenin aktif v2 protokol atamasından beklenen FCR (P-14 re-point).
   *
   * Zincir: Batch → batch'i taşıyan tank_batches satırları (batchDetails girdisi
   * veya primary aggregate) → aktif ProtocolAssignment → ACTIVE FeedingProtocolV2.
   * Çok-üniteli batch'te dominant (en yüksek biomass) ünitenin ataması esas
   * alınır — D-2 band politikasıyla aynı kural. Çözüm ProtocolRateService
   * üzerinden yapılır (OVERRIDE → band|matrix|feed, 0.5–5 clamp): hedef FCR,
   * motorun day-plan snapshot'ına yazdığı değerle aynı SSoT'den gelir.
   *
   * Sıcaklık null geçilir: hedef FCR gün-bağımsız bir referanstır; matris
   * kaynaklarında interpolasyon ağırlık eksenine iner (ProtocolRateService
   * kuralı — uydurma default sıcaklık üretilmez, P-20).
   */
  private async getTargetFCRFromProtocolV2(
    batch: Batch,
    prefetch?: TargetFcrPrefetch,
  ): Promise<number | null> {
    if (prefetch?.protocolRowByBatch.has(batch.id)) {
      return this.resolveProtocolFcrRow(
        batch,
        prefetch.protocolRowByBatch.get(batch.id) ?? null,
        prefetch,
      );
    }
    const rows: Array<ProtocolFcrRow> = await this.batchRepository.manager.query(
      `SELECT pa."overrides" AS overrides,
              p."bands" AS bands,
              p."settings" AS settings,
              p."fcrMatrix" AS "fcrMatrix"
         FROM "tank_batches" tb
         JOIN "feeding_protocol_assignments" pa
           ON pa."tenantId" = tb."tenantId"
          AND pa."unitId" = tb."tankId"
          AND pa."status" = $3
         JOIN "feeding_protocols_v2" p
           ON p."id" = pa."protocolId"
          AND p."tenantId" = pa."tenantId"
          AND p."status" = $4
          AND p."isDeleted" = false
        WHERE tb."tenantId" = $1
          AND (
            tb."primaryBatchId" = $2
            OR EXISTS (
              SELECT 1
                FROM jsonb_array_elements(COALESCE(tb."batchDetails", '[]'::jsonb)) AS detail(value)
               WHERE detail.value->>'batchId' = $2
            )
          )
        ORDER BY tb."totalBiomassKg" DESC
        LIMIT 1`,
      // Statuses bound from their enums, as in the bulk leg (FARM-HIGH-445).
      [batch.tenantId, batch.id, ProtocolAssignmentStatus.ACTIVE, FeedingProtocolStatus.ACTIVE],
    );

    return this.resolveProtocolFcrRow(batch, rows[0] ?? null, prefetch);
  }

  /** Protokol satırı → beklenen FCR — tekil ve toplu yolun ORTAK adımı. */
  private async resolveProtocolFcrRow(
    batch: Batch,
    row: ProtocolFcrRow | null,
    prefetch?: TargetFcrPrefetch,
  ): Promise<number | null> {
    if (!row?.bands?.length || !row.settings) {
      return null;
    }

    const avgWeightG = batch.getCurrentAvgWeight();
    if (avgWeightG <= 0) {
      return null;
    }

    const resolved = this.protocolRateService.bandFor(row.bands, avgWeightG);
    if (!resolved) {
      return null;
    }

    const feedFcrMatrix =
      row.settings.fcrSource === ProtocolFcrSource.FEED
        ? await this.loadFeedFcrMatrix(batch.tenantId, resolved.band.feedId, prefetch)
        : undefined;

    const { value } = this.protocolRateService.resolveExpectedFcr({
      band: resolved.band,
      fcrSource: row.settings.fcrSource,
      avgWeightG,
      temperatureC: null,
      protocolFcrMatrix: row.fcrMatrix ?? undefined,
      feedFcrMatrix,
      fcrOverrides: row.overrides?.fcrOverrides,
    });
    return value;
  }

  /**
   * fcrSource=feed protokoller için band yeminin FCR matrisi
   * (Feed.feedingMatrix2D.fcrMatrix → FcrMatrix). Matris yoksa undefined —
   * resolveExpectedFcr band fallback'ini provenanslı uygular.
   */
  private async loadFeedFcrMatrix(
    tenantId: string,
    feedId: string,
    prefetch?: TargetFcrPrefetch,
  ): Promise<FcrMatrix | undefined> {
    if (prefetch?.feedMatrixByFeedId.has(feedId)) {
      return prefetch.feedMatrixByFeedId.get(feedId);
    }
    const rows: Array<{
      matrix: { temperatures: number[]; weights: number[]; fcrMatrix?: number[][] } | null;
    }> = await this.batchRepository.manager.query(
      `SELECT "feedingMatrix2D" AS matrix FROM "feeds" WHERE "tenantId" = $1 AND "id" = $2`,
      [tenantId, feedId],
    );
    return toFcrMatrix(rows[0]?.matrix ?? null);
  }

  /**
   * Batch'in aktif yemleme programından FCR değerini getirir
   *
   * Zincir: Batch -> BatchLocation (aktif tank) -> FeedingProgramTank -> FeedingProgram -> fcrTable
   * FCR tablosu varsa, batch'in mevcut ortalama ağırlığına göre interpolasyon yapar.
   */
  private async getTargetFCRFromFeedingProgram(
    batch: Batch,
    prefetch?: TargetFcrPrefetch,
  ): Promise<number | null> {
    try {
      // Toplu yol: tablo ön-yüklenmişse hiç sorgu atılmaz (FARM-LOW-291).
      // `has` kontrolü ŞART: eksik anahtar "ön-yüklenmedi" demektir ve tekil
      // yola düşmelidir; `null` ise "aktif legacy program yok" demektir.
      if (prefetch?.legacyProgramByBatch.has(batch.id)) {
        const prefetched = prefetch.legacyProgramByBatch.get(batch.id) ?? null;
        return this.fcrFromLegacyTable(prefetched, batch);
      }

      // Batch'in aktif lokasyonunu bul (hangi tank'ta)
      const activeLocation = await this.batchLocationRepository.findOne({
        where: {
          batchId: batch.id,
          tenantId: batch.tenantId,
          isCurrentLocation: true,
        },
      });

      if (!activeLocation?.tankId) {
        return null;
      }

      // Bu tank'ın aktif yemleme programını bul
      const programTank = await this.feedingProgramTankRepository.findOne({
        where: {
          tenantId: batch.tenantId,
          equipmentId: activeLocation.tankId,
          isActive: true,
        },
        relations: ['feedingProgram'],
      });

      if (!programTank?.feedingProgram) {
        return null;
      }

      const program = programTank.feedingProgram;

      // Program aktif olmalı (toplu sorgu bu filtreyi SQL'de taşır).
      if (program.status !== FeedingProgramStatus.ACTIVE) {
        return null;
      }

      return this.fcrFromLegacyTable(program.fcrTable ?? null, batch);
    } catch (error) {
      if (error instanceof TenantContextError) {
        throw error;
      }
      this.logger.debug(
        `Yemleme programından FCR alınamadı (batchId: ${batch.id}): ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }

  /**
   * Legacy FCR tablosu + batch → hedef FCR, ya da `null`.
   *
   * Tekil ve TOPLU yolun ORTAK gövdesi (FARM-LOW-291): tabloyu iki yerde
   * doğrulamak, iki yolun aynı tablo için farklı cevap vermesine kapı açardı.
   */
  private fcrFromLegacyTable(
    fcrTable: { temperatures: number[]; weights: number[]; fcrValues: number[][] } | null,
    batch: Batch,
  ): number | null {
    if (
      !fcrTable?.temperatures?.length ||
      !fcrTable.weights?.length ||
      !fcrTable.fcrValues?.length
    ) {
      return null;
    }
    const avgWeightG = batch.getCurrentAvgWeight();
    if (avgWeightG <= 0) {
      return null;
    }
    // Sıcaklık bilinmiyorsa tüm sıcaklık satırlarının ortalaması kullanılır.
    return this.interpolateFCRFromTable(fcrTable, avgWeightG);
  }

  /**
   * FCR tablosundan ağırlık bazlı interpolasyon yapar
   *
   * Eğer ağırlık tam bir sütuna denk geliyorsa o değeri döner.
   * Ara değer ise en yakın iki sütun arasında lineer interpolasyon yapar.
   * Sıcaklık bilinmediğinden, tüm sıcaklık satırlarının ortalamasını alır.
   */
  private interpolateFCRFromTable(
    fcrTable: { temperatures: number[]; weights: number[]; fcrValues: number[][] },
    avgWeightG: number,
  ): number | null {
    const { weights, fcrValues } = fcrTable;

    // Ağırlık indeksini bul (interpolasyon için)
    let lowerIdx = 0;
    let upperIdx = weights.length - 1;

    const firstWeight = weights[0];
    const lastWeight = weights[weights.length - 1];

    if (firstWeight === undefined || lastWeight === undefined) {
      return null;
    }

    // Ağırlık aralığın altındaysa ilk sütunu kullan
    if (avgWeightG <= firstWeight) {
      lowerIdx = 0;
      upperIdx = 0;
    }
    // Ağırlık aralığın üstündeyse son sütunu kullan
    else if (avgWeightG >= lastWeight) {
      lowerIdx = weights.length - 1;
      upperIdx = weights.length - 1;
    }
    // Ara değer: iki sütun arasında bul
    else {
      for (let i = 0; i < weights.length - 1; i++) {
        const currentWeight = weights[i];
        const nextWeight = weights[i + 1];
        if (
          currentWeight !== undefined &&
          nextWeight !== undefined &&
          avgWeightG >= currentWeight &&
          avgWeightG < nextWeight
        ) {
          lowerIdx = i;
          upperIdx = i + 1;
          break;
        }
      }
    }

    // Her sıcaklık satırı için interpolasyon yap, sonra ortalama al
    let totalFCR = 0;
    let validRows = 0;

    for (let tempIdx = 0; tempIdx < fcrValues.length; tempIdx++) {
      const row = fcrValues[tempIdx];
      if (!row || row.length <= lowerIdx || row.length <= upperIdx) {
        continue;
      }

      const lowerFCR = row[lowerIdx];
      const upperFCR = row[upperIdx];

      // 0 değeri kapsanmayan hücre demek, atla
      if (lowerFCR === undefined || upperFCR === undefined || lowerFCR <= 0 || upperFCR <= 0) {
        continue;
      }

      let interpolatedFCR: number;
      if (lowerIdx === upperIdx) {
        interpolatedFCR = lowerFCR;
      } else {
        // Lineer interpolasyon
        const lowerWeight = weights[lowerIdx] ?? 0;
        const upperWeight = weights[upperIdx] ?? 0;
        const ratio = (avgWeightG - lowerWeight) / (upperWeight - lowerWeight);
        interpolatedFCR = lowerFCR + ratio * (upperFCR - lowerFCR);
      }

      totalFCR += interpolatedFCR;
      validRows++;
    }

    if (validRows === 0) {
      return null;
    }

    return totalFCR / validRows;
  }

  /**
   * Boş sonuç oluşturur
   */
  private createEmptyResult(warnings: string[]): FCRCalculationResult {
    return {
      periodFCR: 0,
      cumulativeFCR: 0,
      analysis: {
        periodFeedGiven: 0,
        periodGrowth: 0,
        periodFCR: 0,
        cumulativeFeedGiven: 0,
        cumulativeGrowth: 0,
        cumulativeFCR: 0,
        targetFCR: 1.5,
        fcrVariance: 0,
        fcrTrend: 'stable',
      },
      isValid: false,
      warnings,
    };
  }

  /**
   * Lineer regresyon hesaplar
   */
  private linearRegression(points: { x: number; y: number }[]): {
    slope: number;
    correlation: number;
  } {
    const n = points.length;

    // Edge case: when n=0, all divisions would fail; return safe defaults
    if (n === 0 || n === null || n === undefined) {
      return { slope: 0, correlation: 0 };
    }

    const sumX = points.reduce((sum, p) => sum + p.x, 0);
    const sumY = points.reduce((sum, p) => sum + p.y, 0);
    const sumXY = points.reduce((sum, p) => sum + p.x * p.y, 0);
    const sumX2 = points.reduce((sum, p) => sum + p.x * p.x, 0);
    const sumY2 = points.reduce((sum, p) => sum + p.y * p.y, 0);

    // Edge case: when denominator (n * sumX2 - sumX * sumX) = 0, slope would be undefined; return 0
    const slopeDenominator = n * sumX2 - sumX * sumX;
    const slope =
      slopeDenominator === 0 || slopeDenominator === null || slopeDenominator === undefined
        ? 0
        : (n * sumXY - sumX * sumY) / slopeDenominator;

    // R-squared hesaplama
    // Edge case: meanY division by n is safe here since n > 0 was checked above
    const meanY = sumY / n;
    const ssTotal = points.reduce((sum, p) => sum + Math.pow(p.y - meanY, 2), 0);
    // Edge case: intercept division by n is safe here since n > 0 was checked above
    const intercept = (sumY - slope * sumX) / n;
    const ssResidual = points.reduce((sum, p) => {
      const predicted = slope * p.x + intercept;
      return sum + Math.pow(p.y - predicted, 2);
    }, 0);

    // Edge case: ssTotal=0 check is already in place
    const correlation = ssTotal > 0 ? 1 - ssResidual / ssTotal : 0;

    return { slope: isNaN(slope) ? 0 : slope, correlation };
  }

  /**
   * Trend bazlı öneriler oluşturur
   */
  private generateTrendRecommendations(
    trend: 'improving' | 'stable' | 'declining',
    slope: number,
    currentFCR: number,
  ): string[] {
    const recommendations: string[] = [];

    if (trend === 'declining') {
      recommendations.push('Yemleme programını gözden geçirin');
      recommendations.push('Su kalitesi parametrelerini kontrol edin');
      recommendations.push('Balık sağlığını değerlendirin');

      if (slope > 0.03) {
        recommendations.push('ACİL: Hızlı FCR artışı - detaylı inceleme gerekli');
      }
    } else if (trend === 'improving') {
      recommendations.push('Mevcut yemleme stratejisini sürdürün');

      if (currentFCR > 2) {
        recommendations.push('FCR hala yüksek - iyileştirme potansiyeli var');
      }
    } else {
      if (currentFCR > 1.8) {
        recommendations.push('FCR optimizasyonu için yem kalitesini değerlendirin');
      } else {
        recommendations.push('Performans stabil - mevcut protokolü sürdürün');
      }
    }

    return recommendations;
  }
}
