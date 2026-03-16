import { InputType, Field, ObjectType, ID } from '@nestjs/graphql';
import {
  Resolver,
  Query,
  Mutation,
  Args,
  ResolveField,
  Parent,
} from '@nestjs/graphql';
import { Logger } from '@nestjs/common';
import { IsOptional, IsString, IsUUID, IsEnum, MaxLength } from 'class-validator';
import { Tenant, Roles, Role } from '@platform/backend-common';
import { GraphQLJSON } from 'graphql-scalars';

import { DeviceGroup, DeviceGroupType } from '../entities/device-group.entity';
import { DeviceGroupMember, DeviceMemberType } from '../entities/device-group-member.entity';
import { DeviceGroupService, BatchUpdateSensorsInput } from '../services/device-group.service';
import { SensorStatus } from '../../database/entities/sensor.entity';

// ==================== Input DTOs ====================

/**
 * Input for adding a single member to a group
 */
@InputType()
export class AddMemberInputType {
  @Field(() => DeviceMemberType)
  @IsEnum(DeviceMemberType)
  deviceType!: DeviceMemberType;

  @Field()
  @IsUUID()
  deviceId!: string;
}

/**
 * Input for creating a device group
 */
@InputType()
export class CreateDeviceGroupInput {
  @Field()
  @IsString()
  @MaxLength(100)
  name!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field(() => DeviceGroupType, { nullable: true })
  @IsOptional()
  @IsEnum(DeviceGroupType)
  type?: DeviceGroupType;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  parentGroupId?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  metadata?: Record<string, unknown>;
}

/**
 * Input for updating a device group
 */
@InputType()
export class UpdateDeviceGroupInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field(() => DeviceGroupType, { nullable: true })
  @IsOptional()
  @IsEnum(DeviceGroupType)
  type?: DeviceGroupType;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  parentGroupId?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  metadata?: Record<string, unknown>;
}

/**
 * Input for batch-updating sensor fields
 */
@InputType()
export class BatchUpdateSensorsInputType {
  @Field({ nullable: true })
  @IsOptional()
  @IsUUID()
  siteId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID()
  systemId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID()
  equipmentId?: string;

  @Field(() => SensorStatus, { nullable: true })
  @IsOptional()
  @IsEnum(SensorStatus)
  status?: SensorStatus;

  @Field({ nullable: true })
  @IsOptional()
  isActive?: boolean;
}

// ==================== Resolver ====================

/**
 * Device Group Resolver
 * GraphQL resolver for device group management and batch operations
 */
@Resolver(() => DeviceGroup)
export class DeviceGroupResolver {
  private readonly logger = new Logger(DeviceGroupResolver.name);

  constructor(private readonly deviceGroupService: DeviceGroupService) {}

  // ==================== Queries ====================

  /**
   * List all device groups for the tenant
   */
  @Query(() => [DeviceGroup], { name: 'deviceGroups' })
  async listDeviceGroups(
    @Tenant() tenantId: string,
  ): Promise<DeviceGroup[]> {
    return await this.deviceGroupService.findAll(tenantId);
  }

  /**
   * Get a single device group by ID
   */
  @Query(() => DeviceGroup, { name: 'deviceGroup', nullable: true })
  async getDeviceGroup(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<DeviceGroup> {
    return await this.deviceGroupService.findOne(id, tenantId);
  }

  // ==================== Mutations ====================

  /**
   * Create a new device group
   */
  @Mutation(() => DeviceGroup, { name: 'createDeviceGroup' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async createDeviceGroup(
    @Args('input') input: CreateDeviceGroupInput,
    @Tenant() tenantId: string,
  ): Promise<DeviceGroup> {
    this.logger.log(`Creating device group "${input.name}" for tenant ${tenantId}`);
    return await this.deviceGroupService.create(tenantId, input);
  }

  /**
   * Update an existing device group
   */
  @Mutation(() => DeviceGroup, { name: 'updateDeviceGroup' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async updateDeviceGroup(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateDeviceGroupInput,
    @Tenant() tenantId: string,
  ): Promise<DeviceGroup> {
    this.logger.log(`Updating device group ${id}`);
    return await this.deviceGroupService.update(id, tenantId, input);
  }

  /**
   * Delete a device group
   */
  @Mutation(() => Boolean, { name: 'deleteDeviceGroup' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async deleteDeviceGroup(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    this.logger.log(`Deleting device group ${id}`);
    return await this.deviceGroupService.delete(id, tenantId);
  }

  /**
   * Add devices to a group in bulk
   */
  @Mutation(() => [DeviceGroupMember], { name: 'addDevicesToGroup' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async addDevicesToGroup(
    @Args('groupId', { type: () => ID }) groupId: string,
    @Args('members', { type: () => [AddMemberInputType] }) members: AddMemberInputType[],
    @Tenant() tenantId: string,
  ): Promise<DeviceGroupMember[]> {
    this.logger.log(`Adding ${members.length} devices to group ${groupId}`);
    return await this.deviceGroupService.addMembers(groupId, tenantId, members);
  }

  /**
   * Remove devices from a group by member IDs
   */
  @Mutation(() => Boolean, { name: 'removeDevicesFromGroup' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async removeDevicesFromGroup(
    @Args('groupId', { type: () => ID }) groupId: string,
    @Args('memberIds', { type: () => [ID] }) memberIds: string[],
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    this.logger.log(`Removing ${memberIds.length} members from group ${groupId}`);
    return await this.deviceGroupService.removeMembers(groupId, tenantId, memberIds);
  }

  /**
   * Batch update sensor fields for multiple sensors
   */
  @Mutation(() => Boolean, { name: 'batchUpdateSensors' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async batchUpdateSensors(
    @Args('sensorIds', { type: () => [ID] }) sensorIds: string[],
    @Args('input') input: BatchUpdateSensorsInputType,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    this.logger.log(`Batch updating ${sensorIds.length} sensors for tenant ${tenantId}`);
    const serviceInput: BatchUpdateSensorsInput = {
      siteId: input.siteId,
      departmentId: input.departmentId,
      systemId: input.systemId,
      equipmentId: input.equipmentId,
      status: input.status,
      isActive: input.isActive,
    };
    return await this.deviceGroupService.batchUpdateSensors(tenantId, sensorIds, serviceInput);
  }

  /**
   * Batch activate sensors
   */
  @Mutation(() => Boolean, { name: 'batchActivateSensors' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async batchActivateSensors(
    @Args('sensorIds', { type: () => [ID] }) sensorIds: string[],
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    this.logger.log(`Batch activating ${sensorIds.length} sensors for tenant ${tenantId}`);
    return await this.deviceGroupService.batchActivateDevices(tenantId, sensorIds);
  }

  /**
   * Batch deactivate sensors
   */
  @Mutation(() => Boolean, { name: 'batchDeactivateSensors' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async batchDeactivateSensors(
    @Args('sensorIds', { type: () => [ID] }) sensorIds: string[],
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    this.logger.log(`Batch deactivating ${sensorIds.length} sensors for tenant ${tenantId}`);
    return await this.deviceGroupService.batchDeactivateDevices(tenantId, sensorIds);
  }

  // ==================== Field Resolvers ====================

  /**
   * Lazily load members for a device group
   */
  @ResolveField(() => [DeviceGroupMember], { name: 'members', nullable: true })
  async resolveMembers(
    @Parent() group: DeviceGroup,
  ): Promise<DeviceGroupMember[]> {
    return await this.deviceGroupService.getMembersForGroup(group.id);
  }
}
