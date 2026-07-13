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
import { SYSTEM_TENANT_ID } from './configuration.constants';
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
  private getTenantId(context: GraphQLContext): string {
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
