/**
 * AuditLog Entity - Değişiklik takibi için audit log tablosu
 *
 * Tüm entity değişikliklerini (CREATE, UPDATE, DELETE) kaydeder.
 * Retention: 90 gün (configurable)
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export enum AuditAction {
  CREATE = 'CREATE',
  UPDATE = 'UPDATE',
  DELETE = 'DELETE',
  SOFT_DELETE = 'SOFT_DELETE',
  RESTORE = 'RESTORE',
}

export interface AuditChanges {
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  changedFields?: string[];
}

export interface AuditMetadata {
  ipAddress?: string;
  userAgent?: string;
  correlationId?: string;
  source?: string; // API, SYSTEM, MIGRATION, etc.
}

@Entity('farm_audit_logs')
@Index('IDX_farm_audit_tenant_entity', ['tenantId', 'entityType', 'entityId'])
@Index('IDX_farm_audit_tenant_created', ['tenantId', 'createdAt'])
@Index('IDX_farm_audit_created', ['createdAt']) // Retention policy için
@Index('IDX_farm_audit_tenant_action', ['tenantId', 'action'])
@Index('IDX_farm_audit_tenant_user', ['tenantId', 'userId'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  @Index('IDX_farm_audit_tenant')
  tenantId: string;

  @Column({ length: 100 })
  @Index('IDX_farm_audit_entity_type')
  entityType: string; // 'Site', 'Department', 'Batch', etc.

  @Column('uuid')
  entityId: string;

  @Column({
    type: 'enum',
    enum: AuditAction,
  })
  action: AuditAction;

  @Column('uuid', { nullable: true })
  userId?: string;

  @Column({ length: 255, nullable: true })
  userName?: string; // Denormalized for quick access

  @Column({ type: 'jsonb', nullable: true })
  changes?: AuditChanges;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: AuditMetadata;

  @CreateDateColumn({ type: 'timestamptz' })
  @Index('IDX_farm_audit_created_col')
  createdAt: Date;

  /**
   * Entity version at the time of change
   */
  @Column({ type: 'int', nullable: true })
  entityVersion?: number;

  /**
   * Human-readable summary of the change
   */
  @Column({ type: 'text', nullable: true })
  summary?: string;
}
