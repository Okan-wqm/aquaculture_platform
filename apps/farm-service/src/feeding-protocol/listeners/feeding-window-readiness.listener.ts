import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import { validateSensorEvent } from '@platform/event-contracts';
import type { BaseEvent, FeedingWindowReadinessEvent } from '@platform/event-contracts';
import { DataSource } from 'typeorm';

import type { MealReadinessV1 } from '../entities/feeding-meal.entity';

@Injectable()
export class FeedingWindowReadinessListener implements IEventHandler<BaseEvent>, OnModuleInit {
  constructor(
    private readonly dataSource: DataSource,
    @Inject('EVENT_BUS') private readonly eventBus: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.eventBus.subscribeWildcard('FeedingWindowReadiness', this);
  }

  getEventType(): string {
    return 'FeedingWindowReadiness';
  }

  async handle(baseEvent: BaseEvent): Promise<void> {
    const validation = validateSensorEvent('FeedingWindowReadiness', baseEvent);
    if (!validation.valid) {
      throw new Error(`Malformed FeedingWindowReadiness v1 envelope: ${validation.errors}`);
    }
    const event = baseEvent as FeedingWindowReadinessEvent;

    const rows = event.verdicts.map((verdict) => {
      const readiness: MealReadinessV1 = {
        schemaVersion: 'feeding-meal-readiness/v1',
        sourceWindowEventId: event.sourceWindowEventId,
        status: verdict.status,
        minDissolvedOxygen: verdict.minDissolvedOxygen,
        observedDissolvedOxygen: verdict.observedDissolvedOxygen,
        observedAt: verdict.observedAt,
        lowOxygenReductionPercent: verdict.lowOxygenReductionPercent,
        evaluatedAt: event.evaluatedAt,
      };
      return { mealId: verdict.mealId, readiness };
    });
    if (rows.length === 0) return;

    await runInTenantTransaction(this.dataSource, 'farm', event.tenantId, async (queryRunner) => {
      await queryRunner.query(
        `WITH incoming AS (
             SELECT x."mealId"::uuid AS meal_id, x.readiness
               FROM jsonb_to_recordset($1::jsonb)
                    AS x("mealId" text, readiness jsonb)
           )
           UPDATE "feeding_meals" meal
              SET "readiness" = incoming.readiness,
                  "updatedAt" = now()
             FROM incoming
            WHERE meal.id = incoming.meal_id
              AND meal."tenantId" = $2::uuid
              AND meal.status IN ('scheduled', 'partially_fed')
              AND (
                meal."readiness" IS NULL
                OR meal."readiness"->>'evaluatedAt' < incoming.readiness->>'evaluatedAt'
              )`,
        [JSON.stringify(rows), event.tenantId],
      );
    });
  }
}
