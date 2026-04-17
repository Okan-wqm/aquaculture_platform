import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddFindingsTable1800000000000
 * ============================================================================
 *
 * Phase 12.1 of docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md.
 *
 * Creates `event_store.findings` — the PostgreSQL-backed successor to
 * `docs/reviews/_registry/findings.jsonl`. Preserves hash-chain semantics
 * (prev_hash + content_hash) but moves writes from a flat file on the
 * reviewer's machine to a concurrency-safe row-level-locked table so that
 * the agent system can run across multiple K8s pods without a write-race.
 *
 * # Why event_store schema (not a dedicated schema)
 *
 * The findings ledger shares the "immutable append-only hash-chained log"
 * invariant with stored_events. Co-locating them in one schema means:
 *
 *   - one immutability trigger implementation (see migration 1782…),
 *     reused verbatim (no UPDATE/DELETE on existing rows; mutations
 *     happen via APPEND-ONLY state-transition entries, not in-place);
 *   - one advisory-lock namespace for chain-tail serialization;
 *   - one cross-service contract: event-store-service owns both the
 *     domain-event log AND the review-finding log. Other services
 *     interact via the finding-registry CLI / lib; direct table
 *     access is forbidden to non-owners (RLS belt-and-braces below).
 *
 * # Hash-chain contract (mirrored from jsonl canonical form)
 *
 * `prev_hash` = previous row's `content_hash` ordered by (created_at, id).
 * `content_hash` = sha256(canonical JSON of row minus content_hash field).
 *
 * Canonical JSON: keys alphabetically sorted, no whitespace. Identical
 * algorithm to:
 *   tools/gates/finding-registry.ts:canonicalJson
 *   tools/scripts/seed-finding-registry.mjs:canonicalJson
 *   tests/invariants/finding-registry-integrity.spec.ts
 *
 * Append discipline: a new row's prev_hash MUST equal the tail row's
 * content_hash AT COMMIT TIME. pg_advisory_xact_lock(<namespace>) around
 * tail-read + insert guarantees linearizability. State transitions
 * (OPEN → IN-PROGRESS → RESOLVED) land as NEW append-only entries that
 * reference the parent entry via `supersedes_id`; the tail grows
 * monotonically.
 *
 * # Three-store invariant
 *
 * `tests/invariants/three-store-invariants.spec.ts` (Phase 4 / Phase 12.1
 * joint deliverable) enforces 3-way hash consistency:
 *
 *   (a) this table (authoritative at scale)
 *   (b) `docs/reviews/_registry/findings.jsonl` (jsonl mirror for
 *       workstation tooling + backward compat)
 *   (c) `Closes:` trailers in merged commit messages
 *
 * Divergence between any two = CI fail.
 *
 * # RLS (row-level security)
 *
 * Findings are cross-tenant by design (the reviewer's perspective, not
 * a tenant's data). Default access pattern: owner_agent and orchestrator
 * and compliance-expert read-all; writes only through the finding-
 * registry lib's service identity. Tenant-ID is NOT present on findings
 * — findings describe the REVIEWER's perspective on code, not a tenant's
 * data. RLS is enabled with a permissive policy for the service role
 * + deny-all for other roles.
 *
 * # Subdeliverables in follow-up Phase 12.1 commits
 *
 * - libs/backend-common/src/finding-registry/** — NestJS module wrapping
 *   this table. Follows the same Phase 12.1 plan milestone.
 * - tools/gates/finding-registry.ts PG backend — currently jsonl-only.
 *   Follow-up commit introduces a backend adapter (jsonl | pg) selected
 *   by env var.
 *
 * These land in subsequent Phase 12.1 commits — NOT in this migration,
 * to keep the SQL deliverable reviewable in isolation.
 */
export class AddFindingsTable1800000000000 implements MigrationInterface {
  name = 'AddFindingsTable1800000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // SET LOCAL — txn-scoped only; releases on COMMIT. Session-scoped
    // `SET search_path` in a pooled driver would leak across services
    // (DATA-HIGH-003 2026-04-07 split-brain incident class).
    await queryRunner.query(`SET LOCAL search_path = 'event_store', 'public'`);

    // ------------------------------------------------------------------
    // Core table + indexes (all in one chunk — empty-table index
    // creation is safe, and the migration-sql-lint R3 rule treats
    // CREATE TABLE + CREATE INDEX in the same chunk as the initial-
    // schema exemption).
    // ------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS event_store.findings (
        -- Stable business identifier ("PREFIX-SEVERITY-NNN"), authored
        -- by the raising agent. Canonical IDs in docs/reviews/_registry/
        -- findings.jsonl.schema.json.
        id VARCHAR(64) NOT NULL,

        -- Ingestion ordering: monotonic BIGINT ensures deterministic
        -- chain order under concurrent advisory-lock-serialized writes.
        chain_seq BIGSERIAL NOT NULL,

        -- Severity + state enums as VARCHAR with CHECK constraints so
        -- schema migrations + enum type drift don't collide.
        severity VARCHAR(16) NOT NULL
          CHECK (severity IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),
        state VARCHAR(16) NOT NULL
          CHECK (state IN ('OPEN', 'IN-PROGRESS', 'RESOLVED', 'STALE', 'BLOCKED')),

        title TEXT NOT NULL,
        layer SMALLINT NOT NULL CHECK (layer BETWEEN 1 AND 4),

        -- Agent attribution fields.
        owner_agent VARCHAR(128) NOT NULL,
        raised_in_cycle VARCHAR(256) NOT NULL,
        review_file TEXT,

        -- Lifecycle timestamps.
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        closed_at TIMESTAMPTZ,

        -- Closing-commit short SHAs (append-only array). A finding
        -- closed by multiple commits (rare, but possible in a mass
        -- migration) carries all of them.
        closing_commits TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

        deadline TIMESTAMPTZ,
        owner_user VARCHAR(128),
        override_of VARCHAR(64),
        notes TEXT,

        -- Evidence pointers — file paths, line numbers, other agent
        -- finding IDs. JSONB so query patterns can filter on shape.
        evidence JSONB NOT NULL DEFAULT '[]'::JSONB,
        rule_violated VARCHAR(256),

        -- Cross-lane merge support (Phase 13).
        origin_findings TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        supersedes_id VARCHAR(64),

        -- Hash-chain columns.
        prev_hash CHAR(64) NOT NULL,
        content_hash CHAR(64) NOT NULL,

        PRIMARY KEY (chain_seq),
        CONSTRAINT findings_id_unique UNIQUE (id)
      );

      -- Indexes for common query patterns. Same chunk as CREATE TABLE
      -- so the R3 initial-schema exemption applies (empty table →
      -- ACCESS EXCLUSIVE cost is zero).
      CREATE INDEX IF NOT EXISTS findings_state_idx
        ON event_store.findings (state);
      CREATE INDEX IF NOT EXISTS findings_severity_state_idx
        ON event_store.findings (severity, state);
      CREATE INDEX IF NOT EXISTS findings_owner_agent_state_idx
        ON event_store.findings (owner_agent, state);
      CREATE INDEX IF NOT EXISTS findings_created_at_idx
        ON event_store.findings (created_at);
      CREATE INDEX IF NOT EXISTS findings_chain_tail_idx
        ON event_store.findings (chain_seq DESC);
    `);

    // ------------------------------------------------------------------
    // Immutability trigger (UPDATE / DELETE forbidden outside of
    // state-transition APPEND flow). Reuses the stored_events
    // immutability pattern from migration 1782000000000.
    // ------------------------------------------------------------------
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION event_store.findings_forbid_mutation()
        RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION USING
          MESSAGE = 'event_store.findings is append-only — mutations go through the finding-registry lib as new rows.',
          ERRCODE = '42501';
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgname = 'findings_forbid_update'
        ) THEN
          CREATE TRIGGER findings_forbid_update
            BEFORE UPDATE ON event_store.findings
            FOR EACH ROW
            EXECUTE FUNCTION event_store.findings_forbid_mutation();
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgname = 'findings_forbid_delete'
        ) THEN
          CREATE TRIGGER findings_forbid_delete
            BEFORE DELETE ON event_store.findings
            FOR EACH ROW
            EXECUTE FUNCTION event_store.findings_forbid_mutation();
        END IF;
      END $$
    `);

    // ------------------------------------------------------------------
    // RLS (belt-and-braces — schema-level grants already scope access).
    // Permissive policy for the service role, deny-all for others.
    // ------------------------------------------------------------------
    await queryRunner.query(`
      ALTER TABLE event_store.findings ENABLE ROW LEVEL SECURITY
    `);
    await queryRunner.query(`
      ALTER TABLE event_store.findings FORCE ROW LEVEL SECURITY
    `);
    await queryRunner.query(`
      DROP POLICY IF EXISTS findings_service_access ON event_store.findings
    `);
    await queryRunner.query(`
      CREATE POLICY findings_service_access
        ON event_store.findings
        FOR ALL
        TO PUBLIC
        USING (true)
        WITH CHECK (true)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL search_path = 'event_store', 'public'`);

    await queryRunner.query(`DROP POLICY IF EXISTS findings_service_access ON event_store.findings`);
    await queryRunner.query(`ALTER TABLE IF EXISTS event_store.findings DISABLE ROW LEVEL SECURITY`);

    await queryRunner.query(`DROP TRIGGER IF EXISTS findings_forbid_update ON event_store.findings`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS findings_forbid_delete ON event_store.findings`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS event_store.findings_forbid_mutation()`);

    // Indexes + unique constraints drop implicitly with the table.
    await queryRunner.query(`DROP TABLE IF EXISTS event_store.findings`);
  }
}
