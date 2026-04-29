import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';

// Canonical declaration moved to `./audit-log.tokens` so cross-cutting
// consumers (TenantGuard et al) can use the enum without loading the
// `@Entity()` decorator as a side effect. Imported here for use in the
// @Column metadata below AND re-exported (back-compat for existing
// consumers that still import `AuditSeverity` from `audit-log.entity`).
import { AuditSeverity } from './audit-log.tokens';
export { AuditSeverity };

/**
 * AuditLogEntity - Immutable audit trail record
 *
 * Stored in the public/shared schema (not per-tenant) so that
 * audit records survive even if a tenant schema is dropped.
 * Tenant isolation is enforced via the tenantId column + composite indexes.
 *
 * NO soft delete - audit logs are immutable by design.
 */
@Entity('audit_logs', { schema: 'shared' })
@Index('IDX_audit_log_tenant_created', ['tenantId', 'createdAt'])
@Index('IDX_audit_log_user_tenant', ['userId', 'tenantId'])
@Index('IDX_audit_log_resource', ['resource', 'resourceId', 'tenantId'])
@Index('IDX_audit_log_action', ['action', 'tenantId'])
export class AuditLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Action performed, e.g. 'CREATE_FARM', 'UPDATE_BATCH', 'ASSIGN_ROLE'
   */
  @Column({ type: 'varchar', length: 100 })
  action!: string;

  /**
   * Resource/entity type, e.g. 'Farm', 'Batch', 'TenantRole'
   */
  @Column({ type: 'varchar', length: 100 })
  resource!: string;

  /**
   * ID of the affected resource (extracted from mutation result)
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  resourceId!: string | null;

  /**
   * ID of the user who performed the action
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  userId!: string | null;

  /**
   * Email of the user (denormalized for easy display)
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  userEmail!: string | null;

  /**
   * Tenant ID for multi-tenant isolation.
   *
   * ## Type: uuid (not varchar)
   *
   * The platform-wide canonical tenant-identifier type is `uuid`. Every
   * tenant-scoped entity across farm-service, sensor-service,
   * messaging-service, hr-service, billing-service, and the RLS helper
   * family uses `@Column('uuid')` or `@Column({ type: 'uuid', name: … })`.
   * This entity previously declared `varchar(255)` which was a type drift
   * from the canonical convention and had two concrete production
   * consequences:
   *
   *   1. **RLS policy breakage on any service auto-loading this entity.**
   *      The canonical RLS policy installed by
   *      `farm-service/src/database/migrations/1776000000000-EnableRowLevelSecurity.ts`
   *      uses `USING "tenantId" = current_setting('app.current_tenant')::uuid`
   *      — a type-checked comparison that fails with
   *      `operator does not exist: character varying = uuid` on any
   *      `tenantId` column that is not already uuid. The farm-service
   *      production deploy on 2026-04-08 crashed five times in a row on
   *      this exact check after our `SourceSchemaBootstrapService`
   *      orphan-drop enforcement successfully removed other foreign
   *      entities — only `audit_logs` remained as a varchar holdout
   *      because `@aquaculture/backend-common/src/index.ts` re-exports
   *      `./audit` via `__exportStar`, so any service that imports
   *      ANYTHING from backend-common (which farm-service does heavily)
   *      transitively loads this module and runs its `@Entity` decorator,
   *      registering the class on TypeORM's global metadata store,
   *      which farm-service's `autoLoadEntities: true` then picks up.
   *      Orphan-drop removes the table; synchronize re-creates it from
   *      this entity's declaration; the varchar(255) is back; RLS
   *      crashes. The only fix that closes the loop is correcting the
   *      entity's column type here.
   *
   *   2. **Tenant-id type heterogeneity across the schema.** Every
   *      query that joins an audit row against a tenant-owned entity
   *      had to cast one side — either `audit_logs."tenantId"::uuid`
   *      or `other."tenantId"::text`. Neither cast is free in a
   *      query planner's cost model and both obscure intent. Making
   *      the column uuid from the source removes the cast requirement
   *      everywhere.
   *
   * ## Migration impact on existing deployments
   *
   * TypeORM's `synchronize()` will attempt `ALTER TABLE audit_logs
   * ALTER COLUMN "tenantId" TYPE uuid USING "tenantId"::uuid` on the
   * next startup of any service that owns this entity. The cast fails
   * LOUD on any non-canonical value (e.g. a raw tenant slug from an
   * even older schema), which is the correct signal for data
   * corruption — audit log rows should only ever have been written
   * with tenant UUIDs, and anything else is a bug that deserves
   * surfacing rather than a silent string-to-uuid conversion.
   */
  @Column({ type: 'uuid', nullable: true })
  tenantId!: string | null;

  /**
   * Database schema name (e.g. 'tenant_abc123')
   */
  @Column({ type: 'varchar', length: 100, nullable: true })
  schemaName!: string | null;

  /**
   * Additional metadata: sanitized args, description, etc.
   */
  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  /**
   * Client IP address. Stored as native Postgres inet (DBR-MEDIUM-003
   * cure) for INSERT-time validation, efficient indexing, and
   * operator-side IP-range query support via the `<<` containment
   * operator. TypeScript type stays `string` because the pg driver
   * surfaces inet as text on read; the validation happens at INSERT
   * time at the DB layer.
   */
  @Column({ type: 'inet', nullable: true })
  ip!: string | null;

  /**
   * Client user agent string
   */
  @Column({ type: 'varchar', length: 500, nullable: true })
  userAgent!: string | null;

  /**
   * Severity level
   */
  @Column({
    type: 'enum',
    enum: AuditSeverity,
    default: AuditSeverity.INFO,
  })
  severity!: AuditSeverity;

  /**
   * Request correlation ID for distributed tracing
   */
  @Column({ type: 'varchar', length: 100, nullable: true })
  correlationId!: string | null;

  /**
   * Timestamp of the audit event (immutable)
   */
  @CreateDateColumn()
  createdAt!: Date;

  /**
   * Litigation legal-hold flag.
   *
   * WHY: Database-level retention sweeps and any operator-driven DELETE on
   * this table must NOT remove rows flagged for legal hold. The companion
   * BEFORE DELETE trigger `trg_audit_logs_prevent_legal_hold_delete` —
   * installed by `1787400000000-RestoreSharedAuditLogsImmutability` after
   * the regression caused by `1787200000000-RealignSharedAuditLogsSchema`
   * removed it — inspects this column and aborts deletion when the value
   * is true. Exposing the column on the entity lets SchemaDriftValidator
   * detect future drift and lets the canonical LegalHold registry write
   * the flag at INSERT time (the only path the immutability trigger
   * permits, since `trg_audit_logs_prevent_update` rejects every UPDATE).
   *
   * WHAT: Boolean column, default false, set at audit-row INSERT time
   * based on the active LegalHold state for the row's tenantId/scope.
   */
  @Column({ type: 'boolean', default: false })
  legalHold!: boolean;
}
