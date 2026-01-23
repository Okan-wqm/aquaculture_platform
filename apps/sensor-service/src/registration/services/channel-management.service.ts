import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, FindOptionsWhere } from 'typeorm';

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
    input: UpdateChannelInput,
  ): Promise<SensorDataChannel> {
    const channel = await this.channelRepository.findOne({
      where: { id: channelId },
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
   */
  async deleteChannel(channelId: string): Promise<void> {
    const channel = await this.channelRepository.findOne({
      where: { id: channelId },
    });

    if (!channel) {
      throw new NotFoundException(`Channel with ID '${channelId}' not found`);
    }

    await this.channelRepository.remove(channel);
    this.logger.log(`Deleted channel ${channel.channelKey} (${channelId})`);
  }

  /**
   * Get all channels for a sensor
   */
  async getChannelsBySensor(sensorId: string): Promise<SensorDataChannel[]> {
    return this.channelRepository.find({
      where: { sensorId },
      order: { displayOrder: 'ASC', createdAt: 'ASC' },
    });
  }

  /**
   * Get only enabled channels for a sensor
   */
  async getEnabledChannels(sensorId: string): Promise<SensorDataChannel[]> {
    return this.channelRepository.find({
      where: { sensorId, isEnabled: true },
      order: { displayOrder: 'ASC', createdAt: 'ASC' },
    });
  }

  /**
   * Get a single channel by ID
   */
  async getChannel(channelId: string): Promise<SensorDataChannel | null> {
    return this.channelRepository.findOne({
      where: { id: channelId },
    });
  }

  /**
   * Save discovered channels from auto-discovery
   */
  async saveDiscoveredChannels(
    sensorId: string,
    tenantId: string,
    discoveredChannels: DiscoveredChannel[],
    replaceExisting = false,
  ): Promise<SensorDataChannel[]> {
    // If replacing, delete existing channels
    if (replaceExisting) {
      await this.channelRepository.delete({ sensorId });
    }

    const savedChannels: SensorDataChannel[] = [];

    for (let i = 0; i < discoveredChannels.length; i++) {
      const discovered = discoveredChannels[i];
      if (!discovered) continue;

      // Check if channel already exists
      const existing = await this.channelRepository.findOne({
        where: { sensorId, channelKey: discovered.channelKey },
      });

      if (existing && !replaceExisting) {
        // Update existing channel with new sample data
        existing.sampleValue = discovered.sampleValue;
        const updated = await this.channelRepository.save(existing);
        savedChannels.push(updated);
        continue;
      }

      const channel = this.channelRepository.create({
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
      });

      const saved = await this.channelRepository.save(channel);
      savedChannels.push(saved);
    }

    this.logger.log(`Saved ${savedChannels.length} discovered channels for sensor ${sensorId}`);

    return savedChannels;
  }

  /**
   * Reorder channels
   */
  async reorderChannels(
    sensorId: string,
    channelIds: string[],
  ): Promise<SensorDataChannel[]> {
    const channels = await this.channelRepository.find({
      where: { id: In(channelIds) },
    });

    // Validate all channels belong to the sensor
    for (const channel of channels) {
      if (channel.sensorId !== sensorId) {
        throw new ConflictException(`Channel ${channel.id} does not belong to sensor ${sensorId}`);
      }
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
   * Bulk create channels for a new sensor during registration
   */
  async createChannelsForSensor(
    sensorId: string,
    tenantId: string,
    channels: CreateChannelInput[],
  ): Promise<SensorDataChannel[]> {
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

    const saved = await this.channelRepository.save(savedChannels);
    this.logger.log(`Created ${saved.length} channels for sensor ${sensorId}`);

    return saved;
  }

  /**
   * Delete all channels for a sensor
   */
  async deleteChannelsForSensor(sensorId: string): Promise<void> {
    await this.channelRepository.delete({ sensorId });
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
