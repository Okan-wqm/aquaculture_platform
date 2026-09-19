import { ForbiddenException } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  MARINE_PROVIDER_CREDENTIAL_KEYS,
  MARINE_PROVIDER_CREDENTIAL_SERVICE,
} from '@platform/event-contracts';
import { Resolver, Query, Mutation, Args, Context } from '@nestjs/graphql';

import { UpsertConfigurationCommand } from './commands/upsert-configuration.command';
import {
  EffectiveConfigurationDto,
  toEffectiveConfigurationDto,
} from './dto/effective-configuration.dto';
import { Configuration, ConfigEnvironment } from './entities/configuration.entity';
import {
  GraphQLPrincipalContext,
  hasPlatformAdminRole,
  isTenantlessSuperAdmin,
  requireUserId,
  resolveTenantId,
} from './graphql-principal';
import { GetConfigurationQuery } from './queries/get-configuration.query';
import { GetConfigurationsByServiceQuery } from './queries/get-configurations.query';

type GraphQLContext = GraphQLPrincipalContext;

const RESTRICTED_PROVIDER_CREDENTIAL_KEYS: ReadonlySet<string> = new Set(
  Object.values(MARINE_PROVIDER_CREDENTIAL_KEYS),
);

function isRestrictedProviderCredential(service: string, key: string): boolean {
  return (
    service === MARINE_PROVIDER_CREDENTIAL_SERVICE && RESTRICTED_PROVIDER_CREDENTIAL_KEYS.has(key)
  );
}

@Resolver(() => EffectiveConfigurationDto)
export class ConfigurationResolver {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  /**
   * Principal derivation lives in ./graphql-principal so this resolver and the
   * provider-credential resolver answer "who may touch a company credential"
   * from one definition.
   */
  private canReadRestrictedProviderCredentials(context: GraphQLContext): boolean {
    return isTenantlessSuperAdmin(context);
  }

  private assertConfigurationReadAllowed(
    service: string,
    key: string,
    context: GraphQLContext,
  ): void {
    if (
      isRestrictedProviderCredential(service, key) &&
      !this.canReadRestrictedProviderCredentials(context)
    ) {
      throw new ForbiddenException('Configuration is not available through tenant APIs');
    }
  }

  private getTenantId(context: GraphQLContext): string {
    return resolveTenantId(context);
  }

  private getUserId(context: GraphQLContext): string {
    return requireUserId(context);
  }

  /**
   * Check admin access from verified JWT roles.
   */
  private checkAdminAccess(context: GraphQLContext): void {
    if (!hasPlatformAdminRole(context)) {
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
    this.assertConfigurationReadAllowed(serviceId, key, context);
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
    >(new GetConfigurationsByServiceQuery(tenantId, service, environment));
    const visibleConfigurations = this.canReadRestrictedProviderCredentials(context)
      ? configurations
      : configurations.filter(
          (configuration) =>
            !isRestrictedProviderCredential(configuration.service, configuration.key),
        );
    return visibleConfigurations.map((configuration) =>
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
    const restrictedProviderCredential = isRestrictedProviderCredential(service, key);
    if (
      restrictedProviderCredential &&
      !this.canReadRestrictedProviderCredentials(context)
    ) {
      throw new ForbiddenException(
        'Provider credentials are writable only by tenantless SUPER_ADMIN operations',
      );
    }

    const configuration = await this.commandBus.execute<UpsertConfigurationCommand, Configuration>(
      new UpsertConfigurationCommand(
        tenantId,
        service,
        key,
        value,
        environment,
        userId,
        restrictedProviderCredential ? true : isSecret,
        reason,
      ),
    );
    return toEffectiveConfigurationDto(tenantId, configuration);
  }
}
