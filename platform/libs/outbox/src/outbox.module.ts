import { Module, DynamicModule, Type } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { OUTBOX_ENTITY_CLASS, OUTBOX_OPTIONS } from './constants';
import { OutboxEntityBase } from './outbox-entity.base';
import { OutboxMetricsService } from './outbox-metrics.service';
import { OutboxNotifyListener } from './outbox-notify-listener.service';
import { OutboxPublisher } from './outbox-publisher.service';
import type { OutboxFeatureOptions } from './outbox-routing';
import { OutboxWorkerService } from './outbox-worker.service';

/**
 * OutboxModule
 *
 * Registers the transactional outbox infrastructure for a single
 * concrete entity. Each consuming service calls `forFeature(EntityClass)`
 * with its own `@Entity('<service>_outbox')` subclass of `OutboxEntityBase`.
 *
 * Usage:
 * ```ts
 * @Module({
 *   imports: [
 *     OutboxModule.forFeature(FarmOutbox),
 *   ],
 *   exports: [OutboxPublisher],
 * })
 * export class FarmOutboxModule {}
 * ```
 *
 * Requires the consuming service to have already registered an `EVENT_BUS`
 * provider via `EventBusModule.forRoot(...)` — the worker injects it.
 *
 * The `OutboxMetricsService` is registered alongside and exports Prometheus
 * gauges/counters/histograms into the default prom-client registry, so the
 * consumer's existing `/metrics` HTTP endpoint (if any) picks them up
 * automatically without additional wiring.
 *
 * @see Phase 2 + Phase E of farm domain real-time visibility plan.
 */
@Module({})
export class OutboxModule {
  static forFeature<T extends OutboxEntityBase>(
    entityClass: Type<T>,
    options: OutboxFeatureOptions = {},
  ): DynamicModule {
    const normalizedOptions: Required<OutboxFeatureOptions> = {
      allowSystemRouting: options.allowSystemRouting === true,
      allowSecurityRecovery: options.allowSecurityRecovery === true,
    };

    return {
      module: OutboxModule,
      imports: [TypeOrmModule.forFeature([entityClass]), ScheduleModule.forRoot()],
      providers: [
        {
          provide: OUTBOX_ENTITY_CLASS,
          useValue: entityClass,
        },
        {
          provide: OUTBOX_OPTIONS,
          useValue: normalizedOptions,
        },
        OutboxMetricsService,
        OutboxPublisher,
        OutboxWorkerService,
        // P-C1: Long-lived pg.Client LISTEN session that wakes the
        // worker immediately on every new outbox row. Drops median
        // publish latency from ~500ms (cron cadence) to ~5ms. The
        // worker's cron safety net runs in parallel at a slower
        // cadence so no event is lost if the listener session drops.
        OutboxNotifyListener,
      ],
      exports: [OutboxPublisher, OutboxMetricsService],
    };
  }
}
