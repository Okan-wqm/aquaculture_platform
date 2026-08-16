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
 * Kilit disiplini (K-1 kanonik sıra): `withUnitGrowthMutation` batch'leri
 * batchId ARTAN sırada pessimistic_write kilitler, SONRA TankBatch'i kilitler;
 * kilit sonrası batch üyeliği değiştiyse typed retryable error fırlatılır.
 * Ham lock token'ı veya ayrı bir apply metodu yayınlanmaz: mutation yalnız
 * callback ömründeki capability üzerinden yapılabilir.
 *
 * @module FeedingProtocol/Services
 */
import { ConflictException, Injectable, Logger, Optional } from '@nestjs/common';
import {
  mutationInstantDateV1,
  type MutationInstantV1,
  type TenantMutationSession,
} from '@aquaculture/backend-common/database';
import { EntityManager, In } from 'typeorm';

import { Batch } from '../../batch/entities/batch.entity';
import { TankBatch, BatchDetail } from '../../batch/entities/tank-batch.entity';
import { Tank } from '../../tank/entities/tank.entity';
import { FarmDomainMetricsService } from '../../common/metrics/farm-domain-metrics.service';
import { round3 } from '../../common/utils/rounding.util';
import { BatchAggregateMutationPort } from '../../batch/batch-aggregate-mutation.port';

interface LockedUnit {
  readonly tankBatch: TankBatch;
  /** batchId → kilitli Batch (batchId artan sırada kilitlendi). */
  readonly batches: Map<string, Batch>;
  /** SSoT görünüm: batchDetails yoksa primary aggregate'ten türetilen tek girdi. */
  readonly details: BatchDetail[];
}

const UNIT_GROWTH_MUTATION_SCOPE_BRAND: unique symbol = Symbol();

export interface UnitGrowthApplicationV1 {
  readonly beforeBiomassKg: number;
  readonly requestedGrowthKg: number;
  readonly appliedGrowthKg: number;
  readonly afterBiomassKg: number;
}

/**
 * Ephemeral, lock-bound mutation capability. Callers cannot manufacture it and
 * there is no public API that accepts its underlying lock state.
 */
export interface UnitGrowthMutationScopeV1 {
  readonly [UNIT_GROWTH_MUTATION_SCOPE_BRAND]: true;
  readonly unitId: string;
  readonly tankBatch: TankBatch;
  readonly batches: ReadonlyMap<string, Batch>;
  readonly details: readonly BatchDetail[];
  readonly mutationInstant: MutationInstantV1;
  applyGrowth(growthKg: number, basedOnFcr: number): Promise<UnitGrowthApplicationV1>;
}

/** Marker consumed by the operation-transaction retry authority. */
export class UnitGrowthLockConflictError extends ConflictException {
  readonly retryableFeedingTransaction = true;

  constructor(message: string) {
    super(message);
    this.name = 'UnitGrowthLockConflictError';
  }
}

@Injectable()
export class BiomassGrowthApplierService {
  private readonly logger = new Logger(BiomassGrowthApplierService.name);

  constructor(
    private readonly batchMutations: BatchAggregateMutationPort,
    @Optional() private readonly metrics?: FarmDomainMetricsService,
  ) {}

  /**
   * Kanonik kilit edinimi: batchDetails'teki TÜM batch'ler (batchId asc,
   * pessimistic_write) → TankBatch. Üyelik kilit sonrası değiştiyse
   * ConflictException (retryable) — kısmi/sıradışı kilit YOK.
   */
  async withUnitGrowthMutation<T>(
    manager: EntityManager,
    mutationSession: TenantMutationSession,
    tenantId: string,
    unitId: string,
    mutationInstant: MutationInstantV1,
    work: (scope: UnitGrowthMutationScopeV1) => Promise<T>,
  ): Promise<T | null> {
    const locked = await this.acquireUnitGrowthLock(manager, tenantId, unitId);
    if (!locked) return null;
    let active = true;
    const scope = Object.freeze({
      [UNIT_GROWTH_MUTATION_SCOPE_BRAND]: true,
      unitId,
      tankBatch: locked.tankBatch,
      batches: locked.batches,
      details: locked.details,
      mutationInstant,
      applyGrowth: (growthKg: number, basedOnFcr: number) => {
        if (!active) {
          throw new Error('Unit growth mutation scope cannot outlive its lock callback');
        }
        return this.applyLockedGrowth(
          manager,
          mutationSession,
          tenantId,
          locked,
          mutationInstant,
          growthKg,
          basedOnFcr,
        );
      },
    } satisfies UnitGrowthMutationScopeV1);
    try {
      return await work(scope);
    } finally {
      active = false;
    }
  }

