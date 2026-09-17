/**
 * BiomassGrowthApplierService v3 — ünitenin ağırlık/biyokütle durumunun TEK
 * yazarı. v2 yalnızca FCR PROJEKSİYONUNU uyguluyordu; v3'e ÖLÇÜM yolu eklendi.
 *
 * v2 bug'ları ve kökten çözümleri:
 *  - P0-1 (kopuk halka): bir tartım `Batch.weight.actual`'a yazılıp orada
 *    ölüyordu; plan/band/oran yollarının HEPSİ `TankBatch.avgWeightG` okuduğu
 *    için 200 balık tartıp %40 sapma bulmak yem planını DEĞİŞTİRMİYORDU. v3'te
 *    `reconcileMeasuredWeight` ölçümü FCR yoluyla AYNI kilit sırası ve AYNI
 *    oransal dağıtımla ünite aggregate'lerine indirir; `lastSamplingAt` — bu
 *    güne kadar hiçbir yazarı olmayan alan — burada damgalanır.
 *  - P0-2 (provenans yokluğu): projeksiyon ile ölçüm veritabanında AYNI iki
 *    kolondu; hangisinin uydurma hangisinin tartılmış olduğu okunamıyordu.
 *    v3'te TEK yazar `BiomassWriteProvenance` ayrımlı birleşimini ZORUNLU
 *    parametre olarak alır: provenanssız yazım İFADE EDİLEMEZ. Provenans
 *    `TankBatch.weightProvenance` + doğru Batch izine (`theoretical` vs
 *    `actual`) düşer ve `Batch.weight.variance` — bugüne dek hiç yazılmamış
 *    blok — projeksiyon/ölçüm farkından hesaplanır.
 *
 * v1'den devralınan invariantlar (korunur):
 *  - D-1: `Batch.weight.*` TEK tankın değeriyle EZİLMEZ; batch'in TÜM
 *    ünitelerdeki paylarının toplamından aynı transaction'da hesaplanır.
 *  - D-2: değişim ÜNİTE seviyesinde uygulanır ve `batchDetails[]` girdilerine
 *    pay oranında dağıtılır; `batchDetails` SSoT, aggregate'ler ondan TÜRETİLİR.
 *  - P-13: `Tank.currentBiomass` projeksiyonu; ID-konvansiyonu tutmayan ünitede
 *    miss YAPISAL metrikle ölçülür (sessiz no-op ölür).
 *  - K-1: `lockUnitForGrowth` batch'leri batchId ARTAN sırada pessimistic_write
 *    kilitler, SONRA TankBatch'i kilitler; kilit sonrası üyelik değiştiyse
 *    ConflictException (çağıran transaction'ı yeniden dener).
 *
 * @module FeedingProtocol/Services
 */
import { ConflictException, Injectable, Logger, Optional } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';

import { Batch } from '../../batch/entities/batch.entity';
import type { BatchWeight } from '../../batch/entities/batch.types';
import {
  TankBatch,
  BatchDetail,
  type TankWeightProvenance,
} from '../../batch/entities/tank-batch.entity';
import { Tank } from '../../tank/entities/tank.entity';
import { FarmDomainMetricsService } from '../../common/metrics/farm-domain-metrics.service';

/**
 * Ölçüm ile projeksiyon arasındaki farkın "anlamlı" sayıldığı eşik (%).
 *
 * WHY: `BatchWeight.variance.isSignificant` tip olarak vardı ama HİÇBİR yazarı
 * yoktu, dolayısıyla eşik de hiçbir yerde tanımlı değildi. Yem oranı bantları
 * 100 g mertebesinde geniş olduğundan %10'un altındaki sapma bant seçimini
 * pratikte değiştirmez; %10 ve üstü sapma operatörün bakması gereken bir model
 * kaymasıdır.
 * WHAT: |(ölçülen − projekte) / projekte| × 100 > 10 → isSignificant.
 */
export const SIGNIFICANT_WEIGHT_VARIANCE_PERCENT = 10;

