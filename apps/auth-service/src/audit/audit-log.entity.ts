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

/**
 * auth-service's own audit log table — distinct from `shared.audit_logs`
 * (cross-service trail in backend-common's AuditLogEntity).
 *
 * # Why two tables
 *
 * auth-service's audit needs include `entityType` / `entityId` / `previousValue`
 * / `newValue` for fine-grained mutation history (login attempts, token
 * issuance, MFA enrolment) — fields not present in the cross-service
 * `shared.audit_logs` schema. Rather than fork backend-common's entity or
 * inflate the shared table with auth-specific nullable columns, auth keeps
 * its own table in its own schema.
 *
 * # Why explicit `schema: 'auth'`
 *
 * Without `schema:`, TypeORM defaults to `public`. Combined with
 * autoLoadEntities + transitive import of backend-common's
 * `AuditLogEntity('audit_logs', { schema: 'shared' })`, having both classes
 * register under the bare table name `audit_logs` in different schemas was
 * tolerated until 2026-04-14 P9: now the shared one is anchored in `shared`
 * via decorator, but this one defaulted to `public`. CI invariant
 * (e2e/tests/integration/schema-invariants.spec.ts) asserts public has zero
 * application tables, so this entity needed an explicit schema declaration.
 * Closes CRITICAL-002 from the 2026-04-14 review.
 */
@Entity('audit_logs', { schema: 'auth' })
@Index('IDX_audit_tenant_created', ['tenantId', 'createdAt'])
@Index('IDX_audit_performer_tenant', ['performedBy', 'tenantId'])
@Index('IDX_audit_entity', ['entityType', 'entityId', 'tenantId'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 100 })
  performedBy!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  performedByEmail?: string | null;

  @Column({ type: 'varchar', length: 100 })
  action!: string;

  @Column({ type: 'varchar', length: 50 })
  entityType!: string;

  @Column({ type: 'uuid', nullable: true })
  entityId?: string | null;

  @Column({ type: 'uuid', nullable: true })
  tenantId?: string | null;

  @Column({ type: 'jsonb', nullable: true })
  details?: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  previousValue?: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  newValue?: Record<string, unknown> | null;

  @Column({
    type: 'enum',
    enum: AuditLogSeverity,
    default: AuditLogSeverity.INFO,
  })
  severity!: AuditLogSeverity;

  @Column({ type: 'varchar', length: 100, nullable: true })
  requestId?: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  sessionId?: string | null;

  // DBR-MEDIUM-003 cure: native Postgres inet for INSERT-time
  // validation + efficient indexing + operator-side range queries
  // via `<<`. Migration 1787400000000-ConvertAuthAuditIpToInet
  // performs the column-type rewrite.
  @Column({ type: 'inet', nullable: true })
  ipAddress?: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  userAgent?: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  /**
   * Litigation legal-hold flag.
   *
   * WHY: Database-level retention sweeps and any operator-driven DELETE
   * on this table must NOT remove rows flagged for legal hold. The
   * companion BEFORE DELETE trigger
   * `trg_audit_logs_prevent_legal_hold_delete` (installed by
   * `1787100000000-AddAuthAuditLogsImmutability`) inspects this column
   * and aborts deletion when the value is true. Exposing the column on
   * the entity lets SchemaDriftValidator detect future drift and lets
   * the canonical LegalHold registry write the flag at INSERT time
   * (the only path the immutability trigger permits, since
   * `trg_audit_logs_prevent_update` rejects every UPDATE).
   *
   * WHAT: Boolean column, default false, set at audit-row INSERT time
   * based on the active LegalHold state for the row's tenantId/scope.
   */
  @Column({ type: 'boolean', default: false })
  legalHold!: boolean;
}
