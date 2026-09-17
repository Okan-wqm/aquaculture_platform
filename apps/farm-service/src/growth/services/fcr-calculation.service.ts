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
import { Repository, Between, EntityManager } from 'typeorm';
import { TenantContextError } from '@aquaculture/backend-common/database';
import { FeedingRecord } from '../../feeding/entities/feeding-record.entity';
import { FeedingProgram, FeedingProgramStatus } from '../../feeding/entities/feeding-program.entity';
import { FeedingProgramTank } from '../../feeding/entities/feeding-program-tank.entity';
import { BatchLocation } from '../../batch/entities/batch-location.entity';
import { GrowthMeasurement, FCRAnalysis } from '../entities/growth-measurement.entity';
import { Batch, OPERATIONAL_BATCH_STATUSES } from '../../batch/entities/batch.entity';
import { TankOperation, OperationType } from '../../batch/entities/tank-operation.entity';
import { Species } from '../../species/entities/species.entity';
import {
  ProtocolRateService,
  tankBandWeightG,
} from '../../feeding-protocol/services/protocol-rate.service';
import {
  FcrMatrix,
  ProtocolBand,
  ProtocolFcrSource,
  ProtocolSettings,
} from '../../feeding-protocol/entities/feeding-protocol-v2.entity';
import { AssignmentOverrides } from '../../feeding-protocol/entities/protocol-assignment.entity';

// ============================================================================
// RUNNING FCR — SCOPE + PROJECTION SQL (exported so tests run the REAL text)
// ============================================================================

/**
 * The set of batches that HAVE a running FCR: every live batch in an
 * operational (feedable) status.
 *
 * WHY this exists as an exported constant and why it looks the way it does:
 * the 18:00 FCR sweep used to select its own work with
 *
 *     WHERE "isActive" = true
 *       AND status IN ('ACTIVE','GROWING')
 *       AND (fcr->>'actual')::numeric > 0
 *
 * and that predicate was UNSATISFIABLE. `fcr.actual` had exactly one writer —
 * CloseBatchHandler — which sets it in the same block that sets
 * `status = CLOSED` and `isActive = false`. So a live batch always had
 * `fcr.actual = 0` (its create-time value) and failed the third clause, while a
 * batch with a nonzero `fcr.actual` was by construction closed and failed the
 * first two. Zero FCRAlert events were ever emitted, for months, while the
 * consumer (alert-engine FcrAlertEventHandler) sat there waiting.
 *
 * The root cause is NOT the third clause on its own — it is that a scheduled
 * job gated itself on a column that nothing in its own pipeline maintained. So
 * the scope query is now derived ONLY from batch LIFECYCLE state, which every
 * batch lifecycle test already exercises, and the FCR value itself is computed
 * in-process from the single authority (`calculateCumulativeFCR`). The sweep
 * can no longer be silenced by a stale column, because it no longer reads one.
 *
 * The status list is a bound parameter fed from OPERATIONAL_BATCH_STATUSES —
 * the SAME constant behind `BatchDomainService.assertFeedable`, so the batches
 * that can be fed and the batches whose FCR is watched are one set by
 * construction. `$2::text[]` (rather than a literal IN list) is what makes that
 * possible: the enum column is cast to text so the array binds cleanly.
 *
 * Params: $1 tenantId (uuid), $2 operational statuses (text[]).
 */
export const LIVE_BATCH_FCR_SCOPE_SQL = `
  SELECT b."id" AS "batchId"
    FROM "batches_v2" b
   WHERE b."tenantId" = $1::uuid
     AND b."isActive" = true
     AND b."status"::text = ANY($2::text[])
   ORDER BY b."id"`;

