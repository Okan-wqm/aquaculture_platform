import {
  OWNER_MODULE_CODES,
  PLATFORM_ROLE,
  type ModuleAccess,
  type ModuleRole,
  type OwnerModuleCode,
} from '@aquaculture/shared-contracts';
import { Field, ObjectType, registerEnumType } from '@nestjs/graphql';

/**
 * The GraphQL face of the `moduleAccess` claim (RBAC-HIGH-027; ADR-051 §2), served by `me` so the
 * release-R2 web reads the grants the server derived (C1: added in R1, read in R2).
 *
 * WHAT: `ModuleAccess` has one nullable `ModuleRole` field per owner module of the dictionary —
 * the claim's own shape, so no GraphQL module enum is needed (PKG-01 PR2 owns `OwnerModule`).
 * The class implements a type mapped over OwnerModuleCode: a new owner module does not compile
 * until it has its field. A null field means no grant in that module.
 */
export const MODULE_ROLE_GRAPHQL_ENUM = Object.freeze({
  MODULE_MANAGER: PLATFORM_ROLE.MODULE_MANAGER,
  MODULE_USER: PLATFORM_ROLE.MODULE_USER,
} as const satisfies { readonly [Role in ModuleRole]: Role });

registerEnumType(MODULE_ROLE_GRAPHQL_ENUM, { name: 'ModuleRole' });

type ModuleAccessFields = { [Code in OwnerModuleCode]: ModuleRole | null };

@ObjectType('ModuleAccess')
export class ModuleAccessGrants implements ModuleAccessFields {
  @Field(() => MODULE_ROLE_GRAPHQL_ENUM, { nullable: true })
  farm!: ModuleRole | null;

  @Field(() => MODULE_ROLE_GRAPHQL_ENUM, { nullable: true })
  hr!: ModuleRole | null;

  @Field(() => MODULE_ROLE_GRAPHQL_ENUM, { nullable: true })
  sensor!: ModuleRole | null;

  @Field(() => MODULE_ROLE_GRAPHQL_ENUM, { nullable: true })
  hydroponics!: ModuleRole | null;

  static of(access: ModuleAccess): ModuleAccessGrants {
    const grants = new ModuleAccessGrants();
    for (const code of OWNER_MODULE_CODES) grants[code] = access[code] ?? null;
    return grants;
  }
}
