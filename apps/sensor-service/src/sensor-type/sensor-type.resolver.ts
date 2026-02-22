import { Logger } from '@nestjs/common';
import {
  Resolver,
  Query,
  Mutation,
  Args,
  ID,
} from '@nestjs/graphql';
import { Tenant, Roles, Role } from '@platform/backend-common';

import { IndustryTemplate } from '../database/entities/industry-template.entity';
import { SensorTypeDefinition } from '../database/entities/sensor-type-definition.entity';

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
}
