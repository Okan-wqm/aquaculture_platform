/**
 * Sensor Ingestion Service
 * Handles high-throughput sensor data ingestion
 * Optimized for TimescaleDB and 10K+ readings per second
 *
 * SOLID Principles Applied:
 * - SRP: Ingestion only, calibration delegated to CalibrationService
 * - OCP: Uses ReadingMapperRegistry for extensible sensor type mapping
 * - DIP: Depends on interfaces (ICalibrationService, IEventPublisher)
 *
 * Security:
 * - Input validation with sanitizers
 * - UUID format validation
 *
 * Resilience:
 * - Retry logic for transient failures
 * - Circuit breaker for failing dependencies
 * - Proper error types for client handling
 */

import { encodeSensorReadingId } from '@aquaculture/backend-common/sensor';
import { Injectable, Logger, Optional, BadRequestException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import {
  createBaseEvent,
  parameterForChannelKey,
  readingFieldForParameter,
  SENSOR_READING_PARAMETERS,
  type SensorReadingEvent,
  type SensorReadingField,
  type SensorReadingParameter,
  type ParentReadingRoutedEvent,
} from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { Repository, DataSource, In } from 'typeorm';

import {
  DiscoverySource,
  SensorDataChannel,
} from '../../database/entities/sensor-data-channel.entity';
import { QualityCodes, type SensorMetricInput } from '../../database/entities/sensor-metric.entity';
import { SensorReading, SensorReadings } from '../../database/entities/sensor-reading.entity';
import { Sensor, SensorRole, SensorType } from '../../database/entities/sensor.entity';
import { SensorMetricWriterService } from '../../ingestion/sensor-metric-writer.service';
import { CalibrationService } from './calibration.service';
import { DataQualityService } from './data-quality.service';
import { ReadingMapperRegistry } from './reading-mapper.service';
import { validateSensorId, validateTenantId, validateDataPath, MAX_DATA_PATH_DEPTH } from '../validation/input-sanitizer';
import { withRetry, RetryableErrors, CircuitBreaker } from '../utils/retry.util';

/**
 * Ingest reading data input
 */
export interface IngestReadingData {
  sensorId: string;
  tenantId: string;
  readings: SensorReadings;
  pondId?: string;
  farmId?: string;
  timestamp?: Date;
  source?: string;
}

/**
 * Ingest result with success/failure info
 */
export interface IngestResult {
  success: boolean;
  reading?: SensorReading;
  error?: string;
  errorCode?: 'VALIDATION_ERROR' | 'SENSOR_NOT_FOUND' | 'DATABASE_ERROR' | 'EVENT_ERROR';
}

/**
 * Parent routing result
 */
export interface ParentRoutingResult {
  childReadings: SensorReading[];
  errors: Array<{ childId: string; error: string }>;
  processedCount: number;
  errorCount: number;
}

/**
 * LRU Cache with TTL and max size
 */
class BoundedCache<K, V> {
  private cache = new Map<K, { value: V; expiry: number }>();

  constructor(
    private readonly maxSize: number,
    private readonly ttlMs: number,
  ) {}

  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return undefined;
    }
    // Move to end (LRU)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, { value, expiry: Date.now() + this.ttlMs });
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

/**
 * Sensor Ingestion Service
 */
@Injectable()
export class SensorIngestionService {
  private readonly logger = new Logger(SensorIngestionService.name);

  // Bounded caches with LRU eviction
  private readonly channelCache: BoundedCache<string, SensorDataChannel[]>;
  private readonly childSensorCache: BoundedCache<string, Sensor[]>;

  // Circuit breaker for the database dependency.
  // The event bus is no longer a write-path dependency: events are enqueued
  // into the transactional outbox atomically with the reading save, and the
  // outbox relay owns NATS delivery (SENSOR-CRITICAL-001). No event-bus
  // circuit breaker is needed on the ingest hot path.
  private readonly databaseCircuitBreaker: CircuitBreaker;

  // Configuration
  private static readonly CACHE_MAX_SIZE = 1000;
  private static readonly CACHE_TTL_MS = 60000; // 1 minute
  private static readonly BATCH_CHUNK_SIZE = 1000;
  private static readonly MAX_BATCH_SIZE = 10000;

  constructor(
    @InjectRepository(Sensor)
    private readonly sensorRepository: Repository<Sensor>,
    @Optional()
    @InjectRepository(SensorDataChannel)
    private readonly channelRepository: Repository<SensorDataChannel> | null,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly calibrationService: CalibrationService,
    private readonly dataQualityService: DataQualityService,
    private readonly readingMapperRegistry: ReadingMapperRegistry,
    // SENSOR-MEDIUM-066/068 — the SINGLE writer for sensor.sensor_metrics,
    // shared with the MQTT/edge/Rust ingestion plane (SensorMetricWriterModule),
    // so a GraphQL-ingested reading lands in the same channel-keyed store the
    // device-read path queries.
    private readonly metricWriter: SensorMetricWriterService,
  ) {
    this.channelCache = new BoundedCache(
      SensorIngestionService.CACHE_MAX_SIZE,
      SensorIngestionService.CACHE_TTL_MS,
    );
    this.childSensorCache = new BoundedCache(
      SensorIngestionService.CACHE_MAX_SIZE,
      SensorIngestionService.CACHE_TTL_MS,
    );

    // Initialize circuit breaker
    this.databaseCircuitBreaker = new CircuitBreaker('Database', 10, 60000);
  }

  /**
   * Ingest a single sensor reading with full validation and processing
   */
  async ingestReading(data: IngestReadingData): Promise<SensorReading> {
    // Validate inputs
    const validatedData = this.validateIngestInput(data);

    // Validate readings have at least one metric
    if (!this.dataQualityService.hasValidMetrics(validatedData.readings)) {
      throw new BadRequestException('Readings must contain at least one valid metric');
    }

    // Apply calibration transformations
    const transformedReadings = await this.calibrationService.applyCalibration(
      validatedData.sensorId,
      validatedData.readings,
    );

    // Calculate data quality score
    const quality = this.dataQualityService.calculateQuality(transformedReadings);

    // Build the reading read-model. SENSOR-HIGH-085: the id is the as-of anchor
    // codec (not a stored uuid), so the reading a client just ingested resolves
    // back through federation resolveReference to the same projection.
    const timestamp = validatedData.timestamp ?? new Date();
    const reading: SensorReading = {
      id: encodeSensorReadingId(validatedData.sensorId, timestamp.toISOString()),
      sensorId: validatedData.sensorId,
      tenantId: validatedData.tenantId,
      readings: transformedReadings,
      pondId: validatedData.pondId,
      farmId: validatedData.farmId,
      timestamp,
      source: validatedData.source || 'http',
      quality,
    };

    // Resolve the per-parameter channel map ONCE, before the write transaction.
    // applyCalibration() above warmed CalibrationService's channel cache for this
    // sensor, so this is a cache hit — no DB round-trip added to the hot path.
    const channelsByParameter = await this.ensureChannelsForParameters(
      validatedData.sensorId,
      validatedData.tenantId,
      transformedReadings,
      await this.resolveChannelsByParameter(validatedData.sensorId),
    );

    // Save the reading AND enqueue the SensorReading event atomically in a
    // single transaction. The outbox INSERT joins the same DB transaction as
    // the reading save: either both commit or neither. The outbox relay owns
    // NATS delivery after commit, so a dropped broker connection can no longer
    // lose the alert-triggering SensorReading event (SENSOR-CRITICAL-001 —
    // replaces the prior fire-and-forget eventBus.publish). The existing
    // withRetry + databaseCircuitBreaker wrapping is preserved AROUND the
    // transaction so a transient failure of the atomic save+enqueue retries.
    const saveResult = await withRetry(
      () =>
        this.databaseCircuitBreaker.execute(() =>
          this.dataSource.transaction(async (manager) => {
            // SENSOR-HIGH-085: no sensor_readings row is written — the reading is
            // an as-of projection over sensor.sensor_metrics. The SensorReading
            // event and the channel-keyed metric rows are both derived from the
            // in-memory reading and enqueued/written INSIDE this transaction, so
            // the SENSOR-CRITICAL-001 atomicity guarantee now spans enqueue +
            // metrics (either both commit or neither) with no stored-row write.
            await this.outboxPublisher.enqueue(this.buildReadingEvent(reading), manager);
            const metrics = this.buildMetricInputs(
              reading,
              validatedData.readings,
              channelsByParameter,
            );
            if (metrics.length > 0) {
              await this.metricWriter.writeManaged(metrics, manager);
            }
            return reading;
          }),
        ),
      {
        maxRetries: 3,
        initialDelayMs: 100,
        maxDelayMs: 2000,
        isRetryable: RetryableErrors.isTransientDatabaseError,
        loggerName: 'SensorIngestion:save',
      },
    );

    if (!saveResult.success) {
      this.logger.error(`Failed to save reading after retries: ${saveResult.error?.message}`);
      throw saveResult.error;
    }

    const saved = saveResult.result!;

    // Update sensor last seen (fire and forget with logging)
    this.updateSensorLastSeen(validatedData.sensorId).catch((err) =>
      this.logger.warn(`Failed to update lastSeenAt: ${err.message}`),
    );

    this.logger.debug(`Ingested reading from sensor ${validatedData.sensorId}`);
    return saved;
  }

  /**
   * Ingest multiple sensor readings in batch
   * Optimized for high-throughput scenarios with calibration applied
   */
  async ingestBatch(readings: IngestReadingData[]): Promise<number> {
    if (readings.length === 0) {
      return 0;
    }

    if (readings.length > SensorIngestionService.MAX_BATCH_SIZE) {
      throw new BadRequestException(
        `Batch size ${readings.length} exceeds maximum of ${SensorIngestionService.MAX_BATCH_SIZE}`,
      );
    }

    // Validate all inputs first
    const validatedReadings = readings.map((r) => this.validateIngestInput(r));

    // Pre-fetch calibration configs for all unique sensors
    const sensorIds = [...new Set(validatedReadings.map((r) => r.sensorId))];
    await this.prefetchCalibrationConfigs(sensorIds);

    // Process readings with calibration. Each prepared item carries both the
    // persisted entity (calibrated `readings`) AND the raw input readings, so
    // the sensor_metrics projection can record the (raw, calibrated) split.
    const prepared: Array<{ entity: SensorReading; rawReadings: SensorReadings }> = [];
    for (const data of validatedReadings) {
      // Apply calibration (uses cached configs)
      const transformedReadings = await this.calibrationService.applyCalibration(
        data.sensorId,
        data.readings,
      );

      const quality = this.dataQualityService.calculateQuality(transformedReadings);

      const timestamp = data.timestamp ?? new Date();
      prepared.push({
        entity: {
          id: encodeSensorReadingId(data.sensorId, timestamp.toISOString()),
          sensorId: data.sensorId,
          tenantId: data.tenantId,
          readings: transformedReadings,
          pondId: data.pondId,
          farmId: data.farmId,
          timestamp,
          source: data.source || 'batch',
          quality,
        },
        rawReadings: data.readings,
      });
    }

    // Resolve the per-parameter channel map for each unique sensor ONCE. The
    // prefetchCalibrationConfigs()/applyCalibration() calls above warmed the
    // channel cache, so these resolve from cache — no extra DB round-trip.
    const channelMapsBySensor = new Map<
      string,
      Map<SensorReadingParameter, SensorDataChannel>
    >();
    for (const sensorId of sensorIds) {
      // Union of every parameter this sensor reports in the batch, so one
      // provisioning pass covers the whole chunk (SENSOR-HIGH-085 / B1).
      const reported: SensorReadings = {};
      for (const { entity } of prepared) {
        if (entity.sensorId !== sensorId) continue;
        for (const parameter of SENSOR_READING_PARAMETERS) {
          const value = entity.readings[parameter];
          if (value !== undefined) reported[parameter] = value;
        }
      }
      const tenantId = prepared.find((p) => p.entity.sensorId === sensorId)!.entity.tenantId;
      channelMapsBySensor.set(
        sensorId,
        await this.ensureChannelsForParameters(
          sensorId,
          tenantId,
          reported,
          await this.resolveChannelsByParameter(sensorId),
        ),
      );
    }

    // Use chunked inserts, ONE transaction per chunk, each retried
    // INDEPENDENTLY. Each chunk's reading saves, its per-reading SensorReading
    // event enqueues, AND its sensor_metrics projection commit atomically
    // together: a chunk either fully persists with all its events + metric rows,
    // or rolls back entirely (SENSOR-CRITICAL-001). withRetry wraps each chunk
    // SEPARATELY (not the whole loop): a transient failure re-runs only the
    // failed chunk, because retrying the whole loop would re-insert
    // already-committed chunks (PK conflict / duplicate events). The outbox relay
    // owns NATS delivery after commit, so no fire-and-forget publish can drop an
    // alert-triggering event.
    let totalInserted = 0;

    for (let i = 0; i < prepared.length; i += SensorIngestionService.BATCH_CHUNK_SIZE) {
      const chunk = prepared.slice(i, i + SensorIngestionService.BATCH_CHUNK_SIZE);
      const chunkResult = await withRetry(
        () =>
          this.dataSource.transaction(async (manager) => {
            // SENSOR-HIGH-085: no sensor_readings insert — each reading's event
            // and its channel-keyed metric rows are derived from the in-memory
            // reading and committed atomically per chunk (SENSOR-CRITICAL-001).
            const chunkMetrics: SensorMetricInput[] = [];
            for (const { entity, rawReadings } of chunk) {
              await this.outboxPublisher.enqueue(this.buildReadingEvent(entity), manager);
              const channelsByParameter = channelMapsBySensor.get(entity.sensorId);
              if (channelsByParameter) {
                chunkMetrics.push(
                  ...this.buildMetricInputs(entity, rawReadings, channelsByParameter),
                );
              }
            }
            if (chunkMetrics.length > 0) {
              await this.metricWriter.writeManaged(chunkMetrics, manager);
            }
          }),
        {
          maxRetries: 3,
          initialDelayMs: 200,
          maxDelayMs: 5000,
          isRetryable: RetryableErrors.isTransientDatabaseError,
          loggerName: 'SensorIngestion:batchInsert',
        },
      );

      if (!chunkResult.success) {
        this.logger.error(
          `Batch ingest failed after retries at chunk offset ${i}: ${chunkResult.error?.message}`,
        );
        throw chunkResult.error;
      }

      totalInserted += chunk.length;
    }

    // Bulk update last seen for all sensors (more efficient)
    await this.bulkUpdateLastSeen(sensorIds);

    this.logger.log(`Batch ingested ${totalInserted} readings from ${sensorIds.length} sensors`);
    return totalInserted;
  }

  /**
   * Ingest a parent device reading and route values to child sensors
   */
  async ingestParentReading(
    parentId: string,
    tenantId: string,
    payload: Record<string, unknown>,
    timestamp?: Date,
    source?: string,
  ): Promise<ParentRoutingResult> {
    // Validate inputs
    const validParentId = validateSensorId(parentId);
    const validTenantId = validateTenantId(tenantId);

    const errors: Array<{ childId: string; error: string }> = [];
    const childReadings: SensorReading[] = [];

    // Get child sensors with caching
    const children = await this.getChildSensorsForParent(validParentId, validTenantId);

    if (children.length === 0) {
      this.logger.warn(`No child sensors found for parent ${validParentId}`);
      return {
        childReadings,
        errors: [{ childId: validParentId, error: 'No child sensors configured' }],
        processedCount: 0,
        errorCount: 1,
      };
    }

    // Process all child sensors concurrently — ingestReading() has no shared mutable
    // state across different sensorIds, making concurrent execution safe (HIGH-006).
    const childResults = await Promise.allSettled(
      children.map(async (child) => {
        if (!child.dataPath) {
          throw Object.assign(new Error('No dataPath configured'), { childId: child.id });
        }

        const value = this.extractValueFromPayload(payload, child.dataPath);
        if (value === undefined) {
          this.logger.debug(`No value found for dataPath ${child.dataPath} in payload`);
          return null;
        }

        const readings = this.readingMapperRegistry.mapToReadings(value, {
          sensorType: child.type,
          dataPath: child.dataPath,
        });

        const calibratedReadings = this.applyChildCalibration(child, readings);

        return this.ingestReading({
          sensorId: child.id,
          tenantId: validTenantId,
          readings: calibratedReadings,
          pondId: child.pondId,
          farmId: child.farmId,
          timestamp: timestamp ?? new Date(),
          source: source || 'parent-routing',
        });
      }),
    );

    for (let i = 0; i < childResults.length; i++) {
      const result = childResults[i];
      const child = children[i];
      if (!result || !child) continue;
      if (result.status === 'fulfilled' && result.value !== null) {
        childReadings.push(result.value);
      } else if (result.status === 'rejected') {
        const errorMsg = `Failed to process child sensor ${child.id}: ${(result.reason as Error).message}`;
        this.logger.error(errorMsg);
        errors.push({ childId: child.id, error: (result.reason as Error).message });
      }
    }

    this.logger.log(
      `Routed parent ${validParentId} reading to ${childReadings.length}/${children.length} children`,
    );

    // Enqueue the ParentReadingRouted event durably. Child readings have
    // already been persisted with their own SensorReading events (each
    // ingestReading() call is its own atomic save+enqueue). This summary
    // event records the routing outcome and is committed in its own
    // transaction via the outbox so the relay delivers it to NATS after
    // commit — no fire-and-forget publish can drop it (SENSOR-CRITICAL-001).
    await this.dataSource.transaction(async (manager) => {
      await this.outboxPublisher.enqueue(
        this.buildParentRoutingEvent(
          validParentId,
          validTenantId,
          children.length,
          childReadings.length,
          errors.length,
          timestamp,
        ),
        manager,
      );
    });

    return {
      childReadings,
      errors,
      processedCount: childReadings.length,
      errorCount: errors.length,
    };
  }

  /**
   * Validate ingest input data
   */
  private validateIngestInput(data: IngestReadingData): IngestReadingData {
    return {
      ...data,
      sensorId: validateSensorId(data.sensorId),
      tenantId: validateTenantId(data.tenantId),
      pondId: data.pondId ? validateSensorId(data.pondId) : undefined,
      farmId: data.farmId ? validateSensorId(data.farmId) : undefined,
    };
  }

  /**
   * Update sensor's last seen timestamp
   */
  private async updateSensorLastSeen(sensorId: string): Promise<void> {
    try {
      await this.sensorRepository.update({ id: sensorId }, { lastSeenAt: new Date() });
    } catch (error) {
      // Log but don't throw - this is a non-critical operation
      this.logger.warn(`Failed to update lastSeenAt for sensor ${sensorId}: ${(error as Error).message}`);
    }
  }

  /**
   * Bulk update last seen timestamps - more efficient for batch operations
   */
  private async bulkUpdateLastSeen(sensorIds: string[]): Promise<void> {
    if (sensorIds.length === 0) return;

    try {
      await this.sensorRepository.update(
        { id: In(sensorIds) },
        { lastSeenAt: new Date() },
      );
    } catch (error) {
      this.logger.warn(`Failed to bulk update lastSeenAt: ${(error as Error).message}`);
    }
  }

  /**
   * Prefetch calibration configs for multiple sensors.
   * MEDIUM-003: Issues a single batch query for all channels rather than
   * N sequential applyCalibration() calls (1 DB query per sensor).
   */
  private async prefetchCalibrationConfigs(sensorIds: string[]): Promise<void> {
    if (!this.channelRepository || sensorIds.length === 0) return;

    try {
      // Fetch all channels for all sensors in one query
      const allChannels = await this.channelRepository.findBy({
        sensorId: In(sensorIds),
        isEnabled: true,
      });

      // Group by sensorId and populate the calibration service cache directly
      const grouped = new Map<string, SensorDataChannel[]>();
      for (const channel of allChannels) {
        const list = grouped.get(channel.sensorId) ?? [];
        list.push(channel);
        grouped.set(channel.sensorId, list);
      }

      // Warm calibrationService channel cache for each sensor
      for (const [sensorId, channels] of grouped.entries()) {
        // Access the calibration service's internal warming path if available,
        // otherwise fall back to the single-sensor prefetch which hits cache after first call
        this.calibrationService.warmChannelCache(sensorId, channels);
      }
    } catch (error) {
      this.logger.warn(`Failed to batch prefetch calibration configs: ${(error as Error).message}`);
    }
  }

  /**
   * Get child sensors for a parent device with caching
   */
  private async getChildSensorsForParent(parentId: string, tenantId: string): Promise<Sensor[]> {
    const cacheKey = `${parentId}:${tenantId}`;

    const cached = this.childSensorCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const children = await this.sensorRepository.find({
        where: {
          parentId,
          tenantId,
          sensorRole: SensorRole.CHILD,
          isActive: true,
        },
        order: { createdAt: 'ASC' },
      });

      this.childSensorCache.set(cacheKey, children);
      return children;
    } catch (error) {
      this.logger.error(`Failed to fetch child sensors for parent ${parentId}: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * Extract value from payload using dot notation path
   * Validates path depth to prevent DoS
   */
  private extractValueFromPayload(
    payload: Record<string, unknown>,
    dataPath: string,
  ): number | undefined {
    if (!dataPath) return undefined;

    // Validate path depth
    const parts = dataPath.split('.');
    if (parts.length > MAX_DATA_PATH_DEPTH) {
      this.logger.warn(`Data path exceeds maximum depth: ${dataPath}`);
      return undefined;
    }

    // Navigate to value
    let value: unknown = payload;
    for (const part of parts) {
      if (value && typeof value === 'object' && part in value) {
        value = (value as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }

    // Convert to number
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const num = parseFloat(value);
      return Number.isFinite(num) ? num : undefined;
    }

    return undefined;
  }

  /**
   * Apply calibration for a child sensor
   */
  private applyChildCalibration(child: Sensor, readings: SensorReadings): SensorReadings {
    if (!child.calibrationEnabled) {
      return readings;
    }

    const multiplier = Number(child.calibrationMultiplier) || 1;
    const offset = Number(child.calibrationOffset) || 0;

    const calibrated = { ...readings };
    for (const [key, value] of Object.entries(calibrated)) {
      if (typeof value === 'number') {
        (calibrated as Record<string, number>)[key] = value * multiplier + offset;
      }
    }

    return calibrated;
  }

  /**
   * Map the sensor's enabled channels to the reading parameter each one carries
   * (SENSOR-MEDIUM-066/068). Reuses CalibrationService's cache-backed channel
   * load — already warmed by the applyCalibration()/prefetch call that precedes
   * every metric build — so the resolution costs no extra DB round-trip on the
   * ingest hot path. Channels outside the nine-parameter vocabulary
   * (`parameterForChannelKey` → undefined, e.g. flow_rate/orp/co2) are left out;
   * those metrics gain a channel-keyed home in convergence phase ≥3. When two
   * channels resolve to the same parameter, the first wins — one metric row per
   * (time, sensor, channel) parameter, never a duplicate value under two ids.
   */
  private async resolveChannelsByParameter(
    sensorId: string,
  ): Promise<Map<SensorReadingParameter, SensorDataChannel>> {
    const channels = await this.calibrationService.getChannels(sensorId);
    const byParameter = new Map<SensorReadingParameter, SensorDataChannel>();
    for (const channel of channels) {
      const parameter = parameterForChannelKey(channel.channelKey);
      if (parameter && !byParameter.has(parameter)) {
        byParameter.set(parameter, channel);
      }
    }
    return byParameter;
  }

  /**
   * Guarantee every populated reading parameter has a channel to be stored in,
   * auto-provisioning the missing ones (SENSOR-HIGH-085 / B1).
   *
   * WHY THIS EXISTS: sensor_metrics is channel-keyed, so a parameter with no
   * channel has nowhere to be persisted. Before the reading store converged, the
   * flat JSONB row still carried such values; once that store was retired, an
   * unmapped parameter was accepted, acknowledged as success, and then silently
   * dropped — permanent data loss on an ingest that reported OK. Skipping the
   * row is not an option, and neither is failing the ingest: a sensor that sends
   * a value IS measuring that quantity, so the channel's absence is missing
   * configuration, not invalid data.
   *
   * The correct behaviour is therefore automatic (tier-2): the channel is
   * provisioned on first sight, keyed by the canonical parameter name. This is
   * SAFE TO AUTOMATE because the vocabulary is CLOSED — `SENSOR_READING_PARAMETERS`
   * has exactly nine members and `SensorReadings` cannot carry anything else — so
   * a malformed payload can never inflate a sensor beyond nine auto channels.
   *
   * The channelKey is the canonical parameter name itself rather than a
   * snake_case rendering: `parameterForChannelKey` lower-cases before lookup and
   * already resolves it, so no second name-mapping is introduced (the
   * event-contract SSoT stays the only place that knows the vocabulary).
   *
   * Concurrency: two ingests for the same sensor can race, so the insert is
   * `orIgnore()` against the `(tenantId, sensorId, channelKey)` unique
   * constraint and the channel set is re-read afterwards — the loser of the race
   * picks up the winner's row instead of failing.
   */
  private async ensureChannelsForParameters(
    sensorId: string,
    tenantId: string,
    readings: SensorReadings,
    channelsByParameter: Map<SensorReadingParameter, SensorDataChannel>,
  ): Promise<Map<SensorReadingParameter, SensorDataChannel>> {
    if (!this.channelRepository) {
      return channelsByParameter;
    }

    const missing = SENSOR_READING_PARAMETERS.filter(
      (parameter) => readings[parameter] !== undefined && !channelsByParameter.has(parameter),
    );
    if (missing.length === 0) {
      return channelsByParameter;
    }

    await this.channelRepository
      .createQueryBuilder()
      .insert()
      .into(SensorDataChannel)
      .values(
        missing.map((parameter) => ({
          sensorId,
          tenantId,
          channelKey: parameter,
          displayLabel: parameter,
          discoverySource: DiscoverySource.AUTO,
        })),
      )
      .orIgnore()
      .execute();

    this.logger.log(
      `Sensor ${sensorId}: auto-provisioned ${missing.length} data channel(s) for reported ` +
        `parameter(s) ${missing.join(', ')} — the values are now stored instead of dropped`,
    );

    // The sensor's channel set changed; drop the cached copy so this ingest and
    // every later one resolve the new channels.
    this.calibrationService.clearCache(sensorId);
    return this.resolveChannelsByParameter(sensorId);
  }

  /**
   * Project a persisted reading's populated parameters onto channel-keyed
   * sensor_metrics rows (SENSOR-MEDIUM-066/068). Each populated parameter is
   * matched to the sensor's channel whose channelKey resolves to it. `value` is
   * the calibrated result already stored on the reading; `rawValue` is the
   * pre-calibration input — the same (raw, calibrated) split the MQTT/edge
   * writer records. qualityCode comes from the channel's own bounds check,
   * identical to the MQTT path, so both ingestion planes label quality the same
   * way. The shared writer drops any non-finite value defensively.
   *
   * A populated parameter reaching here WITHOUT a channel means its value cannot
   * be persisted anywhere (SENSOR-HIGH-085 / B1): the flat JSONB row that used to
   * carry it is retired. ensureChannelsForParameters() runs before every call and
   * auto-provisions the missing channels precisely so this cannot happen, so a
   * non-zero count is a real defect — it is logged at ERROR, not debug, and names
   * the lost parameters rather than being counted away quietly.
   */
  private buildMetricInputs(
    reading: SensorReading,
    rawReadings: SensorReadings,
    channelsByParameter: Map<SensorReadingParameter, SensorDataChannel>,
  ): SensorMetricInput[] {
    const metrics: SensorMetricInput[] = [];
    const unmapped: SensorReadingParameter[] = [];

    for (const parameter of SENSOR_READING_PARAMETERS) {
      const value = reading.readings[parameter];
      if (value === undefined) {
        continue;
      }

      const channel = channelsByParameter.get(parameter);
      if (!channel) {
        unmapped.push(parameter);
        continue;
      }

      const rawValue = rawReadings[parameter];
      let qualityCode: number = QualityCodes.GOOD;
      let qualityBits = 0;
      const validation = channel.validateValue(value);
      if (!validation.valid) {
        qualityCode = QualityCodes.BAD;
        qualityBits |= 0x20; // out-of-range (clamped) bit
      } else if (validation.level === 'operational') {
        qualityCode = QualityCodes.UNCERTAIN_EU_EXCEEDED;
      }

      metrics.push({
        time: reading.timestamp,
        sensorId: reading.sensorId,
        channelId: channel.id,
        tenantId: reading.tenantId,
        farmId: reading.farmId,
        pondId: reading.pondId,
        rawValue: typeof rawValue === 'number' ? rawValue : value,
        value,
        qualityCode,
        qualityBits,
        sourceProtocol: 'graphql',
        sourceTimestamp: reading.timestamp,
      });
    }

    if (unmapped.length > 0) {
      // Auto-provisioning runs before every call, so reaching here means a value
      // was accepted and could not be stored anywhere — a real defect, named
      // rather than counted away (SENSOR-HIGH-085 / B1).
      this.logger.error(
        `Sensor ${reading.sensorId}: ${unmapped.length} reading parameter(s) still had no channel ` +
          `after auto-provisioning and were NOT persisted: ${unmapped.join(', ')}`,
      );
    }

    return metrics;
  }

  /**
   * Build the sensor reading event (v2 — flat readingXxx fields).
   * ARCH-C01: Emits flat fields instead of nested `readings` object.
   *
   * Pure builder: returns the event object so the caller can enqueue it on
   * the transactional outbox atomically with the reading save
   * (SENSOR-CRITICAL-001). It performs no I/O and no eventBus publish.
   */
  private buildReadingEvent(reading: SensorReading): SensorReadingEvent {
    // Project the JSONB readings onto the flat `readingXxx` event fields via the
    // single mapping SSoT (SENSOR-MEDIUM-066/068). The SensorReadings keys ARE
    // the canonical parameter names, so a new parameter is added in exactly one
    // place (`SENSOR_READING_PARAMETERS`) and producer + consumers stay aligned.
    const readingFields: Partial<Record<SensorReadingField, number | undefined>> = {};
    for (const parameter of SENSOR_READING_PARAMETERS) {
      readingFields[readingFieldForParameter(parameter)] = reading.readings[parameter];
    }

    return {
      ...createBaseEvent<SensorReadingEvent>('SensorReading', reading.tenantId, {
        aggregateId: reading.sensorId,
        aggregateType: 'Sensor',
        version: 2,
      }),
      timestamp:
        reading.timestamp instanceof Date ? reading.timestamp.toISOString() : reading.timestamp,
      sensorId: reading.sensorId,
      farmId: reading.farmId,
      pondId: reading.pondId,
      ...readingFields,
    };
  }

  /**
   * Build the parent routing event.
   *
   * Pure builder: returns the event object so the caller can enqueue it on
   * the transactional outbox (SENSOR-CRITICAL-001). No I/O, no eventBus.
   */
  private buildParentRoutingEvent(
    parentId: string,
    tenantId: string,
    childCount: number,
    processedCount: number,
    errorCount: number,
    timestamp?: Date,
  ): ParentReadingRoutedEvent {
    return {
      ...createBaseEvent<ParentReadingRoutedEvent>('ParentReadingRouted', tenantId, {
        aggregateId: parentId,
        aggregateType: 'Sensor',
      }),
      timestamp: timestamp ? timestamp.toISOString() : new Date().toISOString(),
      parentId,
      childCount,
      processedCount,
      errorCount,
    };
  }

  /**
   * Clear channel cache (call when channels are updated)
   */
  clearChannelCache(sensorId?: string): void {
    if (sensorId) {
      this.channelCache.delete(sensorId);
      this.calibrationService.clearCache(sensorId);
    } else {
      this.channelCache.clear();
      this.calibrationService.clearCache();
    }
  }

  /**
   * Clear child sensor cache (call when children are updated)
   */
  clearChildCache(parentId?: string, tenantId?: string): void {
    if (parentId && tenantId) {
      this.childSensorCache.delete(`${parentId}:${tenantId}`);
    } else {
      this.childSensorCache.clear();
    }
  }

  /**
   * Get cache statistics for monitoring
   */
  getCacheStats(): {
    channelCache: { size: number; maxSize: number };
    childSensorCache: { size: number; maxSize: number };
  } {
    return {
      channelCache: {
        size: this.channelCache.size,
        maxSize: SensorIngestionService.CACHE_MAX_SIZE,
      },
      childSensorCache: {
        size: this.childSensorCache.size,
        maxSize: SensorIngestionService.CACHE_MAX_SIZE,
      },
    };
  }

  /**
   * Get circuit breaker states for monitoring.
   *
   * Only the database breaker remains: event delivery moved off the ingest
   * write path into the transactional outbox (SENSOR-CRITICAL-001), so there
   * is no event-bus breaker to report.
   */
  getCircuitBreakerStates(): {
    database: string;
  } {
    return {
      database: this.databaseCircuitBreaker.getState(),
    };
  }
}
