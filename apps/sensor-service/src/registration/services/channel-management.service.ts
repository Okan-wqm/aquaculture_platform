import { Injectable, Logger, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, FindOptionsWhere, DataSource, EntityManager } from 'typeorm';

interface MaxOrderResult {
  max: number | null;
}

import {
  SensorDataChannel,
  ChannelDataType,
  DiscoverySource,
  AlertThresholdConfig,
  ChannelDisplaySettings,
} from '../../database/entities/sensor-data-channel.entity';

import { DiscoveredChannel } from './channel-discovery.service';

/**
 * Input for creating a data channel
 */
export interface CreateChannelInput {
  channelKey: string;
  displayLabel: string;
  description?: string;
  dataType?: ChannelDataType;
  unit?: string;
  dataPath?: string;
  minValue?: number;
  maxValue?: number;
  calibrationEnabled?: boolean;
  calibrationMultiplier?: number;
  calibrationOffset?: number;
  alertThresholds?: AlertThresholdConfig;
  displaySettings?: ChannelDisplaySettings;
  isEnabled?: boolean;
  displayOrder?: number;
  sampleValue?: unknown;
}

/**
 * Input for updating a data channel
 */
export interface UpdateChannelInput {
  displayLabel?: string;
  description?: string;
  unit?: string;
  dataPath?: string;
  minValue?: number;
  maxValue?: number;
  calibrationEnabled?: boolean;
  calibrationMultiplier?: number;
  calibrationOffset?: number;
  alertThresholds?: AlertThresholdConfig;
  displaySettings?: ChannelDisplaySettings;
  isEnabled?: boolean;
  displayOrder?: number;
}

/**
 * Service for managing sensor data channels
 */
@Injectable()
export class ChannelManagementService {
  private readonly logger = new Logger(ChannelManagementService.name);

