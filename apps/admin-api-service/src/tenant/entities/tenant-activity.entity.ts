import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum ActivityType {
  CREATED = 'created',
  ACTIVATED = 'activated',
  SUSPENDED = 'suspended',
  DEACTIVATED = 'deactivated',
  PLAN_CHANGED = 'plan_changed',
  LIMITS_UPDATED = 'limits_updated',
  MODULE_ASSIGNED = 'module_assigned',
  MODULE_REMOVED = 'module_removed',
  USER_ADDED = 'user_added',
  USER_REMOVED = 'user_removed',
  SETTINGS_UPDATED = 'settings_updated',
  PAYMENT_RECEIVED = 'payment_received',
  PAYMENT_FAILED = 'payment_failed',
  TRIAL_STARTED = 'trial_started',
  TRIAL_EXPIRED = 'trial_expired',
  CONTACT_UPDATED = 'contact_updated',
  DOMAIN_CHANGED = 'domain_changed',
}

@Entity('tenant_activities', { schema: 'admin' })
@Index(['tenantId', 'createdAt'])
@Index(['activityType'])
export class TenantActivity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'enum', enum: ActivityType })
  activityType!: ActivityType;

  @Column({ type: 'varchar', length: 255 })
  title!: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  previousValue?: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  newValue?: Record<string, unknown>;

  /**
   * ADR-0008: an activity row without an actor is not evidence. NOT NULL
   * since migration 1808600000000 (legacy rows backfilled as 'system:legacy').
   */
  @Column({ type: 'varchar', length: 100 })
  performedBy!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  performedByEmail?: string;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt!: Date;

  /**
   * Litigation-hold flag (ADR-0008). Mirror of the DB-level guard installed by
   * migration 1808600000000 (canonical UPDATE refusal + legal-hold DELETE
   * refusal); honoured by the retention kernel's disposal predicate.
   */
  @Column({ type: 'boolean', default: false })
  legalHold!: boolean;
}

// Tenant Notes Entity
@Entity('tenant_notes', { schema: 'admin' })
@Index(['tenantId', 'createdAt'])
export class TenantNote {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'text' })
  content!: string;

  @Column({ type: 'varchar', length: 50, default: 'general' })
  category!: string; // general, support, billing, technical

  @Column({ type: 'boolean', default: false })
  isPinned!: boolean;

  @Column({ type: 'varchar', length: 100 })
  createdBy!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  createdByEmail?: string;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt!: Date;

  // BUG-011 fix: track when a note was last edited so edit history is visible
  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt!: Date;
}
