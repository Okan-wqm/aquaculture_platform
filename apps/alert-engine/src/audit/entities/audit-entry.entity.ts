import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * Audit Entry Entity
 *
 * Persists alert audit log entries to PostgreSQL.
 * Replaces the previous in-memory audit store (max 2000 entries, lost on restart).
 */
@Entity('alert_audit_log')
@Index(['tenantId', 'timestamp'])
@Index(['category', 'timestamp'])
@Index(['eventType', 'timestamp'])
@Index(['entityType', 'entityId'])
@Index(['correlationId'])
export class AuditEntryEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'tenant_id', type: 'uuid', nullable: true })
  tenantId?: string;

  @Column({ name: 'category' })
  category!: string;

  @Column({ name: 'event_type' })
  eventType!: string;

  @Column({ name: 'severity' })
  severity!: string;

  @Column({ name: 'action' })
  action!: string;

  @Column({ name: 'description', type: 'text' })
  description!: string;

  @Column({ name: 'entity_type', nullable: true })
  entityType?: string;

  @Column({ name: 'entity_id', nullable: true })
  entityId?: string;

  @Column({ name: 'user_id', nullable: true })
  userId?: string;

  @Column({ name: 'user_name', nullable: true })
  userName?: string;

  @Column({ name: 'ip_address', nullable: true })
  ipAddress?: string;

  @Column({ name: 'user_agent', nullable: true })
  userAgent?: string;

  @Column({ name: 'previous_state', type: 'jsonb', nullable: true })
  previousState?: Record<string, unknown>;

  @Column({ name: 'new_state', type: 'jsonb', nullable: true })
  newState?: Record<string, unknown>;

  @Column({ name: 'changes', type: 'jsonb', nullable: true })
  changes?: Array<{ field: string; previousValue: unknown; newValue: unknown }>;

  @Column({ name: 'metadata', type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @Column({ name: 'correlation_id', nullable: true })
  correlationId?: string;

  @Column({ name: 'parent_audit_id', nullable: true })
  parentAuditId?: string;

  @Column({ name: 'tags', type: 'jsonb', nullable: true })
  tags?: string[];

  @Column({ name: 'duration', nullable: true })
  duration?: number;

  @Column({ name: 'success' })
  success!: boolean;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage?: string;

  @CreateDateColumn({ name: 'timestamp' })
  timestamp!: Date;
}
