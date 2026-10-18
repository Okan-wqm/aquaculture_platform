/**
 * BiomassGrowthApplierService v2 — FCR büyümesinin TEK uygulama yolu
 * (Faz 5, D-1/D-2 yeniden tasarımı — v1 mantığının "portu" DEĞİL).
 *
 * v1 bug'ları ve kökten çözümleri:
 *  - D-1: v1 `Batch.weight.theoretical`'ı TEK tankın değeriyle EZİYORDU
 *    (son-yazan-kazanır) — çok-üniteli batch'te bozulma. v2, batch'in TÜM
 *    ünitelerdeki paylarının toplamından AYNI transaction'da yeniden hesaplar.
 *    Invariant: `Batch.weight.theoretical.totalBiomass == Σ(ünite payları)`.
 *  - D-2: büyüme ÜNİTE seviyesinde uygulanır ve `batchDetails[]` girdilerine
 *    biomass payı oranında dağıtılır; `batchDetails` tank-içi per-batch
 *    durumun SSoT'sidir, TankBatch aggregate'leri ondan TÜRETİLİR — başka bir
 *    yazarın aggregate yeniden-türetmesi birikmiş büyümeyi silemez.
 *  - P-13: `Tank.currentBiomass` projeksiyonu korunur; ID-konvansiyonu tutmayan
 *    ünitede miss YAPISAL metrikle ölçülür (sessiz no-op ölür).
 *
 * A unit's weight has two inputs and this service is the writer of both: the
 * FCR projection (`applyGrowth`, biomass += fed / expected FCR) and a weighing
 * (`applyMeasuredWeight`). The projection never reads a measurement, so before
 * the weighing path existed a weighing changed nothing any ration reads
 * (FARM-CRITICAL-454). Both paths derive the TankBatch aggregates from
 * `batchDetails[]` the same way and keep the D-1 invariant below.
 *
 * Kilit disiplini (K-1 kanonik sıra): `lockUnitForGrowth` batch'leri
 * batchId ARTAN sırada pessimistic_write kilitler, SONRA TankBatch'i kilitler;
 * kilit sonrası batch üyeliği değiştiyse ConflictException fırlatılır (çağıran
 * transaction'ı yeniden dener) — sıra dışı kilit imkânsız.
 *
 * @module FeedingProtocol/Services
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { EntityManager, In } from 'typeorm';

import { Batch } from '../../batch/entities/batch.entity';
import { TankBatch, BatchDetail } from '../../batch/entities/tank-batch.entity';
import { Tank } from '../../tank/entities/tank.entity';
import { FarmDomainMetricsService } from '../../common/metrics/farm-domain-metrics.service';
import { round3 } from '../../common/utils/rounding.util';

export interface LockedUnit {
  tankBatch: TankBatch;
  /** batchId → kilitli Batch (batchId artan sırada kilitlendi). */
  batches: Map<string, Batch>;
  /** SSoT görünüm: batchDetails yoksa primary aggregate'ten türetilen tek girdi. */
  details: BatchDetail[];
}

/** A weighing, as the unit weight writer applies it. */
export interface MeasuredWeight {
  /** The weighed batch: only its share of the unit moves. */
  readonly batchId: string;
  /** The sample's average weight, grams. */
  readonly avgWeightG: number;
  /** The sample's measurementDate: a Date, or a `date` column's 'YYYY-MM-DD' text. */
  readonly measuredAt: Date | string;
}

/**
 * The UTC calendar day of a weighing. Samples are stored in a `date` column,
 * so two samples of one day carry no order between them: the later-recorded one
 * is applied, and only a sample from an EARLIER day is held back.
 */
export function weighingDay(value: Date | string): string {
  return new Date(value).toISOString().slice(0, 10);
}

@Injectable()
export class BiomassGrowthApplierService {
  private readonly logger = new Logger(BiomassGrowthApplierService.name);

  constructor(@Optional() private readonly metrics?: FarmDomainMetricsService) {}

