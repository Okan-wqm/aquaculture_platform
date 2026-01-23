import { Logger } from '@nestjs/common';
import { Resolver, Query, Mutation, Args, ID, ObjectType, Field, Int } from '@nestjs/graphql';
import { Tenant, CurrentUser } from '@platform/backend-common';
import { GraphQLJSON } from 'graphql-scalars';

import { Sensor } from '../../database/entities/sensor.entity';
import {
  RegisterSensorInput,
  UpdateSensorProtocolInput,
  UpdateSensorInfoInput,
  SensorFilterInput,
  PaginationInput,
  RegisteredSensorType,
  SensorRegistrationResultType,
  ConnectionTestResultType,
  SensorListType,
  RegisterParentWithChildrenInput,
  ParentWithChildrenResultType,
  ParentDeviceType,
  ChildSensorType,
} from '../dto/register-sensor.dto';
import { SensorRegistrationService } from '../services/sensor-registration.service';

/**
 * User context interface from JWT
 */
interface UserContext {
  sub: string;
  email: string;
  tenantId: string;
  roles: string[];
}

// Stats type
@ObjectType()
class SensorStatsType {
  @Field(() => Int) total: number;
  @Field(() => Int) active: number;
  @Field(() => Int) inactive: number;
  @Field(() => Int) testing: number;
  @Field(() => Int) failed: number;
  @Field(() => GraphQLJSON) byType: object;
  @Field(() => GraphQLJSON) byProtocol: object;
}

@Resolver()
export class RegistrationResolver {
  private readonly logger = new Logger(RegistrationResolver.name);

  constructor(private registrationService: SensorRegistrationService) {}

