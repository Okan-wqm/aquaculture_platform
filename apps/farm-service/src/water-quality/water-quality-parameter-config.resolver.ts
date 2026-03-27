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
import { TenantGuard, CurrentTenant, CurrentUser, Roles, Role } from '@aquaculture/backend-common';
import { WaterQualityParameterConfig } from './entities/water-quality-parameter-config.entity';

// DTOs
import { CreateParameterConfigInput } from './dto/create-parameter-config.input';
import { UpdateParameterConfigInput } from './dto/update-parameter-config.input';
import { ParameterConfigFilterInput } from './dto/parameter-config-filter.input';
import { ApplyParameterTemplateInput } from './dto/apply-parameter-template.input';
import { ReorderParameterConfigsInput } from './dto/reorder-parameter-configs.input';

// Commands
import { CreateParameterConfigCommand } from './commands/create-parameter-config.command';
import { UpdateParameterConfigCommand } from './commands/update-parameter-config.command';
import { DeleteParameterConfigCommand } from './commands/delete-parameter-config.command';
import { BulkCreateFromTemplateCommand } from './commands/bulk-create-from-template.command';
import { ReorderParameterConfigsCommand } from './commands/reorder-parameter-configs.command';

// Queries
import { ListParameterConfigsQuery } from './queries/list-parameter-configs.query';
import { GetParameterConfigQuery } from './queries/get-parameter-config.query';
import { GetParameterConfigByCodeQuery } from './queries/get-parameter-config-by-code.query';
import { ListParameterTemplatesQuery } from './queries/list-parameter-templates.query';

// ============================================================================
// RESPONSE TYPES
// ============================================================================

@ObjectType()
export class ParameterTemplateResponse {
  @Field()
  templateId: string;

  @Field()
  name: string;

  @Field()
  description: string;

  @Field(() => [String])
  species: string[];

  @Field(() => Int)
  parameterCount: number;

  @Field(() => [String])
  parameterCodes: string[];
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
  ) {}

  // -------------------------------------------------------------------------
  // QUERIES
  // -------------------------------------------------------------------------

  /**
   * Filtrelenmis parametre konfigurasyonlarini listeler
   */
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
  @Query(() => WaterQualityParameterConfig, { name: 'parameterConfigByCode', nullable: true })
  async getParameterConfigByCode(
    @Args('code') code: string,
    @CurrentTenant() tenantId: string,
  ): Promise<WaterQualityParameterConfig> {
    this.logger.debug(`Getting parameter config by code: ${code}`);
    return this.queryBus.execute(new GetParameterConfigByCodeQuery(tenantId, code));
  }

  /**
   * Kullanilabilir parametre sablonlarini listeler
   */
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
}
