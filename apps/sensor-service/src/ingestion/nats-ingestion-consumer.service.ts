import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  IEventBus,
  IEventHandler,
} from '@platform/event-bus';
import {
  createBaseEvent,
  type SensorMetricIngestedEvent,
  type SensorReadingEvent,
} from '@platform/event-contracts';

import { SensorDataChannel } from '../database/entities/sensor-data-channel.entity';
import { SensorMetricInput } from '../database/entities/sensor-metric.entity';
import { Sensor } from '../database/entities/sensor.entity';

import { BatchProcessorService } from './batch-processor.service';

/**
 * NATS consumer that bridges the Rust ingestion sidecar
 * (`apps/sensor-ingestion`, ADR-025) into the existing NestJS
 * `BatchProcessorService` persistence path AND re-emits the typed
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
 * WHY a 60-second in-process channel cache:
 *   The same cache pattern `DataIngestionService` uses
 *   (`apps/sensor-service/src/ingestion/data-ingestion.service.ts`
 *   `getChannelsCached`). Channels rarely change shape; the cache
 *   collapses one DB hit per metric to one DB hit per sensor per
 *   minute. Sensor-update events invalidate the entry (Faz 3 follow-on).
 *
 * WHY publish typed event AFTER enqueue (not before):
 *   `BatchProcessorService.enqueue` is fire-and-forget into an
 *   in-memory buffer; it returns synchronously without waiting for the
 *   actual DB write. Publishing typed events after the enqueue
 *   guarantees alert-engine receives the event in topology order
 *   (persistence-pending → event-published) which matches the existing
 *   NestJS data-plane semantic.
 */
@Injectable()
export class NatsIngestionConsumerService
  implements
    OnModuleInit,
    OnModuleDestroy,
    IEventHandler<SensorMetricIngestedEvent>
{
  private readonly logger = new Logger(NatsIngestionConsumerService.name);

  /** 60-second per-sensor channel cache. Same TTL as `DataIngestionService`. */
  private readonly channelCache = new Map<
    string,
    { channels: SensorDataChannel[]; expiresAt: number }
  >();
  private static readonly CHANNEL_CACHE_TTL_MS = 60_000;

  /** 60-second per-sensor metadata cache (farmId / pondId / tenantId). */
  private readonly sensorMetaCache = new Map<
    string,
    { sensor: Sensor; expiresAt: number }
  >();
  private static readonly SENSOR_META_TTL_MS = 60_000;

  /**
   * Subject pattern the sidecar publishes on. Mirrors
   * `platform/libs/event-bus/src/nats/nats-event-bus.ts:310-312`
   * `deriveSubject`: `events.{tenantId}.{eventType}` — the wildcard
   * captures every tenant.
   */
  private static readonly SUBJECT_PATTERN = 'events.*.SensorMetricIngested';

  /** Accumulators for bulk-flush observability (logged every minute). */
  private receivedCount = 0;
  private skippedNoSensorCount = 0;
  private skippedNoChannelCount = 0;
  private enqueuedCount = 0;
  private publishedCount = 0;
  private statsTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly batchProcessor: BatchProcessorService,
    private readonly configService: ConfigService,
    @InjectRepository(Sensor)
    private readonly sensorRepository: Repository<Sensor>,
    @InjectRepository(SensorDataChannel)
    private readonly channelRepository: Repository<SensorDataChannel>,
    @Optional()
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus | null,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.eventBus) {
      this.logger.warn(
        'EVENT_BUS not provided; NatsIngestionConsumerService will not subscribe',
      );
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
      this.logger.log(
        `NatsIngestionConsumer stats — received=${this.receivedCount} ` +
          `skippedNoSensor=${this.skippedNoSensorCount} ` +
          `skippedNoChannel=${this.skippedNoChannelCount} ` +
          `enqueued=${this.enqueuedCount} published=${this.publishedCount}`,
      );
      this.receivedCount = 0;
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
        await this.eventBus.unsubscribeFrom(
          NatsIngestionConsumerService.SUBJECT_PATTERN,
        );
      } catch (e) {
        this.logger.warn(
          `unsubscribeFrom failed at shutdown: ${(e as Error).message}`,
        );
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

    // 1. Sensor metadata lookup (cached) — needed for tenantId
    //    cross-check + farmId / pondId enrichment.
    const sensor = await this.getSensorCached(event.sensorId);
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
    const channels = await this.getChannelsCached(event.sensorId);
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
      farmId: sensor.farmId ?? undefined,
      pondId: sensor.pondId ?? undefined,
    };
    this.batchProcessor.enqueue(metric);
    this.enqueuedCount++;

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
    const reading: SensorReadingEvent = {
      ...createBaseEvent('SensorReading', event.tenantId, {
        aggregateId: sensor.id,
        aggregateType: 'Sensor',
      }),
      eventType: 'SensorReading',
      sensorId: sensor.id,
      farmId: sensor.farmId ?? undefined,
      pondId: sensor.pondId ?? undefined,
    };

    const v = event.value;
    switch (channel.channelKey.toLowerCase()) {
      case 'temperature':
      case 'temp':
        reading.readingTemperature = v;
        break;
      case 'ph':
        reading.readingPh = v;
        break;
      case 'do':
      case 'dissolved_oxygen':
      case 'dissolvedoxygen':
        reading.readingDissolvedOxygen = v;
        break;
      case 'salinity':
        reading.readingSalinity = v;
        break;
      case 'ammonia':
        reading.readingAmmonia = v;
        break;
      case 'nitrite':
        reading.readingNitrite = v;
        break;
      case 'nitrate':
        reading.readingNitrate = v;
        break;
      case 'turbidity':
        reading.readingTurbidity = v;
        break;
      case 'water_level':
      case 'waterlevel':
      case 'level':
        reading.readingWaterLevel = v;
        break;
      default:
        // Unknown channelKey: the typed event has no field that fits.
        // Downstream consumers that filter by channel key will skip it;
        // the metric is still in the batch processor (DB-side
        // representation is channel-key-agnostic).
        break;
    }
    return reading;
  }

  // -------------------------------------------------------------------
  // Caches — same shape + TTL as DataIngestionService.getChannelsCached
  // -------------------------------------------------------------------

  private async getSensorCached(sensorId: string): Promise<Sensor | null> {
    const cached = this.sensorMetaCache.get(sensorId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.sensor;
    }
    const sensor = await this.sensorRepository.findOne({
      where: { id: sensorId },
    });
    if (!sensor) {
      return null;
    }
    this.sensorMetaCache.set(sensorId, {
      sensor,
      expiresAt: Date.now() + NatsIngestionConsumerService.SENSOR_META_TTL_MS,
    });
    return sensor;
  }

  private async getChannelsCached(
    sensorId: string,
  ): Promise<SensorDataChannel[]> {
    const cached = this.channelCache.get(sensorId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.channels;
    }
    const channels = await this.channelRepository.find({
      where: { sensorId, isEnabled: true },
    });
    this.channelCache.set(sensorId, {
      channels,
      expiresAt: Date.now() + NatsIngestionConsumerService.CHANNEL_CACHE_TTL_MS,
    });
    return channels;
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