/**
 * Write the freshly computed running FCR back onto the live batch rows.
 *
 * WHY persist a value the authority can recompute: `batches_v2.fcr.actual` is
 * read directly by the UI (farm-module BatchOverviewTab renders "target /
 * actual", UpdateBatchModal shows it, FeedingSummaryTab derives an advisory
 * from it). With no writer for live batches those surfaces showed 0.00 for
 * every batch in production, and FeedingSummaryTab's `actual <= target` branch
 * told operators their FCR was on target when it had simply never been
 * computed. This projection makes `fcr.actual` mean what its name says while
 * `calculateCumulativeFCR` stays the sole authority — nothing DECIDES anything
 * from the persisted copy; `fcr.lastUpdatedAt` states how fresh it is.
 *
 * WHY one bulk statement instead of a save() per batch: the sweep runs inside
 * one tenant transaction, and every row this touches stays write-locked until
 * that transaction commits. Folding all batches into a single UPDATE that runs
 * as the LAST statement of the sweep keeps that lock window at milliseconds
 * instead of the whole tenant pass, so an 18:00 mobile feeding write is not
 * blocked behind the alert loop.
 *
 * `jsonb_set` touches only the two keys it owns, so a concurrent domain write
 * to another key of the same document is not clobbered. `updatedAt` is
 * deliberately NOT bumped: this is a derived refresh, not a domain edit, and
 * moving the audit timestamp of every live batch once a day would make
 * `updatedAt` useless as a signal of real change.
 *
 * Params: $1 tenantId (uuid), $2 batch ids (uuid[]), $3 running FCRs
 * (numeric[], positionally aligned with $2), $4 computed-at ISO-8601 (text).
 */
export const RUNNING_FCR_PROJECTION_SQL = `
  UPDATE "batches_v2" b
     SET "fcr" = jsonb_set(
                   jsonb_set(b."fcr", '{actual}', to_jsonb(v."actual")),
                   '{lastUpdatedAt}', to_jsonb($4::text)
                 )
    FROM unnest($2::uuid[], $3::numeric[]) AS v("batchId", "actual")
   WHERE b."id" = v."batchId"
     AND b."tenantId" = $1::uuid`;

/** One live batch's running FCR, as computed by the single FCR authority. */
export interface RunningFcr {
  readonly batchId: string;
  /** Cumulative, ledger-corrected FCR. 0 means "no realized growth yet". */
  readonly fcr: number;
  readonly totalFeed: number;
  readonly totalGrowth: number;
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
  slope: number;                     // Günlük değişim oranı
  correlation: number;               // R-squared
  forecast7Days: number;             // 7 günlük tahmin
  recommendations: string[];
}

/**
 * FCR karşılaştırma sonucu
 */
export interface FCRComparison {
  currentFCR: number;
  targetFCR: number;
  industryAvgFCR: number;
  varianceFromTarget: number;        // %
  varianceFromIndustry: number;      // %
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
  totalFeedGiven: number;            // kg
  totalGrowth: number;               // kg
  startBiomass: number;              // kg
  currentBiomass: number;            // kg

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

// ============================================================================
// SERVICE
// ============================================================================

@Injectable()
export class FCRCalculationService {
  private readonly logger = new Logger(FCRCalculationService.name);

