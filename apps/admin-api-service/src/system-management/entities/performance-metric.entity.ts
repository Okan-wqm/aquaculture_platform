import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export enum MetricType {
  // Application metrics
  RESPONSE_TIME = 'response_time',
  THROUGHPUT = 'throughput',
  ERROR_RATE = 'error_rate',
  APDEX = 'apdex',
  ACTIVE_USERS = 'active_users',
  REQUEST_COUNT = 'request_count',

  // Database metrics
  DB_CONNECTION_POOL = 'db_connection_pool',
  DB_QUERY_TIME = 'db_query_time',
  DB_CACHE_HIT_RATIO = 'db_cache_hit_ratio',
  DB_DEADLOCKS = 'db_deadlocks',
  DB_ACTIVE_CONNECTIONS = 'db_active_connections',
  DB_SLOW_QUERIES = 'db_slow_queries',

  // Infrastructure metrics
  CPU_USAGE = 'cpu_usage',
  MEMORY_USAGE = 'memory_usage',
  DISK_USAGE = 'disk_usage',
  NETWORK_LATENCY = 'network_latency',
  CONTAINER_HEALTH = 'container_health',
  POD_RESTARTS = 'pod_restarts',

  // Custom metrics
  CUSTOM = 'custom',
}

export enum MetricAggregation {
  AVG = 'avg',
  MIN = 'min',
  MAX = 'max',
  SUM = 'sum',
  COUNT = 'count',
  P50 = 'p50',
  P90 = 'p90',
  P95 = 'p95',
  P99 = 'p99',
}

export interface MetricDimensions {
  service?: string;
  endpoint?: string;
  method?: string;
  region?: string;
  tenantId?: string;
  environment?: string;
  host?: string;
  container?: string;
  database?: string;
  [key: string]: string | undefined;
}

@Entity('performance_metrics', { schema: 'admin' })
@Index(['metricType', 'timestamp'])
@Index(['service', 'timestamp'])
@Index(['timestamp'])
export class PerformanceMetric {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 50 })
  metricType!: MetricType;

  @Column({ length: 200 })
  name!: string;

  @Column({ type: 'float' })
  value!: number;

  @Column({ type: 'varchar', length: 50, nullable: true })
  unit?: string;

  @Column({ type: 'varchar', length: 20, default: MetricAggregation.AVG })
  aggregation!: MetricAggregation;

  @Column({ length: 100, nullable: true })
  service?: string;

  @Column({ type: 'jsonb', nullable: true })
  dimensions?: MetricDimensions;

  @Column({ type: 'jsonb', nullable: true })
  percentiles?: {
    p50?: number;
    p90?: number;
    p95?: number;
    p99?: number;
  };

  @Column({ type: 'jsonb', nullable: true })
  histogram?: {
    buckets: number[];
    counts: number[];
  };

  @Column({ type: 'int', nullable: true })
  sampleCount?: number;

  @Column({ type: 'float', nullable: true })
  minValue?: number;

  @Column({ type: 'float', nullable: true })
  maxValue?: number;

  @Column()
  timestamp!: Date;

  @Column({ type: 'int', default: 60 })
  intervalSeconds!: number;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @CreateDateColumn()
  createdAt!: Date;
}

/**
 * The measured shapes, declared ONCE.
 *
 * `PerformanceMonitoringService` used to re-declare all three, so the jsonb
 * column and the API response could drift apart silently — and did: the service
 * now models "not measured" as `null`, which a duplicated `number` here would
 * have rejected at exactly the boundary that persists it.
 *
 * `null` is NOT MEASURED and it is a different fact from zero. Every one of
 * these was a plain `number` filled with a fabricated 0 whenever the value could
 * not be read, so an unreachable database rendered as an idle healthy one and an
 * empty metrics window rendered as a perfect Apdex of 1.0
 * (ADMIN-HIGH-014 / OBS-CRITICAL-003).
 */
export interface ApplicationMetrics {
  avgResponseTime: number | null;
  p95ResponseTime: number | null;
  p99ResponseTime: number | null;
  throughput: number | null;
  errorRate: number | null;
  apdexScore: number | null;
  activeRequests: number | null;
  totalRequests: number | null;
}

export interface DatabaseMetrics {
  activeConnections: number | null;
  poolSize: number | null;
  poolUtilization: number | null;
  avgQueryTime: number | null;
  slowQueryCount: number | null;
  cacheHitRatio: number | null;
  deadlockCount: number | null;
}

export interface InfrastructureMetrics {
  cpuUsage: number;
  memoryUsage: number;
  memoryTotal: number;
  diskUsage: number;
  diskTotal: number;
  networkLatency: number;
  containerCount: number;
  healthyContainers: number;
  podRestarts: number;
}

@Entity('performance_snapshots', { schema: 'admin' })
@Index(['timestamp'])
@Index(['service'])
export class PerformanceSnapshot {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ length: 100, nullable: true })
  service?: string;

  @Column()
  timestamp!: Date;

  @Column({ type: 'jsonb' })
  applicationMetrics!: ApplicationMetrics;

  @Column({ type: 'jsonb' })
  databaseMetrics!: DatabaseMetrics;

  @Column({ type: 'jsonb' })
  infrastructureMetrics!: InfrastructureMetrics;

  @Column({ type: 'jsonb', nullable: true })
  alerts?: Array<{
    metric: string;
    threshold: number;
    currentValue: number;
    severity: 'warning' | 'critical';
  }>;

  @Column({ type: 'float', nullable: true })
  overallHealthScore?: number;

  @CreateDateColumn()
  createdAt!: Date;
}
