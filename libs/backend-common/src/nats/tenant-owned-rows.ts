import { NotFoundException } from '@nestjs/common';
import type { EntityTarget, FindOptionsWhere, ObjectLiteral } from 'typeorm';

import type { TenantScope } from '../database/tenant-scope';
import { isValidUUID } from '../database/tenant-schema.utils';

/**
 * Which table a request field's id must be a row of (K10 layer 4, PR-T1).
 * `entityFor` picks the table from the other request fields (e.g. a feeding
 * summary's `entityId` is a batch or a tank depending on `entityType`).
 */
export type TenantOwnerRule =
  | { readonly entity: EntityTarget<ObjectLiteral> }
  | {
      readonly entityFor: (
        fields: Readonly<Record<string, unknown>>,
      ) => EntityTarget<ObjectLiteral>;
    };

/** request field name → the table its id must be a row of, in the requesting tenant. */
export type TenantOwnerRegistry = Readonly<Record<string, TenantOwnerRule>>;

/** A request field that names a row: `*Id` by the platform's naming convention. */
const ID_FIELD = /Id$/;

/**
 * Id fields of a request that the service declared no owner table for.
 *
 * WHY fail closed on them: a responder whose request carries an id nobody
 * resolves would answer for an id another tenant owns with an empty or
 * default result ("no blocking events", "0 kg") — indistinguishable from a
 * real answer. Refusing the request makes adding the owner rule the only way
 * to ship a new id field.
 */
export function undeclaredIdFields(
  fields: Readonly<Record<string, unknown>>,
  owners: TenantOwnerRegistry,
): string[] {
  return Object.keys(fields).filter((field) => ID_FIELD.test(field) && !(field in owners));
}

/**
 * Resolve every id the request names to a row of the scope's tenant, before
 * the handler runs.
 *
 * WHAT: for each field with an owner rule and a value, look the row up by id
 * (and by `tenantId` when the table carries one) through the scope's
 * tenant-pinned connection. An id that is not such a row is a
 * `NotFoundException` — the responder's NOT_FOUND — so no handler ever
 * computes an answer for another tenant's id.
 *
 * INVARIANT: the handler of an id-taking subject runs only after every id it
 * was given resolved inside the requesting tenant; if violated → a foreign id
 * yields a default answer that the model presents as fact.
 */
export async function resolveTenantOwnedRows(
  scope: TenantScope,
  fields: Readonly<Record<string, unknown>>,
  owners: TenantOwnerRegistry,
): Promise<void> {
  for (const [field, value] of Object.entries(fields)) {
    const rule = owners[field];
    if (rule === undefined || value === undefined || value === null) continue;
    if (typeof value !== 'string' || !isValidUUID(value)) {
      throw new NotFoundException(`${field} is not a record of this tenant`);
    }
    const entity = 'entity' in rule ? rule.entity : rule.entityFor(fields);
    const repository = scope.manager.getRepository(entity);
    if (repository.metadata.findColumnWithPropertyName('id') === undefined) {
      throw new Error(`owner rule for ${field} names a table without an id column`);
    }
    const where: FindOptionsWhere<ObjectLiteral> = { id: value };
    if (repository.metadata.findColumnWithPropertyName('tenantId') !== undefined) {
      where['tenantId'] = scope.tenantId;
    }
    const row = await repository.findOne({ where, select: { id: true } });
    if (row === null) {
      throw new NotFoundException(`${field} is not a record of this tenant`);
    }
  }
}
