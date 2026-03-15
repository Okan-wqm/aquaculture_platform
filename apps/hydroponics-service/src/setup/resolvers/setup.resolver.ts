import { Resolver, Query, Mutation, Args, ID, Context } from '@nestjs/graphql';
import { UseGuards, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Roles, Role, TenantGuard, CurrentTenant } from '@platform/backend-common';
import { HydroponicsStatusResponse } from '../dto/hydroponics-status.response';
import { HydroponicsConfig } from '../entities/hydroponics-config.entity';
import { CreateHydroponicsConfigInput } from '../dto/create-hydroponics-config.input';
import { UpdateHydroponicsConfigInput } from '../dto/update-hydroponics-config.input';

@Resolver(() => HydroponicsConfig)
@UseGuards(TenantGuard)
export class SetupResolver {
  private readonly logger = new Logger(SetupResolver.name);

  constructor(
    @InjectRepository(HydroponicsConfig)
    private readonly configRepository: Repository<HydroponicsConfig>,
  ) {}

  // -------------------------------------------------------------------------
  // QUERIES
  // -------------------------------------------------------------------------

  @Query(() => HydroponicsStatusResponse, { description: 'Get hydroponics module status' })
  @Roles(Role.MODULE_USER)
  async hydroponicsStatus(
    @Context() context: { req: { user?: { tenantId?: string } } },
  ): Promise<HydroponicsStatusResponse> {
    const tenantId = context.req?.user?.tenantId;
    let configured = false;

    if (tenantId) {
      const count = await this.configRepository.count({ where: { tenantId } });
      configured = count > 0;
    }

    return {
      configured,
      moduleName: 'Hydroponics Management',
    };
  }

  /**
   * List configurations with optional configName filter
   */
  @Query(() => [HydroponicsConfig], { name: 'hydroponicsConfigurations', description: 'List hydroponics configurations' })
  @Roles(Role.MODULE_USER)
  async listConfigurations(
    @CurrentTenant() tenantId: string,
    @Args('type', { type: () => String, nullable: true }) type?: string,
  ): Promise<HydroponicsConfig[]> {
    this.logger.debug(`Listing configurations for tenant: ${tenantId}, type: ${type ?? 'all'}`);

    const where: Record<string, unknown> = { tenantId };
    if (type) {
      where.configName = type;
    }

    return this.configRepository.find({
      where,
      order: { updatedAt: 'DESC' },
    });
  }

  /**
   * Get a single configuration by ID
   */
  @Query(() => HydroponicsConfig, { name: 'hydroponicsConfiguration', description: 'Get a hydroponics configuration by ID' })
  @Roles(Role.MODULE_USER)
  async getConfiguration(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<HydroponicsConfig> {
    this.logger.debug(`Getting configuration: ${id}`);

    const config = await this.configRepository.findOne({
      where: { id, tenantId },
    });

    if (!config) {
      throw new NotFoundException(`Configuration with id "${id}" not found`);
    }

    return config;
  }

  // -------------------------------------------------------------------------
  // MUTATIONS
  // -------------------------------------------------------------------------

  /**
   * Create a new configuration
   */
  @Mutation(() => HydroponicsConfig, { name: 'createHydroponicsConfiguration', description: 'Create a hydroponics configuration' })
  @Roles(Role.MODULE_USER)
  async createHydroponicsConfiguration(
    @Args('input') input: CreateHydroponicsConfigInput,
    @CurrentTenant() tenantId: string,
  ): Promise<HydroponicsConfig> {
    this.logger.log(`Creating configuration for tenant: ${tenantId}, name: ${input.configName ?? 'Default'}`);

    const config = this.configRepository.create({
      tenantId,
      configName: input.configName ?? 'Default',
      settings: input.settings ?? {},
    });

    return this.configRepository.save(config);
  }

  /**
   * Update an existing configuration
   */
  @Mutation(() => HydroponicsConfig, { name: 'updateHydroponicsConfiguration', description: 'Update a hydroponics configuration' })
  @Roles(Role.MODULE_USER)
  async updateHydroponicsConfiguration(
    @Args('input') input: UpdateHydroponicsConfigInput,
    @CurrentTenant() tenantId: string,
  ): Promise<HydroponicsConfig> {
    this.logger.log(`Updating configuration: ${input.id}`);

    const config = await this.configRepository.findOne({
      where: { id: input.id, tenantId },
    });

    if (!config) {
      throw new NotFoundException(`Configuration with id "${input.id}" not found`);
    }

    if (input.configName !== undefined) {
      config.configName = input.configName;
    }
    if (input.settings !== undefined) {
      config.settings = input.settings;
    }

    return this.configRepository.save(config);
  }

  /**
   * Delete a configuration
   */
  @Mutation(() => Boolean, { name: 'deleteHydroponicsConfiguration', description: 'Delete a hydroponics configuration' })
  @Roles(Role.MODULE_USER)
  async deleteHydroponicsConfiguration(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<boolean> {
    this.logger.log(`Deleting configuration: ${id}`);

    const result = await this.configRepository.delete({ id, tenantId });
    return (result.affected ?? 0) > 0;
  }
}
