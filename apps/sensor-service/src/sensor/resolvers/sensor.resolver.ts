import { Logger, NotFoundException } from '@nestjs/common';
import { Resolver, Query, Mutation, Args, Int, ID, ResolveReference } from '@nestjs/graphql';
import { InjectRepository } from '@nestjs/typeorm';
import { Tenant, Roles, Role } from '@aquaculture/backend-common/decorators';
import { Repository } from 'typeorm';

import { SensorReading } from '../../database/entities/sensor-reading.entity';
import { Sensor, SensorStatus } from '../../database/entities/sensor.entity';
import { redactProtocolSecrets } from '../../common/redact-protocol-secrets';
import { AggregationInterval, AggregatedReadingsResponse } from '../dto/aggregated-reading.dto';
import { IngestReadingInput, BatchIngestInput } from '../dto/ingest-reading.dto';
import { SensorIngestionService } from '../services/sensor-ingestion.service';
import { SensorQueryService } from '../services/sensor-query.service';

/**
 * Sensor Resolver
 * GraphQL resolver for sensor operations
 * Implements Apollo Federation
 */
@Resolver(() => Sensor)
export class SensorResolver {
  private readonly logger = new Logger(SensorResolver.name);

  constructor(
    @InjectRepository(Sensor)
    private readonly sensorRepository: Repository<Sensor>,
    private readonly ingestionService: SensorIngestionService,
    private readonly queryService: SensorQueryService,
  ) {}

  /**
   * Federation reference resolver
   * SECURITY: Includes tenant isolation to prevent cross-tenant data access
   */
  /**
   * Mask secret-named protocol-configuration fields before an entity leaves
   * this resolver. The column transformer decrypts credentials on read
   * (SENSOR-MEDIUM-080), so every raw-entity read path here MUST pass through
   * this — the registration read models already redact (SENSOR-HIGH-081);
   * these legacy paths are held to the same standard (SEC-HIGH-096).
   */
  private redactSensor(sensor: Sensor): Sensor {
    if (sensor.protocolConfiguration) {
      sensor.protocolConfiguration = redactProtocolSecrets(sensor.protocolConfiguration);
    }
    return sensor;
  }

  @ResolveReference()
  async resolveReference(
    reference: {
      __typename: string;
      id: string;
      tenantId?: string;
    },
    context: { req?: { user?: { tenantId?: string } } },
  ): Promise<Sensor | null> {
    try {
      // SECURITY: tenant identity comes from the verified request context
      // ONLY — a representation-supplied tenantId is attacker-influenceable
      // input on the federation plane and must never select the schema
      // (hardening rider on SEC-HIGH-096; latent while keys stay id-only).
      const tenantId = context?.req?.user?.tenantId;

      if (!tenantId) {
        this.logger.warn(
          `Federation reference resolver called without tenantId for sensor ${reference.id}`,
        );
        return null;
      }

      // SECURITY: Always filter by tenantId to ensure tenant isolation
      const sensor = await this.sensorRepository.findOne({
        where: { id: reference.id, tenantId },
      });
      return sensor ? this.redactSensor(sensor) : null;
    } catch {
      return null;
    }
  }

