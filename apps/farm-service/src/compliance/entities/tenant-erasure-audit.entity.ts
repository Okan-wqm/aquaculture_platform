import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * TenantErasureAuditEntity — durable record of completed
 * GDPR-Art-17 erasure cascades (COMPLIANCE-MEDIUM-004 cure).
 *
 * # Why a persistent table is the right shape
 *
 * Pre-cure `TenantErasureService.confirm()` consumed the in-memory
 * pending-ticket on success. A retry from the same operator
 * (browser back-forward, ALB retry, double-click) hit the
 * "no pending ticket" branch and threw 404. A confused operator
 * could conclude the erasure never ran and call `initiate()` again,
 * triggering a SECOND cascade with new side effects:
 *
 *   - The DELETE pass is mostly no-op on now-empty tables, but
 *   - The audit-log anonymise UPDATE runs again (cheap re-write
 *     to the same hash output, but a `farm_audit_logs UPDATE` is
 *     ALSO blocked by the immutability trigger AUDITTRAIL-HIGH-005
 *     installed — so the second pass crashes on a trigger that's
 *     supposed to be a safety net, not a control-flow gate).
 *   - The TenantErased outbox event is re-emitted, leading to
 *     downstream cascade re-runs (Stripe void semantics differ on
 *     a re-issued cancel; messaging-service GDPR cascade idempotency
 *     becomes the next-down problem).
 *
 * The cure is to make `confirm()` IDEMPOTENT: a re-invocation on
 * an already-erased tenant returns the original ErasureResult
 * with HTTP 200, never re-running the cascade.
 *
 * # Schema rationale (PRIMARY KEY tenantId)
 *
 *   - tenantId as PK enforces "one erasure per tenant lifetime"
 *     at the DB level. A second insert for the same tenantId
 *     fails on the unique constraint — Tier-1 "make impossible"
 *     belt + suspenders against any future code path that
 *     forgets the idempotency check at the service layer.
 *   - confirmedAt / requestedBy / totalDeleted / auditRowsAnonymised /
 *     tableCount mirror the ErasureResult shape so a re-confirm
 *     can reconstruct the original return value byte-identical.
 *
 * # Why farm schema (not shared)
 *
 * The erasure cascade is farm-service-owned (operates on farm
 * schema entities). Even though TenantErased is a cross-service
 * event, the *audit row* of the cascade is service-local. Cross-
 * service erasure observers each maintain their own audit if
 * their cascades need idempotency.
 *
 * # Why NOT @CreateDateColumn on confirmedAt
 *
 * confirmedAt represents the EXACT moment the ErasureResult was
 * computed, NOT the row INSERT time. The two diverge if the
 * INSERT lands later in the transaction than the in-memory
 * timestamp generation. We assign confirmedAt explicitly from
 * the same `new Date().toISOString()` value the service already
 * computes for the ErasureResult — so a re-confirm returns
 * exactly the original confirmedAt, not the row's INSERT
 * timestamp.
 */
@Entity('tenant_erasure_audit', { schema: 'farm' })
export class TenantErasureAuditEntity {
  /**
   * Tenant whose data was erased. Primary key — uniqueness
   * enforced at DB level so a second cascade for the same tenant
   * fails on the constraint, not on the service-layer
   * idempotency check.
   */
  @PrimaryColumn({ type: 'uuid' })
  tenantId!: string;

  /**
   * ISO 8601 timestamp of the erasure completion. Stored as
   * timestamptz so cross-region operators see consistent values.
   * Matches the ErasureResult.confirmedAt field returned by
   * TenantErasureService.confirm().
   */
  @Column({ type: 'timestamptz' })
  confirmedAt!: Date;

  /**
   * Identity of the operator / system that requested the
   * erasure. Mirrors ErasureResult.requestedBy. Kept after the
   * erasure (we deliberately do NOT anonymise this column)
   * because GDPR Art 17 evidence requires demonstrable
   * accountability of WHO authorized the erasure — that is the
   * controller's record-of-processing obligation, not the data
   * subject's.
   */
  @Column({ type: 'varchar', length: 255 })
  requestedBy!: string;

  /**
   * Total rows deleted across all tenant-scoped tables.
   */
  @Column({ type: 'integer' })
  totalDeleted!: number;

  /**
   * Number of audit-log rows anonymised (NOT deleted, per the
   * AUDITTRAIL invariant — anonymisation preserves the
   * compliance trail).
   */
  @Column({ type: 'integer' })
  auditRowsAnonymised!: number;

  /**
   * Distinct table count touched by the cascade. Useful for
   * dashboards showing erasure-coverage breadth without
   * exposing the per-table breakdown (which goes into
   * `deletedRowsByTable` JSONB).
   */
  @Column({ type: 'integer' })
  tableCount!: number;

  /**
   * Per-table deleted-row counts as a JSONB map
   * (tableName → rowCount). Reconstructs the original
   * ErasureResult.deletedRowsByTable on re-confirm.
   */
  @Column({ type: 'jsonb' })
  deletedRowsByTable!: Record<string, number>;

  /**
   * Per-table count of rows RETAINED under the GDPR Art 17(3)(b)
   * legal-obligation carve-out (COMPLIANCE-HIGH-003) — government-filed
   * regulatory records (regulatory_reports, biomass_reports) that the
   * cascade keeps rather than deletes, with their PII columns anonymised
   * in place. This is the auditable evidence that the controller made a
   * lawful, documented retention decision instead of silently failing to
   * erase. DEFAULT '{}' keeps the column blue-green safe for an in-flight
   * old-code INSERT that predates the retention policy.
   */
  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  retainedRowsByTable!: Record<string, number>;

  /**
   * How many of the retained rows actually had a PII column hashed
   * (rows already free of identifiers are not counted). DEFAULT 0 keeps
   * the column blue-green safe.
   */
  @Column({ type: 'integer', default: 0 })
  retainedRowsAnonymised!: number;
}
