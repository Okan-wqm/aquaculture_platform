import { UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  MARINE_PROVIDER_CREDENTIAL_KEYS,
  MARINE_PROVIDER_CREDENTIAL_SERVICE,
} from '@platform/event-contracts';
import { Resolver, Query, Mutation, Args, Context } from '@nestjs/graphql';

import { UpsertConfigurationCommand } from './commands/upsert-configuration.command';
import { SYSTEM_TENANT_ID } from './configuration.constants';
import {
  EffectiveConfigurationDto,
  toEffectiveConfigurationDto,
} from './dto/effective-configuration.dto';
import { Configuration, ConfigEnvironment } from './entities/configuration.entity';
import { GetConfigurationQuery } from './queries/get-configuration.query';
import { GetConfigurationsByServiceQuery } from './queries/get-configurations.query';

interface GraphQLContext {
  req: {
    user?: {
      sub: string;
      /**
       * Absent/null for SUPER_ADMIN: it is the platform's only tenantless
       * principal by design (auth-service token-mint C1 invariant).
       */
      tenantId?: string | null;
      roles?: string[];
    };
  };
}

/**
 * Roles allowed to administer configuration. The same vocabulary gates both
 * the setConfiguration mutation and the tenantless system-scope resolution,
 * so the two checks can never drift apart.
 */
const PLATFORM_ADMIN_ROLES: readonly string[] = ['admin', 'platform_admin', 'SUPER_ADMIN'];
const RESTRICTED_PROVIDER_CREDENTIAL_KEYS: ReadonlySet<string> = new Set(
  Object.values(MARINE_PROVIDER_CREDENTIAL_KEYS),
);
const TENANT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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

  private hasPlatformAdminRole(context: GraphQLContext): boolean {
    const roles = context.req.user?.roles ?? [];
    return PLATFORM_ADMIN_ROLES.some((role) => roles.includes(role));
  }

  /**
   * Provider credential metadata is an operations-only surface. A tenant
   * principal must not learn whether a company or legacy tenant credential
   * exists, which source won, or when it rotated. The only public GraphQL
   * exception is the tenantless SUPER_ADMIN system scope.
   */
  private canReadRestrictedProviderCredentials(context: GraphQLContext): boolean {
    const user = context.req.user;
    return (
      user !== undefined &&
      (user.tenantId === undefined || user.tenantId === null) &&
      (user.roles ?? []).includes('SUPER_ADMIN')
    );
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

  /**
   * Resolve the tenant scope exclusively from the verified JWT payload.
   * SECURITY: Never fall back to headers - JWT is the only trusted source.
   *
   * WHY the SYSTEM_TENANT_ID resolution for tenantless platform admins:
   * SUPER_ADMIN is the platform's only tenantless principal (auth-service
   * refuses to mint any other token without a tenant), and TenantGuard already
   * admits it in system scope. Platform-scope configuration rows are stored
   * under SYSTEM_TENANT_ID, so a tenantless platform admin reads and writes the
   * system rows — a tenant-scoped user still resolves ONLY from its verified
   * JWT tenant claim, and an authenticated non-admin without a tenant stays
   * rejected fail-closed.
   */
  private resolveTenantScope(context: GraphQLContext, explicitTenantId?: string | null): string {
    if (explicitTenantId !== undefined && explicitTenantId !== null) {
      const user = context.req.user;
      if (!user) {
        throw new UnauthorizedException('Authentication required - tenant ID must come from JWT');
      }
      if (
        (user.tenantId !== undefined && user.tenantId !== null) ||
        !(user.roles ?? []).includes('SUPER_ADMIN')
      ) {
        throw new ForbiddenException(
          'Tenantless SUPER_ADMIN authority is required to target tenant configuration',
        );
      }
      if (!TENANT_ID_PATTERN.test(explicitTenantId) || explicitTenantId === SYSTEM_TENANT_ID) {
        throw new ForbiddenException('Target tenant ID is not a canonical tenant UUID');
      }
      return explicitTenantId;
    }

    const tenantId = context.req.user?.tenantId;
    if (tenantId) {
      return tenantId;
    }
    if (context.req.user && this.hasPlatformAdminRole(context)) {
      return SYSTEM_TENANT_ID;
    }
    throw new UnauthorizedException('Authentication required - tenant ID must come from JWT');
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
    if (!this.hasPlatformAdminRole(context)) {
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
    @Args('tenantId', { type: () => String, nullable: true })
    targetTenantId: string | null = null,
  ): Promise<EffectiveConfigurationDto> {
    const tenantId = this.resolveTenantScope(context, targetTenantId);
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
    @Args('tenantId', { type: () => String, nullable: true })
    targetTenantId: string | null = null,
  ): Promise<EffectiveConfigurationDto[]> {
    const tenantId = this.resolveTenantScope(context, targetTenantId);
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
    @Args('tenantId', { type: () => String, nullable: true })
    targetTenantId: string | null = null,
  ): Promise<EffectiveConfigurationDto> {
    const tenantId = this.resolveTenantScope(context, targetTenantId);
    const userId = this.getUserId(context);
    this.checkAdminAccess(context);
    const restrictedProviderCredential = isRestrictedProviderCredential(service, key);
    if (restrictedProviderCredential && !this.canReadRestrictedProviderCredentials(context)) {
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
