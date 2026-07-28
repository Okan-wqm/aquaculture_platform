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
 *  (c) Storage FEFO düşümü — ünitenin SİTESİYLE sınırlı, site'ta lot yoksa
 *      belgeli tenant-geneli fallback (D-9, gözlemlenebilir warn); idempotency
 *      anahtarı öğün dökümünde `meal-deduct-${mealId}-${pourIndex}`, manuel
 *      yolda `feeding-deduct-${recordId}` — replay çift düşüm YAPAMAZ.
 *      Tek-ledger cutover sonrası kullanılabilir stok satırı yoksa kayıt
 *      FAIL-CLOSED olur; projection yokluğu eski uyumluluk yolunu açamaz.
 *  (d) `FeedingRecordedEvent` outbox — AYNI manager (outbox invariantı);
 *      additive `mealId/pourIndex/dayPlanId/unitId` alanları taşınır.
 *
 * Maliyet sahipliği (C-16): `feedCost` verilmemişse feed.pricePerKg'den TÜM
 * çağıranlar için burada hesaplanır — execution yolunun finansı eksik sayma
 * bug'ı kökten ölür. Para birimi tenant finance-settings SSoT'sinden çözülür.
 *
 * @module Feeding/Services
 */
import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import { toEventIso, FeedingRecordedEvent, createBaseEvent } from '@platform/event-contracts';

