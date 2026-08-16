/**
 * FeedingLedgerService — TEK yem yazma yolu (P-05, Faz 5 plan §2 adım 8).
 *
 * Üç çağıran AYNI yoldan geçer: (1) v2 öğün motoru (döküm başına), (2) manuel
 * `CreateFeedingRecordHandler`, (3) drain penceresi boyunca legacy execution
 * kaydı [K-4]. Böylece `FCRCalculationService` tüm yemi tam bir kez sayar ve
 * finans (`derived-cost-sources`) hiçbir kaydı eksik görmez.
 *
 * Sorumluluklar:
 *  (a) `FeedingRecord` satırı — döküm bağları (`mealId/pourIndex/dayPlanId`)
 *      nullable taşınır; varyans kolonları dolmaya devam eder (C-12 MV kırılmaz).
 *  (b) `Batch.totalFeedConsumed/Cost` güncellemesi — Batch kilidi ÇAĞIRANDA
 *      (kanonik kilit sırası: Batch → ... → storage EN SON [K-1]); bu servis
 *      kilitli entity'yi parametre alır, kendisi kilit almaz.
 *  (c) Storage FEFO düşümü — ünitenin SİTESİ öncelikli, site stoğu yetmezse
 *      allocation sonucunda açıkça işaretlenen tenant-geneli fallback; idempotency
 *      anahtarı öğün dökümünde `meal-deduct-${mealId}-${pourIndex}`, manuel
 *      yolda `feeding-deduct-${recordId}` — replay çift düşüm YAPAMAZ. Eksik,
 *      tükenmiş veya kullanılabilir lotu olmayan stok her zaman fail-closed'dur;
 *      uyumluluk atlaması ya da process-local fallback yoktur.
 *  (d) `FeedingRecordedEvent` outbox — AYNI manager (outbox invariantı);
 *      additive `mealId/pourIndex/dayPlanId/unitId` alanları taşınır.
 *
 * Maliyet sahipliği (C-16): `feedCost` verilmemişse feed.pricePerKg'den TÜM
 * çağıranlar için burada hesaplanır — execution yolunun finansı eksik sayma
 * bug'ı kökten ölür. Para birimi tenant finance-settings SSoT'sinden çözülür.
 *
 * @module Feeding/Services
 */
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import { toEventIso, FeedingRecordedEvent, createBaseEvent } from '@platform/event-contracts';

import { FeedingRecord, FeedingMethod } from '../entities/feeding-record.entity';
import { Batch } from '../../batch/entities/batch.entity';
import { Feed } from '../../feed/entities/feed.entity';
import { StockMovementService } from '../../storage/services/stock-movement.service';
import { FinanceSettingsService } from '../../finance/services/finance-settings.service';

// ============================================================================
// TYPES
// ============================================================================

export interface RecordFeedParams {
  batchId: string;
  tankId?: string;
  pondId?: string;
  batchLocationId?: string;
  feedId: string;
  plannedAmountKg?: number;
  actualAmountKg: number;
  wasteAmountKg?: number;
  feedingDate: Date;
  /** 'HH:mm' — legacy kolon zorunluluğu. */
  feedingTime: string;
  feedingMethod?: FeedingMethod;
  equipmentId?: string;
  feedBatchNumber?: string;
  fedBy: string;
  notes?: string;
  /** Öğün bağları (v2 motoru) — manuel yol boş bırakır. */
  mealId?: string;
  pourIndex?: number;
  dayPlanId?: string;
  /** Faz 6 tarihsel backfill idempotency anahtarı. */
  sourceExecutionId?: string;
  /** D-9 stok kapsamı: ünitenin sitesi. */
  siteId?: string;
  /** Verilmezse feed.pricePerKg'den hesaplanır (C-16). */
  feedCost?: number;
  currency?: string;
  /** Manuel yolun taşıdığı ek gözlemler (environment/fishBehavior vb.). */
  extras?: Partial<
    Pick<
      FeedingRecord,
      | 'environment'
      | 'fishBehavior'
      | 'feedingDurationMinutes'
      | 'feedingSequence'
      | 'totalMealsToday'
      | 'skipReason'
    >
  >;
}

// ============================================================================
// SERVICE
// ============================================================================

