import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum ErrorSeverity {
  DEBUG = 'debug',
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  CRITICAL = 'critical',
  FATAL = 'fatal',
}

export enum ErrorStatus {
  NEW = 'new',
  ACKNOWLEDGED = 'acknowledged',
  IN_PROGRESS = 'in_progress',
  RESOLVED = 'resolved',
  IGNORED = 'ignored',
  RECURRING = 'recurring',
}

export interface StackFrame {
  filename: string;
  function: string;
  lineno: number;
  colno?: number;
  context?: string[];
  inApp?: boolean;
}

export interface ErrorContext {
  user?: {
    id: string;
    email?: string;
    tenantId?: string;
  };
  request?: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
    queryParams?: Record<string, string>;
  };
  response?: {
    statusCode: number;
    body?: unknown;
  };
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  breadcrumbs?: Array<{
    type: string;
    category: string;
    message: string;
    timestamp: Date;
    data?: Record<string, unknown>;
  }>;
}

@Entity('error_occurrences')
@Index(['fingerprint', 'timestamp'])
@Index(['groupId'])
@Index(['severity', 'timestamp'])
@Index(['service', 'timestamp'])
export class ErrorOccurrence {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  groupId!: string;

  @Column({ length: 64 })
  fingerprint!: string;

  @Column({ type: 'varchar', length: 50, default: ErrorSeverity.ERROR })
  severity!: ErrorSeverity;

  @Column({ length: 500 })
  message!: string;

  @Column({ length: 255, nullable: true })
  errorType?: string;

  @Column({ type: 'text', nullable: true })
  stackTrace?: string;

  @Column({ type: 'jsonb', nullable: true })
  stackFrames?: StackFrame[];

  @Column({ type: 'jsonb', nullable: true })
  context?: ErrorContext;

  @Column({ length: 100, nullable: true })
  service?: string;

  @Column({ length: 100, nullable: true })
  environment?: string;

  @Column({ length: 50, nullable: true })
  release?: string;

  @Column({ type: 'uuid', nullable: true })
  tenantId?: string;

  @Column({ type: 'uuid', nullable: true })
  userId?: string;

  @Column({ type: 'inet', nullable: true })
  ipAddress?: string;

  @Column({ type: 'text', nullable: true })
  userAgent?: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @Column()
  timestamp!: Date;

  @CreateDateColumn()
  createdAt!: Date;
}

@Entity('error_groups')
@Index(['fingerprint'], { unique: true })
@Index(['status', 'lastSeenAt'])
@Index(['severity', 'occurrenceCount'])
@Index(['service'])
export class ErrorGroup {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ length: 64 })
  fingerprint!: string;

  @Column({ type: 'varchar', length: 50, default: ErrorSeverity.ERROR })
  severity!: ErrorSeverity;

  @Column({ type: 'varchar', length: 50, default: ErrorStatus.NEW })
  status!: ErrorStatus;

  @Column({ length: 500 })
  message!: string;

  @Column({ length: 255, nullable: true })
  errorType?: string;

  @Column({ length: 100, nullable: true })
  service?: string;

  @Column({ type: 'text', nullable: true })
  culprit?: string;

  @Column({ type: 'int', default: 1 })
  occurrenceCount!: number;

  @Column({ type: 'int', default: 0 })
  userCount!: number;

  @Column()
  firstSeenAt!: Date;

  @Column()
  lastSeenAt!: Date;

  @Column({ type: 'jsonb', nullable: true })
  affectedTenants?: string[];

  @Column({ type: 'jsonb', nullable: true })
  affectedReleases?: string[];

  @Column({ type: 'jsonb', nullable: true })
  tags?: Record<string, string[]>;

  @Column({ type: 'uuid', nullable: true })
  assignedTo?: string;

  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Column({ nullable: true })
  resolvedAt?: Date;

  @Column({ type: 'uuid', nullable: true })
  resolvedBy?: string;

  @Column({ type: 'text', nullable: true })
  resolutionNotes?: string;

  @Column({ type: 'text', nullable: true })
  linkedTicketUrl?: string;

  @Column({ default: false })
  isRegression!: boolean;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

@Entity('error_alert_rules')
@Index(['isActive'])
export class ErrorAlertRule {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ length: 255 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ default: true })
  isActive!: boolean;

  @Column({ type: 'jsonb' })
  conditions!: {
    severity?: ErrorSeverity[];
    service?: string[];
    errorType?: string[];
    messagePattern?: string;
    occurrenceThreshold?: number;
    timeWindowMinutes?: number;
    userCountThreshold?: number;
  };

  @Column({ type: 'jsonb' })
  actions!: Array<{
    type: 'email' | 'slack' | 'pagerduty' | 'webhook' | 'sms';
    config: Record<string, unknown>;
  }>;

  @Column({ type: 'int', default: 15 })
  cooldownMinutes!: number;

  @Column({ nullable: true })
  lastTriggeredAt?: Date;

  @Column({ type: 'int', default: 0 })
  triggerCount!: number;

  @Column({ nullable: true })
  createdBy?: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
