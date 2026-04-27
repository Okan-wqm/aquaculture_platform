import { Resolver, Query, Mutation, Args, ID, Context } from '@nestjs/graphql';
import { UseGuards, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Roles, Role, CurrentTenant, CurrentUser, CurrentUserPayload } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';
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
   * Delete a configuration.
   *
   * PLAT-HIGH-011: MODULE_MANAGER or higher can delete any config within tenant.
   * MODULE_USER can only delete configs they created. This prevents a regular
   * module user from destroying administrator-created configurations.
   */
  @Mutation(() => Boolean, { name: 'deleteHydroponicsConfiguration', description: 'Delete a hydroponics configuration' })
  @Roles(Role.MODULE_USER)
  async deleteHydroponicsConfiguration(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<boolean> {
    this.logger.log(`Deleting configuration: ${id}`);

    const config = await this.configRepository.findOne({
      where: { id, tenantId },
    });

    if (!config) {
      throw new NotFoundException(`Configuration with id "${id}" not found`);
    }

    // PLAT-HIGH-011: Ownership check for MODULE_USER role.
    // MODULE_MANAGER and above (TENANT_ADMIN, SUPER_ADMIN) can delete any config.
    // MODULE_USER can only delete configs where createdBy matches their user ID.
    const userRoles = user.roles || [];
    const isManager = userRoles.some(
      (r) => r === Role.MODULE_MANAGER || r === Role.TENANT_ADMIN || r === Role.SUPER_ADMIN,
    );

    if (!isManager && config.settings?.['createdBy'] !== user.sub) {
      throw new ForbiddenException(
        'MODULE_USER can only delete configurations they created. ' +
        'Contact a MODULE_MANAGER or TENANT_ADMIN to delete this configuration.',
      );
    }

    const result = await this.configRepository.delete({ id, tenantId });
    return (result.affected ?? 0) > 0;
  }
}
