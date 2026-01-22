import { Logger } from '@nestjs/common';
import { Resolver, Query, Mutation, Args, ID, Context } from '@nestjs/graphql';
import { Request } from 'express';

import { SensorDataChannel } from '../../database/entities/sensor-data-channel.entity';
import {
  DataChannelType,
  DiscoveryResultType,
  CreateDataChannelInput,
  UpdateDataChannelInput,
  DiscoverChannelsInput,
  SaveDiscoveredChannelsInput,
  ReorderChannelsInput,
} from '../dto/data-channel.dto';
import { ChannelDiscoveryService } from '../services/channel-discovery.service';
import { ChannelManagementService, CreateChannelInput } from '../services/channel-management.service';

interface GqlContext {
  req?: Request & {
    user?: { tenantId?: string };
    headers?: Record<string, string | undefined>;
  };
}

/**
 * GraphQL resolver for data channel operations
 */
@Resolver(() => DataChannelType)
export class ChannelResolver {
  private readonly logger = new Logger(ChannelResolver.name);

  constructor(
    private readonly discoveryService: ChannelDiscoveryService,
    private readonly managementService: ChannelManagementService,
  ) {}

  // === Queries ===

  @Query(() => [DataChannelType], { name: 'allDataChannels' })
  async getAllDataChannels(
    @Context() context: GqlContext,
  ): Promise<SensorDataChannel[]> {
    // Try multiple sources for tenantId:
    // 1. User context (set by middleware)
    // 2. x-tenant-id header (forwarded by gateway)
    // 3. Parse x-user-payload header directly (backup)
    let tenantId = context.req?.user?.tenantId;

    if (!tenantId) {
      tenantId = context.req?.headers?.['x-tenant-id'];
    }

    if (!tenantId && context.req?.headers?.['x-user-payload']) {
      try {
        const payload = JSON.parse(context.req.headers['x-user-payload']) as { tenantId?: string };
        tenantId = payload.tenantId;
      } catch {
        // Ignore parse errors
      }
    }

    if (!tenantId) {
      this.logger.warn('No tenantId found in request context');
      return [];
    }

    return this.managementService.getChannelsByTenant(tenantId);
  }

  @Query(() => [DataChannelType], { name: 'dataChannelsBySensor' })
  async getChannelsBySensor(
    @Args('sensorId', { type: () => ID }) sensorId: string,
  ): Promise<SensorDataChannel[]> {
    return this.managementService.getChannelsBySensor(sensorId);
  }

  @Query(() => [DataChannelType], { name: 'enabledChannelsBySensor' })
  async getEnabledChannels(
    @Args('sensorId', { type: () => ID }) sensorId: string,
  ): Promise<SensorDataChannel[]> {
    return this.managementService.getEnabledChannels(sensorId);
  }

  @Query(() => DataChannelType, { name: 'dataChannel', nullable: true })
  async getChannel(
    @Args('channelId', { type: () => ID }) channelId: string,
  ): Promise<SensorDataChannel | null> {
    return this.managementService.getChannel(channelId);
  }

  // === Mutations ===

  @Mutation(() => DiscoveryResultType, { name: 'discoverDataChannels' })
  async discoverChannels(
    @Args('input') input: DiscoverChannelsInput,
  ): Promise<DiscoveryResultType> {
    const result = await this.discoveryService.discoverChannels(
      input.sampleData,
      (input.payloadFormat as 'json' | 'csv' | 'text' | 'binary') || 'json',
    );

    return {
      success: result.success,
      channels: result.channels.map(ch => ({
        channelKey: ch.channelKey,
        suggestedLabel: ch.suggestedLabel,
        inferredDataType: ch.inferredDataType,
        inferredUnit: ch.inferredUnit,
        sampleValue: ch.sampleValue,
        dataPath: ch.dataPath,
        suggestedMin: ch.suggestedMin,
        suggestedMax: ch.suggestedMax,
      })),
      sampleData: result.sampleData,
      error: result.error,
      rawPayload: result.rawPayload,
    };
  }

