# ADR-030: Day-One Baseline Reset — Architectural Reset of Migration State + Drift Validator Posture

**Status:** Proposed (2026-05-18)
**Date:** 2026-05-18
**Deciders:** Okan (platform owner) + data-expert + database-reviewer + platform-kernel-expert + infra-expert + multi-tenant-saas-expert + architectural-arbiter
**Owner:** Okan
**Related plans:** `/root/.claude/plans/peppy-crafting-waterfall.md`
**Related ADRs:** ADR-011 Schema Ownership, ADR-012 Schema Drift Prevention, ADR-022 (SUPERSEDED by ADR-025), ADR-025 Edge Schema Per-Tenant.

---

## Context (WHY)

The 14-service migration corpus accumulated **~120 migration files, of
which 29–30% carry "Align/Heal/Repair/Replay/Restore/Sync" prefixes** —
drift-archaeology artifacts authored to reconcile entity-of-record
state with physical DB state.

The 8-agent + 10-agent cross-review on 2026-05-18 traced the root cause
across four orthogonal architectural defects:

1. **Two-writer ledger surface (CLAUDE.md "Inviolable rules" #1
   violation).** Both `aqua-db-migrate` and each service's bootstrap
   `MigrationRunnerService` write to `<schema>.typeorm_migrations`.
   Combined with SAVEPOINT-per-statement patterns (HR
   `1786900-HealHrEnumTypeDrift`), this produces a silent-applied
   class: ledger says "applied", DDL never landed.

2. **Drift validator scope gaps.** `SchemaDriftValidator` checks column
   shape + nullability + enum labels, but not FK presence, index
   presence, default values, or RLS predicate canonicality. Drift in
   those classes accumulates until the next bootstrap-from-scratch
   spec run surfaces it as a batch repair (sensor-service
   `1789000/1789100/1789200-AlignSensorEntitySurface{,Ext,Fks}` —
   three deploys to close a single drift cycle).

3. **Edge schema placement ADR mismatch.** ADR-022's standalone `edge`
   schema under admin-api-service violates ADR-011 (migration owner ≠
   runtime owner). Per-tenant placement under sensor-service is the
   structural fix — captured in ADR-025.

4. **Audit immutability silently dropped via DROP CASCADE.** The
   2026-04 admin-api migration 1782200-MoveSharedTablesFromAdminToShared
   issued `DROP TABLE shared.audit_logs CASCADE`, which silently
   removed immutability triggers + `legalHold` column. The follow-up
   migration 1787400-RestoreSharedAuditLogsImmutability documents the
   gap. No guard prevented the regression at PR time.

The operator declared on 2026-05-18 that:

- **Production carries no real customer data.** Existing tenants are
  operator test artifacts.
- Yasal saklama / customer notice / legal hold / GDPR data request /
  SOC 2 disclosure: NOT APPLICABLE (test environment).
- **The architectural reset is authorized:** SUPER_ADMIN excluded,
  every tenant + every per-tenant schema is wiped + restored from a
  single Baseline migration per service.

This ADR captures the irreversible decision + its consequences.

## Decision (WHAT)

Perform a **day-one baseline reset** of every service's migration
history, gated by 13 architectural invariants (Faz 1), edge ownership
move (Faz 2), and a 14-service consolidated baseline generation (Faz 3).
The reset is one-way; rollback exists only as a `pg_dump --schema-only
--data-only` snapshot taken in Faz 0.

### Architectural primitives introduced (Faz 1 — 13 sub-items)

1.1 **Atomic DDL+ledger commit barrier** — `MigrationRunnerService`
   gains `runPostConditionProbe()` invoked inside the wrapper tx after
   `executeMigration()` returns, before `commitTransaction()`. New
   `PostConditionAwareMigration` interface allows migrations to declare
   `postCondition(qr): Promise<boolean | void>`. False / throw → wrapper
   tx rollback → ledger row never commits.

1.2 **SAVEPOINT ban invariant** — `tests/invariants/no-savepoint-in-migrations.spec.ts`.
   SAVEPOINT in migration body requires `-- ALLOWS-SAVEPOINT: <reason>`
   marker (silent-rollback class formally banned).

1.3 **Entity-diff-witness gate** — `tools/gates/entity-diff-witness.ts`.
   Entity edit in PR diff MUST be accompanied by a new migration OR an
   `ENTITY-DIFF-OK: <service> — <reason>` PR-body waiver.

