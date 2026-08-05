/**
 * Database Management Entities
 *
 * Multi-tenant database schema yönetimi için entity ve type tanımları.
 */

import {
  Check,
  Entity,
  PrimaryGeneratedColumn,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

// ============================================================================
// Enums
// ============================================================================

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
export type RestoreStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

// ============================================================================
// Schema Management Entity
// ============================================================================

@Entity('tenant_schemas', { schema: 'admin' })
@Index(['tenantId'], { unique: true })
@Index('UQ_admin_tenant_schemas_schema_name', ['schemaName'], { unique: true })
@Index(['status'])
@Check(
  'CHK_admin_tenant_schema_identity',
  `"schemaName" = 'tenant_' || LEFT(REPLACE("tenantId"::text, '-', ''), 16)`,
)
export class TenantSchema {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 100 })
  schemaName!: string;

  @Column({ type: 'varchar', length: 50, default: 'active' })
  status!: SchemaStatus;

  @Column({ type: 'varchar', length: 20, default: '1.0.0' })
  currentVersion!: string;

  @Column({ type: 'bigint', default: 0 })
  sizeBytes!: number;

  @Column({ type: 'int', default: 0 })
  tableCount!: number;

  @Column({ type: 'int', default: 0 })
  connectionCount!: number;

  @Column({ type: 'int', default: 10 })
  maxConnections!: number;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown>;

  @Column({ type: 'timestamptz', nullable: true })
  lastMigrationAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  lastBackupAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

// ============================================================================
// Migration Entity
// ============================================================================

@Entity('schema_migrations', { schema: 'admin' })
@Index(['tenantId'])
@Index(['status'])
@Index(['version'])
export class SchemaMigration {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  tenantId!: string | null; // null = global migration

  @Column({ type: 'varchar', length: 100 })
  schemaName!: string;

  @Column({ type: 'varchar', length: 200 })
  migrationName!: string;

  @Column({ type: 'varchar', length: 20 })
  version!: string;

  @Column({ type: 'varchar', length: 50, default: 'pending' })
  status!: MigrationStatus;

  @Column({ type: 'text', nullable: true })
  upScript!: string;

  @Column({ type: 'text', nullable: true })
  downScript!: string;

  @Column({ type: 'text', nullable: true })
  errorMessage!: string;

  @Column({ type: 'int', default: 0 })
  executionTimeMs!: number;

  @Column({ type: 'boolean', default: false })
  isDryRun!: boolean;

  @Column({ type: 'jsonb', nullable: true })
  affectedTables!: string[];

  @Column({ type: 'varchar', length: 100, nullable: true })
  executedBy!: string;

  @Column({ type: 'timestamptz', nullable: true })
  startedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;
}

// ============================================================================
// Backup Entity
// ============================================================================

@Entity('schema_backups', { schema: 'admin' })
@Index(['tenantId'])
@Index(['status'])
@Index(['backupType'])
export class SchemaBackup {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  tenantId!: string | null;

  @Column({ type: 'varchar', length: 100 })
  schemaName!: string;

  @Column({ type: 'varchar', length: 50 })
  backupType!: BackupType;

  @Column({ type: 'varchar', length: 50, default: 'pending' })
  status!: BackupStatus;

  @Column({ type: 'varchar', length: 500, nullable: true })
  filePath!: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  fileName!: string;

  @Column({ type: 'bigint', default: 0 })
  sizeBytes!: number;

  @Column({ type: 'varchar', length: 64, nullable: true })
  checksum!: string;

  @Column({ type: 'boolean', default: true })
  isEncrypted!: boolean;

  @Column({ type: 'boolean', default: false })
  isCompressed!: boolean;

  @Column({ type: 'int', default: 0 })
  retentionDays!: number;

  @Column({ type: 'text', nullable: true })
  errorMessage!: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: {
    tableCount?: number;
    rowCount?: number;
    version?: string;
    compressionRatio?: number;
    encryptionAlgorithm?: string;
    encryptionKeyId?: string;
  };

  @Column({ type: 'timestamptz', nullable: true })
  startedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;
}

// ============================================================================
// Retired Backup Ledger Entity
// ============================================================================