  // Endüstri ortalama FCR değerleri (tür bazlı)
  private readonly industryAverageFCR: Record<string, number> = {
    'atlantic_salmon': 1.2,
    'rainbow_trout': 1.1,
    'sea_bass': 1.8,
    'sea_bream': 2.0,
    'tilapia': 1.6,
    'catfish': 1.5,
    'shrimp': 1.8,
    'default': 1.5,
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
    const totalFeed = feedingRecords.reduce(
      (sum, record) => sum + Number(record.actualAmount),
      0
    );

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
    const effectiveTargetFCR = targetFCR || await this.getTargetFCR(batchId);

    // Analiz oluştur
    // Edge case: when effectiveTargetFCR=0, fcrVariance calculation would divide by zero; return 0
    const fcrVariance = effectiveTargetFCR === 0 || effectiveTargetFCR === null || effectiveTargetFCR === undefined
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
   */
  async calculateCumulativeFCR(
    batchId: string,
    tenantId: string,
    endDate?: Date
  ): Promise<{ fcr: number; totalFeed: number; totalGrowth: number; removedBiomassKg: number }> {
    const batch = await this.batchRepository.findOne({
      where: { id: batchId, tenantId },
    });

    if (!batch) {
      return { fcr: 0, totalFeed: 0, totalGrowth: 0, removedBiomassKg: 0 };
    }

    // Tüm yemleme kayıtlarını al
    const feedQuery = this.feedingRecordRepository.createQueryBuilder('fr')
      .where('fr.tenantId = :tenantId', { tenantId })
      .andWhere('fr.batchId = :batchId', { batchId });

    if (endDate) {
      feedQuery.andWhere('fr.feedingDate <= :endDate', { endDate });
    }

    const feedResult = await feedQuery
      .select('SUM(fr.actualAmount)', 'totalFeed')
      .getRawOne();

    const totalFeed = Number(feedResult?.totalFeed || 0);

    // NOTE: the latest growth measurement is no longer queried here. Current
    // biomass is the derive-on-read value (batch.getCurrentBiomass), so the
    // stale-prone measurement snapshot does not feed the FCR growth term.

    // Ledger: biomass that LEFT the batch (mortality/cull/harvest/transfer-out)
    // or entered it feed-free (transfer-in). Counting TRANSFER_OUT and
    // TRANSFER_IN together makes within-batch tank moves (same batchId out +
    // in) net to zero naturally. Tenant-filtered (op.tenantId) as defence in
    // depth on top of the tenant search_path routing (ADR-011).
    const ledgerQuery = this.tankOperationRepository.createQueryBuilder('op')
      .where('op.tenantId = :tenantId', { tenantId })
      .andWhere('op.batchId = :batchId', { batchId })
      .andWhere('op.isDeleted = false')
      .andWhere('op.operationType IN (:...ledgerTypes)', {
        ledgerTypes: [
          OperationType.MORTALITY,
          OperationType.CULL,
          OperationType.HARVEST,
          OperationType.TRANSFER_OUT,
          OperationType.TRANSFER_IN,
        ],
      });

    if (endDate) {
      ledgerQuery.andWhere('op.operationDate <= :endDate', { endDate });
    }

    const ledgerResult = await ledgerQuery
      .select(
        `COALESCE(SUM(CASE WHEN op.operationType = :transferIn THEN -COALESCE(op.biomassKg, 0) ELSE COALESCE(op.biomassKg, 0) END), 0)`,
        'netRemovedKg',
      )
      .setParameter('transferIn', OperationType.TRANSFER_IN)
      .getRawOne<{ netRemovedKg: string | number | null }>();

    const removedBiomassKg = Number(ledgerResult?.netRemovedKg ?? 0);

    // Başlangıç biomass (initialQuantity * initial avgWeight)
    const initialWeight = batch.weight?.initial?.avgWeight || 0;
    const startBiomass = (batch.initialQuantity * initialWeight) / 1000; // kg
    // Current biomass is the single derive-on-read value (currentQuantity ×
    // effectiveAvgWeightG / 1000) — the SAME source the GraphQL resolver and
    // removal handlers read. Sourcing it from the stored measurement snapshot
    // (GrowthMeasurement.estimatedBiomass) would let FCR growth and the
    // displayed biomass diverge, because that snapshot goes stale on every
    // removal while the derived value tracks the live count. When no count is
    // available yet, fall back to the start biomass.
    const currentBiomass = batch.currentQuantity > 0
      ? batch.getCurrentBiomass()
      : startBiomass;
    // Realized growth includes the growth of biomass that exited the system.
    const totalGrowth = currentBiomass + removedBiomassKg - startBiomass;

    const fcr = totalGrowth > 0 ? totalFeed / totalGrowth : 0;

    return { fcr, totalFeed, totalGrowth, removedBiomassKg };
  }

  /**
   * Recompute the running FCR of every live batch of a tenant, hand each one to
   * `onBatch`, then persist all of them as ONE projection write.
   *
   * WHY the callback shape instead of two public methods (`compute…` then
   * `persist…`): the ordering is load-bearing and a caller must not be able to
   * get it wrong. The projection UPDATE write-locks every live batch row until
   * the surrounding tenant transaction commits, so it has to be the last thing
   * the sweep does — but the alert decisions need the values before that. A
   * compute/persist pair would let a caller write first and then hold locks
   * through a slow per-batch alert loop (target resolution + trend analysis are
   * several queries each). Owning the order here makes the safe sequence the
   * only reachable one, and makes "computed but never persisted" unreachable
   * too.
   *
   * WHY `onBatch` runs BEFORE anything is persisted: if it throws, the whole
   * tenant transaction rolls back and neither the alerts nor a half-written
   * projection survive. The next sweep recomputes from the ledger, so nothing
   * is lost by failing loudly.
   *
   * @param manager  the tenant-transaction EntityManager (search_path pinned)
   * @param tenantId tenant whose live batches are swept
   * @param computedAt stamp written to `fcr.lastUpdatedAt`; passed in so the
   *                   caller can pin it and every batch of one sweep agrees
   * @param onBatch  invoked once per live batch, in id order
   * @returns every live batch's running FCR (including the zero ones)
   */
  async refreshRunningFcrForTenant(
    manager: EntityManager,
    tenantId: string,
    computedAt: Date,
    onBatch: (running: RunningFcr) => Promise<void>,
  ): Promise<RunningFcr[]> {
    const scope: Array<{ batchId: string }> = await manager.query(LIVE_BATCH_FCR_SCOPE_SQL, [
      tenantId,
      // Spread: the constant is readonly, the driver parameter list is not.
      [...OPERATIONAL_BATCH_STATUSES],
    ]);

    const running: RunningFcr[] = [];
    for (const { batchId } of scope) {
      // The SINGLE FCR authority — ledger-corrected realized growth over
      // recorded feed. Reading it here rather than from a column is exactly
      // what stops this sweep from ever being gated on an unmaintained value.
      const cumulative = await this.calculateCumulativeFCR(batchId, tenantId);
      const entry: RunningFcr = {
        batchId,
        fcr: cumulative.fcr,
        totalFeed: cumulative.totalFeed,
        totalGrowth: cumulative.totalGrowth,
      };
      running.push(entry);
      await onBatch(entry);
    }

    if (running.length > 0) {
      await manager.query(RUNNING_FCR_PROJECTION_SQL, [
        tenantId,
        running.map((entry) => entry.batchId),
        running.map((entry) => entry.fcr),
        computedAt.toISOString(),
      ]);
    }

    return running;
  }

  /**
   * FCR trend analizi yapar
   */
  async analyzeFCRTrend(batchId: string, tenantId: string): Promise<FCRTrendAnalysis> {
    // Son 10 ölçümü al
    const measurements = await this.growthMeasurementRepository.find({
      where: { tenantId, batchId },
      order: { measurementDate: 'DESC' },
      take: 10,
    });

    if (measurements.length < 3) {
      return {
        trend: 'stable',
        slope: 0,
        correlation: 0,
        forecast7Days: 0,
        recommendations: ['Yeterli veri yok - daha fazla ölçüm gerekli'],
      };
    }

    // FCR değerlerini çıkar
    const fcrValues = measurements
      .filter(m => m.fcrAnalysis?.periodFCR)
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
    const forecast7Days = lastFCR + (slope * 7);

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
    speciesType?: string
  ): Promise<FCRComparison> {
    const batch = await this.batchRepository.findOne({
      where: { id: batchId, tenantId },
    });

    const cumulativeResult = await this.calculateCumulativeFCR(batchId, tenantId);
    const currentFCR = cumulativeResult.fcr;

    // Target FCR (batch'ten veya varsayılan)
    const targetFCR = await this.getTargetFCR(batchId) || 1.5;

    // Endüstri ortalaması
    const industryAvgFCR = this.industryAverageFCR[speciesType || 'default'] || 1.5;

    // Varyanslar
    // Edge case: when targetFCR=0, variance calculation would divide by zero; return 0
    const varianceFromTarget = targetFCR === 0 || targetFCR === null || targetFCR === undefined
      ? 0
      : ((currentFCR - targetFCR) / targetFCR) * 100;
    // Edge case: when industryAvgFCR=0, variance calculation would divide by zero; return 0
    const varianceFromIndustry = industryAvgFCR === 0 || industryAvgFCR === null || industryAvgFCR === undefined
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
      .filter(m => m.fcrAnalysis?.periodFCR)
      .map(m => m.fcrAnalysis!.periodFCR);

    const bestFCR = fcrValues.length > 0 ? Math.min(...fcrValues) : 0;
    const worstFCR = fcrValues.length > 0 ? Math.max(...fcrValues) : 0;
    const avgFCR = fcrValues.length > 0
      ? fcrValues.reduce((a, b) => a + b, 0) / fcrValues.length
      : 0;

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
    tenantId: string
  ): Promise<{ hasAnomaly: boolean; anomalies: string[] }> {
    const anomalies: string[] = [];

    const cumulativeResult = await this.calculateCumulativeFCR(batchId, tenantId);
    const comparison = await this.compareFCR(batchId, tenantId);
    const trendAnalysis = await this.analyzeFCRTrend(batchId, tenantId);

    // Çok yüksek FCR
    if (cumulativeResult.fcr > 3) {
      anomalies.push(`Kritik: FCR çok yüksek (${cumulativeResult.fcr.toFixed(2)}) - yemleme veya ölçüm hatası olabilir`);
    }

    // Çok düşük FCR (şüpheli)
    if (cumulativeResult.fcr < 0.7 && cumulativeResult.fcr > 0) {
      anomalies.push(`Uyarı: FCR çok düşük (${cumulativeResult.fcr.toFixed(2)}) - veri doğruluğunu kontrol edin`);
    }

    // Hedeften %30+ sapma
    if (Math.abs(comparison.varianceFromTarget) > 30) {
      anomalies.push(`Önemli sapma: FCR hedeften %${comparison.varianceFromTarget.toFixed(1)} farklı`);
    }

    // Hızlı kötüleşme
    if (trendAnalysis.trend === 'declining' && trendAnalysis.slope > 0.05) {
      anomalies.push(`Uyarı: FCR hızla kötüleşiyor (günlük +${(trendAnalysis.slope * 100).toFixed(2)}%)`);
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
  private async getTargetFCR(batchId: string): Promise<number> {
    try {
      // Batch'i species ilişkisiyle birlikte yükle
      const batch = await this.batchRepository.findOne({
        where: { id: batchId },
        relations: ['species'],
      });

      if (!batch) {
        return 1.5;
      }

      // 1. Batch'in kendi FCR hedefi (kullanıcı tarafından override edilmişse)
      if (batch.fcr?.isUserOverride && batch.fcr?.target && batch.fcr.target > 0) {
        return batch.fcr.target;
      }

      // 2. Ünitenin aktif v2 protokol ataması — motorun plan/snapshot hesabıyla
      // aynı SSoT (ProtocolRateService); legacy programdan ÖNCE gelir (P-14).
      const fcrFromProtocolV2 = await this.getTargetFCRFromProtocolV2(batch);
      if (fcrFromProtocolV2 !== null) {
        return fcrFromProtocolV2;
      }

      // 3. Batch'in aktif LEGACY yemleme programındaki FCR tablosundan
      // interpolasyon — v1 motoruyla birlikte Faz 8'de silinir (P-14).
      const fcrFromProgram = await this.getTargetFCRFromFeedingProgram(batch);
      if (fcrFromProgram !== null) {
        return fcrFromProgram;
      }

      // 4. Species growthParameters.targetFCR
      // species ilişkisi lazy olabilir, yoksa ayrıca sorgula
      let species = batch.species;
      if (!species) {
        species = await this.speciesRepository.findOne({
          where: { id: batch.speciesId },
        }) ?? undefined;
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
   *
   * AĞIRLIK KAYNAĞI (0.3 kök çözümü): band, atamayı sağlayan AYNI SATIRIN
   * ünite aggregate'inden çözülür — `batch.getCurrentAvgWeight()` DEĞİL.
   * Eskiden ağırlık batch'ten okunuyordu; `getCurrentAvgWeight()` önce
   * `weight.actual`'ı tercih ettiği için, tartım tank aggregate'lerine indiği
   * anda hedef FCR ile yem oranı KALICI olarak farklı bantlardan gelirdi.
   * Alan kuralı gereği tank otoritedir; `bandFor` artık nominal
   * {@link BandWeightG} istediğinden bu satır kazayla geri alınamaz — batch
   * ağırlığı geçirmek derleme hatasıdır.
   */
  private async getTargetFCRFromProtocolV2(batch: Batch): Promise<number | null> {
    const rows: Array<{
      overrides: AssignmentOverrides | null;
      bands: ProtocolBand[] | null;
      settings: ProtocolSettings | null;
      fcrMatrix: FcrMatrix | null;
      unitAvgWeightG: string | number | null;
      unitTotalQuantity: string | number | null;
      unitTotalBiomassKg: string | number | null;
    }> = await this.batchRepository.manager.query(
      `SELECT pa."overrides" AS overrides,
              p."bands" AS bands,
              p."settings" AS settings,
              p."fcrMatrix" AS "fcrMatrix",
              tb."avgWeightG" AS "unitAvgWeightG",
              tb."totalQuantity" AS "unitTotalQuantity",
              tb."totalBiomassKg" AS "unitTotalBiomassKg"
         FROM "tank_batches" tb
         JOIN "feeding_protocol_assignments" pa
           ON pa."tenantId" = tb."tenantId"
          AND pa."unitId" = tb."tankId"
          AND pa."status" = 'active'
         JOIN "feeding_protocols_v2" p
           ON p."id" = pa."protocolId"
          AND p."tenantId" = pa."tenantId"
          AND p."status" = 'active'
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
      [batch.tenantId, batch.id],
    );

    const row = rows[0];
    if (!row?.bands?.length || !row.settings) {
      return null;
    }

    const avgWeightG = tankBandWeightG({
      avgWeightG: row.unitAvgWeightG,
      totalQuantity: row.unitTotalQuantity,
      totalBiomassKg: row.unitTotalBiomassKg,
    });
    if (avgWeightG <= 0) {
      return null;
    }

    const resolved = this.protocolRateService.bandFor(row.bands, avgWeightG);
    if (!resolved) {
      return null;
    }

    const feedFcrMatrix =
      row.settings.fcrSource === ProtocolFcrSource.FEED
        ? await this.loadFeedFcrMatrix(batch.tenantId, resolved.band.feedId)
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
  ): Promise<FcrMatrix | undefined> {
    const rows: Array<{
      matrix: { temperatures: number[]; weights: number[]; fcrMatrix?: number[][] } | null;
    }> = await this.batchRepository.manager.query(
      `SELECT "feedingMatrix2D" AS matrix FROM "feeds" WHERE "tenantId" = $1 AND "id" = $2`,
      [tenantId, feedId],
    );
    const matrix = rows[0]?.matrix;
    if (!matrix?.fcrMatrix?.length) {
      return undefined;
    }
    return {
      temperatures: matrix.temperatures,
      weights: matrix.weights,
      fcrValues: matrix.fcrMatrix,
    };
  }

  /**
   * Batch'in aktif yemleme programından FCR değerini getirir
   *
   * Zincir: Batch -> BatchLocation (aktif tank) -> FeedingProgramTank -> FeedingProgram -> fcrTable
   * FCR tablosu varsa, batch'in mevcut ortalama ağırlığına göre interpolasyon yapar.
   */
  private async getTargetFCRFromFeedingProgram(batch: Batch): Promise<number | null> {
    try {
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

      // Program aktif olmalı ve FCR tablosu olmalı
      if (program.status !== FeedingProgramStatus.ACTIVE || !program.fcrTable) {
        return null;
      }

      const fcrTable = program.fcrTable;
      if (
        !fcrTable.temperatures?.length ||
        !fcrTable.weights?.length ||
        !fcrTable.fcrValues?.length
      ) {
        return null;
      }

      // Batch'in mevcut ortalama ağırlığını al
      const avgWeightG = batch.getCurrentAvgWeight();
      if (avgWeightG <= 0) {
        return null;
      }

      // FCR tablosundan ağırlık bazlı interpolasyon yap
      // (Sıcaklık bilinmiyorsa tüm sıcaklıkların ortalamasını kullan)
      return this.interpolateFCRFromTable(fcrTable, avgWeightG);
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
        if (currentWeight !== undefined && nextWeight !== undefined && avgWeightG >= currentWeight && avgWeightG < nextWeight) {
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
  private linearRegression(points: { x: number; y: number }[]): { slope: number; correlation: number } {
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
    const slope = slopeDenominator === 0 || slopeDenominator === null || slopeDenominator === undefined
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
    const correlation = ssTotal > 0 ? 1 - (ssResidual / ssTotal) : 0;

    return { slope: isNaN(slope) ? 0 : slope, correlation };
  }

  /**
   * Trend bazlı öneriler oluşturur
   */
  private generateTrendRecommendations(
    trend: 'improving' | 'stable' | 'declining',
    slope: number,
    currentFCR: number
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