1.4 **Protected tables SSoT** — `libs/backend-common/src/constants/protected-tables.ts`.
   23 explicit qualified names + `*_outbox` pattern + 3 protected
   schemas + `COMPLIANCE_WAIVER_MARKER_RE`. Destructive DDL on protected
   targets requires `-- COMPLIANCE-WAIVER:` marker (higher bar than R1
   DESTRUCTIVE marker).

1.5 **Single migration runner SSoT** — `createSchemaVersionGate(schema)`
   factory + `DB_MIGRATE_AUTHORITATIVE` env flag. In production, the
   per-service provider is a READ-ONLY ledger probe; aqua-db-migrate is
   the sole writer. Dev defaults to legacy runner mode (backwards
   compatible).

1.6 **Entity-schema-declaration AST invariant** — per-tenant entities
   OMIT `schema:`, cross-tenant entities (outbox, audit, retention)
   DECLARE explicitly.

1.7 **RLS predicate canonical invariant** — every inline `CREATE POLICY`
   uses the canonical USING clause from `apply-tenant-rls.helper.ts`
   (5 structural elements: bypass_rls clause + current_tenant clause +
   NULLIF + ::uuid cast + `, true` second arg).

1.8 **Schema-drift Class K: foreign_key_presence** — `pg_constraint
   contype='f'` count vs `entity.foreignKeys.length`. Opt-in via
   `SCHEMA_DRIFT_VALIDATE_FK=true` during Faz 1 rollout; Phase 8 elevates
   to error after Faz 6 cleanup.

1.9 **Platform trigger functions init script** — `infrastructure/docker/init-scripts/05-platform-functions.sql`.
   `update_updated_at_column`, `current_tenant_id`, `set_tenant_id` move
   from farm-service's untracked raw-SQL chain to platform-superuser
   bootstrap.

1.10 **Platform extensions init script** — `uuid-ossp`, `pg_trgm`,
   `btree_gist`, `pgcrypto`, `vector` (+ existing `timescaledb`)
   promoted to `00-init-schemas.sh` from per-service migration scatter.

1.11 **CODEOWNERS migration SSoT** — migration runtime + deploy manifest
   paths require infra-expert + database-reviewer dual review.

1.12 + 1.13 **Tenant-fanout entity ↔ MODULE_SCHEMAS parity** —
   every per-tenant entity table is listed in `MODULE_SCHEMAS.tables` for
   its service; every MODULE_SCHEMAS entry has a backing entity file.
   Source-level guarantor of TenantSchemaSyncService fan-out completeness.

### Edge schema ownership (Faz 2)

Edge platform v2 — 7 per-tenant tables under sensor schema, owned by
sensor-service. See ADR-025 for the full decision record. ADR-022 is
marked SUPERSEDED.

### Baseline migration generation (Faz 3)

Tooling: `scripts/migration/baseline-generator.ts` 4-mode generator
(archive-old → generate → audit → verify). Runbook:
`docs/runbooks/baseline-migration-generation.md`. 14-service topological
order — platform-level Tier 1 (admin/auth/billing/config/event-store/
notification/observability) before tenant-scoped Tier 2 (ai/alert/farm/
hr/hydroponics/messaging/sensor). Execution is operator-driven in the
Faz 6 deploy window.

### Init-script SSoT (Faz 4)

`SHARED_SCHEMA_TABLES` updated to canonical 5 (was 4 — added
`access_logs`). New invariant `tests/invariants/shared-schema-canonical.spec.ts`
cross-checks generate-init-schemas.ts ≡ protected-tables.ts ⊆
10-shared-schema.sql.

### Production reset (Faz 6 — operator-executed)

Documented sequence: services down → MinIO purge → NATS purge → Redis
flushdb → OPA reset → DROP SCHEMA in tier order (leaf → consumer →
domain → shared → auth) → init scripts re-run → aqua-db-migrate
baseline run → SUPER_ADMIN restore → reference data seed → Prometheus
tombstone → services up → smoke tests. ~15–30 min downtime; no real
customer data lost per operator authorization.

## Consequences

### Positive

- **Drift archaeology zeroed.** Faz 6 cutover commits a single
  `1800000000000-Baseline.ts` per service; ~120 pre-reset migration
  files move to `.archive/` and are not part of forward-only history.

- **Single ledger writer in production.** ADR-021 cutover collapses the
  two-writer surface — silent-applied class becomes structurally
  impossible because the per-service runner cannot write to the ledger.

