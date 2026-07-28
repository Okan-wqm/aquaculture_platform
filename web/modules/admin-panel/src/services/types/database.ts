// GENERATED backend contracts — tools/codegen/admin-contracts/manifest.ts.
// Imported so shapes below can reference them; re-exported so import sites
// are unchanged.
import type {
  BackupStatus,
  BackupType,
  MigrationStatus,
  SchemaStatus,
  SchemaMigration,
  TenantSchema,
  DatabaseBackup,
} from './generated/admin-contracts';

export type {
  BackupStatus,
  BackupType,
  MigrationStatus,
  SchemaStatus,
  SchemaMigration,
  TenantSchema,
  DatabaseBackup,
};

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
