import {
  CurrentUser,
  Tenant as CurrentTenant,
  TenantAdminOrHigher,
} from '@aquaculture/backend-common/decorators';
import {
  OWNER_MODULE_CODES,
  type ModuleRole,
  type OwnerModuleCode,
} from '@aquaculture/shared-contracts';
import { ParseUUIDPipe } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';

import { ModuleAccessGrants } from '../../authentication/dto/module-access.dto';
import {
  ModuleAccessInput,
  ModulePrimaryManager,
  SetUserModuleAccessInput,
  UserModuleAccess,
} from '../dto/module-access.dto';
import type { ModuleAccessChoice } from '../services/member-grants-replace';
import { ModuleAccessService, type UserModuleAccessView } from '../services/module-access.service';

/**
 * The admin path of module access (PKG-06; ADR-051 §2 "Change"). A tenant administrator's
 * operations, always in the caller's own tenant — from the verified claim (@CurrentTenant),
 * never from an argument — and the actor is the verified subject.
 */
@Resolver()
export class ModuleAccessResolver {
  constructor(private readonly moduleAccess: ModuleAccessService) {}

  /** Replaces the member's module roles within the tenant's enabled modules. */
  @Mutation(() => UserModuleAccess)
  @TenantAdminOrHigher()
  async setUserModuleAccess(
    @CurrentUser('sub') actorId: string,
    @CurrentTenant() tenantId: string,
    @Args('input') input: SetUserModuleAccessInput,
  ): Promise<UserModuleAccess> {
    return toUserModuleAccess(
      await this.moduleAccess.setUserModuleAccess(
        { tenantId, userId: actorId },
        { userId: input.userId, moduleAccess: choiceOf(input.moduleAccess) },
      ),
    );
  }

  /** The member's module roles as their next token carries them. */
  @Query(() => UserModuleAccess)
  @TenantAdminOrHigher()
  async userModuleAccess(
    @CurrentTenant() tenantId: string,
    @Args('userId', { type: () => ID }, new ParseUUIDPipe({ version: '4' })) userId: string,
  ): Promise<UserModuleAccess> {
    return toUserModuleAccess(await this.moduleAccess.readUserModuleAccess(tenantId, userId));
  }

  /** Each enabled module's primary manager (the Assign Manager designation). */
  @Query(() => [ModulePrimaryManager])
  @TenantAdminOrHigher()
  async modulePrimaryManagers(@CurrentTenant() tenantId: string): Promise<ModulePrimaryManager[]> {
    const managers = await this.moduleAccess.listPrimaryManagers(tenantId);
    return managers.map((entry) => Object.assign(new ModulePrimaryManager(), entry));
  }
}

/** Every owner module's stated role; an absent field is no grant, as a null one is. */
function choiceOf(input: ModuleAccessInput): ModuleAccessChoice {
  const choice: { [Code in OwnerModuleCode]?: ModuleRole | null } = {};
  for (const code of OWNER_MODULE_CODES) choice[code] = input[code] ?? null;
  return choice;
}

function toUserModuleAccess(view: UserModuleAccessView): UserModuleAccess {
  return Object.assign(new UserModuleAccess(), {
    userId: view.userId,
    moduleAccess: ModuleAccessGrants.of(view.moduleAccess),
  });
}
