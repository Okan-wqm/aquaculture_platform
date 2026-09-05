/**
 * FeedingWindowReadinessListener — öğün öncesi oksijen verdiktinin öğüne
 * damgalanması (W7 — FARM-MEDIUM-271).
 *
 * `MealWindowUpcoming` her öğün için `minDissolvedOxygen` +
 * `lowOxygenReductionPercent` taşıyordu ve platformda bunları okuyan kimse
 * yoktu — operatörün protokolde kurduğu oksijen koruması hiçbir davranış
 * üretmiyordu. sensor-service artık pencere tick'inde ölçümü tabanla
 * karşılaştırıp OLUMSUZ verdiktleri `FeedingWindowReadiness` olarak yayıyor;
 * bu listener onu öğün satırına damgalıyor, MealBoard rozeti oradan besleniyor.
 *
 * Damga YALNIZ henüz beslenmemiş öğünlere basılır: `fed`/`skipped`/`missed`/
 * `cancelled` bir öğün için "öğün öncesi oksijen düşük" rozeti geçmişi yeniden
 * yazmak olurdu. Aynı sebeple `evaluatedAt` gerilemez — 15 dk'lık tick sırasız
 * teslim edilebildiğinden eski bir verdikt yeni bir verdiktin üstünü örtemez
 * (newest-wins, tenant-localization projeksiyonuyla aynı disiplin).
 *
 * `feeding_meals` PER-TENANT tablodur, bu yüzden yazım `runInTenantTransaction`
 * içinde koşar (search_path pinlenir + doğrulanır) — NATS handler'ının HTTP
 * bağlamı yoktur.
 *
 * @module FeedingProtocol/Listeners
 */
import { isValidUUID, runInTenantTransaction } from '@aquaculture/backend-common/database';
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import type { BaseEvent, FeedingWindowReadinessEvent } from '@platform/event-contracts';
import { DataSource } from 'typeorm';

import type { MealReadiness } from '../entities/feeding-meal.entity';

@Injectable()
export class FeedingWindowReadinessListener implements IEventHandler<BaseEvent>, OnModuleInit {
  private readonly logger = new Logger(FeedingWindowReadinessListener.name);

  constructor(
    private readonly dataSource: DataSource,
    @Optional()
    @Inject('EVENT_BUS')
    private readonly eventBus?: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.eventBus) {
      this.logger.warn(
        'EVENT_BUS not available — feeding-window readiness projection subscription skipped.',
      );
      return;
    }
    await this.eventBus.subscribeWildcard('FeedingWindowReadiness', this);
    this.logger.log(
      'Subscribed to FeedingWindowReadiness for meal readiness badges (cross-tenant wildcard)',
    );
  }

  getEventType(): string {
    return 'FeedingWindowReadiness';
  }

  async handle(event: BaseEvent): Promise<void> {
    if (!event.tenantId || !isValidUUID(event.tenantId)) {
      this.logger.error(
        'FeedingWindowReadiness has missing/invalid tenantId — skipping to prevent ' +
          'cross-tenant read-model corruption.',
      );
      return;
    }

    const verdict = event as FeedingWindowReadinessEvent;
    if (!isValidUUID(verdict.mealId)) {
      this.logger.error('FeedingWindowReadiness carries a non-UUID mealId — skipping.');
      return;
    }

    const readiness: MealReadiness = {
      status: verdict.status,
      minDissolvedOxygen: verdict.minDissolvedOxygen,
      observedDissolvedOxygen: verdict.observedDissolvedOxygen,
      observedAt: verdict.observedAt,
      lowOxygenReductionPercent: verdict.lowOxygenReductionPercent,
      evaluatedAt: event.timestamp,
    };

    await runInTenantTransaction(this.dataSource, 'farm', event.tenantId, async (queryRunner) => {
      await queryRunner.query(
        `UPDATE "feeding_meals"
              SET "readiness" = $1::jsonb,
                  "updatedAt" = now()
            WHERE "id" = $2
              AND "tenantId" = $3
              AND "status" IN ('scheduled', 'partially_fed')
              AND (
                    "readiness" IS NULL
                 OR ("readiness"->>'evaluatedAt') < $4
                  )`,
        [JSON.stringify(readiness), verdict.mealId, event.tenantId, readiness.evaluatedAt],
      );
    });
  }
}
