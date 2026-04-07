import { Module, DynamicModule, Type } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { OutboxEntityBase } from './outbox-entity.base';
import { OutboxPublisher } from './outbox-publisher.service';
import { OutboxWorkerService } from './outbox-worker.service';
import { OutboxMetricsService } from './outbox-metrics.service';
import { OUTBOX_ENTITY_CLASS } from './constants';

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
  ): DynamicModule {
    return {
      module: OutboxModule,
      imports: [
        TypeOrmModule.forFeature([entityClass]),
        ScheduleModule.forRoot(),
      ],
      providers: [
        {
          provide: OUTBOX_ENTITY_CLASS,
          useValue: entityClass,
        },
        OutboxMetricsService,
        OutboxPublisher,
        OutboxWorkerService,
      ],
      exports: [OutboxPublisher, OutboxMetricsService],
    };
  }
}
