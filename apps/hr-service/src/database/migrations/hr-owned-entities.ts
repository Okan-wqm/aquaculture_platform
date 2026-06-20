import {
  validateSqlIdentifier,
  type SqlIdentifierKind,
} from '@aquaculture/backend-common/database';
import type { EntityMetadata } from 'typeorm';

const HR_SOURCE_SCHEMA = 'hr';

/**
 * HR owns both explicit `schema: 'hr'` infrastructure tables and the
 * schema-less tenant-routed entities whose source shape lives in `hr`.
 *
 * Historical HR catch-up migrations filtered only `meta.schema === 'hr'`.
 * After tenant-aware entities dropped their explicit schema, that filter
 * silently ignored the real business tables when the centralized
 * db-migrate runner had entity metadata loaded.
 */
export function isHrOwnedEntity(meta: EntityMetadata): boolean {
  if (meta.synchronize === false) return false;
  return meta.schema === HR_SOURCE_SCHEMA || meta.schema === undefined;
}

export function listHrOwnedEntities(metas: readonly EntityMetadata[]): EntityMetadata[] {
  return metas.filter(isHrOwnedEntity);
}

export function quoteIdent(identifier: string, kind: SqlIdentifierKind = 'schema'): string {
  return `"${validateSqlIdentifier(identifier, kind)}"`;
}

export function quoteQualified(schema: string, table: string): string {
  return `${quoteIdent(schema, 'schema')}.${quoteIdent(table, 'table')}`;
}

export function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}
