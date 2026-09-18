/**
 * Database management types
 */

import type { ApiSchema } from '../contract';

export type TenantSchema = ApiSchema<'TenantSchema'>;

/**
 * One `admin.schema_migrations` row, as the `/database/migrations` endpoints
 * return it.
 *
 * The hand-written copy named almost every field differently — `name`, `sql`,
 * `rollbackSql`, `error`, `createdBy`, plus `type`, `appliedToSchemas` and
 * `failedSchemas` that have no counterpart at all — against the row's
 * `migrationName`, `upScript`, `downScript`, `errorMessage`, `executedBy`,
 * `schemaName` and `affectedTables`. `DatabaseManagementPage` had already
 * noticed and papered over it with `migration.name || migration.migrationName`
 * and a third declaration carrying both spellings as optional
 * (ADMIN-MEDIUM-111). Sourced from the contract, one spelling exists.
 */
export type SchemaMigration = ApiSchema<'SchemaMigration'>;

export interface DatabaseStats {
  totalSize: string;
  tableCount: number;
  indexCount: number;
  connectionPool: {
    total: number;
    active: number;
    idle: number;
    waiting: number;
  };
  replication?: {
    status: string;
    lag: number;
    replicas: number;
  };
  performance: {
    avgQueryTime: number;
    slowQueries: number;
    cacheHitRatio: number;
    deadlocks: number;
  };
}

export interface SlowQuery {
  query: string;
  duration: number;
  calls: number;
  avgDuration: number;
  schema?: string;
  timestamp: string;
}