@Injectable()
export class FeedingLedgerService {
  constructor(
    private readonly stockMovementService: StockMovementService,
    private readonly financeSettings: FinanceSettingsService,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  /**
   * Tek yem yazımı. ÖN KOŞULLAR (çağıran sözleşmesi, kanonik kilit sırası):
   *  - `batch` pessimistic_write kilidiyle YÜKLENMİŞ ve feedable doğrulanmış;
   *  - `feed` aynı transaction'dan okunmuş;
   *  - storage düşümü akışın SON yazımı olarak burada koşar [K-1].
   */
  async recordFeed(
    manager: EntityManager,
    tenantId: string,
    userId: string,
    batch: Batch,
    feed: Feed,
    params: RecordFeedParams,
  ): Promise<FeedingRecord> {
    // (a) Kayıt — varyans kolonları hesaplanır (MV `mv_daily_batch_feeding`
    // bu kolonları okumaya devam eder, C-12).
    const feedCost = params.feedCost ?? this.calculateFeedCost(feed, params.actualAmountKg);
    const currency =
      params.currency ?? (await this.financeSettings.getDefaultCurrencyInTx(manager, tenantId));

    const record = manager.create(FeedingRecord, {
      tenantId,
      batchId: params.batchId,
      tankId: params.tankId,
      pondId: params.pondId,
      batchLocationId: params.batchLocationId,
      feedingDate: params.feedingDate,
      feedingTime: params.feedingTime,
      feedingSequence: params.extras?.feedingSequence ?? 1,
      totalMealsToday: params.extras?.totalMealsToday ?? 1,
      feedId: params.feedId,
      feedBatchNumber: params.feedBatchNumber,
      plannedAmount: params.plannedAmountKg,
      actualAmount: params.actualAmountKg,
      wasteAmount: params.wasteAmountKg,
      environment: params.extras?.environment,
      fishBehavior: params.extras?.fishBehavior,
      feedingMethod: params.feedingMethod ?? FeedingMethod.MANUAL,
      equipmentId: params.equipmentId,
      feedingDurationMinutes: params.extras?.feedingDurationMinutes,
      feedCost,
      currency,
      fedBy: params.fedBy,
      notes: params.notes,
      skipReason: params.extras?.skipReason,
      mealId: params.mealId,
      pourIndex: params.pourIndex,
      dayPlanId: params.dayPlanId,
      sourceExecutionId: params.sourceExecutionId,
    });
    record.calculateVariance();
    const saved = await manager.save(record);

    // (b) Batch aggregate'leri — kilit çağıranda; burada yalnız artırım.
    batch.totalFeedConsumed = Number(batch.totalFeedConsumed || 0) + params.actualAmountKg;
    batch.totalFeedCost = Number(batch.totalFeedCost || 0) + (saved.feedCost ?? 0);
    await manager.save(batch);

    // (c) Storage düşümü — akışın SON yazımı (K-1: storage-only yazarlar
    // hiçbir feeding kilidi talep etmediği için AB-BA döngüsü oluşamaz).
    await this.deductFromStorage(manager, tenantId, userId, saved, params);

    // (d) Durable event — AYNI manager (outbox invariantı).
    const event: FeedingRecordedEvent = {
      ...createBaseEvent<FeedingRecordedEvent>('FeedingRecorded', tenantId, {
        aggregateId: params.batchId,
        aggregateType: 'Batch',
      }),
      userId,
      batchId: params.batchId,
      tankId: params.tankId,
      feedId: params.feedId,
      plannedAmountKg: params.plannedAmountKg ?? 0,
      actualAmountKg: params.actualAmountKg,
      feedingDate: toEventIso(params.feedingDate),
      feedingTime: params.feedingTime || '',
      variance: params.actualAmountKg - (params.plannedAmountKg ?? 0),
      feedCost: saved.feedCost != null ? Number(saved.feedCost).toFixed(2) : undefined,
      currency: saved.feedCost != null ? saved.currency : undefined,
      mealId: params.mealId,
      pourIndex: params.pourIndex,
      dayPlanId: params.dayPlanId,
      unitId: params.tankId,
    };
    await this.outboxPublisher.enqueue(event, manager, {
      aggregateId: params.batchId,
      idempotencyKey: `feeding-recorded:${saved.id}`,
    });

    return saved;
  }

  /** FEFO allocation is compiled and mutated by the canonical stock authority. */
  private async deductFromStorage(
    manager: EntityManager,
    tenantId: string,
    userId: string,
    saved: FeedingRecord,
    params: RecordFeedParams,
  ): Promise<void> {
    const idempotencyKey =
      params.mealId != null && params.pourIndex != null
        ? `meal-deduct-${params.mealId}-${params.pourIndex}`
        : `feeding-deduct-${saved.id}`;

    await this.stockMovementService.recordFeedDeduction(
      manager,
      {
        feedId: params.feedId,
        quantityKg: params.actualAmountKg,
        occurredAt: params.feedingDate,
        preferredSiteId: params.siteId,
        lotNumber: params.feedBatchNumber,
        reference: `FEEDING: ${saved.id}`,
        reason: 'Auto-deducted from feeding record (in-transaction).',
        idempotencyKey,
      },
      { tenantId, userId, userName: 'Feeding' },
    );
  }

  /** C-16: maliyet TÜM çağıranlar için burada — finans eksik saymaz. */
  private calculateFeedCost(feed: Feed, amountKg: number): number {
    if (!feed.pricePerKg) return 0;
    return Number(feed.pricePerKg) * amountKg;
  }
}
