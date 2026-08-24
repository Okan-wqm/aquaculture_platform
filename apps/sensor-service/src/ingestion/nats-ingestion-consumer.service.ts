import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { IEventBus, IEventHandler } from '@platform/event-bus';
import {
  createBaseEvent,
  deriveEventId,
  parameterForChannelKey,
  readingFieldForParameter,
  type SensorMetricIngestedEvent,
  type SensorReadingEvent,
  validateSensorEvent,
} from '@platform/event-contracts';

import { SensorDataChannel } from '../database/entities/sensor-data-channel.entity';
import { SensorMetricInput } from '../database/entities/sensor-metric.entity';
import { Sensor } from '../database/entities/sensor.entity';
import { TagValueFanoutService } from '../scada-runtime/services/tag-value-fanout.service';

import { SensorMetricWriterService } from './sensor-metric-writer.service';
import { SensorMetaCacheService } from './sensor-meta-cache.service';

/**
 * NATS consumer that bridges the Rust ingestion sidecar
 * (`apps/sensor-ingestion`, ADR-025) into the existing NestJS
 * `SensorMetricWriterService` persistence path AND re-emits the typed
 * `SensorReadingEvent` for downstream consumers.
 *
 * WHY this service exists (ADR-022 control / data plane separation):
 *   The Rust sidecar publishes `SensorMetricIngested` — a raw per-channel
 *   tuple it can honestly produce without a sensor-meta cache. Downstream
 *   consumers (alert-engine, AI service, audit) still expect the typed
 *   `SensorReading` event with `readingTemperature` / `readingPh` /
 *   etc. flat fields. This service is the ONE place where raw → typed
 *   mapping happens — it owns the cache lookup, calls the existing
 *   batch persistence path, then publishes the typed event.
 *
 *   Architectural payoff: the sidecar stays minimal and the existing
 *   downstream contract (alert rules, AI prompts, audit log shape) is
 *   preserved byte-for-byte.
 *
 * WHY delegated to SensorMetaCacheService:
 *   The cache used to live as private Maps inside this service. Faz 3
 *   follow-on extracted it into [`SensorMetaCacheService`] so the
 *   lifecycle-event handler ([`SensorCacheInvalidationHandler`]) can
 *   share the same cache instance and eagerly drop entries on
 *   SensorConfigurationUpdated / SensorSuspended / SensorReactivated.
 *   The 60-second TTL is now the upper bound on staleness when no
 *   invalidation event arrived (e.g. raw SQL UPDATE).
 *
 * WHY publish typed event AFTER enqueue (not before):
 *   `SensorMetricWriterService.enqueue` is fire-and-forget into an
 *   in-memory buffer; it returns synchronously without waiting for the
 *   actual DB write. Publishing typed events after the enqueue
 *   guarantees alert-engine receives the event in topology order
 *   (persistence-pending → event-published) which matches the existing
 *   NestJS data-plane semantic.
 */
