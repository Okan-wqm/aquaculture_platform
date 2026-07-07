/**
 * WaterQualityParameterConfig GraphQL Resolver
 *
 * Parametre konfigurasyonu CRUD ve template islemleri icin GraphQL API.
 * CQRS pattern ile CommandBus/QueryBus uzerinden calisir.
 *
 * @module WaterQuality
 */
import { Resolver, Query, Mutation, Args, ID, Int, ObjectType, Field } from '@nestjs/graphql';
import { UseGuards, Logger } from '@nestjs/common';
import { CommandBus, QueryBus } from '@platform/cqrs';
import { CurrentTenant, CurrentUser, Roles, Role } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';
import { WaterQualityParameterConfig } from './entities/water-quality-parameter-config.entity';
import { WaterQualityParamEquipment } from './entities/water-quality-param-equipment.entity';

// DTOs
import { CreateParameterConfigInput } from './dto/create-parameter-config.input';
import { UpdateParameterConfigInput } from './dto/update-parameter-config.input';
import { ParameterConfigFilterInput } from './dto/parameter-config-filter.input';
import { ApplyParameterTemplateInput } from './dto/apply-parameter-template.input';
import { ReorderParameterConfigsInput } from './dto/reorder-parameter-configs.input';
import { CreateParamEquipmentInput } from './dto/create-param-equipment.input';
import { UpdateParamEquipmentInput } from './dto/update-param-equipment.input';
import { BulkMapParamsEquipmentInput } from './dto/bulk-map-params-equipment.input';

// Commands
import { CreateParameterConfigCommand } from './commands/create-parameter-config.command';
import { UpdateParameterConfigCommand } from './commands/update-parameter-config.command';
import { DeleteParameterConfigCommand } from './commands/delete-parameter-config.command';
import { BulkCreateFromTemplateCommand } from './commands/bulk-create-from-template.command';
import { ReorderParameterConfigsCommand } from './commands/reorder-parameter-configs.command';
import { CreateParamEquipmentCommand } from './commands/create-param-equipment.command';
import { UpdateParamEquipmentCommand } from './commands/update-param-equipment.command';
import { DeleteParamEquipmentCommand } from './commands/delete-param-equipment.command';
import { BulkMapParamsEquipmentCommand } from './commands/bulk-map-params-equipment.command';

// Queries
import { ListParameterConfigsQuery } from './queries/list-parameter-configs.query';
import { GetParameterConfigQuery } from './queries/get-parameter-config.query';
import { GetParameterConfigByCodeQuery } from './queries/get-parameter-config-by-code.query';
import { ListParameterTemplatesQuery } from './queries/list-parameter-templates.query';
import { ListParamEquipmentQuery } from './queries/list-param-equipment.query';
import { GetEquipmentParamsQuery } from './queries/get-equipment-params.query';
import { WaterQualityParameterConfigSeederService } from './services/water-quality-parameter-config-seeder.service';
import { Cacheable } from '../common/cache/cacheable.decorator';

// ============================================================================
// RESPONSE TYPES
// ============================================================================

@ObjectType()
export class ParameterTemplateResponse {
  @Field()
  templateId!: string;

  @Field()
  name!: string;

  @Field()
  description!: string;

  @Field(() => [String])
  species!: string[];

  @Field(() => Int)
  parameterCount!: number;

  @Field(() => [String])
  parameterCodes!: string[];
}

/**
 * Result of a default-parameter seed run. `seeded` lists the codes
 * that were inserted; `skipped` lists the codes that already
 * existed so an operator re-running the seeder can tell whether
 * the call did anything.
 */
@ObjectType()
export class SeedDefaultParameterConfigsResponse {
  @Field(() => [String])
  seeded!: string[];

  @Field(() => [String])
  skipped!: string[];
}

// ============================================================================
// RESOLVER
// ============================================================================

@Resolver(() => WaterQualityParameterConfig)
@UseGuards(TenantGuard)
export class WaterQualityParameterConfigResolver {
  private readonly logger = new Logger(WaterQualityParameterConfigResolver.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    private readonly seeder: WaterQualityParameterConfigSeederService,
  ) {}

  // -------------------------------------------------------------------------
  // QUERIES
  // -------------------------------------------------------------------------

