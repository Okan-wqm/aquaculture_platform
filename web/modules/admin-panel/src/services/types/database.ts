/**
 * Database management types — the response shapes admin-api's
 * database-management endpoints actually return. These mirror the backend
 * entities (apps/admin-api-service/src/database-management/entities/database-management.entity.ts),
 * which the list/detail endpoints return directly. Kept in lockstep by
 * tests/invariants/admin-database-types-parity.spec.ts (APA-326): a field name
 * that is not on the backend entity — the old `type`/`location`/`compressionType`/
 * `encryptionKey`/`createdBy`/`sql`/`appliedToSchemas`/`failedSchemas` drift, which
 * made the pages read undefined and silently fall back to the wrong value — fails
 * that gate.
 */

export type SchemaStatus =
  | 'creating'
  | 'active'
  | 'migrating'
  | 'suspended'
  | 'pending_deletion'
  | 'deleted';
export type MigrationStatus = 'pending' | 'running' | 'completed' | 'failed' | 'rolled_back';
export type BackupStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'expired';
export type BackupType = 'full' | 'incremental' | 'differential';

export interface TenantSchema {
  id: string;
  tenantId: string;
  schemaName: string;
  status: SchemaStatus;
  currentVersion: string;
  sizeBytes: number;
  tableCount: number;
  connectionCount: number;
  maxConnections: number;
  lastMigrationAt?: string | null;
  lastBackupAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SchemaMigration {
  id: string;
  tenantId: string | null;
  schemaName: string;
  migrationName: string;
  version: string;
  status: MigrationStatus;
  upScript?: string;
  downScript?: string;
  errorMessage?: string;
  executionTimeMs: number;
  isDryRun: boolean;
  affectedTables?: string[];
  executedBy?: string | null;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
}

export interface DatabaseBackup {
  id: string;
  tenantId?: string | null;
  schemaName: string;
  backupType: BackupType;
  status: BackupStatus;
  filePath?: string;
  fileName?: string;
  sizeBytes: number;
  checksum?: string;
  isEncrypted: boolean;
  isCompressed: boolean;
  retentionDays: number;
  errorMessage?: string;
  metadata?: {
    tableCount?: number;
    rowCount?: number;
    version?: string;
    compressionRatio?: number;
    encryptionAlgorithm?: string;
    encryptionKeyId?: string;
  };
  startedAt?: string;
  completedAt?: string;
  expiresAt?: string;
  createdAt: string;
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
