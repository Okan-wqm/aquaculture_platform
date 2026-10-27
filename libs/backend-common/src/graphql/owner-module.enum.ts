/**
 * The GraphQL face of the module dictionary (RBAC-MEDIUM-023, HR-MEDIUM-064; ADR-051 §2).
 *
 * WHY: hr-service (`HRModuleCode`, a department's module) and alert-engine (`AlertModule`, an
 * alarm's module) each declared a TypeScript enum of module codes and registered it. Neither list
 * could name hr, and they disagreed with the auth catalogue. Both enums are now built from the
 * dictionary's owner modules. Their wire names stay, so the only change a client sees is the
 * added `HR` value; PKG-01 PR2 (release R2) replaces both names with one `OwnerModule`, together
 * with the web and aquamobil documents that name them.
 *
 * WHAT: `registerOwnerModuleEnum(name, description)` registers a frozen copy of OWNER_MODULE
 * under one of OWNER_MODULE_GRAPHQL_ENUM_NAMES and returns it as the enum reference for
 * `@Field` / `@Args`. Each call gets its own copy: Nest keys enum metadata by the reference, so
 * two names sharing one object in a process would resolve to whichever registered first.
 * `tests/invariants/module-dictionary-ssot.spec.ts` requires every module enum to be registered
 * here and nowhere by hand.
 */
import { OWNER_MODULE } from '@aquaculture/shared-contracts';
import { registerEnumType } from '@nestjs/graphql';

/** The module enum names on the wire today (one per owning service). */
export const OWNER_MODULE_GRAPHQL_ENUM_NAMES = Object.freeze([
  'HRModuleCode',
  'AlertModule',
] as const);

export type OwnerModuleGraphqlEnumName = (typeof OWNER_MODULE_GRAPHQL_ENUM_NAMES)[number];

/** The enum reference: the owner modules by key, values being the dictionary codes. */
export type OwnerModuleGraphqlEnum = typeof OWNER_MODULE;

export function registerOwnerModuleEnum(
  name: OwnerModuleGraphqlEnumName,
  description: string,
): OwnerModuleGraphqlEnum {
  const enumRef: OwnerModuleGraphqlEnum = Object.freeze({ ...OWNER_MODULE });
  registerEnumType(enumRef, { name, description });
  return enumRef;
}