  /** Lock acquisition is deliberately private; only the closed callback API exposes state. */
  private async acquireUnitGrowthLock(
    manager: EntityManager,
    tenantId: string,
    unitId: string,
  ): Promise<LockedUnit | null> {
    const preview = await manager.findOne(TankBatch, {
      where: { tankId: unitId, tenantId },
    });
    const previewIds = preview ? this.batchIdsOf(preview).sort() : [];
    const batches = new Map<string, Batch>();
    if (previewIds.length > 0) {
      const lockedBatches = await manager.find(Batch, {
        where: { id: In(previewIds), tenantId },
        lock: { mode: 'pessimistic_write' },
        order: { id: 'ASC' },
      });
      for (const batch of lockedBatches) batches.set(batch.id, batch);
    }

    // The shared TankBatch identity fence is acquired after Batch locks (the
    // global Batch → TankBatch order) and before the tuple lock. It covers both
    // existing and absent aggregates, so a concurrent first-stock transaction
    // cannot race a scheduler claim through the "no row" branch.
    await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `tank-batch-mutation/v1:${tenantId}:${unitId}`,
    ]);

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
      throw new UnitGrowthLockConflictError(
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
   * geri alır — C-11). İstenen ters kayıt tam uygulanamıyorsa clamp edilmez;
   * transaction fail-closed olur ve ledger ile biyokütle ayrışmaz.
   */
  private async applyLockedGrowth(
    manager: EntityManager,
    mutationSession: TenantMutationSession,
    tenantId: string,
    locked: LockedUnit,
    mutationInstant: MutationInstantV1,
    growthKg: number,
    basedOnFcr: number,
  ): Promise<UnitGrowthApplicationV1> {
    if (!Number.isFinite(growthKg)) {
      throw new ConflictException('Growth delta must be finite');
    }
    if (!Number.isFinite(basedOnFcr) || basedOnFcr <= 0) {
      throw new ConflictException('Growth application requires a positive finite FCR');
    }
    const { tankBatch, details } = locked;
    const detailBiomasses = details.map((detail) => Number(detail.biomassKg || 0));
    if (detailBiomasses.some((value) => !Number.isFinite(value) || value < 0)) {
      throw new ConflictException(
        `Unit ${tankBatch.tankId} has invalid batch-detail biomass provenance`,
      );
    }
    const totalBiomass = round3(detailBiomasses.reduce((acc, value) => acc + value, 0));
    const requestedGrowthKg = round3(growthKg);
    if (requestedGrowthKg === 0) {
      return {
        beforeBiomassKg: totalBiomass,
        requestedGrowthKg,
        appliedGrowthKg: 0,
        afterBiomassKg: totalBiomass,
      };
    }
    if (totalBiomass <= 0 || details.length === 0) {
      throw new ConflictException(
        `Unit ${tankBatch.tankId} has no positive biomass to reconcile growth against`,
      );
    }
    const targetBiomassKg = round3(totalBiomass + requestedGrowthKg);
    if (targetBiomassKg < 0) {
      throw new ConflictException(
        `Growth reversal ${requestedGrowthKg} kg exceeds unit ${tankBatch.tankId} biomass ${totalBiomass} kg`,
      );
    }

    // D-2: millikilogram largest-remainder allocation. This is deterministic,
    // non-negative and the detail sum is byte-for-byte equal to the aggregate
    // target; independent per-row rounding cannot leak or manufacture biomass.
    const targetMilliKg = Math.round(targetBiomassKg * 1000);
    if (!Number.isSafeInteger(targetMilliKg)) {
      throw new ConflictException(
        `Unit ${tankBatch.tankId} biomass exceeds the exact millikilogram allocation range`,
      );
    }
    const allocation = details.map((detail, index) => {
      const weight = Number(detail.biomassKg || 0);
      const exact = (targetMilliKg * weight) / totalBiomass;
      const floor = Math.floor(exact);
      return {
        index,
        batchId: detail.batchId,
        milliKg: floor,
        remainder: exact - floor,
      };
    });
    let remainingMilliKg = targetMilliKg - allocation.reduce((sum, row) => sum + row.milliKg, 0);
    const remainderOrder = [...allocation].sort(
      (left, right) =>
        right.remainder - left.remainder ||
        (left.batchId < right.batchId ? -1 : left.batchId > right.batchId ? 1 : 0),
    );
    for (let cursor = 0; remainingMilliKg > 0; cursor += 1, remainingMilliKg -= 1) {
      remainderOrder[cursor % remainderOrder.length]!.milliKg += 1;
    }
    for (const row of allocation) {
      const detail = details[row.index]!;
      detail.biomassKg = row.milliKg / 1000;
      if (detail.quantity > 0) {
        detail.avgWeightG = round3((detail.biomassKg * 1000) / detail.quantity);
      }
    }
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
    await this.batchMutations.commitTankBatchTransition(mutationSession, {
      intent: 'feeding_growth_applied',
      aggregate: tankBatch,
    });

    // D-1: her etkilenen batch'in theoretical'ı TÜM ünitelerdeki paylarının
    // toplamından — aynı transaction, son-yazan-kazanır imkânsız.
    for (const [batchId, batch] of locked.batches) {
      const sums = await this.sumBatchSharesAcrossUnits(manager, tenantId, batchId);
      if (!sums) continue;
      if (batch.weight?.theoretical) {
        batch.weight.theoretical.totalBiomass = round3(sums.biomassKg);
        batch.weight.theoretical.avgWeight =
          sums.quantity > 0 ? round3((sums.biomassKg * 1000) / sums.quantity) : 0;
        batch.weight.theoretical.lastCalculatedAt = mutationInstantDateV1(mutationInstant);
        batch.weight.theoretical.basedOnFCR = basedOnFcr;
      }
      await this.batchMutations.commitBatchTransition(mutationSession, {
        intent: 'growth_applied',
        aggregate: batch,
      });
    }

    // P-13: Tank projeksiyonu — konvansiyon tutmuyorsa YAPISAL metrik + warn.
    const tank = await manager.findOne(Tank, {
      where: { id: tankBatch.tankId, tenantId },
      lock: { mode: 'pessimistic_write' },
    });
    if (tank) {
      tank.currentBiomass = tankBatch.totalBiomassKg;
      await this.batchMutations.commitTankTransition(mutationSession, {
        intent: 'feeding_growth_applied',
        aggregate: tank,
      });
    } else {
      this.metrics?.recordTankProjectionMiss({ operation: 'growth_apply' });
      this.logger.warn(
        `Tank projection row missing for unit ${tankBatch.tankId} — currentBiomass not projected (P-13).`,
      );
    }

    return {
      beforeBiomassKg: totalBiomass,
      requestedGrowthKg,
      appliedGrowthKg: round3(newTotalBiomass - totalBiomass),
      afterBiomassKg: round3(newTotalBiomass),
    };
  }

  /**
   * D-1 invariant girdisi: batch'in TÜM tank_batches satırlarındaki payları.
   * batchDetails taşıyan satırlarda ilgili girdi; taşımayanlarda primary
   * aggregate okunur. Aynı transaction'da koşar.
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
           ON detail.value->>'batchId' = $2::uuid::text
         WHERE tb."tenantId" = $1
           AND (
             detail.value IS NOT NULL
             OR (tb."primaryBatchId" = $2::uuid AND (tb."batchDetails" IS NULL OR jsonb_array_length(tb."batchDetails") = 0))
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
