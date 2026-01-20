import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * Audit log severity levels
 */
export enum AuditLogSeverity {
  INFO = 'info',
  WARNING = 'warning',
  ERROR = 'error',
  CRITICAL = 'critical',
}

@Entity('audit_logs')
@Index('IDX_audit_tenant', ['tenantId'])
@Index('IDX_audit_created', ['createdAt'])
@Index('IDX_audit_action', ['action'])
@Index('IDX_audit_severity', ['severity'])
@Index('IDX_audit_performed_by', ['performedBy'])
@Index('IDX_audit_entity', ['entityType', 'entityId'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100 })
  performedBy: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  performedByEmail: string | null;

  @Column({ type: 'varchar', length: 100 })
  action: string;

  @Column({ type: 'varchar', length: 50 })
  entityType: string;

  @Column({ type: 'uuid', nullable: true })
  entityId: string | null;

  @Column({ type: 'uuid', nullable: true })
  tenantId: string | null;

  @Column({ type: 'jsonb', nullable: true })
  details: Record<string, any> | null;

  @Column({ type: 'jsonb', nullable: true })
  previousValue: Record<string, any> | null;

  @Column({ type: 'jsonb', nullable: true })
  newValue: Record<string, any> | null;

  @Column({
    type: 'enum',
    enum: AuditLogSeverity,
    default: AuditLogSeverity.INFO,
  })
  severity: AuditLogSeverity;

  @Column({ type: 'varchar', length: 100, nullable: true })
  requestId: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  sessionId: string | null;

  @Column({ type: 'varchar', length: 45, nullable: true })
  ipAddress: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  userAgent: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