  // Queries
  @Query(() => RegisteredSensorType, { name: 'sensor', nullable: true })
  async getSensor(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<RegisteredSensorType | null> {
    this.logger.debug(`Getting sensor ${id} for tenant ${tenantId}`);
    const sensor = await this.registrationService.getSensor(id, tenantId);
    if (!sensor) return null;
    return this.mapSensorToType(sensor);
  }

  @Query(() => SensorListType, { name: 'sensors' })
  async listSensors(
    @Args('filter', { nullable: true }) filter?: SensorFilterInput,
    @Args('pagination', { nullable: true }) pagination?: PaginationInput,
    @Tenant() tenantId?: string,
  ): Promise<SensorListType> {
    const effectiveTenantId = tenantId || 'default-tenant';
    this.logger.debug(`Listing sensors for tenant ${effectiveTenantId}`);
    const result = await this.registrationService.listSensors(effectiveTenantId, filter, pagination);
    return {
      items: result.items.map((s) => this.mapSensorToType(s)),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      totalPages: result.totalPages,
    };
  }

  @Query(() => [RegisteredSensorType], { name: 'sensorsByProtocol' })
  async getSensorsByProtocol(
    @Args('protocolCode') protocolCode: string,
    @Tenant() tenantId: string,
  ): Promise<RegisteredSensorType[]> {
    this.logger.debug(`Getting sensors by protocol ${protocolCode} for tenant ${tenantId}`);
    const sensors = await this.registrationService.getSensorsByProtocol(protocolCode, tenantId);
    return sensors.map((s) => this.mapSensorToType(s));
  }

  @Query(() => SensorStatsType, { name: 'sensorStats' })
  async getSensorStats(
    @Tenant() tenantId: string,
  ): Promise<SensorStatsType> {
    this.logger.debug(`Getting sensor stats for tenant ${tenantId}`);
    return this.registrationService.getSensorStats(tenantId);
  }

  // Mutations
  @Mutation(() => SensorRegistrationResultType, { name: 'registerSensor' })
  async registerSensor(
    @Args('input') input: RegisterSensorInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<SensorRegistrationResultType> {
    const effectiveTenantId = tenantId || user?.tenantId || 'default-tenant';
    const userId = user?.sub || 'default-user';
    this.logger.log(`Registering sensor ${input.name} for tenant ${effectiveTenantId}`);

    const result = await this.registrationService.registerSensor(input, effectiveTenantId, userId);
    return {
      success: result.success,
      sensor: result.sensor ? this.mapSensorToType(result.sensor) : undefined,
      error: result.error,
      connectionTestPassed: result.connectionTestPassed,
      latencyMs: result.latencyMs,
    };
  }

  @Mutation(() => ConnectionTestResultType, { name: 'testSensorConnection' })
  async testSensorConnection(
    @Args('sensorId', { type: () => ID }) sensorId: string,
    @Tenant() tenantId: string,
  ): Promise<ConnectionTestResultType> {
    this.logger.debug(`Testing connection for sensor ${sensorId}`);
    const result = await this.registrationService.testSensorConnection(sensorId, tenantId);
    return {
      success: result.success,
      latencyMs: result.latencyMs,
      error: result.error,
      sampleData: result.sampleData,
      testedAt: result.testedAt,
    };
  }

  @Mutation(() => RegisteredSensorType, { name: 'activateSensor' })
  async activateSensor(
    @Args('sensorId', { type: () => ID }) sensorId: string,
    @Tenant() tenantId: string,
  ): Promise<RegisteredSensorType> {
    this.logger.log(`Activating sensor ${sensorId}`);
    const sensor = await this.registrationService.activateSensor(sensorId, tenantId);
    return this.mapSensorToType(sensor);
  }

  @Mutation(() => RegisteredSensorType, { name: 'suspendSensor' })
  async suspendSensor(
    @Args('sensorId', { type: () => ID }) sensorId: string,
    @Args('reason', { nullable: true }) reason?: string,
    @Tenant() tenantId?: string,
  ): Promise<RegisteredSensorType> {
    this.logger.log(`Suspending sensor ${sensorId}`);
    const effectiveTenantId = tenantId || 'default-tenant';
    const sensor = await this.registrationService.suspendSensor(sensorId, effectiveTenantId, reason);
    return this.mapSensorToType(sensor);
  }

  @Mutation(() => RegisteredSensorType, { name: 'reactivateSensor' })
  async reactivateSensor(
    @Args('sensorId', { type: () => ID }) sensorId: string,
    @Tenant() tenantId: string,
  ): Promise<RegisteredSensorType> {
    this.logger.log(`Reactivating sensor ${sensorId}`);
    const sensor = await this.registrationService.reactivateSensor(sensorId, tenantId);
    return this.mapSensorToType(sensor);
  }

  @Mutation(() => SensorRegistrationResultType, { name: 'updateSensorProtocol' })
  async updateSensorProtocol(
    @Args('input') input: UpdateSensorProtocolInput,
    @Tenant() tenantId: string,
  ): Promise<SensorRegistrationResultType> {
    this.logger.log(`Updating protocol for sensor ${input.sensorId}`);
    const result = await this.registrationService.updateProtocolConfig(input, tenantId);
    return {
      success: result.success,
      sensor: result.sensor ? this.mapSensorToType(result.sensor) : undefined,
      error: result.error,
    };
  }

  @Mutation(() => RegisteredSensorType, { name: 'updateSensorInfo' })
  async updateSensorInfo(
    @Args('input') input: UpdateSensorInfoInput,
    @Tenant() tenantId: string,
  ): Promise<RegisteredSensorType> {
    this.logger.log(`Updating info for sensor ${input.sensorId}`);
    const sensor = await this.registrationService.updateSensorInfo(input, tenantId);
    return this.mapSensorToType(sensor);
  }

  @Mutation(() => Boolean, { name: 'deleteSensor' })
  async deleteSensor(
    @Args('sensorId', { type: () => ID }) sensorId: string,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    this.logger.log(`Deleting sensor ${sensorId}`);
    return this.registrationService.deleteSensor(sensorId, tenantId);
  }

  // Helper to map entity to GraphQL type
  private mapSensorToType(sensor: Sensor): RegisteredSensorType {
    return {
      id: sensor.id,
      name: sensor.name,
      type: sensor.type,
      protocolCode: sensor.protocol?.code || '',
      protocolConfiguration: sensor.protocolConfiguration || {},
      connectionStatus: sensor.connectionStatus,
      registrationStatus: sensor.registrationStatus,
      manufacturer: sensor.manufacturer,
      model: sensor.model,
      serialNumber: sensor.serialNumber,
      description: sensor.description,
      farmId: sensor.farmId,
      pondId: sensor.pondId,
      tankId: sensor.tankId,
      location: sensor.location,
      metadata: sensor.metadata,
      tenantId: sensor.tenantId,
      createdAt: sensor.createdAt,
      updatedAt: sensor.updatedAt,
    };
  }

  // ==================== Parent-Child Registration ====================

  @Mutation(() => ParentWithChildrenResultType, { name: 'registerParentWithChildren' })
  async registerParentWithChildren(
    @Args('input') input: RegisterParentWithChildrenInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<ParentWithChildrenResultType> {
    const effectiveTenantId = tenantId || user?.tenantId || 'default-tenant';
    const userId = user?.sub || 'default-user';
    this.logger.log(`Registering parent with children for tenant ${effectiveTenantId}`);

    const result = await this.registrationService.registerParentWithChildren(input, effectiveTenantId, userId);
    return {
      success: result.success,
      parent: result.parent ? this.mapToParentDeviceType(result.parent) : undefined,
      children: result.children ? result.children.map(c => this.mapToChildSensorType(c)) : undefined,
      error: result.error,
      connectionTestPassed: result.connectionTestPassed,
      latencyMs: result.latencyMs,
    };
  }

  @Query(() => ParentDeviceType, { name: 'parentDevice', nullable: true })
  async getParentDevice(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<ParentDeviceType | null> {
    this.logger.debug(`Getting parent device ${id}`);
    const parent = await this.registrationService.getParentWithChildren(id, tenantId);
    if (!parent) return null;
    return this.mapToParentDeviceType(parent);
  }

  @Query(() => [ChildSensorType], { name: 'childSensors' })
  async getChildSensors(
    @Args('parentId', { type: () => ID }) parentId: string,
    @Tenant() tenantId: string,
  ): Promise<ChildSensorType[]> {
    this.logger.debug(`Getting child sensors for parent ${parentId}`);
    const children = await this.registrationService.getChildSensors(parentId, tenantId);
    return children.map(c => this.mapToChildSensorType(c));
  }

  @Query(() => SensorListType, { name: 'parentDevices' })
  async listParentDevices(
    @Args('filter', { nullable: true }) filter?: SensorFilterInput,
    @Args('pagination', { nullable: true }) pagination?: PaginationInput,
    @Tenant() tenantId?: string,
  ): Promise<SensorListType> {
    const effectiveTenantId = tenantId || 'default-tenant';
    this.logger.debug(`Listing parent devices for tenant ${effectiveTenantId}`);
    const result = await this.registrationService.listParentDevices(effectiveTenantId, filter, pagination);
    return {
      items: result.items.map((s) => this.mapSensorToType(s)),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      totalPages: result.totalPages,
    };
  }

  @Mutation(() => ConnectionTestResultType, { name: 'testParentConnection' })
  async testParentConnection(
    @Args('parentId', { type: () => ID }) parentId: string,
    @Tenant() tenantId: string,
  ): Promise<ConnectionTestResultType> {
    this.logger.debug(`Testing parent connection ${parentId}`);
    const result = await this.registrationService.testParentConnection(parentId, tenantId);
    return {
      success: result.success,
      latencyMs: result.latencyMs,
      error: result.error,
      sampleData: result.sampleData,
      testedAt: result.testedAt,
    };
  }

  @Mutation(() => Boolean, { name: 'deleteParentWithChildren' })
  async deleteParentWithChildren(
    @Args('parentId', { type: () => ID }) parentId: string,
    @Tenant() tenantId: string,
  ): Promise<boolean> {
    this.logger.log(`Deleting parent with children ${parentId}`);
    return this.registrationService.deleteParentWithChildren(parentId, tenantId);
  }

  // Helper to map parent entity to GraphQL type
  private mapToParentDeviceType(sensor: Sensor): ParentDeviceType {
    return {
      id: sensor.id,
      name: sensor.name,
      protocolCode: sensor.protocol?.code || '',
      protocolConfiguration: sensor.protocolConfiguration || {},
      connectionStatus: sensor.connectionStatus,
      registrationStatus: sensor.registrationStatus,
      manufacturer: sensor.manufacturer,
      model: sensor.model,
      serialNumber: sensor.serialNumber,
      description: sensor.description,
      farmId: sensor.farmId,
      pondId: sensor.pondId,
      tankId: sensor.tankId,
      location: sensor.location,
      childSensors: sensor.childSensors?.map((c: Sensor) => this.mapToChildSensorType(c)),
      tenantId: sensor.tenantId,
      createdAt: sensor.createdAt,
      updatedAt: sensor.updatedAt,
    };
  }

  // Helper to map child entity to GraphQL type
  private mapToChildSensorType(sensor: Sensor): ChildSensorType {
    return {
      id: sensor.id,
      name: sensor.name,
      type: sensor.type,
      dataPath: sensor.dataPath,
      unit: sensor.unit,
      minValue: sensor.minValue,
      maxValue: sensor.maxValue,
      calibrationEnabled: sensor.calibrationEnabled,
      calibrationMultiplier: sensor.calibrationMultiplier,
      calibrationOffset: sensor.calibrationOffset,
      alertThresholds: sensor.alertThresholds,
      displaySettings: sensor.displaySettings,
      registrationStatus: sensor.registrationStatus,
      tenantId: sensor.tenantId,
      createdAt: sensor.createdAt,
    };
  }
}
