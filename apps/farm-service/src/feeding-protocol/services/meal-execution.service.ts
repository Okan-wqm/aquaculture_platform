/**
 * MealExecutionService — öğün kaydı/atlama akışının sahibi (Faz 5, plan §2).
 *
 * `recordMealFeeding` TEK tenant transaction'ında KANONİK KİLİT SIRASINA uyar
 * (K-1): önce receipt begin (replay hiçbir kilit almadan saklı sonucu döner),
 * sonra Batch(ler, batchId asc) → TankBatch (BiomassGrowthApplier kilit
 * yardımcısı) → FeedingDayPlan → FeedingMeal → (gerekirse) ProtocolAssignment →
 * storage EN SON (FeedingLedgerService içinde). Site yetkisi yazma tx'i
 * İÇİNDE fail-closed doğrulanır (SEC-HIGH-051).
 *
 * Kısmi öğün (D-8): her döküm `pours[]`'a eklenir ve ledger üzerinden BİR
 * `feeding_records` satırı üretir (idempotency `meal-deduct-<mealId>-<pourIndex>`
 * — replay çift düşüm YAPAMAZ; receipt purge edilse bile ikinci katman budur).
 * Öğün operatör onayıyla (`finalize`) kapanır: varyans hesaplanır, `per_meal`
 * modda büyüme uygulanır (growthKg = actualKg / beklenenFCR — snapshot'taki
 * OVERRIDE çözümü aynen kullanılır), kalan öğünler AYNI tx'te yeniden
 * fiyatlanır ve az-atım eşiği aşıldıysa `MealUnderfed` yazılır (P-21).
 *
 * C-17: stok-azaltan bu akış legacy (envelope'suz) modu REDDeder — eski
 * `recordDailyFeeding`'in drain-penceresi toleransı bu yola taşınmaz.
 *
 * Öğün kaydında paralel mortality alanı YOKTUR (P-31) — UI kanonik mortality
 * komutuna yönlendirir; o komut recalc'ı zaten tetikler.
 *
 * @module FeedingProtocol/Services
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import {
  MobileCommandReceiptService,
  type MobileCommandEnvelope,
} from '@aquaculture/backend-common/mobile-command';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { Role } from '@aquaculture/backend-common/decorators';
import { OutboxPublisher } from '@platform/outbox';
import {
  createBaseEvent,
  toEventIso,
  MealFedEvent,
  MealSkippedEvent,
  MealUnderfedEvent,
} from '@platform/event-contracts';

import { FeedingMeal, FeedingMealStatus, MealPour } from '../entities/feeding-meal.entity';
import { FeedingDayPlan, FeedingDayPlanStatus } from '../entities/feeding-day-plan.entity';
import { FeedingProtocolV2 } from '../entities/feeding-protocol-v2.entity';
import { BiomassGrowthApplierService } from './biomass-growth-applier.service';
import { DayPlanRecalcService } from './day-plan-recalc.service';
import { FeedingLedgerService } from '../../feeding/services/feeding-ledger.service';
import { FeedingMethod, FeedingRecord } from '../../feeding/entities/feeding-record.entity';
import { Feed } from '../../feed/entities/feed.entity';
import { BatchDomainService } from '../../batch/services/batch-domain.service';
import { resolveTankSiteId } from '../../batch/utils/tank-lookup.util';
import { StockMovementService } from '../../storage/services/stock-movement.service';
import { FeedAllocationService } from '../../storage/services/feed-allocation.service';
import { MovementType } from '../../storage/entities/stock-movement.entity';
import { StorageItemType } from '../../storage/entities/storage-inventory.entity';
import type { FeedingRecordUpdatedEvent } from '@platform/event-contracts';
import { round3 } from './rounding.util';
import { withUnitLockRetry } from './unit-lock-retry.util';

// ============================================================================
// TYPES
// ============================================================================

export interface MealCaller {
  sub: string;
  roles: Role[];
  assignedSiteIds?: string[];
}

export interface RecordMealFeedingParams {
  tenantId: string;
  userId: string;
  caller: MealCaller;
  mealId: string;
  pourKg: number;
  /** Operatör "öğün bitti" onayı — varyans + growth + recalc bu adımda. */
  finalize: boolean;
  feedingMethod?: string;
  notes?: string;
  envelope?: MobileCommandEnvelope | null;
}

