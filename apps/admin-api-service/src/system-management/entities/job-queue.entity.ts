import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum JobStatus {
  PENDING = 'pending',
  SCHEDULED = 'scheduled',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  RETRYING = 'retrying',
  PAUSED = 'paused',
}

export enum JobPriority {
  LOW = 1,
  NORMAL = 5,
  HIGH = 10,
  CRITICAL = 20,
}

export enum JobType {
  SCHEDULED = 'scheduled',
  IMMEDIATE = 'immediate',
  RECURRING = 'recurring',
  DELAYED = 'delayed',
  TRIGGERED = 'triggered',
}

/**
 * A job's progress, as stored in the `progress` jsonb column and served on
 * `BackgroundJob`.
 *
 * A CLASS, not an interface, because the OpenAPI generator's swagger plugin
 * visits `*.entity.ts` and can only describe classes: as an interface this
 * came out of the contract as `progress?: Record<string, never>` — an object
 * with no declared keys — so `JobQueuePage` read `job.progress.percentage`
 * through a type that says the property cannot exist, and the progress bar
 * rendered `undefined%` to anyone whose eslint config was not strict enough
 * to catch it (ADMIN-HIGH-127). No runtime change: this is still a plain
 * object in a jsonb column.
 */
export class JobProgress {
  current!: number;
  total!: number;
  percentage!: number;
  message?: string;
  checkpoint?: unknown;
}

export interface JobRetryPolicy {
  maxRetries: number;
  retryDelay: number;
  exponentialBackoff: boolean;
  backoffMultiplier?: number;
  maxDelay?: number;
}

@Entity('background_jobs', { schema: 'admin' })
@Index(['status', 'priority', 'scheduledAt'])
@Index(['queueName', 'status'])
@Index(['jobType', 'status'])
@Index(['tenantId', 'status'])
export class BackgroundJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ length: 255 })
  name!: string;

  @Column({ length: 100 })
  queueName!: string;

  @Column({ type: 'varchar', length: 50, default: JobType.IMMEDIATE })
  jobType!: JobType;

  @Column({ type: 'varchar', length: 50, default: JobStatus.PENDING })
  status!: JobStatus;

  @Column({ type: 'int', default: JobPriority.NORMAL })
  priority!: number;

  @Column({ type: 'jsonb', nullable: true })
  payload?: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  result?: Record<string, unknown>;

  @Column({ type: 'text', nullable: true })
  errorMessage?: string;

  @Column({ type: 'text', nullable: true })
  stackTrace?: string;

  @Column({ type: 'jsonb', nullable: true })
  progress?: JobProgress;

  @Column({ type: 'uuid', nullable: true })
  tenantId?: string;

  @Column({ type: 'uuid', nullable: true })
  userId?: string;

  @Column({ type: 'timestamptz', nullable: true })
  scheduledAt?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  startedAt?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt?: Date;

  @Column({ type: 'int', nullable: true })
  durationMs?: number;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'int', default: 3 })
  maxAttempts!: number;

  @Column({ type: 'jsonb', nullable: true })
  retryPolicy?: JobRetryPolicy;

  @Column({ type: 'timestamptz', nullable: true })
  nextRetryAt?: Date;

  @Column({ type: 'text', nullable: true })
  cronExpression?: string;

  @Column({ type: 'timestamptz', nullable: true })
  lastRunAt?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  nextRunAt?: Date;

  @Column({ type: 'int', default: 3600000 })
  timeoutMs!: number;

  @Column({ type: 'jsonb', nullable: true })
  dependencies?: string[];

  @Column({ type: 'uuid', nullable: true })
  parentJobId?: string;

  @Column({ type: 'jsonb', nullable: true })
  tags?: string[];

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @Column({ length: 100, nullable: true })
  workerId?: string;

  @Column({ default: false })
  isRecurring!: boolean;

  @Column({ default: false })
  isPaused!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

@Entity('job_execution_logs', { schema: 'admin' })
@Index(['jobId', 'timestamp'])
@Index(['timestamp'])
export class JobExecutionLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  jobId!: string;

  @Column({ type: 'int' })
  attemptNumber!: number;

  @Column({ type: 'varchar', length: 50 })
  status!: JobStatus;

  @Column({ type: 'timestamptz' })
  startedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt?: Date;

  @Column({ type: 'int', nullable: true })
  durationMs?: number;

  @Column({ type: 'text', nullable: true })
  errorMessage?: string;

  @Column({ type: 'text', nullable: true })
  stackTrace?: string;

  @Column({ type: 'jsonb', nullable: true })
  result?: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  logs?: Array<{
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    timestamp: Date;
    data?: Record<string, unknown>;
  }>;

  @Column({ length: 100, nullable: true })
  workerId?: string;

  @Column({ type: 'float', nullable: true })
  cpuUsage?: number;

  @Column({ type: 'float', nullable: true })
  memoryUsage?: number;

  @Column({ type: 'timestamptz' })
  timestamp!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

@Entity('job_queues', { schema: 'admin' })
@Index(['name'], { unique: true })
export class JobQueue {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ length: 100 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ default: true })
  isActive!: boolean;

  @Column({ default: false })
  isPaused!: boolean;

  @Column({ type: 'int', default: 10 })
  concurrency!: number;

  @Column({ type: 'int', default: 100 })
  maxJobsPerSecond!: number;

  @Column({ type: 'int', default: 3 })
  defaultMaxRetries!: number;

  @Column({ type: 'int', default: 3600000 })
  defaultTimeoutMs!: number;

  @Column({ type: 'jsonb', nullable: true })
  retryPolicy?: JobRetryPolicy;

  @Column({ type: 'int', default: 0 })
  pendingCount!: number;

  @Column({ type: 'int', default: 0 })
  runningCount!: number;

  @Column({ type: 'int', default: 0 })
  completedCount!: number;

  @Column({ type: 'int', default: 0 })
  failedCount!: number;

  @Column({ type: 'float', nullable: true })
  avgProcessingTimeMs?: number;

  @Column({ type: 'timestamptz', nullable: true })
  lastJobAt?: Date;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