- **PR-time gate against future drift.** entity-diff-witness +
  tenant-fanout-entity-parity + protected-tables-guard +
  no-savepoint-in-migrations + rls-predicate-canonical +
  entity-schema-declaration + shared-schema-canonical — 7 source-level
  invariants catch the regression class at every PR.

- **Edge ownership clarified.** sensor-service owns the v2 schema +
  entities + migrations; admin-api consumes via Open Host Service.
  ADR-011 invariant restored.

### Negative

- **One-way door — tenant data unrecoverable.** Faz 6 wipes every
  pre-reset tenant. The `pg_dump --schema-only --data-only` snapshot
  taken in Faz 0 is the only rollback path; the snapshot is retained
  for 7 days then deleted (per ADR-025 §"Backup retention" + GDPR Art
  5(1)(e) storage limitation). Beyond that window, the pre-reset state
  is gone.

- **MFA encryption key loss = SUPER_ADMIN permanent lockout.** Faz 0
  MUST vault `MFA_ENCRYPTION_KEY` + `PASSWORD_PEPPER`. KMS rotation
  during the reset window is forbidden. This is the single irreversible
  failure mode of the plan.

- **Migration history loss.** Pre-reset commits remain in git via
  `git tag pre-baseline-2026-05-XX`, but the working tree contains only
  the Baseline migration. `git blame` against pre-reset entity edits
  requires the tag.

- **Live execution dependence.** Faz 3 typeorm migration:generate
  requires a fresh dev Postgres; the source-level deliverable is
  tooling + runbook. Operator drives the per-service generation in the
  Faz 6 window.

### Architectural risk tier

Tier 1 (make-it-impossible) for the invariants. Tier 4 (operator
runbook) for the production reset execution. The combination is the
floor of the discipline.

## Alternatives Considered

### Alternative A — Incremental cleanup (no reset)

Rejected. Drift archaeology is the symptom; the cause is missing
PR-time invariants + dual-writer ledger surface + entity-fingerprint
gap. Without removing the legacy migration history, every new "Align*"
migration adds noise to the corpus without addressing the structural
defect. The operator declared on 2026-05-18 that the test-data-only
production state authorizes the cleaner approach.

### Alternative B — Lockfile-based entity-fingerprint manifest

Originally planned in Faz 1.3. Deferred to Faz 7 (post-reset). The
fingerprint snapshot is only meaningful after the baseline reset
stabilizes the entity surface; capturing it pre-reset would lock the
manifest to the legacy shape. Faz 1.3 ships the diff-time entity-diff-
witness gate which provides equivalent PR-time coverage.

## Operational

- **Branch:** `migration` — all 9 commits land on this branch.
- **PR:** #288 (draft) — opened 2026-05-18 to exercise CI workflows;
  merged on the Faz 6 cutover atom.
- **Plan dossier:** `/root/.claude/plans/peppy-crafting-waterfall.md`.
- **Faz 6 deploy script:** `scripts/deploy/droplet-up.sh` + manual
  psql operations documented in the runbook.

## Compliance

- ADR-011 Schema Ownership Model: reinforced (Faz 2 edge move
  restores invariant; Faz 1.6 entity-schema-declaration AST verifies).
- ADR-012 Schema Drift Prevention: extended (Class K FK + post-condition
  probe close the silent-applied class).
- CLAUDE.md "Inviolable rules" #1 (ledger applied iff DDL applied):
  structurally enforced via post-condition probe + single-writer cutover.
- CLAUDE.md "Inviolable rules" #2 (@Entity schema discipline):
  Faz 1.6 invariant.
- ADR-022 Edge Schema Placement: superseded by ADR-025.

## Open Items

- **OPEN-ADR-030-1:** Lockfile-based entity-fingerprint manifest
  (deferred from Faz 1.3 to Faz 7 post-reset). Scheduled for the
  30-day post-reset monitoring window.

- **OPEN-ADR-030-2:** Per-tenant `audit_archive_v1` partition count
  budget at scale (carried from ADR-025 §"Open Items").

- **OPEN-ADR-030-3:** Pre-existing CI failures (web/shell lint, E2E,
  security-audit, three-store stale-SHA) are pre-existing repo issues
  surfaced as deltas in PR #288's `nx affected` graph. Sweep in a
  follow-up PR; not blocking the Faz 6 cutover.
