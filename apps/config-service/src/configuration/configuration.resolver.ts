import {
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  Resolver,
  Query,
  Mutation,
  Args,
  Context,
} from '@nestjs/graphql';

import { UpsertConfigurationCommand } from './commands/upsert-configuration.command';
import {
  EffectiveConfigurationDto,
  toEffectiveConfigurationDto,
} from './dto/effective-configuration.dto';
import {
  Configuration,
  ConfigEnvironment,
} from './entities/configuration.entity';
import { GetConfigurationQuery } from './queries/get-configuration.query';
import { GetConfigurationsByServiceQuery } from './queries/get-configurations.query';

interface GraphQLContext {
  req: {
    user?: {
      sub: string;
      tenantId: string;
      roles?: string[];
    };
  };
}

@Resolver(() => EffectiveConfigurationDto)
export class ConfigurationResolver {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  /**
   * Extract tenant ID exclusively from verified JWT payload.
   * SECURITY: Never fall back to headers - JWT is the only trusted source.
   */
  private getTenantId(context: GraphQLContext): string {
    const tenantId = context.req.user?.tenantId;
    if (!tenantId) {
      throw new UnauthorizedException('Authentication required - tenant ID must come from JWT');
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
   * Check admin access from verified JWT roles.
   */
  private checkAdminAccess(context: GraphQLContext): void {
    const roles = context.req.user?.roles ?? [];
    if (!roles.includes('admin') && !roles.includes('platform_admin') && !roles.includes('SUPER_ADMIN')) {
      throw new ForbiddenException('Admin access required for this operation');
    }
  }

  // ─── Queries ──────────────────────────────────────────────────

  @Query(() => EffectiveConfigurationDto, { name: 'effectiveConfiguration' })
  async getEffectiveConfiguration(
    @Args('serviceId') serviceId: string,
    @Args('key') key: string,
    @Args('environment', { type: () => ConfigEnvironment, nullable: true })
    environment: ConfigEnvironment,
    @Context() context: GraphQLContext,
  ): Promise<EffectiveConfigurationDto> {
    const tenantId = this.getTenantId(context);
    const configuration = await this.queryBus.execute<GetConfigurationQuery, Configuration>(
      new GetConfigurationQuery(tenantId, serviceId, key, environment),
    );
    return toEffectiveConfigurationDto(tenantId, configuration);
  }

  @Query(() => [EffectiveConfigurationDto], { name: 'effectiveConfigurationsByService' })
  async getEffectiveConfigurationsByService(
    @Args('service') service: string,
    @Args('environment', { type: () => ConfigEnvironment, nullable: true })
    environment: ConfigEnvironment,
    @Context() context: GraphQLContext,
  ): Promise<EffectiveConfigurationDto[]> {
    const tenantId = this.getTenantId(context);
    const configurations = await this.queryBus.execute<
      GetConfigurationsByServiceQuery,
      Configuration[]
    >(
      new GetConfigurationsByServiceQuery(tenantId, service, environment),
    );
    return configurations.map((configuration) =>
      toEffectiveConfigurationDto(tenantId, configuration),
    );
  }

  // ─── Mutations ────────────────────────────────────────────────

  /**
   * Atomic upsert - uses INSERT ... ON CONFLICT DO UPDATE under the hood.
   */
  @Mutation(() => EffectiveConfigurationDto)
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
  ): Promise<EffectiveConfigurationDto> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    this.checkAdminAccess(context);

    const configuration = await this.commandBus.execute<
      UpsertConfigurationCommand,
      Configuration
    >(
      new UpsertConfigurationCommand(tenantId, service, key, value, environment, userId, isSecret, reason),
    );
    return toEffectiveConfigurationDto(tenantId, configuration);
  }
}