import { FeedingRecord, FeedingMethod } from '../entities/feeding-record.entity';
import { Batch } from '../../batch/entities/batch.entity';
import { Feed } from '../../feed/entities/feed.entity';
import { StockMovementService } from '../../storage/services/stock-movement.service';
import { FeedAllocationService } from '../../storage/services/feed-allocation.service';
import { MovementType } from '../../storage/entities/stock-movement.entity';
import { StorageItemType } from '../../storage/entities/storage-inventory.entity';
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
  private readonly logger = new Logger(FeedingLedgerService.name);

  constructor(
    private readonly stockMovementService: StockMovementService,
    private readonly financeSettings: FinanceSettingsService,
    private readonly outboxPublisher: OutboxPublisher,
    // Çok-lotlu FEFO tahsis motoru (FARM-CRITICAL-245).
    private readonly feedAllocation: FeedAllocationService,
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
      // FARM-CRITICAL-241: drain penceresinde yazılan canlı satır, tarihsel
      // backfill satırıyla AYNI şekle sahip (`sourceExecutionId` dolu,
      // `mealId` boş). Provenans damgası olmadan ne rollback ne attribution
      // onarımı kendi satırını tanıyabiliyordu.
      backfillSource: params.sourceExecutionId ? 'live-drain' : undefined,
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
    await this.outboxPublisher.enqueue(event, manager);

    return saved;
  }

  /**
   * FEFO düşümü — site kapsamlı (D-9). Tek-ledger cutover sonrasında uygun
   * lot yoksa projection satırının geçmişte var olup olmadığına bakmadan
   * FAIL-CLOSED fırlatır.
   */
  private async deductFromStorage(
    manager: EntityManager,
    tenantId: string,
    userId: string,
    saved: FeedingRecord,
    params: RecordFeedParams,
  ): Promise<void> {
    // ÇOK-LOTLU FEFO tahsisi (FARM-CRITICAL-245): yetersizlik kararı SATIRDAN
    // değil HAVUZ TOPLAMINDAN verilir ve düşüm gerekirse birden çok lota
    // kaskad eder. Eskiden tek satır seçiliyordu; 0.3 kg'lık artık lot,
    // sitede 3000 kg varken 150 kg'lık öğünü komple reddediyordu.
    const allocation = await this.feedAllocation.allocateForDeduction(manager, tenantId, {
      feedId: params.feedId,
      quantityKg: params.actualAmountKg,
      asOf: params.feedingDate,
      lotNumber: params.feedBatchNumber,
      siteId: params.siteId,
    });

    const baseKey =
      params.mealId != null && params.pourIndex != null
        ? `meal-deduct-${params.mealId}-${params.pourIndex}`
        : `feeding-deduct-${saved.id}`;

    for (const [index, slice] of allocation.slices.entries()) {
      // Tek dilimli tahsis ESKİ anahtarı birebir korur: cutover öncesi yazılmış
      // düşümlerin replay'i hâlâ idempotent hit alır. Çok dilimli tahsis yeni
      // bir durumdur, dolayısıyla ek indeks çakışma üretemez.
      const idempotencyKey = index === 0 ? baseKey : `${baseKey}-${index}`;
      await this.stockMovementService.recordMovement(
        manager,
        {
          movementType: MovementType.OUT,
          itemType: StorageItemType.FEED,
          itemId: params.feedId,
          quantity: slice.quantityKg,
          fromLocationId: slice.storageLocationId,
          lotNumber: slice.lotNumber,
          reference: `FEEDING: ${saved.id}`,
          reason: 'Auto-deducted from feeding record (in-transaction).',
          idempotencyKey,
          movementDate: params.feedingDate,
        },
        { tenantId, userId, userName: 'Feeding' },
      );
    }
  }

  /**
   * Yem düzeltmesinin stok ayağı — TEK uygulama (FARM-MEDIUM-253/254,
   * FARM-HIGH-248). Hem `correctMealPour` hem `updateFeedingRecord` buradan
   * geçer; iki kopya idempotency, lot seçimi ve iade kurallarında sapardı.
   *
   *  - Ön koşul "feed'in ŞU AN storage satırı var mı" DEĞİL, "bu kayıt için OUT
   *    hareketi yazıldı mı"dır: lot tükenip satır silindiğinde eski kontrol
   *    iadeyi SESSİZCE atlıyordu.
   *  - Yukarı düzeltme çok-lotlu FEFO tahsisinden geçer (havuz toplamı kararı).
   *  - Aşağı düzeltme LIFO: en son çekilen lottan başlayarak iade edilir ve
   *    lot dağılımı korunur (eski hâl her zaman "orijinal" tek harekete iade
   *    edip expiry'siz hayalet lot satırı doğuruyordu).
   */
  async applyStockCorrection(
    manager: EntityManager,
    tenantId: string,
    userId: string,
    params: {
      feedId: string;
      deltaKg: number;
      siteId?: string;
      /** Orijinal düşümün idempotency anahtar KÖKÜ (dilimler `-1`, `-2` …). */
      deductionKeyBase: string;
      /** Bu düzeltmenin idempotency anahtarı (revizyon dahil). */
      correctionKey: string;
      reference: string;
    },
  ): Promise<void> {
    if (params.deltaKg === 0) return;

    const deductions: Array<{
      fromLocationId: string | null;
      lotNumber: string | null;
      expiryDate: Date | null;
      receivedDate: Date | null;
      quantity: string | number;
    }> = await manager.query(
      // Expiry and arrival travel WITH the lot (FARM-MEDIUM-254): a lot that
      // drained to zero has no `storage_inventory` row left, so returning to it
      // re-creates one. Without these two columns that row was born undated and
      // FEFO sorted the returned feed as the freshest stock in the location.
      `SELECT "from_location_id" AS "fromLocationId",
              "lot_number"       AS "lotNumber",
              "expiry_date"      AS "expiryDate",
              "received_date"    AS "receivedDate",
              quantity
         FROM "stock_movements"
        WHERE "tenant_id" = $1
          AND ("idempotency_key" = $2 OR "idempotency_key" LIKE $2 || '-%')
          AND "movement_type" = $3
        ORDER BY "idempotency_key" ASC`,
      // Hareket tipi PARAMETRE olarak bağlanır, string literal olarak DEĞİL.
      // Literal hâli ('OUT') kolonun gerçek içeriğiyle ('out' — MovementType.OUT
      // değeri, varchar(20) kolonuna TypeORM tarafından yazılır) hiç eşleşmiyordu;
      // sorgu her zaman sıfır satır dönüyor, fonksiyon aşağıdaki erken çıkışa
      // düşüyor ve düzeltmenin stok ayağı İKİ YÖNDE de sessizce atlanıyordu.
      // Enum'ı bağlayarak SSoT TypeScript tarafına alınır: harf sapması artık
      // derleme zamanı bir isim hatası olur, sessiz sıfır-satır değil.
      [tenantId, params.deductionKeyBase, MovementType.OUT],
    );

    if (deductions.length === 0) {
      this.logger.warn(
        `No OUT movement recorded for ${params.deductionKeyBase} — storage correction skipped ` +
          '(Phase-A feed, no ledger footprint).',
      );
      return;
    }

    if (params.deltaKg > 0) {
      const allocation = await this.feedAllocation.allocateForDeduction(manager, tenantId, {
        feedId: params.feedId,
        quantityKg: params.deltaKg,
        asOf: new Date(),
        siteId: params.siteId,
      });
      for (const [index, slice] of allocation.slices.entries()) {
        await this.stockMovementService.recordMovement(
          manager,
          {
            movementType: MovementType.OUT,
            itemType: StorageItemType.FEED,
            itemId: params.feedId,
            quantity: slice.quantityKg,
            fromLocationId: slice.storageLocationId,
            lotNumber: slice.lotNumber,
            reference: params.reference,
            reason: 'Feeding correction — upward (in-transaction).',
            idempotencyKey: index === 0 ? params.correctionKey : `${params.correctionKey}-${index}`,
            movementDate: new Date(),
          },
          { tenantId, userId, userName: 'Feeding' },
        );
      }
      return;
    }

    let remaining = Math.abs(params.deltaKg);
    const lifo = [...deductions].reverse();
    for (const [index, movement] of lifo.entries()) {
      if (remaining <= 0) break;
      if (!movement.fromLocationId) continue;
      const giveBack = Math.min(remaining, Number(movement.quantity));
      if (giveBack <= 0) continue;
      await this.stockMovementService.recordMovement(
        manager,
        {
          movementType: MovementType.IN,
          itemType: StorageItemType.FEED,
          itemId: params.feedId,
          quantity: giveBack,
          toLocationId: movement.fromLocationId,
          lotNumber: movement.lotNumber ?? undefined,
          // The lot goes back with the identity it left with, not as a new
          // arrival. NULL stays NULL — an unknown provenance is not invented.
          expiryDate: movement.expiryDate ?? undefined,
          receivedDate: movement.receivedDate ?? undefined,
          reference: params.reference,
          reason: 'Feeding correction — LIFO return to the drawn lots.',
          idempotencyKey: index === 0 ? params.correctionKey : `${params.correctionKey}-r${index}`,
          movementDate: new Date(),
        },
        { tenantId, userId, userName: 'Feeding' },
      );
      remaining -= giveBack;
    }

    if (remaining > 0.001) {
      // Düşülenden fazla iade istenemez — sessiz kısmi iade yerine fail-closed.
      throw new ConflictException(
        `İade miktarı bu kaydın düşümlerini aşıyor (${params.deductionKeyBase}, kalan ${remaining}kg)`,
      );
    }
  }

  /** C-16: maliyet TÜM çağıranlar için burada — finans eksik saymaz. */
  private calculateFeedCost(feed: Feed, amountKg: number): number {
    if (!feed.pricePerKg) return 0;
    return Number(feed.pricePerKg) * amountKg;
  }
}
