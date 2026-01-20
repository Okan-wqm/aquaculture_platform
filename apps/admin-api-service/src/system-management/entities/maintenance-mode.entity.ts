import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum MaintenanceScope {
  GLOBAL = 'global',
  TENANT = 'tenant',
  SERVICE = 'service',
  REGION = 'region',
}

export enum MaintenanceType {
  SCHEDULED = 'scheduled',
  EMERGENCY = 'emergency',
  ROLLING_UPDATE = 'rolling_update',
  DATABASE_MIGRATION = 'database_migration',
  SECURITY_PATCH = 'security_patch',
}

export enum MaintenanceStatus {
  SCHEDULED = 'scheduled',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  EXTENDED = 'extended',
}

export interface MaintenanceNotification {
  type: 'email' | 'sms' | 'push' | 'banner' | 'webhook';
  sentAt?: Date;
  recipients?: string[];
  template?: string;
}

export interface AffectedService {
  name: string;
  status: 'unavailable' | 'degraded' | 'read_only';
  message?: string;
}

@Entity('maintenance_modes')
@Index(['scope', 'status'])
@Index(['scheduledStart', 'scheduledEnd'])
@Index(['tenantId'])
export class MaintenanceMode {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 255 })
  title: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'varchar', length: 50, default: MaintenanceScope.GLOBAL })
  scope: MaintenanceScope;

  @Column({ type: 'varchar', length: 50, default: MaintenanceType.SCHEDULED })
  type: MaintenanceType;

  @Column({ type: 'varchar', length: 50, default: MaintenanceStatus.SCHEDULED })
  status: MaintenanceStatus;

  @Column({ type: 'uuid', nullable: true })
  tenantId: string;

  @Column({ type: 'jsonb', nullable: true })
  affectedTenants: string[];

  @Column({ type: 'jsonb', nullable: true })
  affectedServices: AffectedService[];

  @Column({ type: 'jsonb', nullable: true })
  affectedRegions: string[];

  @Column()
  scheduledStart: Date;

  @Column({ nullable: true })
  scheduledEnd: Date;

  @Column({ nullable: true })
  actualStart: Date;

  @Column({ nullable: true })
  actualEnd: Date;

  @Column({ type: 'int', default: 60 })
  estimatedDurationMinutes: number;

  @Column({ type: 'text', nullable: true })
  userMessage: string;

  @Column({ type: 'text', nullable: true })
  internalNotes: string;

  @Column({ type: 'jsonb', nullable: true })
  notifications: MaintenanceNotification[];

  @Column({ default: false })
  allowReadOnlyAccess: boolean;

  @Column({ default: false })
  bypassForSuperAdmins: boolean;

  @Column({ type: 'jsonb', nullable: true })
  whitelistedIPs: string[];

  @Column({ type: 'jsonb', nullable: true })
  whitelistedUsers: string[];

  @Column({ type: 'text', nullable: true })
  bannerColor: string;

  @Column({ type: 'text', nullable: true })
  bannerIcon: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown>;

  @Column({ nullable: true })
  createdBy: string;

  @Column({ nullable: true })
  updatedBy: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
