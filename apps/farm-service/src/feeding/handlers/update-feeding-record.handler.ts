/**
 * UpdateFeedingRecordHandler — plan-dışı yem kaydının düzeltilmesi.
 *
 * FARM-HIGH-248 öncesi bu handler YALNIZ `feeding_records.actualAmount` ve
 * `batches_v2.totalFeedConsumed` yazıyordu: stok, gün planı ve biyokütle
 * dokunulmadan kalıyordu. Üç yönlü sapma üretiyordu:
 *
 *  - **Stok:** düşüm `feeding-deduct-<id>` anahtarıyla kayıt başına BİR kez
 *    yazıldığı için hiçbir düzeltme onu büyütemiyordu → fantom stok; gerçek
 *    lot bitince fail-closed düşüm beklenmedik anda yemlemeyi reddediyordu.
 *  - **Plan:** `unplannedActualKg` eski değerinde kalıyor, kalan öğünler bayat
 *    biyokütleden fiyatlanıyordu.
 *  - **Büyüme (en tehlikelisi, iki yönlü):** yukarı düzeltmede biyokütle eksik
 *    kalıyor; AŞAĞI düzeltmede uygulanmış büyüme geri alınmıyor → ortalama
 *    ağırlık fazla görünüyor → YANLIŞ protokol bandı → sistematik aşırı
 *    besleme. Yani hata ertesi günün plan üretimini besliyordu.
 *
 * Ayrıca batch aggregate'i KİLİTSİZ read-modify-write ile yazılıyordu; aynı
 * agregayı yazan diğer iki yol kilitliyor — eşzamanlı `correctMealPour` sessizce
 * eziliyordu (lost update).
 *
 * Yeni akış `correctMealPour` mimarisinin AYNISI: kanonik kilitler
 * (Batch asc → TankBatch → DayPlan), farkın ledger üzerinden stok hareketi,
 * `unplannedActualKg` deltası, büyüme deltası + recalc — hepsi AYNI
 * transaction'da.
 *
 * @module Feeding/Handlers
 */
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { OutboxPublisher } from '@platform/outbox';
import {
  toEventIso,
  createBaseEvent,
  type FeedingRecordUpdatedEvent,
} from '@platform/event-contracts';
import { UpdateFeedingRecordCommand } from '../commands/update-feeding-record.command';
import { FeedingRecord } from '../entities/feeding-record.entity';
import { Batch } from '../../batch/entities/batch.entity';
import { FeedingLedgerService } from '../services/feeding-ledger.service';
import { BiomassGrowthApplierService } from '../../feeding-protocol/services/biomass-growth-applier.service';
import { DayPlanRecalcService } from '../../feeding-protocol/services/day-plan-recalc.service';
import { FeedingDayPlan } from '../../feeding-protocol/entities/feeding-day-plan.entity';
import { withUnitLockRetry } from '../../feeding-protocol/services/unit-lock-retry.util';