  constructor(
    @InjectRepository(SensorDataChannel)
    private readonly channelRepository: Repository<SensorDataChannel>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Create a new data channel for a sensor
   */
  async createChannel(
    sensorId: string,
    tenantId: string,
    input: CreateChannelInput,
  ): Promise<SensorDataChannel> {
    // Check for duplicate channel key
    const existing = await this.channelRepository.findOne({
      where: { sensorId, channelKey: input.channelKey },
    });

    if (existing) {
      throw new ConflictException(
        `Channel with key '${input.channelKey}' already exists for this sensor`,
      );
    }

    // Get next display order
    const maxOrder = await this.channelRepository
      .createQueryBuilder('channel')
      .where('channel.sensorId = :sensorId', { sensorId })
      .select('MAX(channel.displayOrder)', 'max')
      .getRawOne<MaxOrderResult>();

    const channel = this.channelRepository.create({
      sensorId,
      tenantId,
      channelKey: input.channelKey,
      displayLabel: input.displayLabel,
      description: input.description,
      dataType: input.dataType || ChannelDataType.NUMBER,
      unit: input.unit,
      dataPath: input.dataPath || input.channelKey,
      minValue: input.minValue,
      maxValue: input.maxValue,
      calibrationEnabled: input.calibrationEnabled || false,
      calibrationMultiplier: input.calibrationMultiplier ?? 1.0,
      calibrationOffset: input.calibrationOffset ?? 0.0,
      alertThresholds: input.alertThresholds,
      displaySettings: input.displaySettings,
      isEnabled: input.isEnabled ?? true,
      displayOrder: input.displayOrder ?? (maxOrder?.max ? maxOrder.max + 1 : 0),
      discoverySource: DiscoverySource.MANUAL,
      sampleValue: input.sampleValue,
    });

    const saved = await this.channelRepository.save(channel);
    this.logger.log(`Created channel ${saved.channelKey} for sensor ${sensorId}`);

    return saved;
  }

  /**
   * Update an existing data channel
   */
  async updateChannel(
    channelId: string,
    tenantId: string,
    input: UpdateChannelInput,
  ): Promise<SensorDataChannel> {
    const channel = await this.channelRepository.findOne({
      where: { id: channelId, tenantId },
    });

    if (!channel) {
      throw new NotFoundException(`Channel with ID '${channelId}' not found`);
    }

    // Apply updates
    if (input.displayLabel !== undefined) channel.displayLabel = input.displayLabel;
    if (input.description !== undefined) channel.description = input.description;
    if (input.unit !== undefined) channel.unit = input.unit;
    if (input.dataPath !== undefined) channel.dataPath = input.dataPath;
    if (input.minValue !== undefined) channel.minValue = input.minValue;
    if (input.maxValue !== undefined) channel.maxValue = input.maxValue;
    if (input.calibrationEnabled !== undefined) channel.calibrationEnabled = input.calibrationEnabled;
    if (input.calibrationMultiplier !== undefined) channel.calibrationMultiplier = input.calibrationMultiplier;
    if (input.calibrationOffset !== undefined) channel.calibrationOffset = input.calibrationOffset;
    if (input.alertThresholds !== undefined) channel.alertThresholds = input.alertThresholds;
    if (input.displaySettings !== undefined) channel.displaySettings = input.displaySettings;
    if (input.isEnabled !== undefined) channel.isEnabled = input.isEnabled;
    if (input.displayOrder !== undefined) channel.displayOrder = input.displayOrder;

    const saved = await this.channelRepository.save(channel);
    this.logger.log(`Updated channel ${saved.channelKey} (${channelId})`);

    return saved;
  }

  /**
   * Delete a data channel
   * SECURITY: tenantId in WHERE clause prevents cross-tenant IDOR
   */
  async deleteChannel(channelId: string, tenantId: string): Promise<void> {
    const channel = await this.channelRepository.findOne({
      where: { id: channelId, tenantId },
    });

    if (!channel) {
      throw new NotFoundException(`Channel with ID '${channelId}' not found`);
    }

    await this.channelRepository.remove(channel);
    this.logger.log(`Deleted channel ${channel.channelKey} (${channelId})`);
  }

  /**
   * Get all channels for a sensor
   * SECURITY: tenantId in WHERE clause prevents cross-tenant IDOR
   */
  async getChannelsBySensor(sensorId: string, tenantId: string): Promise<SensorDataChannel[]> {
    return this.channelRepository.find({
      where: { sensorId, tenantId },
      order: { displayOrder: 'ASC', createdAt: 'ASC' },
    });
  }

  /**
   * Get only enabled channels for a sensor
   * SECURITY: tenantId in WHERE clause prevents cross-tenant IDOR
   */
  async getEnabledChannels(sensorId: string, tenantId: string): Promise<SensorDataChannel[]> {
    return this.channelRepository.find({
      where: { sensorId, tenantId, isEnabled: true },
      order: { displayOrder: 'ASC', createdAt: 'ASC' },
    });
  }

  /**
   * Get a single channel by ID
   * SECURITY: tenantId in WHERE clause prevents cross-tenant IDOR
   */
  async getChannel(channelId: string, tenantId: string): Promise<SensorDataChannel | null> {
    return this.channelRepository.findOne({
      where: { id: channelId, tenantId },
    });
  }

  /**
   * Save discovered channels from auto-discovery.
   * HIGH-008: Pre-loads all existing channels in one query to eliminate the
   * N+1 pattern (previously 1 SELECT + 1 INSERT/UPDATE per channel).
   */
  async saveDiscoveredChannels(
    sensorId: string,
    tenantId: string,
    discoveredChannels: DiscoveredChannel[],
    replaceExisting = false,
  ): Promise<SensorDataChannel[]> {
    // If replacing, delete via the canonical tenant-scoped method (SENSOR-CRITICAL-002)
    // IMPORTANT: Never use raw channelRepository.delete() — always use deleteChannelsForSensor()
    // to ensure tenantId is included in destructive operations.
    if (replaceExisting) {
      await this.deleteChannelsForSensor(sensorId, tenantId);
    }

    // Pre-load all existing channels for this sensor in a single query (HIGH-008)
    const existingChannels = replaceExisting
      ? []
      : await this.channelRepository.find({ where: { sensorId, tenantId } });
    const existingByKey = new Map<string, SensorDataChannel>(
      existingChannels.map((c) => [c.channelKey, c]),
    );

    const toUpdate: SensorDataChannel[] = [];
    const toInsert: SensorDataChannel[] = [];

    for (let i = 0; i < discoveredChannels.length; i++) {
      const discovered = discoveredChannels[i];
      if (!discovered) continue;

      const existing = existingByKey.get(discovered.channelKey);

      if (existing && !replaceExisting) {
        // Update existing channel with new sample data
        existing.sampleValue = discovered.sampleValue;
        toUpdate.push(existing);
        continue;
      }

      toInsert.push(this.channelRepository.create({
        sensorId,
        tenantId,
        channelKey: discovered.channelKey,
        displayLabel: discovered.suggestedLabel,
        dataType: discovered.inferredDataType,
        unit: discovered.inferredUnit,
        dataPath: discovered.dataPath,
        minValue: discovered.suggestedMin,
        maxValue: discovered.suggestedMax,
        calibrationEnabled: false,
        calibrationMultiplier: 1.0,
        calibrationOffset: 0.0,
        isEnabled: true,
        displayOrder: i,
        discoverySource: DiscoverySource.AUTO,
        discoveredAt: new Date(),
        sampleValue: discovered.sampleValue,
        displaySettings: {
          showOnDashboard: true,
          precision: 2,
        },
      }));
    }

    // Batch save all new and updated channels in two bulk operations
    const savedNew = toInsert.length > 0 ? await this.channelRepository.save(toInsert) : [];
    const savedUpdated = toUpdate.length > 0 ? await this.channelRepository.save(toUpdate) : [];
    const savedChannels = [...savedUpdated, ...savedNew];

    this.logger.log(`Saved ${savedChannels.length} discovered channels for sensor ${sensorId}`);

    return savedChannels;
  }

  /**
   * Reorder channels
   * SECURITY: tenantId in WHERE clause prevents cross-tenant IDOR
   */
  async reorderChannels(
    sensorId: string,
    channelIds: string[],
    tenantId: string,
  ): Promise<SensorDataChannel[]> {
    const channels = await this.channelRepository.find({
      where: { id: In(channelIds), sensorId, tenantId },
    });

    // Verify all requested channels were found (prevents cross-sensor references)
    if (channels.length !== channelIds.length) {
      throw new ConflictException(`Some channel IDs do not belong to sensor ${sensorId}`);
    }

    // Update display order
    for (let i = 0; i < channelIds.length; i++) {
      const channel = channels.find(c => c.id === channelIds[i]);
      if (channel) {
        channel.displayOrder = i;
      }
    }

    const saved = await this.channelRepository.save(channels);
    this.logger.log(`Reordered ${saved.length} channels for sensor ${sensorId}`);

    return saved.sort((a, b) => a.displayOrder - b.displayOrder);
  }

  /**
   * Bulk create channels for a new sensor during registration.
   *
   * @param sensorId  Sensor to attach channels to
   * @param tenantId  Tenant scope for data isolation
   * @param channels  Channel definitions — channelKey must be unique within the array
   * @throws ConflictException if duplicate channelKey values are found in the input
   */
  async createChannelsForSensor(
    sensorId: string,
    tenantId: string,
    channels: CreateChannelInput[],
    manager?: EntityManager,
  ): Promise<SensorDataChannel[]> {
    // ── Duplicate channelKey validation ──
    // Detect duplicates before saving so callers get a clean validation error
    // instead of a raw database unique constraint violation.
    const seenKeys = new Set<string>();
    const duplicates: string[] = [];
    for (const ch of channels) {
      if (!ch?.channelKey) continue;
      if (seenKeys.has(ch.channelKey)) {
        duplicates.push(ch.channelKey);
      }
      seenKeys.add(ch.channelKey);
    }
    if (duplicates.length > 0) {
      throw new ConflictException(
        `Duplicate channelKey values in input: ${[...new Set(duplicates)].join(', ')}`,
      );
    }

    const savedChannels: SensorDataChannel[] = [];

    for (let i = 0; i < channels.length; i++) {
      const input = channels[i];
      if (!input) continue;

      const channel = this.channelRepository.create({
        sensorId,
        tenantId,
        channelKey: input.channelKey,
        displayLabel: input.displayLabel,
        description: input.description,
        dataType: input.dataType || ChannelDataType.NUMBER,
        unit: input.unit,
        dataPath: input.dataPath || input.channelKey,
        minValue: input.minValue,
        maxValue: input.maxValue,
        calibrationEnabled: input.calibrationEnabled || false,
        calibrationMultiplier: input.calibrationMultiplier ?? 1.0,
        calibrationOffset: input.calibrationOffset ?? 0.0,
        alertThresholds: input.alertThresholds,
        displaySettings: input.displaySettings || { showOnDashboard: true, precision: 2 },
        isEnabled: input.isEnabled ?? true,
        displayOrder: input.displayOrder ?? i,
        discoverySource: DiscoverySource.MANUAL,
        sampleValue: input.sampleValue,
      });

      savedChannels.push(channel);
    }

    // When a transactional manager is supplied (SENSOR-LOW-007 registration
    // atomicity), save through it so channel creation joins the caller's
    // transaction — a failure here rolls back the sensor row AND its outbox
    // lifecycle event together, leaving no orphaned SensorRegistrationStarted.
    // The channels carry an explicit tenantId (built above), so the manager save
    // does not bypass tenant scoping.
    const saved = manager
      ? await manager.save(SensorDataChannel, savedChannels)
      : await this.channelRepository.save(savedChannels);
    this.logger.log(`Created ${saved.length} channels for sensor ${sensorId}`);

    return saved;
  }

  /**
   * PERF-RISK-004: Bulk update alert thresholds for multiple channels in a single transaction.
   * Replaces N individual mutations with one atomic operation.
   *
   * @param tenantId  Tenant scope for security isolation
   * @param updates   Array of { channelId, alertThresholds } (max 100)
   * @returns Number of channels successfully updated
   */
  async bulkUpdateChannelThresholds(
    tenantId: string,
    updates: Array<{ channelId: string; alertThresholds?: AlertThresholdConfig }>,
  ): Promise<number> {
    const MAX_BULK_ITEMS = 100;

    if (updates.length === 0) {
      return 0;
    }

    if (updates.length > MAX_BULK_ITEMS) {
      throw new BadRequestException(
        `Bulk update limited to ${MAX_BULK_ITEMS} items, received ${updates.length}`,
      );
    }

    const channelIds = updates.map((u) => u.channelId);

    // Load all channels in a single query, scoped to tenant for security
    const channels = await this.channelRepository.find({
      where: { id: In(channelIds), tenantId },
    });

    if (channels.length !== channelIds.length) {
      const foundIds = new Set(channels.map((c) => c.id));
      const missing = channelIds.filter((id) => !foundIds.has(id));
      throw new NotFoundException(
        `Channels not found or not accessible: ${missing.join(', ')}`,
      );
    }

    // Build a lookup for quick access
    const channelMap = new Map(channels.map((c) => [c.id, c]));

    // Apply updates in a single transaction
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      for (const update of updates) {
        const channel = channelMap.get(update.channelId)!;
        if (update.alertThresholds !== undefined) {
          channel.alertThresholds = update.alertThresholds;
        }
      }

      await queryRunner.manager.save(channels);
      await queryRunner.commitTransaction();

      this.logger.log(
        `Bulk updated thresholds for ${channels.length} channels (tenant: ${tenantId})`,
      );

      return channels.length;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Delete all channels for a sensor
   * SECURITY: tenantId in WHERE clause prevents cross-tenant IDOR
   */
  async deleteChannelsForSensor(sensorId: string, tenantId: string): Promise<void> {
    await this.channelRepository.delete({ sensorId, tenantId });
    this.logger.log(`Deleted all channels for sensor ${sensorId}`);
  }

  /**
   * Get channels by tenant (for cross-sensor queries)
   */
  async getChannelsByTenant(
    tenantId: string,
    channelKey?: string,
  ): Promise<SensorDataChannel[]> {
    const where: FindOptionsWhere<SensorDataChannel> = { tenantId, isEnabled: true };
    if (channelKey) {
      where.channelKey = channelKey;
    }

    return this.channelRepository.find({
      where,
      relations: ['sensor'],
      order: { channelKey: 'ASC', displayOrder: 'ASC' },
    });
  }
}