export interface LockedUnit {
  tankBatch: TankBatch;
  /** batchId → kilitli Batch (batchId artan sırada kilitlendi). */
  batches: Map<string, Batch>;
  /** SSoT görünüm: batchDetails yoksa primary aggregate'ten türetilen tek girdi. */
  details: BatchDetail[];
}

/**
 * Bir tartımın taşıdığı provenans. Ölçüm KİMLİĞİ (measurementId) zorunludur:
 * kaynağı gösterilemeyen bir "ölçüm" projeksiyondan ayırt edilemez.
 */
export interface MeasurementProvenance {
  readonly source: 'measurement';
  readonly measurementId: string;
  readonly measuredAt: Date;
  readonly sampleSize: number;
  readonly confidencePercent: number;
}

/** FCR modelinin ürettiği (ölçülmemiş, projekte) büyümenin provenansı. */
export interface FcrProjectionProvenance {
  readonly source: 'fcr_projection';
  readonly basedOnFcr: number;
}

/**
 * TEK yazarın ZORUNLU parametresi.
 *
 * WHY: v2'de yazar çıplak bir `basedOnFcr: number` alıyordu; ölçülmüş bir
 * ağırlık bu yoldan geçseydi FCR projeksiyonu olarak kalıcılaşırdı — yani
 * tartılmış sayı, modelin uydurduğu sayıdan ayırt edilemez hale gelirdi.
 * Ayrımlı birleşim, "bu sayı nereden geldi?" sorusunu çağrının TİPİNE taşır:
 * etiketsiz bir yazım derlenmez.
 */
export type BiomassWriteProvenance = FcrProjectionProvenance | MeasurementProvenance;

/** `reconcileMeasuredWeight` sonucu — tartımın modele karşı ölçtüğü hata. */
export interface MeasuredReconciliation {
  /** Tartımdan HEMEN ÖNCE FCR projeksiyonunun ulaştığı ünite ortalaması (g). */
  projectedAvgWeightG: number;
  /** Tartımın ünite için ileri sürdüğü ortalama (g). */
  measuredAvgWeightG: number;
  /** (ölçülen − projekte) / projekte × 100. */
  projectionErrorPercent: number;
  /** Ünite biyokütlesine uygulanan işaretli düzeltme (kg). */
  appliedDeltaKg: number;
  /** Tartımın DEĞİŞTİRMEDİĞİ balık adedi (sayım SSoT'si TankBatchService'tedir). */
  fishCount: number;
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
   * FCR PROJEKSİYONU yolu: `growthKg`'yi ünitenin batch paylarına biomass
   * oranında dağıtır ve provenansı `fcr_projection` olarak damgalar.
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
    // Projeksiyon yolunun pay tabanı biyokütledir: sıfır biyokütleli üniteye
    // FCR büyümesi dağıtmanın tanımlı bir oranı yoktur (ölçüm yolunda vardır —
    // orada ağırlığı ölçüm SÖYLER, adet zaten bilinir).
    const totalBiomass = locked.details.reduce(
      (acc, detail) => acc + Number(detail.biomassKg || 0),
      0,
    );
    if (totalBiomass <= 0) return;