  /**
   * Kanonik kilit edinimi: batchDetails'teki TÜM batch'ler (batchId asc,
   * pessimistic_write) → TankBatch. Üyelik kilit sonrası değiştiyse
   * ConflictException (retryable) — kısmi/sıradışı kilit YOK.
   */
  /**
   * A batch row locked for write, reusing the unit lock ONLY when that lock
   * genuinely covers this batch.
   *
   * Callers used to decide this themselves and the idiom drifted apart:
   * `create-feeding-record` asked `locked?.batches.get(batchId)` (correct —
   * membership-checked), while `update-feeding-record` wrote
   * `lock: locked ? undefined : { mode: 'pessimistic_write' }`, which skips the
   * lock on the mere PRESENCE of a unit lock. Two reachable cases break that
   * assumption: `lockUnitForGrowth` returns a LockedUnit with an EMPTY batches
   * map for an emptied tank (no batchDetails, null primaryBatchId), and
   * `batches` only ever holds the unit's CURRENT batches — so correcting a
   * historical record whose batch has since left the tank locks a different
   * batch than the one being mutated. Either way the aggregate was
   * read-modify-written unlocked, under a comment claiming it was safe
   * (FARM-HIGH-248).
   *
   * Asking the token instead of asking whether a token exists is the whole
   * fix, and having ONE implementation of the question is what stops the two
   * call sites diverging again.
   */
  async lockBatchForWrite(
    manager: EntityManager,
    tenantId: string,
    batchId: string,
    locked: LockedUnit | null,
  ): Promise<Batch | null> {
    const alreadyLocked = locked?.batches.get(batchId);
    if (alreadyLocked) return alreadyLocked;

    return manager.findOne(Batch, {
      where: { id: batchId, tenantId },
      lock: { mode: 'pessimistic_write' },
    });
  }

