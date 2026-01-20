import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export enum DebugSessionType {
  QUERY_INSPECTION = 'query_inspection',
  API_LOG_VIEWING = 'api_log_viewing',
  CACHE_INSPECTION = 'cache_inspection',
  FEATURE_FLAG_OVERRIDE = 'feature_flag_override',
  PERFORMANCE_PROFILING = 'performance_profiling',
  ERROR_DEBUGGING = 'error_debugging',
}

export enum QueryLogType {
  SELECT = 'select',
  INSERT = 'insert',
  UPDATE = 'update',
  DELETE = 'delete',
  TRANSACTION = 'transaction',
  SCHEMA = 'schema',
}

@Entity('debug_sessions')
@Index(['adminId', 'tenantId'])
@Index(['sessionType', 'createdAt'])
@Index(['isActive'])
export class DebugSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  adminId: string;

  @Column({ type: 'uuid' })
  tenantId: string;

  @Column({ type: 'varchar', length: 50 })
  sessionType: DebugSessionType;

  @Column({ default: true })
  isActive: boolean;

  @Column({ type: 'jsonb', nullable: true })
  configuration: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  filters: {
    startTime?: Date;
    endTime?: Date;
    queryTypes?: QueryLogType[];
    apiEndpoints?: string[];
    cacheKeys?: string[];
    minDuration?: number;
    includeErrors?: boolean;
    userId?: string;
  };

  @Column({ type: 'int', default: 1000 })
  maxResults: number;

  @Column({ nullable: true })
  expiresAt: Date;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown>;

  @CreateDateColumn()
  createdAt: Date;
}

@Entity('captured_queries')
@Index(['debugSessionId', 'timestamp'])
@Index(['tenantId', 'timestamp'])
@Index(['queryType', 'durationMs'])
export class CapturedQuery {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true })
  debugSessionId: string;

  @Column({ type: 'uuid' })
  tenantId: string;

  @Column({ type: 'uuid', nullable: true })
  userId: string;

  @Column({ type: 'varchar', length: 50 })
  queryType: QueryLogType;

  @Column({ type: 'text' })
  query: string;

  @Column({ type: 'jsonb', nullable: true })
  parameters: unknown[];

  @Column({ type: 'text', nullable: true })
  normalizedQuery: string;

  @Column({ type: 'float' })
  durationMs: number;

  @Column({ type: 'int', nullable: true })
  rowsAffected: number;

  @Column({ type: 'int', nullable: true })
  rowsReturned: number;

  @Column({ type: 'text', nullable: true })
  tableName: string;

  @Column({ type: 'jsonb', nullable: true })
  explainPlan: Record<string, unknown>;

  @Column({ default: false })
  isSlowQuery: boolean;

  @Column({ default: false })
  hasError: boolean;

  @Column({ type: 'text', nullable: true })
  errorMessage: string;

  @Column({ type: 'text', nullable: true })
  stackTrace: string;

  @Column({ type: 'inet', nullable: true })
  connectionSource: string;

  @Column()
  timestamp: Date;

  @CreateDateColumn()
  createdAt: Date;
}

@Entity('captured_api_calls')
@Index(['debugSessionId', 'timestamp'])
@Index(['tenantId', 'timestamp'])
@Index(['endpoint', 'method'])
export class CapturedApiCall {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true })
  debugSessionId: string;

  @Column({ type: 'uuid' })
  tenantId: string;

  @Column({ type: 'uuid', nullable: true })
  userId: string;

  @Column({ length: 10 })
  method: string;

  @Column({ length: 500 })
  endpoint: string;

  @Column({ type: 'text', nullable: true })
  fullUrl: string;

  @Column({ type: 'jsonb', nullable: true })
  requestHeaders: Record<string, string>;

  @Column({ type: 'jsonb', nullable: true })
  requestBody: unknown;

  @Column({ type: 'jsonb', nullable: true })
  queryParams: Record<string, string>;

  @Column({ type: 'int' })
  responseStatus: number;

  @Column({ type: 'jsonb', nullable: true })
  responseHeaders: Record<string, string>;

  @Column({ type: 'jsonb', nullable: true })
  responseBody: unknown;

  @Column({ type: 'float' })
  durationMs: number;

  @Column({ type: 'inet', nullable: true })
  clientIp: string;

  @Column({ type: 'text', nullable: true })
  userAgent: string;

  @Column({ type: 'text', nullable: true })
  correlationId: string;

  @Column({ default: false })
  hasError: boolean;

  @Column({ type: 'text', nullable: true })
  errorMessage: string;

  @Column()
  timestamp: Date;

  @CreateDateColumn()
  createdAt: Date;
}

@Entity('cache_entries_snapshot')
@Index(['debugSessionId', 'capturedAt'])
@Index(['tenantId', 'key'])
export class CacheEntrySnapshot {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true })
  debugSessionId: string;

  @Column({ type: 'uuid', nullable: true })
  tenantId: string;

  @Column({ length: 500 })
  key: string;

  @Column({ type: 'jsonb', nullable: true })
  value: unknown;

  @Column({ type: 'int', nullable: true })
  sizeBytes: number;

  @Column({ type: 'int', nullable: true })
  ttlSeconds: number;

  @Column({ nullable: true })
  expiresAt: Date;

  @Column({ type: 'int', default: 0 })
  hitCount: number;

  @Column({ nullable: true })
  lastAccessedAt: Date;

  @Column({ length: 100, nullable: true })
  cacheStore: string;

  @Column({ type: 'jsonb', nullable: true })
  tags: string[];

  @Column()
  capturedAt: Date;

  @CreateDateColumn()
  createdAt: Date;
}

@Entity('feature_flag_overrides')
@Index(['tenantId', 'featureKey'])
@Index(['adminId', 'isActive'])
export class FeatureFlagOverride {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tenantId: string;

  @Column({ length: 100 })
  featureKey: string;

  @Column({ type: 'jsonb' })
  originalValue: unknown;

  @Column({ type: 'jsonb' })
  overrideValue: unknown;

  @Column({ default: true })
  isActive: boolean;

  @Column({ type: 'uuid' })
  adminId: string;

  @Column({ type: 'text', nullable: true })
  reason: string;

  @Column({ nullable: true })
  expiresAt: Date;

  @Column({ nullable: true })
  appliedAt: Date;

  @Column({ nullable: true })
  revertedAt: Date;

  @Column({ type: 'uuid', nullable: true })
  revertedBy: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown>;

  @CreateDateColumn()
  createdAt: Date;
}
