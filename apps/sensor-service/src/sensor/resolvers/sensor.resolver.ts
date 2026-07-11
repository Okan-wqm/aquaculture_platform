import { Logger, NotFoundException, ConflictException } from '@nestjs/common';
import {
  Resolver,
  Query,
  Mutation,
  Args,
  Int,
  ID,
  ResolveReference,
} from '@nestjs/graphql';
import { InjectRepository } from '@nestjs/typeorm';
import { Tenant, CurrentUser, Roles, Role } from '@aquaculture/backend-common/decorators';
import { Repository } from 'typeorm';

import { SensorReading } from '../../database/entities/sensor-reading.entity';
import { Sensor, SensorStatus } from '../../database/entities/sensor.entity';
import {
  AggregationInterval,
  AggregatedReadingsResponse,
} from '../dto/aggregated-reading.dto';
import { CreateSensorInput, UpdateSensorInput } from '../dto/create-sensor.dto';
import { IngestReadingInput, BatchIngestInput } from '../dto/ingest-reading.dto';
import { SensorTypeService } from '../../sensor-type/sensor-type.service';
import { SensorIngestionService } from '../services/sensor-ingestion.service';
import { SensorQueryService } from '../services/sensor-query.service';

/**
 * User context interface
 */
interface UserContext {
  sub: string;
  email: string;
  tenantId: string;
  roles: string[];
}

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
    private readonly sensorTypeService: SensorTypeService,
  ) {}

  /**
   * Federation reference resolver
   * SECURITY: Includes tenant isolation to prevent cross-tenant data access
   */
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
      // SECURITY: Extract tenantId from context or reference
      const tenantId = context?.req?.user?.tenantId || reference.tenantId;

      if (!tenantId) {
        this.logger.warn(
          `Federation reference resolver called without tenantId for sensor ${reference.id}`,
        );
        return null;
      }

      // SECURITY: Always filter by tenantId to ensure tenant isolation
      return await this.sensorRepository.findOne({
        where: { id: reference.id, tenantId },
      });
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

    return sensor;
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

    return await this.sensorRepository.find({
      where,
      skip,
      take: safeLimit,
      order: { createdAt: 'DESC' },
    });
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
    return await this.queryService.getLatestReadingsForSensors(
      sensorIds,
      tenantId,
    );
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

  /**
   * Create a new sensor
   */
  @Mutation(() => Sensor, { name: 'createSensor' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async createSensor(
    @Args('input') input: CreateSensorInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<Sensor> {
    this.logger.log(`Creating sensor ${input.name}`);

    // Check for duplicate serial number within tenant
    const existing = await this.sensorRepository.findOne({
      where: { serialNumber: input.serialNumber, tenantId },
    });

    if (existing) {
      throw new ConflictException(
        `Sensor with serial number ${input.serialNumber} already exists`,
      );
    }

    const { typeDefinitionId, ...sensorInput } = input;

    const sensor = this.sensorRepository.create({
      ...sensorInput,
      typeDefinitionId: typeDefinitionId || undefined,
      tenantId,
      status: SensorStatus.ACTIVE,
      createdBy: user.sub,
    });

    const saved = await this.sensorRepository.save(sensor);

    // If a dynamic type definition was provided, create default channels
    if (typeDefinitionId) {
      try {
        await this.sensorTypeService.createChannelsFromTypeDefinition(
          saved.id,
          tenantId,
          typeDefinitionId,
        );
      } catch (error) {
        // Channel creation is non-critical — sensor is still valid
        this.logger.warn(
          `Failed to create channels from type definition ${typeDefinitionId} for sensor ${saved.id}: ${error}`,
        );
      }
    }

    return saved;
  }

  /**
   * Update a sensor
   */
  @Mutation(() => Sensor, { name: 'updateSensor' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async updateSensor(
    @Args('input') input: UpdateSensorInput,
    @Tenant() tenantId: string,
  ): Promise<Sensor> {
    const sensor = await this.sensorRepository.findOne({
      where: { id: input.sensorId, tenantId },
    });

    if (!sensor) {
      throw new NotFoundException(
        `Sensor with ID ${input.sensorId} not found`,
      );
    }

    // Update fields
    if (input.name) sensor.name = input.name;
    if (input.status) sensor.status = input.status;
    if (input.firmwareVersion) sensor.firmwareVersion = input.firmwareVersion;
    if (input.pondId !== undefined) sensor.pondId = input.pondId;
    if (input.farmId !== undefined) sensor.farmId = input.farmId;

    return await this.sensorRepository.save(sensor);
  }

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
