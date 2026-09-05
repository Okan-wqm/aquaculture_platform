import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';

import { IEventBus, IEventHandler, HandlerOutcome } from '@platform/event-bus';
import type {
  SensorConfigurationUpdatedEvent,
  SensorReactivatedEvent,
  SensorSuspendedEvent,
} from '@platform/event-contracts';

import { SensorMetaCacheService } from './sensor-meta-cache.service';

type SensorLifecycleEvent =
  | SensorConfigurationUpdatedEvent
  | SensorSuspendedEvent
  | SensorReactivatedEvent;

/**
 * Subscribes to sensor lifecycle events and drops the matching
 * `SensorMetaCacheService` entries so the next ingestion event for
 * that sensor sees fresh DB state instead of waiting up to 60 s for
 * the TTL to expire.
 *
 * WHY this handler exists separately from `NatsIngestionConsumerService`:
 *   "Cache content for read efficiency" and "drop cache content on
 *   write" are distinct architectural concerns. Lumping both into one
 *   handler couples subscription topology (one handler subscribes to
 *   N topics, each a different event shape) with hot-path data flow.
 *   Splitting keeps each handler responsible for ONE event family and
 *   keeps the unit-test harness for each path independent.
 *
 * Event family invalidations:
 *   - `SensorConfigurationUpdated` — channels may have changed
 *     (channel added/removed/renamed; flag flipped). Drop the per-
 *     sensor cache so the next ingestion re-fetches both Sensor and
 *     SensorDataChannel rows.
 *   - `SensorSuspended` — sensor is no longer active; drop so any
 *     in-flight metric event for it does NOT find the (still-cached)
 *     active sensor row and silently persist a metric for a suspended
 *     sensor.
 *   - `SensorReactivated` — drop so the next read repopulates from
 *     the now-active row (the cached value, if any, was the suspended
 *     state).
 *
 * WHY no SensorRegistered handler:
 *   A newly-registered sensor cannot be in cache yet. The first
 *   ingestion event for it triggers a cache miss, which fetches from
 *   the DB and caches. The handler is a no-op for SensorRegistered.
 *
 * WHY this is `Optional`-injected with `EVENT_BUS`:
 *   Unit tests of unrelated modules (no NATS) can build the
 *   IngestionModule without an EventBus. Same posture as the existing
 *   `NatsIngestionConsumerService`.
 */
@Injectable()
export class SensorCacheInvalidationHandler
  implements OnModuleInit, OnModuleDestroy, IEventHandler<SensorLifecycleEvent>
{
  private readonly logger = new Logger(SensorCacheInvalidationHandler.name);

  /**
   * Subjects subscribed at boot. Tenant wildcard captures every
   * tenant; the eventType discriminator is the third segment per
   * `nats-event-bus.ts:310-312` deriveSubject.
   */
  private static readonly SUBJECTS = [
    'events.*.SensorConfigurationUpdated',
    'events.*.SensorSuspended',
    'events.*.SensorReactivated',
  ] as const;

  /** Counter rolled up every minute for ops observability. */
  private invalidationCount = 0;
  private statsTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly metaCache: SensorMetaCacheService,
    @Optional()
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus | null,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.eventBus) {
      this.logger.warn('EVENT_BUS not provided; SensorCacheInvalidationHandler will not subscribe');
      return;
    }
    for (const subject of SensorCacheInvalidationHandler.SUBJECTS) {
      // subscribeTo is per-subject (the trio of lifecycle events
      // above); a single getEventType() return cannot cover all three,
      // so we do explicit per-subject subscriptions below.
      await this.eventBus.subscribeTo<SensorLifecycleEvent>(subject, this);
    }
    this.logger.log(
      `Subscribed to ${SensorCacheInvalidationHandler.SUBJECTS.length} sensor-lifecycle subjects (cache invalidation)`,
    );
    this.statsTimer = setInterval(() => {
      if (this.invalidationCount > 0) {
        this.logger.log(
          `SensorCacheInvalidation stats — invalidations=${this.invalidationCount} in last 60s`,
        );
      }
      this.invalidationCount = 0;
    }, 60_000);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    if (!this.eventBus) return;
    for (const subject of SensorCacheInvalidationHandler.SUBJECTS) {
      try {
        await this.eventBus.unsubscribeFrom(subject);
      } catch (e) {
        this.logger.warn(
          `unsubscribeFrom("${subject}") failed at shutdown: ${(e as Error).message}`,
        );
      }
    }
  }

  /**
   * Returned by `IEventHandler.getEventType` so the platform's
   * registry can introspect a "what does this handler observe" string.
   * The handler subscribes to MULTIPLE subjects in `onModuleInit`, so
   * this string is informational only — the actual subject list is
   * the static `SUBJECTS` array above.
   */
  getEventType(): string {
    return 'events.*.Sensor{Configuration,Suspended,Reactivated}';
  }

  /**
   * Hot path. Every lifecycle event drops exactly the sensor's cache
   * entry (sensor + per-sensor channels). Dropping on a
   * not-yet-cached sensor is a no-op (the underlying Map.delete
   * returns false; the metaCache logger only emits on actual hits).
   *
   * Failure semantics: throwing aborts JetStream ack, causing
   * redelivery. Cache invalidation is idempotent so redelivery is
   * harmless; we still catch + log unexpected exceptions to keep the
   * subscription alive.
   */
  async handle(event: SensorLifecycleEvent): Promise<HandlerOutcome> {
    try {
      this.metaCache.invalidateSensor(event.sensorId);
      this.invalidationCount++;
      this.logger.debug(`Invalidated cache for sensor ${event.sensorId} on ${event.eventType}`);
    } catch (e) {
      // Invalidation is idempotent and the cache self-heals on TTL; log and
      // acknowledge rather than redeliver a lifecycle event.
      this.logger.error(
        `Cache invalidation failed for sensor ${event.sensorId}: ${(e as Error).message}`,
      );
    }
    return Promise.resolve(HandlerOutcome.ack());
  }
}
