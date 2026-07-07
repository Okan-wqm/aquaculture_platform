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
  /**
   * Recorded when a SUPER_ADMIN or TENANT_ADMIN consciously placed
   * fish into a tank that violated the configured biomass / density
   * cap. Phase 1.1 of the farm-module plan: TankCapacityService.enforce
   * still allows the write under 'admin-override' mode, but the
   * elevated risk leaves a row here so post-hoc analysis can reconstruct
   * which operator decided to overstock when, why, and by how much.
   */
  CAPACITY_BLOCKED = 'CAPACITY_BLOCKED',
  /**
   * FARM-MEDIUM-054: a mortality removal was recorded against a batch in a tank.
   * Mortality is a high-stakes inventory decrement; allocate/close already leave
   * a durable farm_audit_logs trail, mortality/cull did not. Written transactionally
   * (AuditLogService.logWithManager) inside the RecordMortalityHandler txn.
   */
  MORTALITY_RECORDED = 'MORTALITY_RECORDED',
  /**
   * FARM-MEDIUM-054: a cull removal was recorded against a batch in a tank.
   * Written transactionally inside the RecordCullHandler txn.
   */
  CULL_RECORDED = 'CULL_RECORDED',
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

@Entity('farm_audit_logs', { schema: 'farm' })
@Index('IDX_farm_audit_tenant_entity', ['tenantId', 'entityType', 'entityId'])
@Index('IDX_farm_audit_tenant_created', ['tenantId', 'createdAt'])
@Index('IDX_farm_audit_created', ['createdAt']) // Retention policy için
@Index('IDX_farm_audit_tenant_action', ['tenantId', 'action'])
@Index('IDX_farm_audit_tenant_user', ['tenantId', 'userId'])
// AUDITTRAIL-HIGH-005 cure: legalHold column mirrors the DB-level
// trigger guard installed by migration 1788300000000. The flag is set
// only by litigation-hold workflows; once true, the BEFORE DELETE
// trigger refuses deletion at the DB level — defense-in-depth against
// retention-sweep regressions.
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  @Index('IDX_farm_audit_tenant')
  tenantId!: string;

  @Column({ length: 100 })
  @Index('IDX_farm_audit_entity_type')
  entityType!: string; // 'Site', 'Department', 'Batch', etc.

  @Column('uuid')
  entityId!: string;

  @Column({
    type: 'enum',
    enum: AuditAction,
  })
  action!: AuditAction;

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
  createdAt!: Date;

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

  /**
   * Litigation-hold flag. When true, BEFORE DELETE trigger
   * (`trg_farm_audit_logs_prevent_legal_hold_delete`) refuses deletion at
   * the DB level — preserves evidence integrity even if a buggy
   * retention sweep, misconfigured CASCADE, or compromised application
   * role attempts to drop held rows.
   */
  @Column({ type: 'boolean', default: false })
  legalHold!: boolean;
}
