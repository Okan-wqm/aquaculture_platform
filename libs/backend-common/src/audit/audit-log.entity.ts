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
import { AuditMethod, AuditResult, AuditSeverity } from './audit-log.tokens';
export { AuditMethod, AuditResult, AuditSeverity };

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
   *
   * ## Why the column is nullable (DBR-LOW-002 cure)
   *
   * `shared.audit_logs` records BOTH tenant-scoped AND system-level
   * events. System-level events legitimately have `tenantId IS NULL`
   * — e.g., a SUPER_ADMIN provisioning a new tenant emits an audit
   * row BEFORE the tenant exists, schema-bootstrap operations on
   * source schemas, platform-wide configuration changes that are
   * not tied to a single tenant.
   *
   * The agent rule "tenant_id on RLS-protected or tenant-scoped
   * tables MUST be NOT NULL" applies to PER-TENANT tables. This
   * table is the cross-tenant audit trail (one of the canonical
   * SHARED_SCHEMA_TABLES per ADR-011), explicitly designed to hold
   * cross-tenant + system-level rows alongside tenant-scoped ones.
   * The shared.audit_logs table does NOT have RLS enabled — the
   * NULL-policy concern does not apply.
   *
   * If/when RLS is added to shared.audit_logs (defense-in-depth
   * recommended in agent guidance), the policy MUST explicitly
   * handle NULL tenantId rows:
   *
   *     CREATE POLICY shared_audit_log_tenant_isolation
   *       USING (
   *         "tenantId" = current_setting('app.current_tenant')::uuid
   *         OR ("tenantId" IS NULL AND has_role('platform_admin'))
   *       );
   *
   * The full doctrine — when an audit table can be nullable, when
   * not, the RLS policy shape that handles NULLs — is documented
   * at docs/architecture/audit-tables.md (paired with DBR-MEDIUM-006
   * follow-on).
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

  // ──────────────────────────────────────────────────────────────────────
  // AUDITTRAIL-CRITICAL-004 — mandatory-shape extension
  // ──────────────────────────────────────────────────────────────────────
  // The audit-trail-completeness-auditor agent's mandatory shape demands
  // 22 columns. The pre-extension entity carried 14. The 8 below close
  // the gap. Each column is also created in DB by migration
  // `1788100000000-AddAuditLogShapeExtension` which adds matching CHECK
  // constraints + secondary indexes; this entity declaration is the
  // schema-drift-validator's canonical truth. Removing or retyping any
  // column here without an accompanying migration WILL fail the invariant.
  //
  // Nullability mirrors the migration: legacy rows (pre-extension) cannot
  // carry these values, so columns are nullable for the V1→V2 transition.
  // A follow-up migration enforces NOT NULL on the trio (actor, method,
  // result) once backfill completes — tracked under AUDITTRAIL agenda.
  //
  // WHY EACH FIELD: see prose docstring on each property below; the
  // shorthand is "field carries a forensic capability that was previously
  // either missing or buried inside metadata.jsonb (not queryable)."

  /**
   * Actor's home tenantId — the tenant the actor belongs to.
   *
   * WHY: SUPER_ADMIN cross-tenant impersonation rows carry the actor's
   * home tenant in this column and the *target* tenant in
   * `actedOnTenantId`. Without this column, the dual-identity context
   * was crammed into `metadata.jsonb`, which (a) is not indexable in a
   * plan-aware way and (b) silently loses semantic meaning the moment
   * the JSON shape changes.
   *
   * WHAT: nullable uuid; null for legacy rows and for actions where
   * actor identity does not exist (system/automation rows).
   */
  @Column({ type: 'uuid', nullable: true })
  @Index('IDX_audit_log_actor_home_tenant')
  actorHomeTenantId!: string | null;

  /**
   * Acted-on tenantId — the tenant the action targeted.
   *
   * WHY: the legacy `tenantId` column was overloaded between actor scope
   * and target scope. Splitting it here makes the semantics explicit.
   * During the V1→V2 transition window, `tenantId` and `actedOnTenantId`
   * MUST be equal for non-impersonation rows; the difference between the
   * two is exactly the dual-identity case.
   *
   * WHAT: nullable uuid; null for cross-tenant aggregation rows.
   */
  @Column({ type: 'uuid', nullable: true })
  @Index('IDX_audit_log_acted_on_tenant')
  actedOnTenantId!: string | null;

  /**
   * Channel through which the audited action arrived.
   *
   * WHY: forensic timeline ambiguity — without this column, a DELETE
   * action could be a CRON sweep, an HTTP DELETE, an operator CLI run,
   * or an event-bus driven projection. The closed vocabulary matches
   * the only five channels the platform exposes (HTTP/GRAPHQL/NATS/CRON/CLI)
   * and is enforced by a DB-level CHECK constraint.
   *
   * WHAT: varchar(16) constrained by CHECK; matches `AuditMethod` enum.
   * Stored as the enum string value rather than a postgres ENUM type
   * because postgres ENUMs are pathologically painful to extend (see
   * `pg_enum` partial-update gotcha) and CHECK constraints can be
   * altered cheaply.
   */
  @Column({ type: 'varchar', length: 16, nullable: true })
  method!: AuditMethod | null;

  /**
   * MFA step-up cleared flag.
   *
   * WHY: SOC 2 CC6.1 evidence reports filter aggressively on
   * "show me everything that happened with MFA cleared." Storing this in
   * `metadata.jsonb` made every such report a sequential scan. The
   * partial index `idx_audit_logs_mfa_verified_created WHERE mfaVerified
   * = true` (installed by the same migration) keeps the index small —
   * the common case is mfaVerified=false.
   *
   * WHAT: non-null boolean default false; semantically present on every
   * row even if pre-extension (default applies to legacy rows).
   */
  @Column({ type: 'boolean', default: false })
  mfaVerified!: boolean;

  /**
   * Outcome of the audited action.
   *
   * WHY: the legacy schema overloaded `severity`. SUCCESS at INFO
   * severity is the common case; SUCCESS at CRITICAL severity is a
   * SUPER_ADMIN cross-tenant action that succeeded (still success, but
   * worth alarming on). DENIED is not the same as ERROR — denial is the
   * system working as designed. Keeping the two axes orthogonal removes
   * a class of false-positive alerts and a class of false-negative
   * compliance findings.
   *
   * WHAT: varchar(16) constrained by CHECK; matches `AuditResult` enum.
   */
  @Column({ type: 'varchar', length: 16, nullable: true })
  result!: AuditResult | null;

  /**
   * Hex SHA-256 of entity state BEFORE the mutation (32 bytes → 64 hex chars).
   *
   * WHY: mutation-integrity proof. Without this, a tampered audit row
   * cannot be distinguished from a legitimate one — the only signal is
   * the immutability trigger, which prevents UPDATE but cannot detect
   * INSERT-time forgery. The hash binds the audit row to the entity
   * state it was emitted against. Combined with `postStateHash` it
   * forms a chained proof of the mutation.
   *
   * WHAT: nullable varchar(64); null for non-mutation actions
   * (READ, EXPORT, etc.) and for legacy rows.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  preStateHash!: string | null;

  /**
   * Hex SHA-256 of entity state AFTER the mutation.
   *
   * WHY: mate to `preStateHash`. A SUCCESS row carries both. A DENIED
   * row carries only `preStateHash` (no post-state exists because the
   * mutation never happened). A FAILED row may carry both if the failure
   * was post-mutation (e.g. event-bus publish failed after DB commit) or
   * only `preStateHash` if pre-mutation.
   *
   * WHAT: nullable varchar(64).
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  postStateHash!: string | null;

  /**
   * Operator-supplied justification for override actions.
   *
   * WHY: audit-trail-completeness-auditor invariant: actions whose name
   * matches the `*_OVERRIDE` pattern (e.g. `TANK_CAPACITY_OVERRIDE`,
   * `MFA_BYPASS_OVERRIDE`) MUST carry a non-null justification — otherwise
   * the override is unreviewable by a future auditor. The check is
   * enforced at write-time by the `@AuditedOperation` interceptor; this
   * column is the durable record.
   *
   * WHAT: text (no length cap) — operator may need to paste a ticket
   * link or a multi-paragraph rationale.
   */
  @Column({ type: 'text', nullable: true })
  justification!: string | null;

  /**
   * UUIDs of other audit rows that belong to the same logical session
   * as this one.
   *
   * WHY: impersonation start row → impersonation end row linkage.
   * Without this, reconstructing a session requires timestamp-window
   * heuristics, which are unreliable across timezone-skewed clocks and
   * are useless once retention compaction collapses chunks.
   *
   * WHAT: nullable uuid[] (postgres native array); null for atomic
   * single-row events. Population is the caller's responsibility — the
   * audit pipeline does not infer linkage.
   */
  @Column({ type: 'uuid', array: true, nullable: true })
  relatedAuditIds!: string[] | null;
}