  async lockUnitForGrowth(
    manager: EntityManager,
    tenantId: string,
    unitId: string,
  ): Promise<LockedUnit | null> {
    const preview = await manager.findOne(TankBatch, {
      where: { tankId: unitId, tenantId },
    });
    if (!preview) return null;

    const previewIds = this.batchIdsOf(preview).sort();
    const batches = new Map<string, Batch>();
    if (previewIds.length > 0) {
      const lockedBatches = await manager.find(Batch, {
        where: { id: In(previewIds), tenantId },
        lock: { mode: 'pessimistic_write' },
        order: { id: 'ASC' },
      });
      for (const batch of lockedBatches) batches.set(batch.id, batch);
    }

    const tankBatch = await manager.findOne(TankBatch, {
      where: { tankId: unitId, tenantId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!tankBatch) return null;

    const lockedIds = this.batchIdsOf(tankBatch);
    const missing = lockedIds.filter((id) => !batches.has(id));
    if (missing.length > 0) {
      // Kilitsiz önizleme ile kilitli durum arasında üyelik değişti — sıra
      // bozmadan devam etmek imkânsız; çağıran transaction'ı yeniden dener.
      throw new ConflictException(
        `Unit ${unitId} batch membership changed during lock acquisition (missing: ${missing.join(', ')}). Retry.`,
      );
    }

    return { tankBatch, batches, details: this.detailsOf(tankBatch) };
  }

  /**
   * growthKg'yi ünitenin batch paylarına biomass oranında dağıtır, TankBatch
   * aggregate'lerini batchDetails'ten TÜRETİR, her etkilenen Batch'in
   * theoretical ağırlığını TÜM ünitelerdeki paylarının toplamından yeniden
   * hesaplar (D-1) ve Tank projeksiyonunu günceller (P-13 metrikli).
   *
   * `growthKg` NEGATİF olabilir (correctMealPour aşağı düzeltmesi büyümeyi
   * geri alır — C-11); pay hiçbir zaman sıfırın altına inmez.
   *
   * ÖN KOŞUL: `locked` bu servisin `lockUnitForGrowth`'undan gelir (kanonik sıra).
   */
  async applyGrowth(
    manager: EntityManager,
    tenantId: string,
    locked: LockedUnit,
    growthKg: number,
    basedOnFcr: number,
  ): Promise<void> {
    if (growthKg === 0) return;
    const { tankBatch, details } = locked;
    const totalBiomass = details.reduce((acc, detail) => acc + Number(detail.biomassKg || 0), 0);
    if (totalBiomass <= 0) return;

    // D-2: pay oranında dağıtım — batchDetails SSoT, aggregate'ler türetilir.
    for (const detail of details) {
      const share = (Number(detail.biomassKg) / totalBiomass) * growthKg;
      detail.biomassKg = round3(Math.max(Number(detail.biomassKg) + share, 0));
      if (detail.quantity > 0) {
        detail.avgWeightG = round3((detail.biomassKg * 1000) / detail.quantity);
      }
    }
    await this.saveUnitFromDetails(manager, locked);

    // D-1: her etkilenen batch'in theoretical'ı TÜM ünitelerdeki paylarının
    // toplamından — aynı transaction, son-yazan-kazanır imkânsız.
    for (const [batchId, batch] of locked.batches) {
      await this.restampTheoreticalFromShares(manager, tenantId, batchId, batch, basedOnFcr);
    }

    await this.projectTankBiomass(manager, tenantId, tankBatch, 'growth_apply');
  }

  /**
   * Re-bases the weighed batch's share of the unit onto the measured average.
   *
   * WHY: every ration path (the 06:00 plan, the intra-day recalc, the feed
   * forecast) sizes the feed from this unit's aggregates, and until this
   * existed only the FCR projection moved them, so a weighing reached no ration
   * (FARM-CRITICAL-454).
   *
   * WHAT: the share's biomass becomes its fish count times the measured
   * average. Only the weighed batch's share moves: in a mixed tank the other
   * batches were not sampled. The count is untouched, since a sample asserts a
   * weight, never a population (the count's writer is TankBatchService).
   * Aggregates, the batch's theoretical track (D-1) and the Tank projection
   * (P-13) follow exactly as after FCR growth, and the unit is stamped with the
   * weighing's day.
   *
   * A sample from an earlier day than the one this share was last re-based on
   * moves nothing (FARM-MEDIUM-453): it is older than what the tank already
   * knows. Returns whether the share moved, so the caller reprices the day plan
   * only when the ration's input changed.
   *
   * PRECONDITION: `locked` comes from `lockUnitForGrowth` (canonical order).
   *
   * @throws BadRequestException when the unit does not hold the batch, or the
   *   sample's average is not a positive weight.
   */
  async applyMeasuredWeight(
    manager: EntityManager,
    tenantId: string,
    locked: LockedUnit,
    weighing: MeasuredWeight,
  ): Promise<boolean> {
    const { tankBatch, details } = locked;
    const share = details.find((detail) => detail.batchId === weighing.batchId);
    const batch = locked.batches.get(weighing.batchId);
    if (!share || !batch) {
      throw new BadRequestException(
        `Batch ${weighing.batchId} is not stocked in unit ${tankBatch.tankId}; ` +
          'a growth sample must name the tank its fish were taken from.',
      );
    }
    if (!(weighing.avgWeightG > 0)) {
      throw new BadRequestException(
        `A growth sample must weigh more than 0 g on average (got ${weighing.avgWeightG}).`,
      );
    }

    const measuredAt = new Date(weighing.measuredAt);
    if (
      share.lastSampledAt !== undefined &&
      weighingDay(measuredAt) < weighingDay(share.lastSampledAt)
    ) {
      return false;
    }

    share.biomassKg = round3((Number(share.quantity) * weighing.avgWeightG) / 1000);
    share.avgWeightG = round3(weighing.avgWeightG);
    share.lastSampledAt = measuredAt.toISOString();
    // The row's stamp is the tank's latest weighing of any batch, so a share
    // weighed later than another keeps it from moving back.
    if (!tankBatch.lastSamplingAt || measuredAt > new Date(tankBatch.lastSamplingAt)) {
      tankBatch.lastSamplingAt = measuredAt;
    }
    await this.saveUnitFromDetails(manager, locked);
    // A weighing moves the weight, not the FCR the projection divides by, so
    // the theoretical track keeps the FCR it was last projected with.
    await this.restampTheoreticalFromShares(manager, tenantId, weighing.batchId, batch, null);
    await this.projectTankBiomass(manager, tenantId, tankBatch, 'growth_measure');
    return true;
  }

  /**
   * Derives the TankBatch aggregates from `batchDetails[]` (the SSoT) and
   * saves the row: total and current biomass, average weight over the unit's
   * count, and each share's percentage of the biomass.
   */
  private async saveUnitFromDetails(manager: EntityManager, locked: LockedUnit): Promise<void> {
    const { tankBatch, details } = locked;
    const newTotalBiomass = details.reduce((acc, detail) => acc + Number(detail.biomassKg), 0);
    tankBatch.batchDetails = details;
    tankBatch.totalBiomassKg = round3(newTotalBiomass);
    tankBatch.currentBiomassKg = tankBatch.totalBiomassKg;
    if (tankBatch.totalQuantity > 0) {
      tankBatch.avgWeightG = round3((newTotalBiomass * 1000) / tankBatch.totalQuantity);
    }
    for (const detail of details) {
      detail.percentageOfTank =
        newTotalBiomass > 0 ? round3((Number(detail.biomassKg) / newTotalBiomass) * 100) : 0;
    }
    await manager.save(tankBatch);
  }

  /**
   * D-1: the batch's theoretical track is the sum of its shares in every unit.
   * `basedOnFcr` null keeps the FCR the track was last projected with.
   */
  private async restampTheoreticalFromShares(
    manager: EntityManager,
    tenantId: string,
    batchId: string,
    batch: Batch,
    basedOnFcr: number | null,
  ): Promise<void> {
    const sums = await this.sumBatchSharesAcrossUnits(manager, tenantId, batchId);
    if (!sums) return;
    if (batch.weight?.theoretical) {
      batch.weight.theoretical.totalBiomass = round3(sums.biomassKg);
      batch.weight.theoretical.avgWeight =
        sums.quantity > 0 ? round3((sums.biomassKg * 1000) / sums.quantity) : 0;
      batch.weight.theoretical.lastCalculatedAt = new Date();
      if (basedOnFcr !== null) batch.weight.theoretical.basedOnFCR = basedOnFcr;
    }
    await manager.save(batch);
  }

  /** P-13: Tank projeksiyonu — konvansiyon tutmuyorsa YAPISAL metrik + warn. */
  private async projectTankBiomass(
    manager: EntityManager,
    tenantId: string,
    tankBatch: TankBatch,
    operation: 'growth_apply' | 'growth_measure',
  ): Promise<void> {
    const tank = await manager.findOne(Tank, {
      where: { id: tankBatch.tankId, tenantId },
      lock: { mode: 'pessimistic_write' },
    });
    if (tank) {
      tank.currentBiomass = tankBatch.totalBiomassKg;
      await manager.save(tank);
    } else {
      this.metrics?.recordTankProjectionMiss({ operation });
      this.logger.warn(
        `Tank projection row missing for unit ${tankBatch.tankId} — currentBiomass not projected (P-13).`,
      );
    }
  }

  /**
   * D-1 invariant girdisi: batch'in TÜM tank_batches satırlarındaki payları.
   * batchDetails taşıyan satırlarda ilgili girdi; taşımayanlarda primary
   * aggregate okunur. Aynı transaction'da koşar.
   *
   * `$2` İKİ bağlamda kullanılıyor: jsonb'den çıkan `->>'batchId'` (text) ve
   * `primaryBatchId` (uuid). Postgres bir parametreye TEK tip çıkarır; ilk
   * kullanım text olduğu için `$2`'yi text'e bağlar ve `uuid = text` operatörü
   * bulunmadığından sorgu PARSE anında patlar — veriden bağımsız, HER çağrıda.
   * `applyGrowth` bunu her kilitli batch için çağırdığından büyüme uygulayan
   * her öğün kaydı ve her DAILY rollup bu hatayı alıyordu; mock'lu süitler
   * göremiyordu çünkü sorgu hiç Postgres'e gitmiyordu. Bu yüzden uuid kolonu
   * text'e cast edilir: parametre her iki karşılaştırmada da text kalır.
   */
  private async sumBatchSharesAcrossUnits(
    manager: EntityManager,
    tenantId: string,
    batchId: string,
  ): Promise<{ biomassKg: number; quantity: number } | null> {
    const rows: Array<{ biomass: string | number | null; quantity: string | number | null }> =
      await manager.query(
        `SELECT
           COALESCE(detail.value->>'biomassKg', tb."totalBiomassKg"::text)::numeric AS biomass,
           COALESCE(detail.value->>'quantity', tb."totalQuantity"::text)::numeric AS quantity
         FROM "tank_batches" tb
         LEFT JOIN LATERAL jsonb_array_elements(COALESCE(tb."batchDetails", '[]'::jsonb)) AS detail(value)
           ON detail.value->>'batchId' = $2
         WHERE tb."tenantId" = $1
           AND (
             detail.value IS NOT NULL
             OR (tb."primaryBatchId"::text = $2 AND (tb."batchDetails" IS NULL OR jsonb_array_length(tb."batchDetails") = 0))
           )`,
        [tenantId, batchId],
      );
    if (rows.length === 0) return null;
    return rows.reduce(
      (acc, row) => ({
        biomassKg: acc.biomassKg + Number(row.biomass ?? 0),
        quantity: acc.quantity + Number(row.quantity ?? 0),
      }),
      { biomassKg: 0, quantity: 0 },
    );
  }

  private batchIdsOf(tankBatch: TankBatch): string[] {
    const detailIds = (tankBatch.batchDetails ?? [])
      .map((detail) => detail.batchId)
      .filter(Boolean);
    if (detailIds.length > 0) return [...new Set(detailIds)];
    return tankBatch.primaryBatchId ? [tankBatch.primaryBatchId] : [];
  }

  /** batchDetails SSoT görünümü; yoksa primary aggregate'ten tek sanal girdi. */
  private detailsOf(tankBatch: TankBatch): BatchDetail[] {
    if (tankBatch.batchDetails?.length) return tankBatch.batchDetails;
    if (!tankBatch.primaryBatchId) return [];
    return [
      {
        batchId: tankBatch.primaryBatchId,
        batchNumber: tankBatch.primaryBatchNumber ?? '',
        quantity: tankBatch.totalQuantity,
        avgWeightG: Number(tankBatch.avgWeightG || 0),
        biomassKg: Number(tankBatch.totalBiomassKg || 0),
        percentageOfTank: 100,
      },
    ];
  }
}
