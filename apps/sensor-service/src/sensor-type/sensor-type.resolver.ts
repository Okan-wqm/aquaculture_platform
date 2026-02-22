import { Logger } from '@nestjs/common';
import {
  Resolver,
  Query,
  Mutation,
  Args,
  ID,
} from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import { Tenant, Roles, Role } from '@platform/backend-common';

import { ChannelDetectionLog } from '../database/entities/channel-detection-log.entity';
import { SensorDataChannel } from '../database/entities/sensor-data-channel.entity';
import { IndustryTemplate } from '../database/entities/industry-template.entity';
import { SensorTypeDefinition } from '../database/entities/sensor-type-definition.entity';

import { ChannelDetectionService } from './channel-detection.service';
import { CreateSensorTypeInput } from './dto/create-sensor-type.dto';
import { UpdateSensorTypeInput } from './dto/update-sensor-type.dto';
import { SensorTypeService } from './sensor-type.service';

/**
 * SensorType Resolver
 * GraphQL resolver for sensor type definitions and industry templates
 */
@Resolver(() => SensorTypeDefinition)
export class SensorTypeResolver {
  private readonly logger = new Logger(SensorTypeResolver.name);

  constructor(
    private readonly sensorTypeService: SensorTypeService,
    private readonly channelDetectionService: ChannelDetectionService,
  ) {}

  /**
   * List sensor types for the current tenant (includes system types)
   */
  @Query(() => [SensorTypeDefinition], { name: 'sensorTypes' })
  async getSensorTypes(
    @Tenant() tenantId: string,
  ): Promise<SensorTypeDefinition[]> {
    return this.sensorTypeService.getSensorTypes(tenantId);
  }

  /**
   * List all active industry templates
   */
  @Query(() => [IndustryTemplate], { name: 'industryTemplates' })
  async getIndustryTemplates(): Promise<IndustryTemplate[]> {
    return this.sensorTypeService.getTemplates();
  }

  /**
   * Create a custom sensor type
   */
  @Mutation(() => SensorTypeDefinition, { name: 'createSensorType' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async createSensorType(
    @Args('input') input: CreateSensorTypeInput,
    @Tenant() tenantId: string,
  ): Promise<SensorTypeDefinition> {
    this.logger.log(`Creating sensor type "${input.typeKey}"`);
    return this.sensorTypeService.createSensorType(tenantId, input);
  }

  /**
   * Update a sensor type
   */
  @Mutation(() => SensorTypeDefinition, { name: 'updateSensorType' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async updateSensorType(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateSensorTypeInput,
    @Tenant() tenantId: string,
  ): Promise<SensorTypeDefinition> {
    return this.sensorTypeService.updateSensorType(tenantId, id, input);
  }

  /**
   * Delete a sensor type
   */
  @Mutation(() => Boolean, { name: 'deleteSensorType' })
  @Roles(Role.TENANT_ADMIN)
  async deleteSensorType(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    return this.sensorTypeService.deleteSensorType(tenantId, id);
  }

  /**
   * Apply an industry template for the current tenant
   */
  @Mutation(() => [SensorTypeDefinition], { name: 'applyIndustryTemplate' })
  @Roles(Role.TENANT_ADMIN)
  async applyIndustryTemplate(
    @Args('templateKey') templateKey: string,
    @Tenant() tenantId: string,
  ): Promise<SensorTypeDefinition[]> {
    this.logger.log(`Applying template "${templateKey}"`);
    return this.sensorTypeService.applyTemplate(tenantId, templateKey);
  }

  // === Channel Detection ===

  /**
   * Detect sensor channels from raw data samples using AI analysis
   */
  @Mutation(() => ChannelDetectionLog, { name: 'detectSensorChannels' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async detectSensorChannels(
    @Args('sensorId', { type: () => ID }) sensorId: string,
    @Args('samples', { type: () => GraphQLJSON }) samples: unknown[],
    @Tenant() tenantId: string,
  ): Promise<ChannelDetectionLog> {
    this.logger.log(`Detecting channels for sensor ${sensorId}`);
    return this.channelDetectionService.detectChannels(sensorId, tenantId, samples);
  }

  /**
   * Approve a channel detection proposal, optionally with modifications
   */
  @Mutation(() => [SensorDataChannel], { name: 'approveChannelProposal' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async approveChannelProposal(
    @Args('proposalId', { type: () => ID }) proposalId: string,
    @Args('modifications', { type: () => GraphQLJSON, nullable: true }) modifications: unknown,
    @Tenant() tenantId: string,
  ): Promise<SensorDataChannel[]> {
    this.logger.log(`Approving channel proposal ${proposalId}`);
    return this.channelDetectionService.approveProposal(
      proposalId,
      tenantId,
      modifications as any[] | undefined,
    );
  }

  /**
   * Reject a channel detection proposal
   */
  @Mutation(() => Boolean, { name: 'rejectChannelProposal' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async rejectChannelProposal(
    @Args('proposalId', { type: () => ID }) proposalId: string,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    this.logger.log(`Rejecting channel proposal ${proposalId}`);
    return this.channelDetectionService.rejectProposal(proposalId, tenantId);
  }

  /**
   * Get pending (unapproved) channel detection proposals for a sensor
   */
  @Query(() => [ChannelDetectionLog], { name: 'pendingChannelProposals' })
  async pendingChannelProposals(
    @Args('sensorId', { type: () => ID }) sensorId: string,
    @Tenant() tenantId: string,
  ): Promise<ChannelDetectionLog[]> {
    return this.channelDetectionService.getPendingProposals(sensorId, tenantId);
  }
}