  @Mutation(() => DataChannelType, { name: 'createDataChannel' })
  async createChannel(
    @Args('sensorId', { type: () => ID }) sensorId: string,
    @Args('input') input: CreateDataChannelInput,
    @Context() context: GqlContext,
  ): Promise<SensorDataChannel> {
    const tenantId = context.req?.user?.tenantId || 'default';

    const createInput: CreateChannelInput = {
      channelKey: input.channelKey,
      displayLabel: input.displayLabel,
      description: input.description,
      dataType: input.dataType,
      unit: input.unit,
      dataPath: input.dataPath,
      minValue: input.minValue,
      maxValue: input.maxValue,
      calibrationEnabled: input.calibrationEnabled,
      calibrationMultiplier: input.calibrationMultiplier,
      calibrationOffset: input.calibrationOffset,
      alertThresholds: input.alertThresholds,
      displaySettings: input.displaySettings as Record<string, unknown> | undefined,
      isEnabled: input.isEnabled,
      displayOrder: input.displayOrder,
      sampleValue: input.sampleValue,
    };

    return this.managementService.createChannel(sensorId, tenantId, createInput);
  }

  @Mutation(() => DataChannelType, { name: 'updateDataChannel' })
  async updateChannel(
    @Args('input') input: UpdateDataChannelInput,
  ): Promise<SensorDataChannel> {
    return this.managementService.updateChannel(input.channelId, {
      displayLabel: input.displayLabel,
      description: input.description,
      unit: input.unit,
      dataPath: input.dataPath,
      minValue: input.minValue,
      maxValue: input.maxValue,
      calibrationEnabled: input.calibrationEnabled,
      calibrationMultiplier: input.calibrationMultiplier,
      calibrationOffset: input.calibrationOffset,
      alertThresholds: input.alertThresholds,
      displaySettings: input.displaySettings as Record<string, unknown> | undefined,
      isEnabled: input.isEnabled,
      displayOrder: input.displayOrder,
    });
  }

  @Mutation(() => Boolean, { name: 'deleteDataChannel' })
  async deleteChannel(
    @Args('channelId', { type: () => ID }) channelId: string,
  ): Promise<boolean> {
    await this.managementService.deleteChannel(channelId);
    return true;
  }

  @Mutation(() => [DataChannelType], { name: 'saveDiscoveredChannels' })
  async saveDiscoveredChannels(
    @Args('input') input: SaveDiscoveredChannelsInput,
    @Context() context: GqlContext,
  ): Promise<SensorDataChannel[]> {
    const tenantId = context.req?.user?.tenantId || 'default';

    // Convert GraphQL input to service input
    const discoveredChannels = input.channels.map(ch => ({
      channelKey: ch.channelKey,
      suggestedLabel: ch.displayLabel,
      inferredDataType: ch.dataType ?? 'float',
      inferredUnit: ch.unit,
      sampleValue: ch.sampleValue,
      dataPath: ch.dataPath,
      suggestedMin: ch.minValue,
      suggestedMax: ch.maxValue,
    }));

    return this.managementService.saveDiscoveredChannels(
      input.sensorId,
      tenantId,
      discoveredChannels,
      input.replaceExisting,
    );
  }

  @Mutation(() => [DataChannelType], { name: 'reorderDataChannels' })
  async reorderChannels(
    @Args('input') input: ReorderChannelsInput,
  ): Promise<SensorDataChannel[]> {
    return this.managementService.reorderChannels(input.sensorId, input.channelIds);
  }

  @Mutation(() => Boolean, { name: 'deleteAllChannelsForSensor' })
  async deleteAllChannels(
    @Args('sensorId', { type: () => ID }) sensorId: string,
  ): Promise<boolean> {
    await this.managementService.deleteChannelsForSensor(sensorId);
    return true;
  }
}