@Injectable()
@CommandHandler(UpdateFeedingRecordCommand)
export class UpdateFeedingRecordHandler
  implements ICommandHandler<UpdateFeedingRecordCommand, FeedingRecord>
{
  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly feedingLedger: FeedingLedgerService,
    private readonly growthApplier: BiomassGrowthApplierService,
    private readonly recalcService: DayPlanRecalcService,
  ) {}

  async execute(command: UpdateFeedingRecordCommand): Promise<FeedingRecord> {
    return withUnitLockRetry(() => this.executeOnce(command));
  }

  private async executeOnce(command: UpdateFeedingRecordCommand): Promise<FeedingRecord> {
    const { tenantId, feedingRecordId, payload, userId } = command;

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;

      // Kilitsiz ön-okuma: kimlikler (kanonik kilit sırası için).
      const preview = await manager.findOne(FeedingRecord, {
        where: { id: feedingRecordId, tenantId },
      });
      if (!preview) {
        throw new NotFoundException(`Feeding record ${feedingRecordId} bulunamadı`);
      }

      // C-11: öğün-bağlı kayıt bu yoldan düzeltilemez — `correctMealPour`
      // öğün varyansını ve döküm sayaçlarını da yönetir.
      if (preview.mealId != null) {
        throw new BadRequestException(
          `Feeding record ${feedingRecordId} bir öğün dökümüne bağlı (meal ${preview.mealId}) — ` +
            `updateFeedingRecord ile düzeltilemez; correctMealPour kullanın`,
        );
      }

      // Kanonik kilitler: Batch(asc) → TankBatch (ünite üzerinden) → DayPlan.
      const locked = preview.tankId
        ? await this.growthApplier.lockUnitForGrowth(manager, tenantId, preview.tankId)
        : null;
      const batch = await manager.findOne(Batch, {
        where: { id: preview.batchId, tenantId },
        lock: locked ? undefined : { mode: 'pessimistic_write' },
      });
      const dayPlan = preview.dayPlanId
        ? await manager.findOne(FeedingDayPlan, {
            where: { id: preview.dayPlanId, tenantId },
            lock: { mode: 'pessimistic_write' },
          })
        : null;

      const record = await manager.findOne(FeedingRecord, {
        where: { id: feedingRecordId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!record) {
        throw new NotFoundException(`Feeding record ${feedingRecordId} bulunamadı`);
      }

      const oldActualAmount = Number(record.actualAmount);
      const oldFeedCost = Number(record.feedCost || 0);
      // Bu kayda daha önce yazılmış düzeltme hareketi sayısı → yeni revizyon.
      const priorCorrections: Array<{ count: string | number }> = await manager.query(
        `SELECT COUNT(*)::int AS count FROM "stock_movements"
          WHERE "tenant_id" = $1 AND "idempotency_key" LIKE $2 || '%'`,
        [tenantId, `feeding-correct-${record.id}-`],
      );
      const correctionRevision = Number(priorCorrections[0]?.count ?? 0) + 1;

      if (payload.actualAmount !== undefined) record.actualAmount = payload.actualAmount;
      if (payload.wasteAmount !== undefined) record.wasteAmount = payload.wasteAmount;
      if (payload.environment !== undefined) record.environment = payload.environment;
      if (payload.fishBehavior !== undefined) record.fishBehavior = payload.fishBehavior;
      if (payload.feedingMethod !== undefined) record.feedingMethod = payload.feedingMethod;
      if (payload.feedingDurationMinutes !== undefined) {
        record.feedingDurationMinutes = payload.feedingDurationMinutes;
      }
      if (payload.feedCost !== undefined) record.feedCost = payload.feedCost;
      if (payload.notes !== undefined) record.notes = payload.notes;
      if (payload.skipReason !== undefined) record.skipReason = payload.skipReason;
      record.calculateVariance();

      const saved = await manager.save(record);
      const newActualAmount = Number(saved.actualAmount);
      const newFeedCost = Number(saved.feedCost || 0);
      const amountDiff = round3(newActualAmount - oldActualAmount);
      const costDiff = round3(newFeedCost - oldFeedCost);

      // (a) Stok: farkın kendisi ledger üzerinden — çok-lotlu tahsis (yukarı)
      //     veya LIFO iade (aşağı). Revizyon sayacı kayıt sürümünden gelir ki
      //     art arda düzeltmeler ayrı idempotency anahtarları alsın.
      if (amountDiff !== 0) {
        await this.feedingLedger.applyStockCorrection(manager, tenantId, userId, {
          feedId: saved.feedId,
          deltaKg: amountDiff,
          siteId: dayPlan?.siteId,
          deductionKeyBase: `feeding-deduct-${saved.id}`,
          // Revizyon damgası: art arda düzeltmelerin idempotency anahtarları
          // çakışmasın diye kayıt üzerindeki düzeltme sayacı kullanılır.
          correctionKey: `feeding-correct-${saved.id}-${correctionRevision}`,
          reference: `FEEDING-CORRECTION: ${saved.id}`,
        });
      }

      // (b) Batch aggregate — KİLİTLİ nesne üzerinden (lost update yok).
      if (batch && (amountDiff !== 0 || costDiff !== 0)) {
        batch.totalFeedConsumed = round3(Number(batch.totalFeedConsumed || 0) + amountDiff);
        batch.totalFeedCost = round3(Number(batch.totalFeedCost || 0) + costDiff);
        await manager.save(batch);
      }

      // (c) Plan-dışı toplam + büyüme deltası + kalan öğünlerin recalc'ı.
      if (amountDiff !== 0 && dayPlan) {
        await manager.query(
          `UPDATE "feeding_day_plans" SET "unplannedActualKg" = "unplannedActualKg" + $1
            WHERE "tenantId" = $2 AND id = $3`,
          [amountDiff, tenantId, dayPlan.id],
        );
      }
      if (amountDiff !== 0 && locked) {
        const expectedFcr = Number(dayPlan?.resolution?.expectedFcr) || 0;
        if (expectedFcr > 0) {
          await this.growthApplier.applyGrowth(
            manager,
            tenantId,
            locked,
            amountDiff / expectedFcr,
            expectedFcr,
          );
        }
        if (preview.tankId) {
          await this.recalcService.recalcForUnit(
            manager,
            tenantId,
            preview.tankId,
            'unplanned_feed',
          );
        }
      }

      // Always-fire event: downstream FCR / feed-cost projections need EVERY
      // correction, including behaviour/notes-only ones.
      const event: FeedingRecordUpdatedEvent = {
        ...createBaseEvent<FeedingRecordUpdatedEvent>('FeedingRecordUpdated', tenantId, {
          aggregateId: saved.id,
          aggregateType: 'FeedingRecord',
        }),
        feedingRecordId: saved.id,
        batchId: saved.batchId,
        previousActualAmountKg: oldActualAmount,
        newActualAmountKg: newActualAmount,
        amountDiffKg: amountDiff,
        previousFeedCost: oldFeedCost,
        newFeedCost,
        costDiff,
        updatedAt: toEventIso(new Date()),
      };
      await this.outboxPublisher.enqueue(event, manager);

      return saved;
    });
  }
}

/** kg alanları numeric(…,3) — aritmetik aynı hassasiyette. */
function round3(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}
