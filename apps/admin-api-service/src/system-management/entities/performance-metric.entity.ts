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

@Entity('performance_metrics')
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

@Entity('performance_snapshots')
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
  applicationMetrics!: {
    avgResponseTime: number;
    p95ResponseTime: number;
    p99ResponseTime: number;
    throughput: number;
    errorRate: number;
    apdexScore: number;
    activeRequests: number;
    totalRequests: number;
  };

  @Column({ type: 'jsonb' })
  databaseMetrics!: {
    activeConnections: number;
    poolSize: number;
    poolUtilization: number;
    avgQueryTime: number;
    slowQueryCount: number;
    cacheHitRatio: number;
    deadlockCount: number;
  };

  @Column({ type: 'jsonb' })
  infrastructureMetrics!: {
    cpuUsage: number;
    memoryUsage: number;
    memoryTotal: number;
    diskUsage: number;
    diskTotal: number;
    networkLatency: number;
    containerCount: number;
    healthyContainers: number;
    podRestarts: number;
  };

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
