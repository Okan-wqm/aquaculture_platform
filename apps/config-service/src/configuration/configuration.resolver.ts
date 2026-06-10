import {
  Resolver,
  Query,
  Mutation,
  Args,
  ID,
  Context,
  ResolveField,
  Parent,
  Int,
} from '@nestjs/graphql';
import {
  UnauthorizedException,
} from '@nestjs/common';
import { RequireTenantPermission } from '@aquaculture/backend-common/decorators';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  Configuration,
  ConfigurationHistory,
  ConfigEnvironment,
} from './entities/configuration.entity';
import {
  CreateConfigurationInput,
  UpdateConfigurationInput,
  ConfigurationFilterInput,
} from './dto/create-configuration.input';
import { CreateConfigurationCommand } from './commands/create-configuration.command';
import { UpdateConfigurationCommand } from './commands/update-configuration.command';
import { DeleteConfigurationCommand } from './commands/delete-configuration.command';
import { UpsertConfigurationCommand } from './commands/upsert-configuration.command';
import {
  GetConfigurationQuery,
  GetConfigurationByIdQuery,
} from './queries/get-configuration.query';
import {
  GetConfigurationsQuery,
  GetConfigurationsByServiceQuery,
  GetConfigurationHistoryQuery,
} from './queries/get-configurations.query';

interface GraphQLContext {
  req: {
    tenantId?: string;
    user?: {
      sub: string;
      tenantId: string;
      roles?: string[];
    };
  };
}

@Resolver(() => Configuration)
export class ConfigurationResolver {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  /**
   * Extract tenant ID from the canonical guard-resolved request field.
   */
  private getTenantId(context: GraphQLContext): string {
    const tenantId = context.req.tenantId ?? context.req.user?.tenantId;
    if (!tenantId) {
      throw new UnauthorizedException('Authentication required - tenant ID must be guard-resolved');
    }
    return tenantId;
  }

  /**
   * Extract user ID exclusively from verified JWT payload.
   * SECURITY: Never fall back to headers or 'system' literal.
   */
  private getUserId(context: GraphQLContext): string {
    const userId = context.req.user?.sub;
    if (!userId) {
      throw new UnauthorizedException('Authentication required - user ID must come from JWT');
    }
    return userId;
  }

  /**
   * Mask secret values in GraphQL responses.
   * SECURITY: Never expose encrypted blobs or plaintext secrets.
   */
  @ResolveField(() => String, { name: 'value' })
  resolveValue(@Parent() config: Configuration): string {
    if (config.isSecret) {
      return '[ENCRYPTED]';
    }
    return config.value;
  }

  // ─── Queries ──────────────────────────────────────────────────

  @Query(() => Configuration, { name: 'configuration' })
  @RequireTenantPermission('config:read')
  async getConfiguration(
    @Args('service') service: string,
    @Args('key') key: string,
    @Args('environment', { type: () => ConfigEnvironment, nullable: true })
    environment: ConfigEnvironment,
    @Context() context: GraphQLContext,
  ): Promise<Configuration> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetConfigurationQuery(tenantId, service, key, environment),
    );
  }

  @Query(() => Configuration, { name: 'configurationById' })
  @RequireTenantPermission('config:read')
  async getConfigurationById(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: GraphQLContext,
  ): Promise<Configuration> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(new GetConfigurationByIdQuery(tenantId, id));
  }

  @Query(() => [Configuration], { name: 'configurations' })
  @RequireTenantPermission('config:read')
  async getConfigurations(
    @Args('filter', { nullable: true }) filter: ConfigurationFilterInput,
    @Context() context: GraphQLContext,
  ): Promise<Configuration[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(new GetConfigurationsQuery(tenantId, filter));
  }

  @Query(() => [Configuration], { name: 'configurationsByService' })
  @RequireTenantPermission('config:read')
  async getConfigurationsByService(
    @Args('service') service: string,
    @Args('environment', { type: () => ConfigEnvironment, nullable: true })
    environment: ConfigEnvironment,
    @Context() context: GraphQLContext,
  ): Promise<Configuration[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetConfigurationsByServiceQuery(tenantId, service, environment),
    );
  }

  @Query(() => [ConfigurationHistory], { name: 'configurationHistory' })
  @RequireTenantPermission('config:read')
  async getConfigurationHistory(
    @Args('configurationId', { type: () => ID }) configurationId: string,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 50 }) limit: number,
    @Context() context: GraphQLContext,
  ): Promise<ConfigurationHistory[]> {
    const tenantId = this.getTenantId(context);
    // Cap limit to prevent abuse
    const cappedLimit = Math.min(Math.max(limit, 1), 500);
    return this.queryBus.execute(
      new GetConfigurationHistoryQuery(tenantId, configurationId, cappedLimit),
    );
  }

  // ─── Mutations ────────────────────────────────────────────────

  @Mutation(() => Configuration)
  @RequireTenantPermission('config:write')
  async createConfiguration(
    @Args('input') input: CreateConfigurationInput,
    @Context() context: GraphQLContext,
  ): Promise<Configuration> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);

    return this.commandBus.execute(
      new CreateConfigurationCommand(tenantId, input, userId),
    );
  }

  @Mutation(() => Configuration)
  @RequireTenantPermission('config:write')
  async updateConfiguration(
    @Args('input') input: UpdateConfigurationInput,
    @Context() context: GraphQLContext,
  ): Promise<Configuration> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);

    return this.commandBus.execute(
      new UpdateConfigurationCommand(tenantId, input, userId),
    );
  }

  @Mutation(() => Boolean)
  @RequireTenantPermission('config:delete')
  async deleteConfiguration(
    @Args('id', { type: () => ID }) id: string,
    @Args('hardDelete', { defaultValue: false }) hardDelete: boolean,
    @Context() context: GraphQLContext,
  ): Promise<boolean> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);

    return this.commandBus.execute(
      new DeleteConfigurationCommand(tenantId, id, userId, hardDelete),
    );
  }

  /**
   * Atomic upsert - uses INSERT ... ON CONFLICT DO UPDATE under the hood.
   */
  @Mutation(() => Configuration)
  @RequireTenantPermission('config:write')
  async setConfiguration(
    @Args('service') service: string,
    @Args('key') key: string,
    @Args('value') value: string,
    @Args('environment', {
      type: () => ConfigEnvironment,
      nullable: true,
      defaultValue: ConfigEnvironment.ALL,
    })
    environment: ConfigEnvironment,
    @Args('isSecret', { nullable: true, defaultValue: false }) isSecret: boolean,
    @Args('reason', { type: () => String, nullable: true }) reason: string | undefined,
    @Context() context: GraphQLContext,
  ): Promise<Configuration> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);

    return this.commandBus.execute(
      new UpsertConfigurationCommand(tenantId, service, key, value, environment, userId, isSecret, reason),
    );
  }
}
