/**
 * Database management types
 */

export interface TenantSchema {
  tenantId: string;
  tenantName: string;
  schemaName: string;
  status: 'active' | 'suspended' | 'archived' | 'migration_pending';
  tableCount: number;
  sizeBytes: number;
  rowCount: number;
  lastMigrationAt?: string;
  currentVersion: string;
  createdAt: string;
}

export interface SchemaMigration {
  id: string;
  version: string;
  name: string;
  description?: string;
  type: 'schema' | 'data' | 'index' | 'rollback';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'rolled_back';
  appliedToSchemas: string[];
  failedSchemas: string[];
  startedAt?: string;
  completedAt?: string;
  error?: string;
  sql?: string;
  rollbackSql?: string;
  createdBy: string;
  createdAt: string;
}

export interface DatabaseBackup {
  id: string;
  type: 'full' | 'incremental' | 'schema_only' | 'data_only';
  status: 'pending' | 'running' | 'completed' | 'failed';
  tenantId?: string;
  schemaName?: string;
  sizeBytes?: number;
  location: string;
  compressionType?: string;
  encryptionKey?: string;
  startedAt: string;
  completedAt?: string;
  expiresAt?: string;
  error?: string;
  createdBy: string;
}

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