@Entity('retired_schema_backups', { schema: 'admin' })
@Index(['tenantId', 'createdAt'])
@Index(['retiredAt'])
export class RetiredSchemaBackup {
  @PrimaryColumn({ type: 'uuid' })
  backupId!: string;

  @Column({ type: 'uuid', nullable: true })
  tenantId!: string | null;

  @Column({ type: 'varchar', length: 100 })
  schemaName!: string;

  @Column({ type: 'varchar', length: 50 })
  backupType!: BackupType;

  @Column({ type: 'varchar', length: 50 })
  status!: BackupStatus;

  @Column({ type: 'varchar', length: 500, nullable: true })
  filePath!: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  fileName!: string | null;

  @Column({ type: 'bigint', default: 0 })
  sizeBytes!: number;

  @Column({ type: 'varchar', length: 64, nullable: true })
  checksum!: string | null;

  @Column({ type: 'boolean', default: false })
  isCompressed!: boolean;

  @Column({ type: 'int', default: 0 })
  retentionDays!: number;

  @Column({ type: 'text', nullable: true })
  errorMessage!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @Column({ type: 'timestamptz', nullable: true })
  startedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  createdAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  retiredAt!: Date;

  @Column({ type: 'varchar', length: 100 })
  retiredReason!: 'legacy_plaintext_backup';

  @Column({ type: 'varchar', length: 100 })
  retiredByMigration!: string;

  @Column({ type: 'uuid', array: true, default: () => 'ARRAY[]::uuid[]' })
  cleanupRunIds!: string[];

  @Column({ type: 'uuid', array: true, default: () => 'ARRAY[]::uuid[]' })
  restoreIds!: string[];

  @Column({ type: 'jsonb' })
  originalRecord!: Record<string, unknown>;
}

// ============================================================================
// Restore Entity
// ============================================================================

@Entity('schema_restores', { schema: 'admin' })
@Index(['tenantId'])
@Index(['backupId'])
@Index(['retiredBackupId'])
@Index(['status'])
export class SchemaRestore {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  backupId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  retiredBackupId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  tenantId!: string | null;

  @Column({ type: 'varchar', length: 100 })
  targetSchemaName!: string;

  @Column({ type: 'varchar', length: 50, default: 'pending' })
  status!: RestoreStatus;

  @Column({ type: 'boolean', default: false })
  isPointInTime!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  pointInTimeTarget!: Date;

  @Column({ type: 'text', nullable: true })
  errorMessage!: string;

  @Column({ type: 'int', default: 0 })
  executionTimeMs!: number;

  @Column({ type: 'varchar', length: 100, nullable: true })
  executedBy!: string;

  @Column({ type: 'jsonb', nullable: true })
  restoredTables!: string[];

  @Column({ type: 'timestamptz', nullable: true })
  startedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;
}

// ============================================================================
// Database Monitoring Entity
// ============================================================================

@Entity('database_metrics', { schema: 'admin' })
@Index(['tenantId'])
@Index(['recordedAt'])
@Index(['metricType'])
export class DatabaseMetric {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  tenantId!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  schemaName!: string;

  @Column({ type: 'varchar', length: 50 })
  metricType!: string;

  @Column({ type: 'jsonb' })
  metrics!: DatabaseMetricData;

  @Column({ type: 'timestamptz' })
  recordedAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;
}

// ============================================================================
// Slow Query Log Entity
// ============================================================================

@Entity('slow_query_logs', { schema: 'admin' })
@Index(['tenantId'])
@Index(['executionTimeMs'])
@Index(['recordedAt'])
export class SlowQueryLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  tenantId!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  schemaName!: string;

  @Column({ type: 'text' })
  query!: string;

  @Column({ type: 'text', nullable: true })
  normalizedQuery!: string;

  @Column({ type: 'int' })
  executionTimeMs!: number;

  @Column({ type: 'int', default: 0 })
  rowsAffected!: number;

  @Column({ type: 'int', default: 0 })
  rowsExamined!: number;

  @Column({ type: 'boolean', default: false })
  usedIndex!: boolean;

  @Column({ type: 'jsonb', nullable: true })
  explainPlan!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 200, nullable: true })
  sourceTable!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  userId!: string;

  @Column({ type: 'timestamptz' })
  recordedAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;
}

