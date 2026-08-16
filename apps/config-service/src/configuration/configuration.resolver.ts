import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';

import { ApplyConfigurationBatchCommand } from './commands/apply-configuration-batch.command';
import {
  ApplyConfigurationBatchInputV1,
  ConfigurationBatchReceiptV1,
  ConfigurationScopeInputV1,
  ConfigurationSnapshotV1,
} from './dto/configuration-snapshot.dto';
import { SYSTEM_TENANT_ID } from './configuration.constants';
import { GetConfigurationSnapshotQuery } from './queries/get-configuration-snapshot.query';

interface GraphQLContext {
  req: {
    user?: {
      sub: string;
      tenantId?: string | null;
      roles?: string[];
    };
  };
}

const CONFIGURATION_ADMIN_ROLES: ReadonlySet<string> = new Set([
  'admin',
  'platform_admin',
  'SUPER_ADMIN',
]);

@Resolver(() => ConfigurationSnapshotV1)
export class ConfigurationResolver {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Query(() => ConfigurationSnapshotV1, { name: 'configurationSnapshot' })
  async configurationSnapshot(
    @Args('scope', { type: () => ConfigurationScopeInputV1 })
    scope: ConfigurationScopeInputV1,
    @Context() context: GraphQLContext,
  ): Promise<ConfigurationSnapshotV1> {
    this.assertAdmin(context);
    const tenantId = this.resolveTargetTenant(scope.targetTenantId, context);
    return this.queryBus.execute<GetConfigurationSnapshotQuery, ConfigurationSnapshotV1>(
      new GetConfigurationSnapshotQuery(tenantId, scope.environment),
    );
  }

  @Mutation(() => ConfigurationBatchReceiptV1, { name: 'applyConfigurationBatch' })
  async applyConfigurationBatch(
    @Args('input', { type: () => ApplyConfigurationBatchInputV1 })
    input: ApplyConfigurationBatchInputV1,
    @Context() context: GraphQLContext,
  ): Promise<ConfigurationBatchReceiptV1> {
    this.assertAdmin(context);
    const actorId = context.req.user?.sub;
    if (!actorId) throw new UnauthorizedException('Authenticated actor is required');
    const tenantId = this.resolveTargetTenant(input.targetTenantId, context);
    return this.commandBus.execute<ApplyConfigurationBatchCommand, ConfigurationBatchReceiptV1>(
      new ApplyConfigurationBatchCommand(input, tenantId, actorId, true),
    );
  }

  private assertAdmin(context: GraphQLContext): void {
    const user = context.req.user;
    if (!user) throw new UnauthorizedException('Authentication required');
    if (!(user.roles ?? []).some((role) => CONFIGURATION_ADMIN_ROLES.has(role))) {
      throw new ForbiddenException('Configuration administrator role required');
    }
  }

  private resolveTargetTenant(
    requestedTenantId: string | undefined,
    context: GraphQLContext,
  ): string {
    const user = context.req.user;
    if (!user) throw new UnauthorizedException('Authentication required');
    if (requestedTenantId !== undefined) {
      if (!(user.roles ?? []).some((role) => role === 'platform_admin' || role === 'SUPER_ADMIN')) {
        throw new ForbiddenException('Cross-tenant configuration requires a platform role');
      }
      return requestedTenantId;
    }
    if (user.tenantId) return user.tenantId;
    if ((user.roles ?? []).includes('SUPER_ADMIN')) return SYSTEM_TENANT_ID;
    throw new ForbiddenException('Configuration scope is not resolvable from the verified JWT');
  }
}