export interface MealFeedingResult {
  id: string;
  status: FeedingMealStatus;
  actualKg: number;
  varianceKg: number | null;
  variancePercent: number | null;
}

const RECEIPT_TABLE = 'farm_mobile_command_receipts' as const;

// ============================================================================
// SERVICE
// ============================================================================

@Injectable()
export class MealExecutionService {
  private readonly logger = new Logger(MealExecutionService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly receiptService: MobileCommandReceiptService,
    private readonly siteAuth: SiteAuthorizationService,
    private readonly growthApplier: BiomassGrowthApplierService,
    private readonly recalcService: DayPlanRecalcService,
    private readonly feedingLedger: FeedingLedgerService,
    private readonly batchDomainService: BatchDomainService,
    private readonly stockMovementService: StockMovementService,
    // Çok-lotlu FEFO tahsisi — düşüm ve yukarı düzeltme aynı motordan geçer.
    private readonly feedAllocation: FeedAllocationService,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async recordMealFeeding(params: RecordMealFeedingParams): Promise<MealFeedingResult> {
    if (!Number.isFinite(params.pourKg) || params.pourKg <= 0 || params.pourKg > 10000) {
      throw new BadRequestException('Döküm miktarı 0 < kg <= 10000 aralığında olmalıdır');
    }
    // FARM-MEDIUM-288: ünite batch üyeliği kilit ediniminde değişirse
    // (transfer/stoklama/tam hasat) TRANSACTION SINIRINDA sınırlı yeniden
    // deneme — kendi kendine geçen bir yarış operatöre 409 olarak yansımaz.
    return withUnitLockRetry(() => this.recordMealFeedingOnce(params));
  }

  private async recordMealFeedingOnce(params: RecordMealFeedingParams): Promise<MealFeedingResult> {
    return runInTenantTransaction(this.dataSource, 'farm', params.tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;

      // 1) Receipt — replay saklı sonucu HİÇBİR kilit almadan döner (adım sırası).
      const receipt = await this.receiptService.begin(manager, {
        tableName: RECEIPT_TABLE,
        tenantId: params.tenantId,
        envelope: params.envelope,
        operationType: 'recordMealFeeding',
        responseType: 'FeedingMeal',
      });
      if (receipt.mode === 'replay') {
        return this.replayResult(receipt.responsePayload);
      }
      if (receipt.mode === 'legacy') {
        // C-17: stok-azaltan akış envelope'suz (legacy) komutu kabul etmez.
        throw new BadRequestException(
          'recordMealFeeding requires the mobile idempotency envelope (clientCommandId + payloadHash)',
        );
      }

      // 2) Kilitsiz ön-okuma: ünite/dayPlan kimlikleri (kanonik sıra için).
      const preview = await manager.findOne(FeedingMeal, {
        where: { id: params.mealId, tenantId: params.tenantId },
      });
      if (!preview) throw new NotFoundException(`Öğün bulunamadı: ${params.mealId}`);

      // 3) Kanonik kilitler: Batch(asc) → TankBatch (+ TÜM batch'ler feedable, D-2).
      const locked = await this.growthApplier.lockUnitForGrowth(
        manager,
        params.tenantId,
        preview.unitId,
      );
      if (!locked) {
        throw new ConflictException(`Ünitede stok kaydı yok: ${preview.unitId}`);
      }
      for (const batch of locked.batches.values()) {
        this.batchDomainService.assertFeedable(batch);
      }

      // 4) DayPlan → Meal kilitleri + durum doğrulaması.
      const dayPlan = await manager.findOne(FeedingDayPlan, {
        where: { id: preview.dayPlanId, tenantId: params.tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!dayPlan) throw new NotFoundException(`Gün planı bulunamadı: ${preview.dayPlanId}`);
      const meal = await manager.findOne(FeedingMeal, {
        where: { id: params.mealId, tenantId: params.tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!meal) throw new NotFoundException(`Öğün bulunamadı: ${params.mealId}`);
      if (
        meal.status !== FeedingMealStatus.SCHEDULED &&
        meal.status !== FeedingMealStatus.PARTIALLY_FED
      ) {
        throw new ConflictException(
          `Öğün '${meal.status}' durumunda — yalnız scheduled/partially_fed öğün beslenebilir`,
        );
      }

      // 5) SEC-HIGH-051: site yetkisi yazma tx'i İÇİNDE, fail-closed.
      const siteId = await resolveTankSiteId(manager, meal.unitId, params.tenantId);
      this.siteAuth.assertSiteAssignment({
        caller: {
          sub: params.caller.sub,
          roles: params.caller.roles,
          assignedSiteIds: params.caller.assignedSiteIds,
        },
        siteId,
      });

      // 6) Döküm ekle (kümülatif) — ledger tek yem yazma yolu (storage EN SON).
      const pourIndex = (meal.pours ?? []).length;
      const now = new Date();
      const pour: MealPour = {
        pourIndex,
        kg: round3(params.pourKg),
        at: now.toISOString(),
        by: params.userId,
        feedingMethod: params.feedingMethod,
      };
      meal.pours = [...(meal.pours ?? []), pour];
      meal.actualKg = round3(Number(meal.actualKg || 0) + params.pourKg);
      meal.feedingMethod = params.feedingMethod ?? meal.feedingMethod;
      if (params.notes) meal.notes = params.notes;

      const primaryBatchId = locked.tankBatch.primaryBatchId;
      const primaryBatch = primaryBatchId ? locked.batches.get(primaryBatchId) : undefined;
      if (!primaryBatch) {
        throw new ConflictException(
          `Ünitenin birincil batch'i çözülemedi (${meal.unitId}) — yem kaydı batch'siz yazılamaz`,
        );
      }
      const feed = await manager.findOne(Feed, {
        where: { id: meal.feedId, tenantId: params.tenantId },
      });
      if (!feed) throw new NotFoundException(`Yem bulunamadı: ${meal.feedId}`);

      await this.feedingLedger.recordFeed(
        manager,
        params.tenantId,
        params.userId,
        primaryBatch,
        feed,
        {
          batchId: primaryBatch.id,
          tankId: meal.unitId,
          feedId: meal.feedId,
          plannedAmountKg: params.finalize ? Number(meal.plannedKg) : undefined,
          actualAmountKg: params.pourKg,
          feedingDate: now,
          feedingTime: `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`,
          feedingMethod: (params.feedingMethod as FeedingMethod) ?? FeedingMethod.MANUAL,
          fedBy: params.userId,
          mealId: meal.id,
          pourIndex,
          dayPlanId: dayPlan.id,
          siteId: siteId ?? undefined,
        },
      );

      // 7) MealFed — döküm başına durable event (D-8 granülü).
      const fedEvent: MealFedEvent = {
        ...createBaseEvent<MealFedEvent>('MealFed', params.tenantId, {
          aggregateId: meal.id,
          aggregateType: 'FeedingMeal',
        }),
        unitId: meal.unitId,
        mealId: meal.id,
        dayPlanId: dayPlan.id,
        feedId: meal.feedId,
        pourIndex,
        pourKg: pour.kg,
        actualKg: meal.actualKg,
        fedAt: toEventIso(now),
        feedingMethod: params.feedingMethod,
      };
      await this.outboxPublisher.enqueue(fedEvent, manager);

      // 8) Finalize: varyans + growth (per_meal) + kalan öğünlerin recalc'ı.
      // `mealPersisted`: per_meal dalında öğün recalc'tan ÖNCE yazılır (M-1);
      // bayrak çift yazımı önler.
      let mealPersisted = false;
      if (params.finalize) {
        meal.status = FeedingMealStatus.FED;
        meal.fedAt = now;
        meal.fedBy = params.userId;
        meal.varianceKg = round3(meal.actualKg - Number(meal.plannedKg));
        meal.variancePercent =
          Number(meal.plannedKg) > 0
            ? round3(((meal.actualKg - Number(meal.plannedKg)) / Number(meal.plannedKg)) * 100)
            : 0;

        const protocol = await manager.findOne(FeedingProtocolV2, {
          where: { id: dayPlan.protocolId, tenantId: params.tenantId },
        });

        // Mod PLANIN kolonundan okunur (FARM-CRITICAL-244): protokolün o anki
        // ayarına bakmak, ayar değiştiğinde büyümeyi çift saydırıyor ya da
        // kaybettiriyordu. Eski `protocol?.settings... !== 'daily'` kalıbı
        // ayrıca FAIL-OPEN'dı: protokol bulunamazsa sessizce per_meal
        // uyguluyordu.
        if (dayPlan.growthApplicationMode !== 'daily') {
          // per_meal: growthKg = actualKg / beklenen FCR (snapshot provenanslı).
          const expectedFcr = dayPlan.resolution.expectedFcr;
          const growthKg = expectedFcr > 0 ? meal.actualKg / expectedFcr : 0;
          await this.growthApplier.applyGrowth(
            manager,
            params.tenantId,
            locked,
            growthKg,
            expectedFcr,
          );
          // M-1 (FARM-MEDIUM-250): öğün satırı recalc'tan ÖNCE yazılır.
          // Aksi hâlde recalc `status='scheduled'` filtresiyle BU öğünü de
          // "kalan" sayıp yeniden fiyatlıyor, ardından bayat entity ile
          // yapılan save + settleDayPlanStatus recalc'ın `recalcLog` ve
          // `plannedTotalKg` yazımını geri alıyordu (lost update).
          // `correctMealPour` bu sırayı zaten doğru uyguluyor.
          await manager.save(meal);
          mealPersisted = true;
          // Kalan öğünler yeni biomass'tan — band geçişi histerezisle burada.
          await this.recalcService.recalcForUnit(
            manager,
            params.tenantId,
            meal.unitId,
            'meal_growth',
          );
        }

        // P-21: az-atım eşiği (negatif varyans) — finalize'da, öğün kapsamında.
        const threshold = protocol?.settings.underfeedAlertThresholdPercent ?? 15;
        if (meal.variancePercent !== null && meal.variancePercent < -threshold) {
          const underfed: MealUnderfedEvent = {
            ...createBaseEvent<MealUnderfedEvent>('MealUnderfed', params.tenantId, {
              aggregateId: meal.id,
              aggregateType: 'FeedingMeal',
            }),
            scope: 'meal',
            unitId: meal.unitId,
            unitCode: dayPlan.unitCode,
            dayPlanId: dayPlan.id,
            mealId: meal.id,
            plannedKg: Number(meal.plannedKg),
            actualKg: meal.actualKg,
            variancePercent: meal.variancePercent,
            thresholdPercent: threshold,
          };
          await this.outboxPublisher.enqueue(underfed, manager);
        }
      } else {
        meal.status = FeedingMealStatus.PARTIALLY_FED;
      }
      if (!mealPersisted) await manager.save(meal);

      // 9) Day plan durumu: ilk döküm → in_progress; açık öğün kalmadıysa completed.
      await this.settleDayPlanStatus(manager, params.tenantId, dayPlan);

      const result: MealFeedingResult = {
        id: meal.id,
        status: meal.status,
        actualKg: meal.actualKg,
        varianceKg: meal.varianceKg ?? null,
        variancePercent: meal.variancePercent ?? null,
      };

      // 10) Receipt complete — commit ile atomik.
      await this.receiptService.complete(manager, {
        tableName: RECEIPT_TABLE,
        receipt,
        responseType: 'FeedingMeal',
        responseId: meal.id,
        responsePayload: result,
      });
      return result;
    });
  }

  /**
   * Döküm düzeltmesi (C-11): fark kadar stok hareketi (IN iade / ek OUT) +
   * kayıt/öğün varyansı + growth-delta AYNI transaction'da. `updateFeedingRecord`
   * öğün-bağlı kayıtları buraya yönlendirir — P-05 invariantı düzeltmede de
   * bütündür. Düzeltme geçmişi pour üzerinde denetlenebilir (originalKg,
   * correctedAt/By, corrections sayacı).
   */
  async correctMealPour(params: {
    tenantId: string;
    userId: string;
    caller: MealCaller;
    mealId: string;
    pourIndex: number;
    correctedKg: number;
  }): Promise<MealFeedingResult> {
    if (
      !Number.isFinite(params.correctedKg) ||
      params.correctedKg <= 0 ||
      params.correctedKg > 10000
    ) {
      throw new BadRequestException('Düzeltilmiş miktar 0 < kg <= 10000 aralığında olmalıdır');
    }
    // FARM-MEDIUM-288 — bkz. recordMealFeeding.
    return withUnitLockRetry(() => this.correctMealPourOnce(params));
  }

  private async correctMealPourOnce(params: {
    tenantId: string;
    userId: string;
    caller: MealCaller;
    mealId: string;
    pourIndex: number;
    correctedKg: number;
  }): Promise<MealFeedingResult> {
    return runInTenantTransaction(this.dataSource, 'farm', params.tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;

      const preview = await manager.findOne(FeedingMeal, {
        where: { id: params.mealId, tenantId: params.tenantId },
      });
      if (!preview) throw new NotFoundException(`Öğün bulunamadı: ${params.mealId}`);

      // Kanonik kilitler (recordMealFeeding ile aynı sıra).
      const locked = await this.growthApplier.lockUnitForGrowth(
        manager,
        params.tenantId,
        preview.unitId,
      );
      if (!locked) throw new ConflictException(`Ünitede stok kaydı yok: ${preview.unitId}`);
      const dayPlan = await manager.findOne(FeedingDayPlan, {
        where: { id: preview.dayPlanId, tenantId: params.tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!dayPlan) throw new NotFoundException(`Gün planı bulunamadı: ${preview.dayPlanId}`);
      const meal = await manager.findOne(FeedingMeal, {
        where: { id: params.mealId, tenantId: params.tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!meal) throw new NotFoundException(`Öğün bulunamadı: ${params.mealId}`);

      const siteId = await resolveTankSiteId(manager, meal.unitId, params.tenantId);
      this.siteAuth.assertSiteAssignment({
        caller: {
          sub: params.caller.sub,
          roles: params.caller.roles,
          assignedSiteIds: params.caller.assignedSiteIds,
        },
        siteId,
      });

      const pour = (meal.pours ?? []).find((entry) => entry.pourIndex === params.pourIndex);
      if (!pour) {
        throw new NotFoundException(
          `Öğün ${params.mealId} üzerinde ${params.pourIndex} numaralı döküm yok`,
        );
      }
      const delta = round3(params.correctedKg - pour.kg);
      const currentResult: MealFeedingResult = {
        id: meal.id,
        status: meal.status,
        actualKg: Number(meal.actualKg || 0),
        varianceKg: meal.varianceKg ?? null,
        variancePercent: meal.variancePercent ?? null,
      };
      if (delta === 0) return currentResult; // no-op düzeltme

      // Pour + öğün güncellemesi (denetim izi korunur).
      const now = new Date();
      pour.originalKg = pour.originalKg ?? pour.kg;
      pour.kg = params.correctedKg;
      pour.correctedAt = now.toISOString();
      pour.correctedBy = params.userId;
      pour.corrections = (pour.corrections ?? 0) + 1;
      meal.pours = [...(meal.pours ?? [])];
      meal.actualKg = round3(Number(meal.actualKg || 0) + delta);
      if (meal.status === FeedingMealStatus.FED) {
        meal.varianceKg = round3(meal.actualKg - Number(meal.plannedKg));
        meal.variancePercent =
          Number(meal.plannedKg) > 0
            ? round3(((meal.actualKg - Number(meal.plannedKg)) / Number(meal.plannedKg)) * 100)
            : 0;
      }
      await manager.save(meal);

      // Ledger kaydı: (mealId, pourIndex) unique — döküm başına TAM bir satır (P-05).
      const record = await manager.findOne(FeedingRecord, {
        where: { tenantId: params.tenantId, mealId: meal.id, pourIndex: params.pourIndex },
      });
      if (!record) {
        throw new ConflictException(
          `Döküm kaydı bulunamadı (meal ${meal.id}, pour ${params.pourIndex}) — ledger tutarsız`,
        );
      }
      const previousAmount = Number(record.actualAmount);
      const previousCost = Number(record.feedCost || 0);
      const feed = await manager.findOne(Feed, {
        where: { id: record.feedId, tenantId: params.tenantId },
      });
      const newCost = feed?.pricePerKg
        ? round3(Number(feed.pricePerKg) * params.correctedKg)
        : previousCost;
      record.actualAmount = params.correctedKg;
      record.feedCost = newCost;
      record.calculateVariance();
      await manager.save(record);

      // Batch aggregate delta'ları (kayıttaki batch kilitli set'te olmalı).
      const batch = locked.batches.get(record.batchId);
      if (!batch) {
        throw new ConflictException(
          `Kayıt batch'i (${record.batchId}) ünitenin kilitli batch kümesinde değil — üyelik değişti, yeniden deneyin`,
        );
      }
      batch.totalFeedConsumed = round3(Number(batch.totalFeedConsumed || 0) + delta);
      batch.totalFeedCost = round3(Number(batch.totalFeedCost || 0) + (newCost - previousCost));
      await manager.save(batch);

      // Storage düzeltmesi — fark kadar; Phase-A (storage izi olmayan feed) atlanır.
      await this.applyStorageCorrection(manager, params, meal, delta, siteId);

      // Growth delta (finalize edilmiş + per_meal plan) + kalan öğün recalc'ı.
      // DAILY modda delta burada UYGULANMAZ; rollup kümülatif mutabakatla
      // (`rollupAppliedKg <> Σ actualKg`) bir sonraki koşuda uygular —
      // eski "tek atımlık damga" bu deltayı kalıcı olarak kaybediyordu
      // (FARM-CRITICAL-244).
      if (meal.status === FeedingMealStatus.FED) {
        if (dayPlan.growthApplicationMode !== 'daily') {
          const expectedFcr = dayPlan.resolution.expectedFcr;
          const growthDelta = expectedFcr > 0 ? delta / expectedFcr : 0;
          await this.growthApplier.applyGrowth(
            manager,
            params.tenantId,
            locked,
            growthDelta,
            expectedFcr,
          );
          await this.recalcService.recalcForUnit(
            manager,
            params.tenantId,
            meal.unitId,
            'pour_correction',
          );
        }
      }

      // Düzeltme, mevcut FeedingRecordUpdated kontratıyla duyurulur (ek tip yok).
      const event: FeedingRecordUpdatedEvent = {
        ...createBaseEvent<FeedingRecordUpdatedEvent>('FeedingRecordUpdated', params.tenantId, {
          aggregateId: record.batchId,
          aggregateType: 'Batch',
        }),
        feedingRecordId: record.id,
        batchId: record.batchId,
        previousActualAmountKg: previousAmount,
        newActualAmountKg: params.correctedKg,
        amountDiffKg: delta,
        previousFeedCost: previousCost,
        newFeedCost: newCost,
        costDiff: round3(newCost - previousCost),
        updatedAt: toEventIso(now),
      };
      await this.outboxPublisher.enqueue(event, manager);

      return {
        id: meal.id,
        status: meal.status,
        actualKg: meal.actualKg,
        varianceKg: meal.varianceKg ?? null,
        variancePercent: meal.variancePercent ?? null,
      };
    });
  }

  /**
   * Düzeltme stok hareketi: pozitif delta ek OUT (site-kapsamlı FEFO), negatif
   * delta orijinal düşümün lokasyonuna İADE (IN). Tek-ledger cutover sonrası
   * eksik projection veya eksik orijinal hareket fail-closed olur.
   */
  /**
   * Düzeltme stok hareketi — TEK uygulama `FeedingLedgerService`'te
   * (FARM-HIGH-248 ile aynı motoru `updateFeedingRecord` de kullanır; iki
   * kopya idempotency/lot/iade kurallarında sapardı).
   */
  private async applyStorageCorrection(
    manager: EntityManager,
    params: { tenantId: string; userId: string; mealId: string; pourIndex: number },
    meal: FeedingMeal,
    delta: number,
    siteId: string | null,
  ): Promise<void> {
    const pour = (meal.pours ?? []).find((entry) => entry.pourIndex === params.pourIndex);
    await this.feedingLedger.applyStockCorrection(manager, params.tenantId, params.userId, {
      feedId: meal.feedId,
      deltaKg: delta,
      siteId: siteId ?? undefined,
      deductionKeyBase: `meal-deduct-${params.mealId}-${params.pourIndex}`,
      correctionKey: `meal-correct-${params.mealId}-${params.pourIndex}-${pour?.corrections ?? 1}`,
      reference: `MEAL-CORRECTION: ${params.mealId}#${params.pourIndex}`,
    });
  }

  /**
   * Öğünü atla — biomass/stok dokunuşu yok; MealSkipped durable event (P-12).
   * Kilitler kanonik sırada (K-1): DayPlan → Meal — record/correct ile aynı yön.
   */
  async skipMeal(params: {
    tenantId: string;
    userId: string;
    caller: MealCaller;
    mealId: string;
    reason: string;
  }): Promise<MealFeedingResult> {
    return runInTenantTransaction(this.dataSource, 'farm', params.tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;

      // Kilitsiz ön-okuma: dayPlan kimliği (kanonik sıra K-1 — DayPlan → Meal).
      const preview = await manager.findOne(FeedingMeal, {
        where: { id: params.mealId, tenantId: params.tenantId },
      });
      if (!preview) throw new NotFoundException(`Öğün bulunamadı: ${params.mealId}`);

      const dayPlan = await manager.findOne(FeedingDayPlan, {
        where: { id: preview.dayPlanId, tenantId: params.tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!dayPlan) throw new NotFoundException(`Gün planı bulunamadı: ${preview.dayPlanId}`);
      const meal = await manager.findOne(FeedingMeal, {
        where: { id: params.mealId, tenantId: params.tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!meal) throw new NotFoundException(`Öğün bulunamadı: ${params.mealId}`);
      if (meal.status !== FeedingMealStatus.SCHEDULED) {
        throw new ConflictException(`Yalnız scheduled öğün atlanabilir (durum: ${meal.status})`);
      }

      const siteId = await resolveTankSiteId(manager, meal.unitId, params.tenantId);
      this.siteAuth.assertSiteAssignment({
        caller: {
          sub: params.caller.sub,
          roles: params.caller.roles,
          assignedSiteIds: params.caller.assignedSiteIds,
        },
        siteId,
      });

      meal.status = FeedingMealStatus.SKIPPED;
      meal.notes = params.reason;
      await manager.save(meal);

      const event: MealSkippedEvent = {
        ...createBaseEvent<MealSkippedEvent>('MealSkipped', params.tenantId, {
          aggregateId: meal.id,
          aggregateType: 'FeedingMeal',
        }),
        unitId: meal.unitId,
        mealId: meal.id,
        dayPlanId: meal.dayPlanId,
        reason: params.reason,
        skippedAt: toEventIso(new Date()),
      };
      await this.outboxPublisher.enqueue(event, manager);

      // W5 (kullanıcı kararı 3): atlanan öğünün kg'ı kalan öğünlere OTOMATİK
      // dağıtılmaz. Tenant açıkça telafi yüzdesi tanımladıysa yalnız o kadarı
      // dağıtılır; tanımlamadıysa bu çağrı hiçbir şey yapmaz.
      await this.recalcService.applyMissedCatchUp(
        manager,
        params.tenantId,
        dayPlan,
        Number(meal.plannedKg) - Number(meal.actualKg || 0),
      );

      await this.settleDayPlanStatus(manager, params.tenantId, dayPlan);

      return {
        id: meal.id,
        status: meal.status,
        actualKg: Number(meal.actualKg || 0),
        varianceKg: null,
        variancePercent: null,
      };
    });
  }

  /**
   * Replay yanıtını jsonb'den YAPISAL doğrulamayla geri kurar — saklı yanıt
   * complete()'te bu servisçe yazıldı; şekli tutmuyorsa (kayıt bozulması)
   * fail-closed Conflict fırlatılır, cast'le geçiştirilmez.
   */
  private replayResult(payload: unknown): MealFeedingResult {
    if (payload !== null && typeof payload === 'object') {
      const record: Record<string, unknown> = { ...payload };
      const { id, status, actualKg, varianceKg, variancePercent } = record;
      if (typeof id === 'string' && typeof status === 'string' && typeof actualKg === 'number') {
        return {
          id,
          status: status as FeedingMealStatus,
          actualKg,
          varianceKg: typeof varianceKg === 'number' ? varianceKg : null,
          variancePercent: typeof variancePercent === 'number' ? variancePercent : null,
        };
      }
    }
    throw new ConflictException('Stored recordMealFeeding replay payload is malformed');
  }

  /** Açık (scheduled/partially_fed) öğün kalmadıysa planı kapat; ilk aktivitede in_progress. */
  private async settleDayPlanStatus(
    manager: EntityManager,
    tenantId: string,
    dayPlan: FeedingDayPlan,
  ): Promise<void> {
    const openCount = await manager.count(FeedingMeal, {
      where: [
        { dayPlanId: dayPlan.id, tenantId, status: FeedingMealStatus.SCHEDULED },
        { dayPlanId: dayPlan.id, tenantId, status: FeedingMealStatus.PARTIALLY_FED },
      ],
    });
    const nextStatus =
      openCount === 0 ? FeedingDayPlanStatus.COMPLETED : FeedingDayPlanStatus.IN_PROGRESS;
    if (dayPlan.status !== nextStatus) {
      dayPlan.status = nextStatus;
      // HEDEFLENMİŞ update (M-1 / FARM-MEDIUM-250): tam-entity `save()` bu
      // noktada elde tutulan BAYAT nesneyi yazar ve aynı transaction'da
      // recalc'ın güncellediği `recalcLog` + `plannedTotalKg` alanlarını geri
      // alırdı (TypeORM `save()` optimistic sürüm kontrolü yapmaz, hata da
      // yükselmezdi). Yalnız durum kolonu yazılır.
      await manager.update(FeedingDayPlan, { id: dayPlan.id, tenantId }, { status: nextStatus });
    }
  }
}
