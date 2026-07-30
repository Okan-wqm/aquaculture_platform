---
name: run-migration-prod
description: Execute a migration against production — hard `DATABASE_MIGRATIONS_RUN=false` invariant + per-tenant runner + blue-green 3-step discipline + smoke test + rollback runbook path
type: skill
version: 1
status: reference-only
owners: infra-expert, data-expert, database-reviewer
handoff:
  on_complete_invoke: [infra-expert, data-expert, database-reviewer]
  on_security_touch: security-reviewer
  on_event_impact: null
  on_multi_tenant_touch: multi-tenant-saas-expert
---

# Skill — Run Migration in Production

## When to invoke

After a migration has landed on `main` + passed the `pre-migration-restore-test` skill for any destructive / large / compliance-touching change. This skill is the production execution path — NOT the CI migration-check workflow (which runs against ephemeral test DBs).

## Prerequisites

- Migration file(s) merged to main.
- Restore-test report (`pre-migration-restore-test` Step 7) with go/no-go = GO, signed by infra-expert.
- Maintenance window scheduled OR blue-green-safe migration shape (no `ACCESS EXCLUSIVE` >2s on a live-write table).
- PagerDuty/oncall aware; rollback runbook path identified.
- `DATABASE_MIGRATIONS_RUN=false` confirmed in production env vars — runner owns execution, not TypeORM auto-sync.

## Cascade

### Step 1 — Verify production environment invariants

**Affected files:** (no edits; verification).

**Mechanism:**

```bash
ssh root@<droplet>
# 1. DATABASE_MIGRATIONS_RUN MUST be false
docker exec -e <svc> env | grep DATABASE_MIGRATIONS_RUN
# Expected: DATABASE_MIGRATIONS_RUN=false

# 2. synchronize MUST be false in data-source.ts (static verify)
grep -R "synchronize" apps/<svc>/src/database/data-source.ts
# Expected: synchronize: false

# 3. Current DB connection count + lock-wait count (baseline)
psql <prod> -c "SELECT count(*) FROM pg_stat_activity WHERE state != 'idle';"
psql <prod> -c "SELECT count(*) FROM pg_locks WHERE granted = false;"
```

**Why:** data-expert invariant — production REQUIRES `DATABASE_MIGRATIONS_RUN=false`; the runner hard-fails otherwise. Baseline locks/connections identify the "normal" level before the migration.

**Verification:** all three assertions pass; baseline captured for Step 4 comparison.

**Cross-domain notifications:** `infra-expert` oncall check.

### Step 2 — Take an on-demand backup immediately before the migration

**Affected files:** (no edits; backup).

**Mechanism:**

```bash
./scripts/backup/backup-databases.sh --tag=pre-migration-<migration-slug>
# Verify artefact uploaded + SHA-256 matches .github/manifests/
```

**Why:** regardless of the most-recent scheduled backup's age, take a fresh on-demand one tagged to this migration. If rollback is needed and the scheduled backup is 22h old, you have a ≤1min-old checkpoint. Backup script is hash-pinned per INFRA-1 (`71474fbf`).

**Verification:** backup artefact present in bucket; SHA-256 checksum matches manifest.

**Cross-domain notifications:** `infra-expert` backup verification.

### Step 3 — Run the migration via per-tenant runner (schema-per-tenant) OR per-service runner (shared / core)

**Affected files:** (no edits; execution).

**Mechanism:** choose the runner path by migration target:

**Per-service runner** (migrations targeting `public`, `shared`, or a service's core schema like `auth`, `billing`, `messaging`):

```bash
# SSH into service container, run migration
docker exec <svc>-prod npm run migration:run -- --service=<svc> 2>&1 | tee /tmp/migration-<slug>.log
```

**Per-tenant runner** (migrations targeting schema-per-tenant services — `farm`, `sensor`, `hr`, `hydroponics`, `alert`, `ai`, `messaging/tenant-schemas`):

```bash
# TenantSchemaSyncService iterates every tenant schema
docker exec <svc>-prod npm run tenant:migrate -- --service=<svc> --parallelism=4 2>&1 | tee /tmp/tenant-migration-<slug>.log
```

Migration runs INSIDE the deployed container so app + DB version match. `--parallelism=4` for per-tenant runs allows 4 concurrent tenant migrations (tune per DB capacity — `max_connections` / 4 is a safe ceiling for PG16).

**Why:** per data-expert: a migration that mutates per-tenant tables but is NOT wired into the tenant runner = CRITICAL (silent drift; existing tenants never receive it). Per-tenant runner iterates via `TenantSchemaSyncService`.

**Verification:** log exits 0; per-tenant run shows `N migrations applied across M tenants` matching expected `(new-migrations × tenant-count)`.

**Cross-domain notifications:** `data-expert` migration execution primary; `infra-expert` lock/connection monitoring.

### Step 4 — Live monitoring during execution

**Affected files:** (no edits; observability dashboards).

**Mechanism:** tail three dashboards in parallel during the migration:

1. **PG lock wait** — `SELECT count(*) FROM pg_locks WHERE granted = false;` — spikes >Step 1 baseline = lock pile-up. If >10 for >30s, PAUSE the migration (the `TenantSchemaSyncService` exposes a pause hook).
2. **Query latency** — Prometheus `histogram_quantile(0.99, rate(pg_stat_statements_total_time_bucket{...}[1m]))`. p99 >2× baseline = regression.
3. **Application error rate** — Prometheus `rate(http_requests_total{status=~"5.."}[1m])`. Any spike = rollback candidate.

**Why:** blue-green migrations are only safe IF the migration completes cleanly — a stuck `ALTER TABLE` holds `ACCESS EXCLUSIVE` and blocks all reads + writes until it finishes or is cancelled.

**Verification:** all three dashboards remain within ±20% of baseline for the duration of the migration.

**Cross-domain notifications:** `observability-expert` for dashboard setup; `performance-expert` for regression triage.

### Step 5 — Post-migration schema + invariant verification

**Affected files:** (no edits; verification).

**Mechanism:**

```bash
# 1. SchemaDriftValidator re-run
docker exec <svc>-prod npm run schema:validate -- --service=<svc>

# 2. Adoption invariant test (staging replica of prod)
npx jest --config tests/invariants/jest.config.ts --testPathPatterns=adoption-invariants

# 3. Entity-to-DB column type drift check (database-reviewer pattern)
./scripts/schema-registry/generate-init-schemas.ts --compare-to=prod
```

**Why:** post-migration, reassert every invariant that was green pre-migration. Drift at this stage is the last chance to catch it before the next migration compounds the issue.

**Verification:** all three checks pass.

**Cross-domain notifications:** `database-reviewer` schema-state audit; `data-expert` if drift detected.

### Step 6 — Smoke test — domain-critical flows against prod

**Affected files:** `e2e/tests/smoke/<migration-slug>.spec.ts` (written once per destructive migration; reusable).

**Mechanism:** a minimal-state E2E that exercises the domain path the migration affects — e.g. for "add batch.priority", the smoke test creates a batch, reads it, updates priority, reads it, deletes it. Runs against prod with a smoke-test tenant (never a real customer tenant).

**Why:** invariants + schema checks catch DDL correctness; smoke catches business-logic correctness. A migration that renames a column correctly in DDL but breaks the application's SQL because a stale `SELECT` still references the old name is caught here.

**Verification:** smoke-test exit 0 within 2 min.

**Cross-domain notifications:** `respective-domain-expert` on smoke-test authoring + results.

### Step 7 — Finding registry + deploy record

**Affected files:** `docs/reviews/infra-expert/{date}-prod-migration-{slug}.md`;
registry transition via `.github/workflows/finding-registry-authority.yml`.

**Mechanism:** infra-expert writes a prod-migration report (lock-wait max,
latency p99 delta, migration duration, any warnings). If the migration closes a
tracked finding, first verify that the fix commit carrying the matching
`Closes:` trailer is reachable from protected `main`. Then dispatch the Finding
Registry Authority against `main` with the full lowercase 40-character commit
SHA:

```bash
git fetch origin main
PROTECTED_MAIN_SHA="$(git rev-parse origin/main)"
test "${#PROTECTED_MAIN_SHA}" -eq 40
FIX_COMMIT_REF='origin/main' # set to the protected-main migration fix commit
CLOSING_SHA="$(git rev-parse "${FIX_COMMIT_REF}^{commit}")"
test "${#CLOSING_SHA}" -eq 40
git merge-base --is-ancestor "${CLOSING_SHA}" origin/main

gh workflow run finding-registry-authority.yml --ref main \
  -f operation=close \
  -f command_id='prod-migration:add-batch-priority:INFRA-HIGH-046:close' \
  -f finding_id='<FINDING-ID>' \
  -f closing_sha="${CLOSING_SHA}"
```

The `command_id` is the durable idempotency key: use the exact same value for
every retry of this closure, and never reuse it for another operation. Record
the full protected-main head SHA before dispatch and accept the run only when
its head SHA matches. Never edit `findings.jsonl` or invoke a local registry
mutator.

**Why:** the prod-migration report is the audit-trail anchor for SOC 2 + the go/no-go decision for the NEXT migration attempting the same pattern. Finding-closure closes the review-to-fix traceability loop.

**Verification:** report exists; the generated automation PR is merged only
after required checks pass on its exact head; a fresh protected-main checkout
passes `npm run findings:verify`.

**Cross-domain notifications:** `context-manager` finding state transition; `architectural-arbiter` if the migration revealed a systemic pattern.

### Step R — Rollback (ANY failure in Steps 3-6)

**Affected files:** the rollback migration (pre-authored per data-expert's destructive-migration 4-requirement gate — rollback migration designed pre-merge).

**Mechanism:** rollback strategy is documented PER MIGRATION in its file header comment. Typical shapes:

- **ADD COLUMN reverts**: `ALTER TABLE <t> DROP COLUMN <c>;` — safe if the column was nullable and no prod code reads it yet.
- **Destructive reverts (DROP COLUMN, TRUNCATE, narrowing type)**: NO in-place revert — must restore from the Step 2 backup into staging, verify the expected rows are there, then restore specific tables back to prod via `pg_dump -t <table>` + `psql -c "TRUNCATE <table>; \\copy ...".`. This is why the Step 2 backup is mandatory.
- **RENAME reverts**: `ALTER TABLE <t> RENAME COLUMN <new> TO <old>;` — reversible if no code yet depends on the new name.

Per data-expert: `DROP COLUMN` does NOT reclaim disk until `VACUUM FULL` / `CLUSTER` — the column's pages remain until vacuum runs, so the "oops" window on disk-level recovery can be hours to days.

**Why:** rollback is the 3am call when a migration breaks prod. Pre-authored rollback scripts mean oncall is executing, not designing.

**Verification:** rollback runbook path is referenced in the migration's file-header comment; dry-run executed during pre-migration-restore-test Step 5 (migration + rollback round-trip).

**Cross-domain notifications:** `infra-expert` oncall coordination; `architectural-arbiter` if rollback reveals a design flaw.

## Validation checklist

- [ ] Step 1 `DATABASE_MIGRATIONS_RUN=false` confirmed; baseline metrics captured.
- [ ] Step 2 on-demand backup tagged to migration; SHA-256 verified.
- [ ] Step 3 correct runner path chosen (per-service vs per-tenant).
- [ ] Step 4 three dashboards monitored; within ±20% baseline.
- [ ] Step 5 schema drift validator + adoption invariant + entity-column check all PASS.
- [ ] Step 6 smoke E2E PASS for the affected domain path.
- [ ] Step 7 prod-migration report written; finding-registry closed if applicable.
- [ ] Rollback path (Step R) identified + dry-run validated before this execution.

## Examples

- `apps/messaging-service/src/migrations/1782300000000-AddTenantIdToMessageChildren.ts` — documents a session-scoped search_path anti-pattern (caught by migration-sql-lint R4). The Step R rollback for this migration was to revert the session-scope + add the tenant_id column in a second migration.
- `apps/hr-service/src/database/migrations/1786000400000-MoveEmployeesToHr.ts` — a SET SCHEMA migration; the in-place rollback is `ALTER TABLE hr.employees SET SCHEMA public;` — safe because the move preserves every column + constraint.

## Cross-references

- ADR-011 — schema ownership + migration-runner ownership.
- ADR-012 — schema drift prevention (post-migration verification).
- ADR-016 — deploy resilience (this skill is under that umbrella).
- `.claude/agents/data-expert.md` — destructive-migration 4-requirement gate; migration envelope.
- `.claude/agents/infra-expert.md` — DR / resilience invariants; IP/UG-7 lock-pile-up watch.
- `tools/gates/migration-sql-lint.ts` — R1-R5 rules (pre-merge gate; this skill assumes already-passed).

## Changelog

- v1 (2026-04-17) — initial landing, Phase 3 deliverable.
