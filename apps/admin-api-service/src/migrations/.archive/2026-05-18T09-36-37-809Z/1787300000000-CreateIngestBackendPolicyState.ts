import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CreateIngestBackendPolicyState — admin.ingest_backend_policy_state
 * ============================================================================
 *
 * Adds the single-row SoT for the per-tenant IngestBackend rollout decision
 * (ADR-031). admin-api-service publishes
 * `policy.ingest_backend.changed` on every mutation of this row; the Rust
 * sensor-ingestion sidecar subscribes to
 * `policy.ingest_backend.>` and hot-swaps its `DynamicBackendPolicy`.
 * The sidecar also request-replies against
 * `policy.ingest_backend.snapshot` at cold start, which reads THIS row.
 *
 * # Why a dedicated table rather than system_settings
 *
 * The rollout policy is a first-class control-plane concern with
 * optimistic locking (concurrent admin changes MUST NOT race + silently
 * clobber) and a distinctive audit surface. system_settings values are
 * opaque strings with no per-row lock; shoehorning the snapshot into it
 * would have lost the @VersionColumn invariant that keeps concurrent
 * applies honest. One dedicated row owned by the concern.
 *
 * # Shape
 *
 *   key           varchar(32)    PK, always 'current' (singleton sentinel)
 *   defaultBackend varchar(8)    'node' | 'rust' — wire literal (lowercase)
 *   overrides     jsonb          UUID string → 'node'|'rust', default {}
 *   updatedBy     varchar(64)    operator UUID (null for seeded default)
 *   version       int            optimistic-locking column
 *   updatedAt     timestamptz    last change wall-clock
 *
 * Seeded with the safe default (defaultBackend='node', overrides={}) so
 * the Rust sidecar's cold-start snapshot request succeeds on a clean
 * deploy — operators explicitly flip tenants onto Rust; nothing moves
 * by accident.
 */
export class CreateIngestBackendPolicyState1787300000000
  implements MigrationInterface {
  name = 'CreateIngestBackendPolicyState1787300000000';

  public async up(qr: QueryRunner): Promise<void> {
    // CREATE + DEFAULT-SEED bundled into ONE query so the
    // migration-sql-lint R3 rule classifies this as an
    // initial-schema migration (no CONCURRENTLY requirement —
    // the table is empty at migration time).
    await qr.query(`
      CREATE TABLE IF NOT EXISTS admin.ingest_backend_policy_state (
        key              varchar(32)  PRIMARY KEY,
        "defaultBackend" varchar(8)   NOT NULL
                         CONSTRAINT ingest_backend_policy_state_default_backend_chk
                         CHECK ("defaultBackend" IN ('node', 'rust')),
        overrides        jsonb        NOT NULL DEFAULT '{}'::jsonb,
        "updatedBy"      varchar(64),
        version          integer      NOT NULL DEFAULT 1,
        "updatedAt"      timestamptz  NOT NULL DEFAULT now()
      );

      -- Safe-default seed so the sidecar's cold-start snapshot
      -- request succeeds on a greenfield deploy. ADR-031
      -- §safe-rollout: defaultBackend='node' means nothing
      -- routes to Rust until an operator explicitly opts a
      -- tenant in.
      INSERT INTO admin.ingest_backend_policy_state
        (key, "defaultBackend", overrides, "updatedBy", version, "updatedAt")
      VALUES
        ('current', 'node', '{}'::jsonb, NULL, 1, now())
      ON CONFLICT (key) DO NOTHING;
    `);
  }

  public async down(qr: QueryRunner): Promise<void> {
    // Bidirectional migration per ADR-011 blue-green safety.
    // Dropping the table loses the current rollout state — the
    // runbook calls for snapshotting the row's JSON before
    // invoking down(); the restore path re-applies up() then
    // re-inserts the captured snapshot.
    await qr.query(`DROP TABLE IF EXISTS admin.ingest_backend_policy_state;`);
  }
}