    await this.applyBiomassDelta(manager, tenantId, locked, growthKg, {
      source: 'fcr_projection',
      basedOnFcr,
    });
  }

  /**
   * ÖLÇÜM yolu: bir tartımın ileri sürdüğü ORTALAMA AĞIRLIĞI üniteye indirir.
   *
   * WHY (alan kuralı): karışık tank TEK KOHORTTUR — balıklar boy ayrımından
   * geçip birlikte yerleştirilir, yani tank tek boy sınıfı taşır ve bir tartım
   * TANKI örnekler. Bu yüzden ölçüm tank seviyesinde geçerlidir ve farkı
   * `batchDetails` paylarına oranla dağıtmak doğru davranıştır (batch kimliği
   * yalnız İZLENEBİLİRLİK için tutulur; AĞIRLIK tank seviyesindedir).
   *
   * WHY (adet dokunulmazlığı): bir tartım ORTALAMA AĞIRLIK ileri sürer, POPÜLASYON
   * İLERİ SÜRMEZ. Adedin tek sahibi `TankBatchService.applyBatchDelta`'dır
   * (stok/ölüm/transfer/hasat). Bu yüzden hedef biyokütle BİLİNEN adetten
   * türetilir (`adet × ölçülenOrtalama / 1000`) ve `totalQuantity` hiç
   * yazılmaz — bir örneklem popülasyonu sessizce yeniden ifade edemez.
   *
   * ÖN KOŞUL: `locked` bu servisin `lockUnitForGrowth`'undan gelir (kanonik sıra).
   *
   * @returns Ölçüm ile projeksiyonun farkı; ünite boşsa ya da ölçüm geçersizse `null`.
   */
  async reconcileMeasuredWeight(
    manager: EntityManager,
    tenantId: string,
    locked: LockedUnit,
    measuredAvgWeightG: number,
    provenance: MeasurementProvenance,
  ): Promise<MeasuredReconciliation | null> {
    if (!(measuredAvgWeightG > 0)) return null;

    const { details } = locked;
    const fishCount = details.reduce((acc, detail) => acc + Number(detail.quantity || 0), 0);
    if (fishCount <= 0) return null;

    const currentBiomassKg = details.reduce(
      (acc, detail) => acc + Number(detail.biomassKg || 0),
      0,
    );
    const projectedAvgWeightG = round3((currentBiomassKg * 1000) / fishCount);
    // Hedef biyokütle: ölçümün söylediği ağırlık × ZATEN BİLİNEN adet.
    const measuredBiomassKg = (fishCount * measuredAvgWeightG) / 1000;
    const deltaKg = round3(measuredBiomassKg - currentBiomassKg);

    await this.applyBiomassDelta(manager, tenantId, locked, deltaKg, provenance);

    return {
      projectedAvgWeightG,
      measuredAvgWeightG: round3(measuredAvgWeightG),
      projectionErrorPercent: projectionErrorPercent(measuredAvgWeightG, projectedAvgWeightG),
      appliedDeltaKg: deltaKg,
      fishCount,
    };
  }

  /**
   * `Batch.weight` provenans bloklarının TEK yazarı (şekil kuralı burada yaşar).
   *
   * WHY: hangi izin (theoretical | actual) yazılacağı, hangi alanların
   * damgalanacağı ve variance'ın nasıl türetileceği tek yerde durmalı; aksi
   * halde ikinci bir yazar er ya da geç ölçümü projeksiyon izine yazar. Ünitesi
   * olmayan (havuzda/tanksız) bir batch'in tartımı da bu fonksiyondan geçer —
   * sayıların NEREDEN geldiği değişir, blok ŞEKLİ değişmez.
   *
   * @param aggregate Batch'in TÜM ünitelerdeki paylarının toplamı.
   */
  stampBatchWeight(
    batch: Batch,
    aggregate: { biomassKg: number; quantity: number },
    provenance: BiomassWriteProvenance,
  ): void {
    const weight = this.ensureWeightBlocks(batch);
    const avgWeight =
      aggregate.quantity > 0 ? round3((aggregate.biomassKg * 1000) / aggregate.quantity) : 0;

    if (provenance.source === 'fcr_projection') {
      weight.theoretical.totalBiomass = round3(aggregate.biomassKg);
      weight.theoretical.avgWeight = avgWeight;
      weight.theoretical.lastCalculatedAt = new Date();
      weight.theoretical.basedOnFCR = provenance.basedOnFcr;
    } else {
      weight.actual.totalBiomass = round3(aggregate.biomassKg);
      weight.actual.avgWeight = avgWeight;
      weight.actual.lastMeasuredAt = provenance.measuredAt;
      weight.actual.sampleSize = provenance.sampleSize;
      weight.actual.confidencePercent = provenance.confidencePercent;
    }

    // Bu satır fazın bütün amacı: ölçüm ile projeksiyonun farkı ARTIK
    // hesaplanabilir bir sayıdır. Yalnız iki iz de doluyken anlamlıdır —
    // tek izli batch'te fark uydurulmaz, sıfır bırakılır.
    const measured = weight.actual.avgWeight;
    const projected = weight.theoretical.avgWeight;
    if (measured > 0 && projected > 0) {
      const percentageDifference = projectionErrorPercent(measured, projected);
      weight.variance = {
        weightDifference: round3(measured - projected),
        percentageDifference,
        isSignificant: Math.abs(percentageDifference) > SIGNIFICANT_WEIGHT_VARIANCE_PERCENT,
      };
    }
  }

  // ==========================================================================
  // TEK YAZAR
  // ==========================================================================

  /**
   * Ünitenin biyokütlesini `deltaKg` kadar değiştiren TEK yol.
   *
   * Provenans ZORUNLU parametredir (etiketsiz yazım ifade edilemez) ve hem
   * `TankBatch.weightProvenance`'a hem de doğru `Batch.weight` izine düşer.
   */
  private async applyBiomassDelta(
    manager: EntityManager,
    tenantId: string,
    locked: LockedUnit,
    deltaKg: number,
    provenance: BiomassWriteProvenance,
  ): Promise<void> {
    const { tankBatch, details } = locked;
    const totalBiomass = details.reduce((acc, detail) => acc + Number(detail.biomassKg || 0), 0);
    const totalQuantity = details.reduce((acc, detail) => acc + Number(detail.quantity || 0), 0);

    // Pay tabanı: normalde biyokütle payı (D-2). Biyokütle sıfırken oran
    // tanımsızdır; o durumda TEK savunulabilir taban adet payıdır — ölçüm
    // yolunda bu gerçek bir hâldir (yeni stoklanmış, ağırlığı henüz sıfır
    // görünen ünitenin ilk tartımı) ve payı adede göre dağıtmak, ölçülen
    // ortalamayı her girdiye aynen vermekle özdeştir.
    const useBiomassShare = totalBiomass > 0;
    const shareBasis = useBiomassShare ? totalBiomass : totalQuantity;
    if (shareBasis <= 0) return;

    // Ölçüm provenansı için: tartımın DEĞİŞTİRDİĞİ projeksiyon değeri, mutasyon
    // ÖNCESİNDE yakalanmalı — sonra okunursa ölçümün kendisi geri okunur.
    const projectedAvgWeightG =
      totalQuantity > 0 ? round3((totalBiomass * 1000) / totalQuantity) : 0;

    // D-2: pay oranında dağıtım — batchDetails SSoT, aggregate'ler türetilir.
    for (const detail of details) {
      const weight = useBiomassShare ? Number(detail.biomassKg || 0) : Number(detail.quantity || 0);
      const share = (weight / shareBasis) * deltaKg;
      detail.biomassKg = round3(Math.max(Number(detail.biomassKg || 0) + share, 0));
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

    tankBatch.weightProvenance = this.toTankProvenance(
      provenance,
      Number(tankBatch.avgWeightG || 0),
      projectedAvgWeightG,
    );
    if (provenance.source === 'measurement') {
      // Bu alanın bugüne kadar HİÇBİR yazarı yoktu (tank.resolver ve
      // equipment.resolver okuyordu, kalıcı olarak null'dı). Tartımın tek
      // doğru damgası burasıdır.
      tankBatch.lastSamplingAt = provenance.measuredAt;
    }
    await manager.save(tankBatch);

    // D-1: her etkilenen batch'in ağırlığı TÜM ünitelerdeki paylarının
    // toplamından — aynı transaction, son-yazan-kazanır imkânsız.
    for (const [batchId, batch] of locked.batches) {
      const sums = await this.sumBatchSharesAcrossUnits(manager, tenantId, batchId);
      if (!sums) continue;
      this.stampBatchWeight(batch, sums, provenance);
      await manager.save(batch);
    }

    // P-13: Tank projeksiyonu — konvansiyon tutmuyorsa YAPISAL metrik + warn.
    const tank = await manager.findOne(Tank, {
      where: { id: tankBatch.tankId, tenantId },
      lock: { mode: 'pessimistic_write' },
    });
    if (tank) {
      tank.currentBiomass = tankBatch.totalBiomassKg;
      await manager.save(tank);
    } else {
      this.metrics?.recordTankProjectionMiss({
        operation: provenance.source === 'measurement' ? 'growth_measure' : 'growth_apply',
      });
      this.logger.warn(
        `Tank projection row missing for unit ${tankBatch.tankId} — currentBiomass not projected (P-13).`,
      );
    }
  }

  /** Domain provenansını kalıcı `TankBatch.weightProvenance` şekline çevirir. */
  private toTankProvenance(
    provenance: BiomassWriteProvenance,
    newAvgWeightG: number,
    projectedAvgWeightG: number,
  ): TankWeightProvenance {
    const at = new Date().toISOString();
    if (provenance.source === 'fcr_projection') {
      return { source: 'fcr_projection', at, basedOnFcr: provenance.basedOnFcr };
    }
    return {
      source: 'measurement',
      at,
      measurementId: provenance.measurementId,
      sampleSize: provenance.sampleSize,
      confidencePercent: provenance.confidencePercent,
      measuredAvgWeightG: round3(newAvgWeightG),
      supersededProjectedAvgWeightG: projectedAvgWeightG,
      projectionErrorPercent: projectionErrorPercent(newAvgWeightG, projectedAvgWeightG),
    };
  }

  /**
   * Eksik ağırlık bloklarını TAMAMLAR (atlamaz).
   *
   * WHY: v2 `if (batch.weight?.theoretical)` ile eksik bloğu SESSİZCE atlıyordu —
   * yani baseline öncesi kısmi JSONB taşıyan bir batch'te yazım hiç olmuyordu.
   * Sessiz no-op, bu fazın kökten sildiği hata sınıfının ta kendisi; blok yoksa
   * doğru davranış onu kurmaktır. `initial` yalnızca yokken ve OKUNAN değerden
   * kurulur — uydurma bir başlangıç ağırlığı üretilmez.
   */
  private ensureWeightBlocks(batch: Batch): BatchWeight {
    const existing: Partial<BatchWeight> = batch.weight ?? {};
    const weight: BatchWeight = {
      initial: existing.initial ?? {
        avgWeight: 0,
        totalBiomass: 0,
        measuredAt: batch.stockedAt ?? new Date(),
      },
      theoretical: existing.theoretical ?? {
        avgWeight: 0,
        totalBiomass: 0,
        lastCalculatedAt: new Date(0),
        basedOnFCR: 0,
      },
      actual: existing.actual ?? {
        avgWeight: 0,
        totalBiomass: 0,
        lastMeasuredAt: new Date(0),
        sampleSize: 0,
        confidencePercent: 0,
      },
      variance: existing.variance ?? {
        weightDifference: 0,
        percentageDifference: 0,
        isSignificant: false,
      },
    };
    batch.weight = weight;
    return weight;
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
           ON detail.value->>'batchId' = $2
         WHERE tb."tenantId" = $1
           AND (
             detail.value IS NOT NULL
             OR (tb."primaryBatchId" = $2 AND (tb."batchDetails" IS NULL OR jsonb_array_length(tb."batchDetails") = 0))
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

function round3(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

/**
 * (ölçülen − projekte) / projekte × 100 — `BatchWeight.variance` ile AYNI işaret
 * konvansiyonu (pozitif = balık modelin sandığından ağır). Projeksiyon sıfırken
 * oran tanımsızdır; sonsuz yerine 0 döner (karşılaştıracak model yok demektir).
 */
function projectionErrorPercent(measured: number, projected: number): number {
  if (!(projected > 0)) return 0;
  return round3(((measured - projected) / projected) * 100);
}
