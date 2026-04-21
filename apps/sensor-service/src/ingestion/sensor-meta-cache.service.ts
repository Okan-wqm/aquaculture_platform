import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { SensorDataChannel } from '../database/entities/sensor-data-channel.entity';
import { Sensor } from '../database/entities/sensor.entity';

/**
 * In-process sensor + channel metadata cache shared by every Faz 3
 * NATS-driven flow (NatsIngestionConsumer enrichment, lifecycle-event
 * invalidation handler, future cache-miss responder for the Rust
 * sidecar).
 *
 * WHY this is a separate service:
 *   The cache used to live inside NatsIngestionConsumerService as
 *   private Map fields. That coupled "cache-the-data-on-read" to
 *   "consume-the-event-and-write-to-DB" — extracting now means a
 *   single Map per process AND a single owner of the invalidation
 *   contract. Multiple subscribers (the consumer that enriches; the
 *   lifecycle-event handler that invalidates; the future
 *   sensor.lookup.by-topic responder) all share the same TTL +
 *   tenant-scoped key shape without having to reinvent it.
 *
 * Cache key shape:
 *   - Sensor entries: keyed by `sensorId` UUID (UUID is globally
 *     unique; tenantId is carried inside the value so callers can
 *     re-check the SEC-M01 tenant binding without a separate lookup).
 *   - Channel entries: keyed by `sensorId` UUID; the value is the
 *     full per-sensor channel array. Single-shot fetch keeps the
 *     consumer fast (one DB hit per sensor instead of one per
 *     channel) and matches the existing
 *     DataIngestionService.getChannelsCached pattern.
 *
 * TTL:
 *   60 seconds. Lifecycle-event invalidation (the new handler in
 *   sensor-cache-invalidation.handler.ts) eagerly drops entries on
 *   SensorConfigurationUpdated / SensorSuspended / SensorReactivated
 *   so the 60s TTL is the upper bound on staleness when no
 *   invalidation event arrived (e.g. raw SQL UPDATE outside the
 *   service path, or NATS broker hiccup).
 */
@Injectable()
export class SensorMetaCacheService {
  private readonly logger = new Logger(SensorMetaCacheService.name);

  static readonly TTL_MS = 60_000;

  /** Sensor metadata cache: sensorId -> { sensor, expiresAt }. */
  private readonly sensorCache = new Map<
    string,
    { sensor: Sensor; expiresAt: number }
  >();

  /** Channel metadata cache: sensorId -> { channels[], expiresAt }. */
  private readonly channelCache = new Map<
    string,
    { channels: SensorDataChannel[]; expiresAt: number }
  >();

  constructor(
    @InjectRepository(Sensor)
    private readonly sensorRepository: Repository<Sensor>,
    @InjectRepository(SensorDataChannel)
    private readonly channelRepository: Repository<SensorDataChannel>,
  ) {}

  /**
   * Look up a sensor by id. Returns the cached value when fresh, else
   * loads from the repository and caches.
   *
   * Returns `null` for sensors that do not exist; callers MUST handle
   * the null case (the typical handling is to drop the in-flight
   * event to avoid poisoning the JetStream consumer).
   */
  async getSensor(sensorId: string): Promise<Sensor | null> {
    const cached = this.sensorCache.get(sensorId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.sensor;
    }
    const sensor = await this.sensorRepository.findOne({
      where: { id: sensorId },
    });
    if (!sensor) {
      return null;
    }
    this.sensorCache.set(sensorId, {
      sensor,
      expiresAt: Date.now() + SensorMetaCacheService.TTL_MS,
    });
    return sensor;
  }

  /**
   * Look up the enabled channels for a sensor. Returns an empty array
   * when no channels exist (NOT cached; the next call retries the DB
   * since "zero channels" is usually a misconfiguration the operator
   * is fixing in real time).
   */
  async getChannels(sensorId: string): Promise<SensorDataChannel[]> {
    const cached = this.channelCache.get(sensorId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.channels;
    }
    const channels = await this.channelRepository.find({
      where: { sensorId, isEnabled: true },
    });
    if (channels.length > 0) {
      this.channelCache.set(sensorId, {
        channels,
        expiresAt: Date.now() + SensorMetaCacheService.TTL_MS,
      });
    }
    return channels;
  }

  /**
   * Drop a single sensor's cached entry — called by the lifecycle-
   * event invalidation handler on SensorConfigurationUpdated,
   * SensorSuspended, SensorReactivated. Idempotent — calling on an
   * absent entry is a no-op.
   *
   * Invalidates BOTH the sensor entry AND the per-sensor channel
   * entry: a configuration change that flips a channel's `isEnabled`
   * bit must invalidate the channel cache too, else the consumer's
   * channel-key dispatch keeps the stale set.
   */
  invalidateSensor(sensorId: string): void {
    const sHit = this.sensorCache.delete(sensorId);
    const cHit = this.channelCache.delete(sensorId);
    if (sHit || cHit) {
      this.logger.debug(
        `Invalidated cache for sensor ${sensorId} (sensor=${sHit}, channels=${cHit})`,
      );
    }
  }

  /**
   * Drop every entry whose value's `tenantId` matches. Used by the
   * lifecycle-event handler on tenant-scoped events (e.g. tenant
   * suspension) — and reserved for future GDPR-delete or schema-
   * migration triggers.
   */
  invalidateTenant(tenantId: string): void {
    let dropped = 0;
    for (const [id, entry] of this.sensorCache) {
      if (entry.sensor.tenantId === tenantId) {
        this.sensorCache.delete(id);
        // Channel cache is keyed by sensorId; drop in lockstep.
        this.channelCache.delete(id);
        dropped++;
      }
    }
    if (dropped > 0) {
      this.logger.debug(
        `Invalidated ${dropped} cache entries for tenant ${tenantId}`,
      );
    }
  }

  /**
   * Test-only accessor for the sensor-cache size. Lets unit tests
   * assert cache state after invalidation calls without exposing the
   * internal Map. Marked underscore so a future automated check can
   * detect accidental production calls.
   */
  /* istanbul ignore next */
  _testSize(): { sensors: number; channels: number } {
    return {
      sensors: this.sensorCache.size,
      channels: this.channelCache.size,
    };
  }
}