// ============================================================================
// Types
// ============================================================================

export interface DatabaseMetricData {
  // Connection metrics
  activeConnections?: number;
  idleConnections?: number;
  maxConnections?: number;
  connectionUtilization?: number;

  // Query metrics
  queriesPerSecond?: number;
  avgQueryTime?: number;
  slowQueries?: number;
  failedQueries?: number;

  // Storage metrics
  totalSizeBytes?: number;
  dataSizeBytes?: number;
  indexSizeBytes?: number;
  freeSizeBytes?: number;

  // Table metrics
  tableCount?: number;
  rowCount?: number;
  deadTuples?: number;

  // Performance metrics
  cacheHitRatio?: number;
  indexHitRatio?: number;
  bufferHitRatio?: number;
  transactionsPerSecond?: number;

  // Lock metrics
  activeLocks?: number;
  waitingLocks?: number;
  deadlocks?: number;
}

export interface SchemaInfo {
  schemaName: string;
  tenantId: string;
  status: SchemaStatus;
  version: string;
  sizeBytes: number;
  tableCount: number;
  tables: TableInfo[];
  createdAt: Date;
  lastMigrationAt: Date | null;
  lastBackupAt: Date | null;
}

export interface TableInfo {
  tableName: string;
  rowCount: number;
  sizeBytes: number;
  indexCount: number;
  lastVacuum: Date | null;
  lastAnalyze: Date | null;
}

export interface MigrationPlan {
  id: string;
  name: string;
  version: string;
  description: string;
  upScript: string;
  downScript: string;
  affectedTables: string[];
  estimatedDuration: number;
  isDestructive: boolean;
  requiresDowntime: boolean;
}

export interface MigrationResult {
  migrationId: string;
  tenantId: string | null;
  schemaName: string;
  status: MigrationStatus;
  executionTimeMs: number;
  error?: string;
}

export interface BackupOptions {
  tenantId?: string;
  backupType: BackupType;
  compress?: boolean;
  encrypt?: boolean;
  retentionDays?: number;
  includeIndexes?: boolean;
  excludeTables?: string[];
  auditActorId?: string;
}

export interface RestoreOptions {
  backupId: string;
  targetSchemaName?: string;
  pointInTime?: Date;
  tablesToRestore?: string[];
  auditActorId?: string;
}

export interface ConnectionPoolStatus {
  poolName: string;
  totalConnections: number;
  activeConnections: number;
  idleConnections: number;
  waitingRequests: number;
  maxConnections: number;
  utilizationPercent: number;
}

export interface IndexRecommendation {
  tableName: string;
  columns: string[];
  indexType: 'btree' | 'hash' | 'gin' | 'gist';
  reason: string;
  estimatedImpact: 'high' | 'medium' | 'low';
  recommendedAction: 'add_index' | 'review_unused_index';
  indexName: string;
  authority: 'db-migrate';
}

export interface DatabaseHealthStatus {
  status: 'healthy' | 'warning' | 'critical';
  score: number;
  checks: HealthCheck[];
  recommendations: string[];
}

export interface HealthCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  value: number | string;
  threshold?: number | string;
  message: string;
}

/**
 * Structured response for slow query monitoring.
 *
 * The `source` field indicates which data provider was used:
 * - 'slow_query_logs': Internal application-level slow query log table
 * - 'pg_stat_statements': PostgreSQL extension with historical query stats
 * - 'pg_stat_activity': Currently running queries (always available)
 * - 'none': All sources failed; data will be empty with an error in metadata
 */
export type SlowQuerySource =
  | 'slow_query_logs'
  | 'pg_stat_statements'
  | 'pg_stat_activity'
  | 'none';

export interface SlowQueryResultMetadata {
  total: number;
  limit: number;
  minExecutionTimeMs?: number;
  note?: string;
  error?: string;
}

export interface SlowQueryResult {
  source: SlowQuerySource;
  data: Record<string, unknown>[];
  metadata: SlowQueryResultMetadata;
}
