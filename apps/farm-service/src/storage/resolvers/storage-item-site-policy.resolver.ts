/**
 * Per-site stock policy GraphQL surface (plan K8 tier 1, FARM-HIGH-336).
 *
 * WHY manager-gated writes: a site minimum decides which site gets stock
 * transfers and purchases; it is distribution configuration, owned by
 * TENANT_ADMIN / MODULE_MANAGER (who are cross-site by the role hierarchy).
 * Reads are open to MODULE_USER, scoped to their assigned sites.
 * Layering: Resolver → Command/Query Bus → Handler → tenant-scoped repository.
 */
import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { CommandBus, QueryBus } from '@platform/cqrs';
import { CurrentTenant, CurrentUser, Role, Roles } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';
import type { SiteScopeCaller } from '@aquaculture/backend-common/security';

import {
  StorageItemSitePolicyFilterInput,
  UpsertStorageItemSitePolicyInput,
} from '../dto/storage-item-site-policy.input';
import { StorageItemSitePolicyResponse } from '../dto/storage-item-site-policy.response';
import { UpsertStorageItemSitePolicyCommand } from '../commands/upsert-storage-item-site-policy.command';
import { DeleteStorageItemSitePolicyCommand } from '../commands/delete-storage-item-site-policy.command';
import { ListStorageItemSitePoliciesQuery } from '../queries/list-storage-item-site-policies.query';

@Resolver(() => StorageItemSitePolicyResponse)
@UseGuards(TenantGuard)
export class StorageItemSitePolicyResolver {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [StorageItemSitePolicyResponse])
  async storageItemSitePolicies(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: SiteScopeCaller,
    @Args('filter', { nullable: true }) filter?: StorageItemSitePolicyFilterInput,
  ): Promise<StorageItemSitePolicyResponse[]> {
    return this.queryBus.execute(
      new ListStorageItemSitePoliciesQuery(tenantId, user, filter ?? {}),
    );
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => StorageItemSitePolicyResponse)
  async upsertStorageItemSitePolicy(
    @Args('input') input: UpsertStorageItemSitePolicyInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<StorageItemSitePolicyResponse> {
    return this.commandBus.execute(
      new UpsertStorageItemSitePolicyCommand(input, tenantId, user.sub),
    );
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => Boolean)
  async deleteStorageItemSitePolicy(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<boolean> {
    return this.commandBus.execute(new DeleteStorageItemSitePolicyCommand(id, tenantId, user.sub));
  }
}