  /**
   * Filtrelenmis parametre konfigurasyonlarini listeler
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [WaterQualityParameterConfig], { name: 'parameterConfigs' })
  async listParameterConfigs(
    @CurrentTenant() tenantId: string,
    @Args('filter', { nullable: true }) filter?: ParameterConfigFilterInput,
  ): Promise<WaterQualityParameterConfig[]> {
    this.logger.debug(`Listing parameter configs for tenant: ${tenantId}`);
    return this.queryBus.execute(new ListParameterConfigsQuery(tenantId, filter));
  }

  /**
   * ID ile tek bir parametre konfigurasyonunu getirir
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => WaterQualityParameterConfig, { name: 'parameterConfig', nullable: true })
  async getParameterConfig(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<WaterQualityParameterConfig> {
    this.logger.debug(`Getting parameter config: ${id}`);
    return this.queryBus.execute(new GetParameterConfigQuery(tenantId, id));
  }

  /**
   * Code ile tek bir parametre konfigurasyonunu getirir
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => WaterQualityParameterConfig, { name: 'parameterConfigByCode', nullable: true })
  async getParameterConfigByCode(
    @Args('code') code: string,
    @CurrentTenant() tenantId: string,
  ): Promise<WaterQualityParameterConfig> {
    this.logger.debug(`Getting parameter config by code: ${code}`);
    return this.queryBus.execute(new GetParameterConfigByCodeQuery(tenantId, code));
  }

  /**
   * Kullanilabilir parametre sablonlarini listeler.
   *
   * Phase 7.3 — cached for 1 hour. The catalogue is a static
   * template registry that changes only when a new template ships
   * in a release; once-an-hour staleness is well within any
   * operational expectation. `scopeToTenant: false` because
   * templates are identical across tenants.
   */
  @Cacheable({
    prefix: 'wq:parameterTemplates',
    ttlSeconds: 3600,
    scopeToTenant: false,
  })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [ParameterTemplateResponse], { name: 'parameterTemplates' })
  async listParameterTemplates(): Promise<ParameterTemplateResponse[]> {
    this.logger.debug('Listing parameter templates');
    return this.queryBus.execute(new ListParameterTemplatesQuery());
  }

  // -------------------------------------------------------------------------
  // MUTATIONS (TENANT_ADMIN + MODULE_MANAGER only)
  // -------------------------------------------------------------------------

  /**
   * Yeni parametre konfigurasyonu olusturur
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => WaterQualityParameterConfig)
  async createParameterConfig(
    @Args('input') input: CreateParameterConfigInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<WaterQualityParameterConfig> {
    this.logger.log(`Creating parameter config "${input.code}" for tenant ${tenantId}`);
    return this.commandBus.execute(
      new CreateParameterConfigCommand(tenantId, input, user.sub),
    );
  }

  /**
   * Mevcut parametre konfigurasyonunu gunceller
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => WaterQualityParameterConfig)
  async updateParameterConfig(
    @Args('input') input: UpdateParameterConfigInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<WaterQualityParameterConfig> {
    this.logger.log(`Updating parameter config ${input.id} for tenant ${tenantId}`);
    return this.commandBus.execute(
      new UpdateParameterConfigCommand(tenantId, input.id, input, user.sub),
    );
  }

  /**
   * Parametre konfigurasyonunu siler
   */
  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => Boolean)
  async deleteParameterConfig(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<boolean> {
    this.logger.log(`Deleting parameter config ${id} for tenant ${tenantId}`);
    return this.commandBus.execute(
      new DeleteParameterConfigCommand(tenantId, id),
    );
  }

  /**
   * Seed the seven-parameter salmonid default catalogue for a
   * tenant (temperature, pH, dissolved oxygen, ammonia, nitrite,
   * salinity, turbidity). Idempotent on re-run — codes that
   * already exist get skipped rather than duplicated.
   *
   * Phase 7.5 partial of the "Farm modülü kalan kör noktalar"
   * plan. Closes the phase-6.5 onboarding gap: new tenants
   * hitting strict validation mode can now bootstrap a working
   * config set in one mutation instead of clicking through the
   * setup page one parameter at a time.
   */
  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => SeedDefaultParameterConfigsResponse)
  async seedDefaultWaterQualityParameterConfigs(
    @CurrentTenant() tenantId: string,
  ): Promise<SeedDefaultParameterConfigsResponse> {
    this.logger.log(
      `Seeding default water-quality parameter configs for tenant ${tenantId}`,
    );
    return this.seeder.seedDefaults(tenantId);
  }

  /**
   * Sablondan toplu parametre konfigurasyonu olusturur
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => [WaterQualityParameterConfig])
  async applyParameterTemplate(
    @Args('input') input: ApplyParameterTemplateInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<WaterQualityParameterConfig[]> {
    this.logger.log(`Applying template "${input.templateId}" for tenant ${tenantId}`);
    return this.commandBus.execute(
      new BulkCreateFromTemplateCommand(tenantId, input.templateId, input.overwrite, user.sub),
    );
  }

  /**
   * Parametre konfigurasyonlarinin siralama duzenini degistirir
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => [WaterQualityParameterConfig])
  async reorderParameterConfigs(
    @Args('input') input: ReorderParameterConfigsInput,
    @CurrentTenant() tenantId: string,
  ): Promise<WaterQualityParameterConfig[]> {
    this.logger.log(`Reordering ${input.orderedIds.length} parameter configs for tenant ${tenantId}`);
    return this.commandBus.execute(
      new ReorderParameterConfigsCommand(tenantId, input.orderedIds),
    );
  }

  // -------------------------------------------------------------------------
  // PARAM-EQUIPMENT QUERIES
  // -------------------------------------------------------------------------

  /**
   * Lists parameter-equipment mappings with optional filters
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [WaterQualityParamEquipment], { name: 'parameterEquipmentMappings' })
  async listParamEquipmentMappings(
    @CurrentTenant() tenantId: string,
    @Args('equipmentId', { type: () => ID, nullable: true }) equipmentId?: string,
    @Args('parameterConfigId', { type: () => ID, nullable: true }) parameterConfigId?: string,
    @Args('isActive', { nullable: true }) isActive?: boolean,
  ): Promise<WaterQualityParamEquipment[]> {
    this.logger.debug(`Listing param-equipment mappings for tenant: ${tenantId}`);
    return this.queryBus.execute(
      new ListParamEquipmentQuery(tenantId, { equipmentId, parameterConfigId, isActive }),
    );
  }

  /**
   * Gets all active parameter mappings for a specific equipment
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [WaterQualityParamEquipment], { name: 'equipmentParameters' })
  async getEquipmentParameters(
    @Args('equipmentId', { type: () => ID }) equipmentId: string,
    @CurrentTenant() tenantId: string,
  ): Promise<WaterQualityParamEquipment[]> {
    this.logger.debug(`Getting equipment parameters for equipment: ${equipmentId}`);
    return this.queryBus.execute(new GetEquipmentParamsQuery(tenantId, equipmentId));
  }

  // -------------------------------------------------------------------------
  // PARAM-EQUIPMENT MUTATIONS
  // -------------------------------------------------------------------------

  /**
   * Creates a single parameter-equipment mapping
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => WaterQualityParamEquipment)
  async createParamEquipmentMapping(
    @Args('input') input: CreateParamEquipmentInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<WaterQualityParamEquipment> {
    this.logger.log(
      `Creating param-equipment mapping: param=${input.parameterConfigId}, equip=${input.equipmentId} for tenant ${tenantId}`,
    );
    return this.commandBus.execute(
      new CreateParamEquipmentCommand(tenantId, input, user.sub),
    );
  }

  /**
   * Updates an existing parameter-equipment mapping
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => WaterQualityParamEquipment)
  async updateParamEquipmentMapping(
    @Args('input') input: UpdateParamEquipmentInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<WaterQualityParamEquipment> {
    this.logger.log(`Updating param-equipment mapping ${input.id} for tenant ${tenantId}`);
    return this.commandBus.execute(
      new UpdateParamEquipmentCommand(tenantId, input.id, input, user.sub),
    );
  }

  /**
   * Hard-deletes a parameter-equipment mapping
   */
  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => Boolean)
  async deleteParamEquipmentMapping(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<boolean> {
    this.logger.log(`Deleting param-equipment mapping ${id} for tenant ${tenantId}`);
    return this.commandBus.execute(new DeleteParamEquipmentCommand(tenantId, id));
  }

  /**
   * Bulk maps multiple parameters to a single equipment
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => [WaterQualityParamEquipment])
  async bulkMapParamsToEquipment(
    @Args('input') input: BulkMapParamsEquipmentInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<WaterQualityParamEquipment[]> {
    this.logger.log(
      `Bulk mapping ${input.parameterConfigIds.length} params to equipment ${input.equipmentId} for tenant ${tenantId}`,
    );
    return this.commandBus.execute(
      new BulkMapParamsEquipmentCommand(tenantId, input, user.sub),
    );
  }
}
