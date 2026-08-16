import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import {
  ADMIN_AUDIT_SEVERITY,
  ADMIN_AUDIT_TRUST_CLASS,
  type AdminAuditAction,
  type AdminAuditLegacyProvenanceV1,
  type AdminAuditSeverity,
  type AdminAuditTrustClass,
} from '@platform/admin-http-contracts';

/**
 * admin-api-service's own audit log table — distinct from
 * `shared.audit_logs` (cross-service trail) and `auth.audit_logs`
 * (auth-service operational audit).
 *
 * # Why three audit tables
 *
 * Admin-api's audit captures cross-tenant SUPER_ADMIN actions: tenant
 * impersonation start/stop, tenant suspension, plan changes, etc. These
 * are written under `BypassRlsService.withBypass()` (admin-api wraps every
 * request via AdminBypassRlsInterceptor) and need extended fields
 * (the shared audit action catalog, severity and structured details) that don't
 * fit `shared.audit_logs`'s tighter schema.
 *
 * # Why explicit `schema: 'admin'`
 *
 * Same rationale as the auth-service AuditLog comment: without a schema
 * decorator, TypeORM defaults to `public`. Combined with autoLoadEntities
 * + transitive import of backend-common's AuditLogEntity (now in `shared`),
 * three classes named `AuditLog` would have collided in TypeORM's metadata
 * store with two of them defaulting to `public`. The schema-invariants CI
 * test would fail. Closes CRITICAL-002 from the 2026-04-14 review.
 */
@Entity('audit_logs', { schema: 'admin' })
@Index(['action'])
@Index(['entityType', 'entityId'])
@Index(['performedBy'])
@Index(['tenantId'])
@Index(['createdAt'])
@Index(['severity'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 100 })
  action!: AdminAuditAction;

  @Column({ type: 'varchar', length: 50 })
  entityType!: string;

  @Column({ type: 'uuid', nullable: true })
  entityId?: string;

  @Column({ type: 'uuid', nullable: true })
  tenantId?: string;

  @Column({ type: 'varchar', length: 100 })
  performedBy!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  performedByEmail?: string;

  // DBR-MEDIUM-003 cure: native Postgres inet for INSERT-time
  // validation + efficient indexing + operator-side range queries
  // via `<<`. Migration 1788000000000-ConvertAuditIpColumnsToInet
  // performs the column-type rewrite.
  @Column({ type: 'inet', nullable: true })
  ipAddress?: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  userAgent?: string;

  @Column({ type: 'jsonb', nullable: true })
  details?: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  previousValue?: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  newValue?: Record<string, unknown>;

  @Column({
    type: 'enum',
    enum: ADMIN_AUDIT_SEVERITY,
    default: ADMIN_AUDIT_SEVERITY.INFO,
  })
  severity!: AdminAuditSeverity;

  /**
   * Runtime evidence and unverified historical imports share a query surface,
   * never a trust claim. Completeness projections include only
   * AUTHORITATIVE_RUNTIME rows.
   */
  @Column({
    type: 'enum',
    enum: ADMIN_AUDIT_TRUST_CLASS,
    default: ADMIN_AUDIT_TRUST_CLASS.AUTHORITATIVE_RUNTIME,
  })
  trustClass!: AdminAuditTrustClass;

  @Column({ type: 'jsonb', nullable: true })
  provenance?: AdminAuditLegacyProvenanceV1;

  @Column({ type: 'varchar', length: 100, nullable: true })
  requestId?: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  sessionId?: string;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt!: Date;

  /**
   * Litigation-hold flag (AUDITTRAIL-HIGH-006 cure).
   *
   * Mirror of the DB-level guard installed by migration
   * 1787800000000. When true, BEFORE DELETE trigger
   * `trg_audit_logs_prevent_legal_hold_delete` refuses deletion at the
   * DB level — preserves SUPER_ADMIN cross-tenant audit evidence even
   * if a buggy retention sweep, misconfigured CASCADE, or compromised
   * application role attempts to drop held rows.
   */
  @Column({ type: 'boolean', default: false })
  legalHold!: boolean;
}
