import { Resolver, Query, Mutation, Args, ID, Context } from '@nestjs/graphql';
import { UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  Configuration,
  ConfigurationHistory,
  ConfigEnvironment,
  ConfigValueType,
} from './entities/configuration.entity';
import {
  CreateConfigurationInput,
  UpdateConfigurationInput,
  ConfigurationFilterInput,
} from './dto/create-configuration.input';
import { CreateConfigurationCommand } from './commands/create-configuration.command';
import { UpdateConfigurationCommand } from './commands/update-configuration.command';
import { DeleteConfigurationCommand } from './commands/delete-configuration.command';
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
    headers: {
      'x-tenant-id'?: string;
      'x-user-id'?: string;
      'x-api-key'?: string;
    };
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

  private getTenantId(context: GraphQLContext): string {
    const tenantId =
      context.req.user?.tenantId || context.req.headers['x-tenant-id'];
    if (!tenantId) {
      throw new UnauthorizedException('Tenant ID is required');
    }
    return tenantId;
  }

  private getUserId(context: GraphQLContext): string {
    return context.req.user?.sub || context.req.headers['x-user-id'] || 'system';
  }

  private checkAdminAccess(context: GraphQLContext): void {
    const roles = context.req.user?.roles || [];
    if (!roles.includes('admin') && !roles.includes('platform_admin')) {
      throw new ForbiddenException('Admin access required');
    }
  }

  // Queries
  @Query(() => Configuration, { name: 'configuration' })
  async getConfiguration(
    @Args('service') service: string,
    @Args('key') key: string,
    @Args('environment', { nullable: true }) environment: string,
    @Context() context: GraphQLContext,
  ): Promise<Configuration> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetConfigurationQuery(tenantId, service, key, environment),
    );
  }

  @Query(() => Configuration, { name: 'configurationById' })
  async getConfigurationById(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: GraphQLContext,
  ): Promise<Configuration> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(new GetConfigurationByIdQuery(tenantId, id));
  }

  @Query(() => [Configuration], { name: 'configurations' })
  async getConfigurations(
    @Args('filter', { nullable: true }) filter: ConfigurationFilterInput,
    @Context() context: GraphQLContext,
  ): Promise<Configuration[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(new GetConfigurationsQuery(tenantId, filter));
  }

  @Query(() => [Configuration], { name: 'configurationsByService' })
  async getConfigurationsByService(
    @Args('service') service: string,
    @Args('environment', { nullable: true }) environment: string,
    @Context() context: GraphQLContext,
  ): Promise<Configuration[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetConfigurationsByServiceQuery(tenantId, service, environment),
    );
  }

  @Query(() => [ConfigurationHistory], { name: 'configurationHistory' })
  async getConfigurationHistory(
    @Args('configurationId', { type: () => ID }) configurationId: string,
    @Args('limit', { nullable: true }) limit: number,
    @Context() context: GraphQLContext,
  ): Promise<ConfigurationHistory[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetConfigurationHistoryQuery(tenantId, configurationId, limit),
    );
  }

  // Mutations
  @Mutation(() => Configuration)
  async createConfiguration(
    @Args('input') input: CreateConfigurationInput,
    @Context() context: GraphQLContext,
  ): Promise<Configuration> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    this.checkAdminAccess(context);

    return this.commandBus.execute(
      new CreateConfigurationCommand(tenantId, input, userId),
    );
  }

  @Mutation(() => Configuration)
  async updateConfiguration(
    @Args('input') input: UpdateConfigurationInput,
    @Context() context: GraphQLContext,
  ): Promise<Configuration> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    this.checkAdminAccess(context);

    return this.commandBus.execute(
      new UpdateConfigurationCommand(tenantId, input, userId),
    );
  }

  @Mutation(() => Boolean)
  async deleteConfiguration(
    @Args('id', { type: () => ID }) id: string,
    @Args('hardDelete', { defaultValue: false }) hardDelete: boolean,
    @Context() context: GraphQLContext,
  ): Promise<boolean> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    this.checkAdminAccess(context);

    return this.commandBus.execute(
      new DeleteConfigurationCommand(tenantId, id, userId, hardDelete),
    );
  }

  // REST-style convenience mutations
  @Mutation(() => Configuration)
  async setConfiguration(
    @Args('service') service: string,
    @Args('key') key: string,
    @Args('value') value: string,
    @Args('environment', { nullable: true, defaultValue: ConfigEnvironment.ALL })
    environment: ConfigEnvironment,
    @Context() context: GraphQLContext,
  ): Promise<Configuration> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    this.checkAdminAccess(context);

    // Try to find existing config
    try {
      const existing = await this.queryBus.execute(
        new GetConfigurationQuery(tenantId, service, key, environment),
      );

      // Update existing
      return this.commandBus.execute(
        new UpdateConfigurationCommand(
          tenantId,
          { id: existing.id, value },
          userId,
        ),
      );
    } catch {
      // Create new with required defaults
      const input: CreateConfigurationInput = {
        service,
        key,
        value,
        environment,
        valueType: ConfigValueType.STRING,
        isSecret: false,
      };
      return this.commandBus.execute(
        new CreateConfigurationCommand(tenantId, input, userId),
      );
    }
  }
}