@Injectable()
export class NatsIngestionConsumerService
  implements OnModuleInit, OnModuleDestroy, IEventHandler<SensorMetricIngestedEvent>
{
  private readonly logger = new Logger(NatsIngestionConsumerService.name);

  /**
   * Subject pattern the sidecar publishes on. Mirrors
   * `platform/libs/event-bus/src/nats/nats-event-bus.ts:310-312`
   * `deriveSubject`: `events.{tenantId}.{eventType}` — the wildcard
   * captures every tenant.
   */
  private static readonly SUBJECT_PATTERN = 'events.*.SensorMetricIngested';

  /** Accumulators for bulk-flush observability (logged every minute). */
  private receivedCount = 0;
  /** Schema validation failures — dropped before enrichment. */
  private rejectedSchemaCount = 0;
  private skippedNoSensorCount = 0;
  private skippedNoChannelCount = 0;
  private enqueuedCount = 0;
  private publishedCount = 0;
  private statsTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly metricWriter: SensorMetricWriterService,
    private readonly configService: ConfigService,
    private readonly metaCache: SensorMetaCacheService,
    @Optional()
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus | null,
    // Live-data producer (SENSOR-HIGH-046): fans each ingested metric out to
    // subscribed /scada operator sockets via the registry's sensor→fqn
    // linkage. Optional so ingestion keeps working if the SCADA runtime is
    // not mounted (e.g. isolated integration tests).
    @Optional()
    @Inject(TagValueFanoutService)
    private readonly tagFanout: TagValueFanoutService | null,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.eventBus) {
      this.logger.warn('EVENT_BUS not provided; NatsIngestionConsumerService will not subscribe');
      return;
    }

    // The subscribeTo path uses the literal subject; subscribe at
    // boot so the consumer is live before the sidecar starts emitting.
    // Errors here MUST surface — a silent subscribe failure would let
    // the sidecar's events fall on the floor.
    await this.eventBus.subscribeTo<SensorMetricIngestedEvent>(
      NatsIngestionConsumerService.SUBJECT_PATTERN,
      this,
    );
    this.logger.log(
      `Subscribed to ${NatsIngestionConsumerService.SUBJECT_PATTERN} (Rust sidecar bridge)`,
    );

    // One-minute stats roll-up so an operator can correlate sidecar
    // throughput against the consumer's enqueue + publish rate without
    // sampling tracing spans.
    this.statsTimer = setInterval(() => {
      const fanout = this.tagFanout?.drainStats() ?? { pushed: 0, unmapped: 0 };
      this.logger.log(
        `NatsIngestionConsumer stats — received=${this.receivedCount} ` +
          `rejectedSchema=${this.rejectedSchemaCount} ` +
          `skippedNoSensor=${this.skippedNoSensorCount} ` +
          `skippedNoChannel=${this.skippedNoChannelCount} ` +
          `enqueued=${this.enqueuedCount} published=${this.publishedCount} ` +
          `scadaPushed=${fanout.pushed} scadaUnmapped=${fanout.unmapped}`,
      );
      this.receivedCount = 0;
      this.rejectedSchemaCount = 0;
      this.skippedNoSensorCount = 0;
      this.skippedNoChannelCount = 0;
      this.enqueuedCount = 0;
      this.publishedCount = 0;
    }, 60_000);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    if (this.eventBus) {
      try {
        await this.eventBus.unsubscribeFrom(NatsIngestionConsumerService.SUBJECT_PATTERN);
      } catch (e) {
        this.logger.warn(`unsubscribeFrom failed at shutdown: ${(e as Error).message}`);
      }
    }
  }

  /**
   * `IEventHandler.getEventType` — used by the platform event-bus
   * registry to wire this handler back to the SUBJECT_PATTERN it
   * subscribed under.
   */
  getEventType(): string {
    return NatsIngestionConsumerService.SUBJECT_PATTERN;
  }

  /**
   * `IEventHandler.handle` — hot path. Called once per
   * `SensorMetricIngested` event the sidecar publishes.
   *
   * Failure semantics: a thrown exception aborts JetStream ack and
   * the event redelivers. We catch + log + swallow most enrichment
   * failures because re-delivery on enrichment failure causes a
   * poison-pill loop (the sensor missing from DB now will still be
   * missing on retry). The few cases that DO throw are transient
   * (DB unavailable) — the platform's redelivery is the right answer
   * there.
   */
  async handle(event: SensorMetricIngestedEvent): Promise<void> {
    this.receivedCount++;

    // 0. JSON Schema validation — defence-in-depth at the trust
    //    boundary. The Rust producer's `serde(deny_unknown_fields)`
    //    rejects shape drift on the publish side; this validator
    //    rejects anything that arrives malformed (extra field, wrong
    //    discriminator, range violation on qualityCode/producerTs).
    //    Drops here NEVER throw — we want JetStream to ack-and-discard
    //    a poison payload, not redeliver it forever.
    const schemaResult = validateSensorEvent('SensorMetricIngested', event);
    if (!schemaResult.valid) {
      this.rejectedSchemaCount++;
      this.logger.warn(
        `SensorMetricIngested rejected by schema validator (eventId=${
          (event as { eventId?: unknown }).eventId ?? 'unknown'
        }): ${schemaResult.errors}`,
      );
      return;
    }

    // 1. Sensor metadata lookup (cached) — needed for tenantId
    //    cross-check + farmId / pondId enrichment.
    const sensor = await this.metaCache.getSensor(event.sensorId);
    if (!sensor) {
      this.skippedNoSensorCount++;
      this.logger.debug(
        `SensorMetricIngested for unknown sensorId=${event.sensorId} (tenant=${event.tenantId}); dropping`,
      );
      return;
    }

    // 2. ADR-025 § Threat 2 sanity: the sidecar already enforces
    //    topic↔payload tenant binding. Re-checking here as defence in
    //    depth — if a bug or a future relaxation lets a mismatched
    //    event through, this drop keeps the persistence path honest.
    if (sensor.tenantId !== event.tenantId) {
      this.logger.warn(
        `Tenant mismatch on SensorMetricIngested: event.tenantId=${event.tenantId} sensor.tenantId=${sensor.tenantId}; dropping`,
      );
      return;
    }

    // 3. Channel lookup (cached). The sidecar identifies the channel
    //    by uuid; we resolve to the channel definition for channelKey
    //    + dataType.
    const channels = await this.metaCache.getChannels(event.sensorId);
    const channel = channels.find((c) => c.id === event.channelId);
    if (!channel) {
      this.skippedNoChannelCount++;
      this.logger.debug(
        `SensorMetricIngested for unknown channelId=${event.channelId} on sensor=${event.sensorId}; dropping`,
      );
      return;
    }

    // 4. Build the SensorMetricInput and hand to the existing
    //    BatchProcessor. The batch processor flushes on time (500ms)
    //    or size (500 rows), preserving the platform invariant 4.
    //
    // WHY prefer event-side farmId / pondId over sensor.farmId /
    //    sensor.pondId:
    //    The Rust sidecar's drain (Faz 3 follow-on) populates
    //    `event.farmId` / `event.pondId` from its warm `TopicCache`
    //    at the moment the event was minted. That value is the SoT
    //    when the cache was warm at publish time — preferring it
    //    saves the per-event DB roundtrip on the warm-cache happy
    //    path AND keeps the consumer aligned with what every other
    //    downstream subscriber sees on the wire.
    //
    //    Fallback chain: `event.* ?? sensor.* ?? undefined`. The
    //    `sensor.*` step is defence-in-depth — covers the cache-miss
    //    path (sidecar's cache was cold; it left the field absent on
    //    the wire) AND the staleness inversion (sidecar's cache is
    //    stale relative to the consumer's). The `?? undefined`
    //    terminator preserves the SensorMetricInput contract which
    //    forbids `null` for these optional FK columns.
    const metric: SensorMetricInput = {
      time: new Date(event.producerTs),
      sensorId: event.sensorId,
      channelId: event.channelId,
      tenantId: event.tenantId,
      rawValue: event.rawValue,
      value: event.value,
      qualityCode: event.qualityCode,
      sourceProtocol: 'rust-sidecar',
      sourceTimestamp: new Date(event.producerTs),
      farmId: event.farmId ?? sensor.farmId ?? undefined,
      pondId: event.pondId ?? sensor.pondId ?? undefined,
    };
    // 4. Hand to the single writer and AWAIT the durable outcome: the writer
    //    settles this promise only after the row's tenant batch COMMITTED
    //    (ack-after-commit, SENSOR-CRITICAL-087), so the event-bus ACK fires
    //    strictly after persistence and a DB failure propagates into a NAK
    //    for redelivery instead of an acked loss.
    await this.metricWriter.enqueue(metric);
    this.enqueuedCount++;

    // 4b. Live fan-out to subscribed /scada operator sockets. Best-effort by
    //     contract — fanoutMetric never throws (a fan-out failure must not
    //     poison the ingestion path into JetStream redelivery).
    if (this.tagFanout) {
      await this.tagFanout.fanoutMetric({
        tenantId: event.tenantId,
        sensorId: event.sensorId,
        channelId: event.channelId,
        value: event.value,
        timestampMs: event.producerTs,
        qualityCode: event.qualityCode,
      });
    }

    // 5. Re-emit the typed SensorReadingEvent for downstream consumers
    //    (alert-engine, AI service, audit). channelKey selects the
    //    typed field name; if the channelKey is unrecognised we still
    //    publish the event with the value attached to the closest
    //    field — the alert-engine has its own untyped eval path.
    if (this.eventBus) {
      try {
        const typed = this.buildTypedReadingEvent(event, sensor, channel);
        await this.eventBus.publish<SensorReadingEvent>(typed);
        this.publishedCount++;
      } catch (e) {
        this.logger.warn(
          `Failed to publish typed SensorReadingEvent (sensor=${event.sensorId}): ${(e as Error).message}`,
        );
      }
    }
  }

  /**
   * Map a raw `SensorMetricIngested` event + sensor metadata + channel
   * definition into the typed `SensorReadingEvent` that downstream
   * consumers expect.
   *
   * The `channelKey` → `readingXxx` mapping uses the same keys the
   * existing NestJS path uses — see
   * `apps/sensor-service/src/ingestion/data-ingestion.service.ts`
   * for the legacy origin of the convention.
   */
  private buildTypedReadingEvent(
    event: SensorMetricIngestedEvent,
    sensor: Sensor,
    channel: SensorDataChannel,
  ): SensorReadingEvent {
    // Same fallback chain as the SensorMetricInput build above:
    //   event.* (sidecar cache-warm SoT)  →  sensor.* (consumer-side
    //   cache fallback / cold-path)  →  undefined.
    // Architectural-tier-1 reasoning: with both sides present the
    // most-specific value (event-side, minted at sidecar publish
    // time) wins; with only the consumer side present the consumer's
    // own cache covers the cold path. There is no shape in which the
    // typed event can leak a wrong farm — every transition is a
    // strictly more-stale value falling back to a strictly less-
    // stale one (or to `undefined`).
    const reading: SensorReadingEvent = {
      ...createBaseEvent('SensorReading', event.tenantId, {
        aggregateId: sensor.id,
        aggregateType: 'Sensor',
        // Task 1.4: the child event's identity is a pure function of the
        // SOURCE event + channel — a redelivered source re-emits the SAME
        // child id, so JetStream dedup (Nats-Msg-Id = eventId) and
        // downstream uniqueness keys collapse the duplicate instead of
        // double-firing alerts.
        eventId: deriveEventId(`${event.eventId}\u0000${event.channelId}`),
      }),
      eventType: 'SensorReading',
      sensorId: sensor.id,
      farmId: event.farmId ?? sensor.farmId ?? undefined,
      pondId: event.pondId ?? sensor.pondId ?? undefined,
    };

    // SENSOR-MEDIUM-066/068: channelKey → parameter → flat field via the single
    // event-contract SSoT (was a hand-maintained switch). An out-of-vocabulary
    // channelKey (flow_rate, orp, co2, …) resolves to undefined — the typed event
    // has no field that fits; the metric is still in the batch processor, so no
    // data is lost DB-side.
    const parameter = parameterForChannelKey(channel.channelKey);
    if (parameter !== undefined) {
      reading[readingFieldForParameter(parameter)] = event.value;
    }
    return reading;
  }

  /**
   * Test-only access to the typed-event mapper so unit tests can
   * exercise the channel-key dispatch table without spinning up the
   * EventBus / DB.
   *
   * Marked with a leading underscore + comment so a future static
   * analyser flagging "test surface in production code" can pick it up
   * and we can move it to a dedicated mapper module if it grows.
   */
  _testBuildTypedReadingEvent(
    event: SensorMetricIngestedEvent,
    sensor: Sensor,
    channel: SensorDataChannel,
  ): SensorReadingEvent {
    return this.buildTypedReadingEvent(event, sensor, channel);
  }
}
