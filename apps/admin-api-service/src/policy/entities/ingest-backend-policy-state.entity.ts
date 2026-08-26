import { Column, Entity, PrimaryColumn, UpdateDateColumn, VersionColumn } from 'typeorm';

import type { IngestBackendKind, IngestBackendSnapshot } from '@platform/event-contracts';

/**
 * Singleton row storing the current per-tenant IngestBackend
 * rollout decision (ADR-031). This is the source-of-truth the
 * admin-api-service serves via `policy.ingest_backend.snapshot`
 * and mutates via `policy.ingest_backend.changed` publishes.
 *
 * Why a single-row entity rather than one row per decision:
 *   The snapshot IS the decision — there is always exactly one
 *   authoritative state. Versioned history lives in audit_logs
 *   (every change records an audit entry); the entity here is
 *   the current-state SoT. Single-row design with a fixed
 *   primary-key sentinel makes the invariant "exactly one
 *   policy" structurally impossible to violate (no way to end
 *   up with two conflicting rows).
 *
 * Why JSONB for overrides:
 *   The override map is small (rollout cohort — from zero through
 *   single-digit pilot to full cut-over) and is always read +
 *   written as a whole. A sidecar table keyed by tenantId would
 *   give us per-row audit but doubles the query cost on every
 *   snapshot fetch (the common path). The changed-event carries
 *   the incremental Change, so per-tenant traceability lives on
 *   NATS + audit_logs, not in the state table.
 *
 * Schema: admin (ADR-011 — every @Entity declares schema).
 */
@Entity('ingest_backend_policy_state', { schema: 'admin' })
export class IngestBackendPolicyStateEntity {
  /**
   * Fixed sentinel — there is only one row. Named constant
   * [[POLICY_STATE_SINGLETON_KEY]] is the canonical value; tests
   * + migrations use it to avoid string drift.
   */
  @PrimaryColumn({ type: 'varchar', length: 32 })
  key!: string;

  /**
   * Default backend every tenant without an override routes to.
   * Stored as the wire literal ('node' | 'rust') so the JSON
   * serialise from this row into the snapshot reply is a no-op
   * cast — identical to the Rust side's serde form.
   */
  @Column({ type: 'varchar', length: 8 })
  defaultBackend!: IngestBackendKind;

  /**
   * Per-tenant override map. Keys are UUID strings (lowercase
   * hyphenated); values are the same `"node" | "rust"` literal
   * used in defaultBackend. JSONB so the map survives
   * round-trip through JSON.stringify + JSON.parse without
   * coercion — the snapshot wire shape IS this map.
   */
  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  overrides!: Record<string, IngestBackendKind>;

  /**
   * Who applied the most recent change. Populated from the
   * admin-api caller's JWT claims (UUID of the operator /
   * service account). Null only for migration-seeded default
   * rows.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  updatedBy!: string | null;

  /**
   * Optimistic-locking column. Prevents two concurrent apply
   * operations from racing + silently losing one of the
   * changes. Conflicts surface as TypeORM's
   * `OptimisticLockVersionMismatchError` which the service layer
   * retries or bubbles as 409 Conflict.
   */
  @VersionColumn()
  version!: number;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

/**
 * Canonical primary-key sentinel for the single row. Exported so
 * migrations + services reference the same constant.
 */
export const POLICY_STATE_SINGLETON_KEY = 'current';

/**
 * Project the entity shape onto the `IngestBackendSnapshot` wire
 * type. Used by the service + responder to reply to the
 * request-reply snapshot subject without the caller juggling the
 * VersionColumn / timestamp metadata.
 */
export function toSnapshot(
  row: Pick<IngestBackendPolicyStateEntity, 'defaultBackend' | 'overrides'>,
): IngestBackendSnapshot {
  return {
    defaultBackend: row.defaultBackend,
    overrides: row.overrides,
  };
}