  /**
   * Get a single sensor by ID
   */
  @Query(() => Sensor, { name: 'sensor', nullable: true })
  async getSensor(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<Sensor> {
    const sensor = await this.sensorRepository.findOne({
      where: { id, tenantId },
    });

    if (!sensor) {
      throw new NotFoundException(`Sensor with ID ${id} not found`);
    }

    return this.redactSensor(sensor);
  }

  /**
   * List all sensors for the tenant (raw array, no pagination wrapper).
   * Legacy query — frontend uses the paginated 'sensors' query from RegistrationResolver.
   */
  @Query(() => [Sensor], { name: 'sensorRawList' })
  async listSensors(
    @Tenant() tenantId: string,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 })
    page: number,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 })
    limit: number,
    @Args('pondId', { type: () => ID, nullable: true })
    pondId?: string,
    @Args('status', { type: () => SensorStatus, nullable: true })
    status?: SensorStatus,
    // MOB-MEDIUM-008: mobile tank screens join sensors by the FARM container
    // UUID stored in sensor.tank_id (indexed) — a resolver-level filter, not a
    // client-side heuristic over the free-form pondId field.
    @Args('tankId', { type: () => ID, nullable: true })
    tankId?: string,
  ): Promise<Sensor[]> {
    // SECURITY: Clamp page and limit BEFORE computing skip to prevent
    // tenant-level query DoS via large OFFSET values.
    // Previously, skip was computed from unbounded page/limit before clamping.
    const safePage = Math.max(1, Math.min(page, 10000));
    const safeLimit = Math.max(1, Math.min(limit, 200));
    const skip = (safePage - 1) * safeLimit;

    const where: Record<string, unknown> = { tenantId };
    if (pondId) where['pondId'] = pondId;
    if (status) where['status'] = status;
    if (tankId) where['tankId'] = tankId;

    const sensors = await this.sensorRepository.find({
      where,
      skip,
      take: safeLimit,
      order: { createdAt: 'DESC' },
    });

    // SEC-HIGH-096 (2026-08-23 scan №41): the decrypted protocol
    // configuration carries live device credentials — mask them on this raw
    // entity path exactly like the registration read models do.
    return sensors.map((s) => this.redactSensor(s));
  }

  /**
   * Get latest reading for a sensor
   */
  @Query(() => SensorReading, { name: 'latestReading', nullable: true })
  async getLatestReading(
    @Args('sensorId', { type: () => ID }) sensorId: string,
    @Tenant() tenantId: string,
  ): Promise<SensorReading | null> {
    return await this.queryService.getLatestReading(sensorId, tenantId);
  }

  /**
   * Get latest readings for multiple sensors in a single batch query.
   * Returns one reading per sensor (the most recent).
   * Uses DISTINCT ON for O(1) DB round-trips instead of N+1.
   */
  @Query(() => [SensorReading], { name: 'latestReadingsBatch' })
  async getLatestReadingsBatch(
    @Args('sensorIds', { type: () => [ID] }) sensorIds: string[],
    @Tenant() tenantId: string,
  ): Promise<SensorReading[]> {
    return await this.queryService.getLatestReadingsForSensors(sensorIds, tenantId);
  }

  /**
   * Get readings in a time range
   */
  @Query(() => [SensorReading], { name: 'readings' })
  async getReadings(
    @Args('sensorId', { type: () => ID }) sensorId: string,
    @Args('startTime') startTime: Date,
    @Args('endTime') endTime: Date,
    @Tenant() tenantId: string,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 1000 })
    limit: number,
  ): Promise<SensorReading[]> {
    return await this.queryService.getReadingsInRange(
      sensorId,
      tenantId,
      startTime,
      endTime,
      limit,
    );
  }

  /**
   * Get aggregated readings using TimescaleDB time_bucket
   * Optimized for chart rendering - returns pre-aggregated data points
   *
   * Time range -> Auto-selected interval (if not specified):
   * - 1 hour   -> 1 minute    (60 points)
   * - 6 hours  -> 5 minutes   (72 points)
   * - 24 hours -> 15 minutes  (96 points)
   * - 3 days   -> 1 hour      (72 points)
   * - 7 days   -> 4 hours     (42 points)
   * - 30 days  -> 1 day       (30 points)
   */
  @Query(() => AggregatedReadingsResponse, { name: 'aggregatedReadings' })
  async getAggregatedReadings(
    @Args('sensorId', { type: () => ID }) sensorId: string,
    @Args('startTime') startTime: Date,
    @Args('endTime') endTime: Date,
    @Tenant() tenantId: string,
    @Args('interval', { type: () => AggregationInterval, nullable: true })
    interval?: AggregationInterval,
  ): Promise<AggregatedReadingsResponse> {
    return await this.queryService.getAggregatedReadings(
      sensorId,
      tenantId,
      startTime,
      endTime,
      interval,
    );
  }

  // SENSOR-MEDIUM-064: the createSensor and updateSensor mutations were deleted.
  // They were an unused GraphQL back door that inserted a Sensor with status
  // ACTIVE directly — bypassing the per-plan maxSensors quota, protocol
  // validation, the DRAFT→test→ACTIVE lifecycle, and the SensorRegistered outbox
  // events that farm/alert consume. registerSensor (registration/) is now the
  // single write path for new sensors; updateSensorInfo/updateSensorProtocol own
  // updates. The createSensor-only typeDefinitionId capability is revived on the
  // canonical registration path under SENSOR-MEDIUM-071.

  /**
   * Ingest a sensor reading
   */
  // SENSOR-LOW-001: forging readings can trigger/suppress alerts — require
  // operator authority, matching createSensor/updateSensor. Device-originated
  // ingestion uses the signed service-identity/MQTT path, not this user route.
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => SensorReading, { name: 'ingestReading' })
  async ingestReading(
    @Args('input') input: IngestReadingInput,
    @Tenant() tenantId: string,
  ): Promise<SensorReading> {
    return await this.ingestionService.ingestReading({
      sensorId: input.sensorId,
      tenantId,
      readings: input.readings,
      pondId: input.pondId,
      farmId: input.farmId,
      timestamp: input.timestamp,
      source: 'graphql',
    });
  }

  /**
   * Batch ingest sensor readings
   */
  // SENSOR-LOW-001: same operator-authority gate as ingestReading.
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => Int, { name: 'batchIngestReadings' })
  async batchIngestReadings(
    @Args('input') input: BatchIngestInput,
    @Tenant() tenantId: string,
  ): Promise<number> {
    const readings = input.readings.map((r) => ({
      sensorId: r.sensorId,
      tenantId,
      readings: r.readings,
      pondId: r.pondId,
      farmId: r.farmId,
      timestamp: r.timestamp,
      source: 'graphql-batch',
    }));

    return await this.ingestionService.ingestBatch(readings);
  }
}
