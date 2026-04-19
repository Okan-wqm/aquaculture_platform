# Review: Main-branch GitHub Actions failure remediation

- **Branch reviewed:** `main` HEAD `842e9df4` (2026-04-17 19:26 UTC)
- **Cycle:** 2026-04-19 incident response
- **Reviewer:** infra-expert (auxiliary review for the four-failure incident)
- **Plan reference:** `/root/.claude/plans/sparkling-swimming-turtle.md`

## Context

Four workflows on `main` were red simultaneously, blocking the deploy chain to the DigitalOcean droplet and emitting nightly failure noise on three schedules:

1. `CI - Affected → deploy / build-frontend-artifacts` (push-triggered) — broke deploy.
2. `Security - Trivy` (weekly schedule) — image scan parse error.
3. `Backup - Production Postgres` (nightly schedule) — env contract violation.
4. `Infrastructure - Terraform Drift Detection` (nightly schedule) — AWS surface unused.

This document records the root causes and the architectural fixes per CLAUDE.md tier hierarchy.

---

## INFRA-CRITICAL-001 — tenant-admin build broken on `main` HEAD

- **Severity:** CRITICAL (blocks every deploy from `main`)
- **Layer:** 1
- **Evidence:** `web/modules/tenant-admin/src/pages/TenantDashboard.tsx:167` — TS1109 in CI run `24582890424` job `71885380750`.
- **Root cause:** `enabled: !!tenantId,` was placed inside the `(modules || []).map((m) => { return {...}; })` callback's return-object close, where it parsed as a stray label expression. The corrected shape (now landed): the `enabled` key belongs to the enclosing `useQuery({...})` options object, after `queryFn:` closes.
- **Latent surface:** the syntax error masked 21 TS6133 (unused-locals) errors in `useDevicePolling.ts` and `useTenantData.ts` — leftovers from the `cleanup-tenant-query-key` codemod (commit `0a4f88f8`) that landed on `agentic` and never reached `main`. Fix-forward had to bring all three files to a buildable state in one atomic commit.
- **Architectural tier:** T1 (correct shape via cherry-pick + manual TS2304 fix in `useDeviceAction()` where `tenantId` is legitimately referenced for cache invalidation).
- **Prevention surface:** explored — pre-push hook running `nx affected --target=build,lint`. Rejected because the workstation cannot sustain the build cost on every push (lint OOMs at default Node heap, build saturates). CI - Affected remains the canonical gate; the architectural prevention layer for *this class* of error has to live at the GitHub branch-protection layer once the team's velocity preferences allow it.

## INFRA-HIGH-002 — Trivy image-ref violates OCI lowercase requirement

- **Severity:** HIGH (nightly security scan red)
- **Layer:** 3
- **Evidence:** `.github/workflows/security-trivy.yml:71` (and `:63`); CI run `24621760712` Trivy 0.69.1 error: `failed to parse the image name: could not parse reference: ghcr.io/Okan-wqm/aquaculture_platform/gateway-api:latest`.
- **Root cause:** workflow expanded `${{ github.repository }}` → `Okan-wqm/aquaculture_platform`. The owner segment's uppercase `O` violates the OCI distribution spec (image references must be lowercase). Trivy 0.69+ enforces this strictly.
- **Architectural tier:** T1 — workflow-level `env: IMAGE_NAMESPACE: ghcr.io/okan-wqm/aquaculture_platform` is now the single source of truth for the image namespace; both `docker pull` and `image-ref:` reference it via `${{ env.IMAGE_NAMESPACE }}`.

## INFRA-HIGH-003 — Backup workflow lacks fail-fast secret preflight

- **Severity:** HIGH (nightly backup red since the secrets were not provisioned)
- **Layer:** 3
- **Evidence:** `.github/workflows/backup-production.yml:94–102`; CI run `24621923865` log line `tools/scripts/database/backup-databases.sh: line 41: SPACES_BUCKET: SPACES_BUCKET required`.
- **Root cause:** the script (which is the SSoT for the env contract) validates seven required secrets at line 41. The workflow did not validate them on the runner before opening the SSH tunnel + syncing the script + invoking it remotely (~30s wasted per failure run). Missing-secret errors surfaced inside the droplet log instead of the GitHub job log header.
- **Architectural tier:** T3 — added a runner-side preflight step that mirrors the script's env contract and emits `::error::Missing required secrets: ...` with the Settings URL inline. The script remains the SSoT; the workflow preflight just shifts the failure to the earliest possible point.
- **Operator action required:** the seven backup secrets (plus three SSH secrets) must be provisioned at `https://github.com/Okan-wqm/aquaculture_platform/settings/secrets/actions` before the next scheduled run can succeed. Code-side change unblocks the *detection*, not the *credential supply*.

## INFRA-HIGH-004 — AWS Terraform surface unused; nightly drift fails on missing OIDC role

- **Severity:** HIGH (nightly drift red; plan + apply workflows latently broken)
- **Layer:** 4
- **Evidence:** `.github/workflows/infra-terraform-drift.yml:42` (also `infra-terraform-plan.yml:67`, `infra-terraform-apply.yml:63,189`); CI run `24623695869`: `aws-actions/configure-aws-credentials: Could not load credentials from any providers`.
- **Root cause:** the platform deploys to **DigitalOcean** per `docs/DEPLOY.md`. The AWS-targeted Terraform tree (`infrastructure/terraform/{environments,bootstrap}/` + `modules/{eks,rds,rds-proxy,elasticache,secrets-manager,networking}/`) and its three workflows assume an AWS OIDC role that was never provisioned. The surface cannot succeed in this account.
- **Architectural tier:** T1 — delete the surface that cannot succeed. Removed three workflows + the entire AWS-targeted Terraform tree. Preserved `infrastructure/terraform/modules/staging-droplet/` (DO-targeted) as the seed for any future DO Terraform work.
- **Out of scope:** introducing a DO-Spaces Terraform backend or a DO-credential drift workflow. Tracked as future work when DO IaC actually exists.

---

## INFRA-MEDIUM-005 — `scripts/*.js` use CommonJS under `type: module`

- **Severity:** MEDIUM (blocks dependabot PRs via schema-validation job; latent for the other two scripts)
- **Layer:** 3
- **Evidence:** `scripts/package.json` declares `"type": "module"`. Three sibling files used `const X = require('Y')`:
  - `scripts/validate-pagination-schema.js:14` (the one CI tripped on, dependabot PR #10 schema-validation job `72031489535`)
  - `scripts/seed-feeds.js:8` (latent)
  - `scripts/update-feeds-max-weight.js:5` (latent)
- **Root cause:** Node 22 honours the parent `package.json` `type: module` declaration and refuses to evaluate `require()` in any `.js` file underneath it.
- **Architectural fix (T1):** all three files converted from `const X = require('Y')` → `import X from 'node:Y'`. None of them use `module.exports`, `__dirname`, or `__filename`, so the conversion is mechanical (one line per file). Aligns the file content with the directory's module contract instead of weakening the contract via `.cjs` renames.

---

## INFRA-CRITICAL-006 — `AddTenantCostRollup` migration: RLS after columnstore enable rejected by TimescaleDB ≥2.18

- **Severity:** CRITICAL (blocks every deploy at the db-migrate container; no service starts)
- **Layer:** 1
- **Evidence:** `apps/observability-service/src/database/migrations/1805000000000-AddTenantCostRollup.ts:146` (RLS) and `:172` (`timescaledb.compress`); CI run `24635946979` deploy job `72031661385`; log:
  ```
  aqua-db-migrate | Migration failed
    schema: observability
    migration: AddTenantCostRollup1805000000000
    error: operation not supported on hypertables that have columnstore enabled
  ##[error]aqua-db-migrate failed — schema migration aborted BEFORE service containers started.
  ```
- **Root cause:** TimescaleDB ≥2.18 reframes `timescaledb.compress` as columnstore mode on the hypertable; once columnstore is on, the engine rejects subsequent vanilla `ALTER TABLE ENABLE/FORCE ROW LEVEL SECURITY`. The migration enabled compression first (line 172), then attempted RLS (line 146 in original) — second operation crashed the migration.
- **Architectural fix (T1, reorder to honour the columnstore lock-out):**
  - **`up()`:** CREATE TABLE → CREATE INDEX → **RLS (ENABLE / FORCE / CREATE POLICY)** → `create_hypertable` → `SET (timescaledb.compress …)` → `add_compression_policy` → `add_retention_policy`. RLS lands on a regular table; `create_hypertable` preserves policies. No functional change to the resulting object — same constraints, same indexes, same hypertable, same 14-day compression, same 90-day retention, same tenant-scoped policy with `observability_service_admin` bypass.
  - **`down()`:** `remove_retention_policy` → `remove_compression_policy` → `DROP TABLE … CASCADE`. CASCADE is the TimescaleDB-canonical teardown — atomically removes policies, RLS state, indexes, hypertable metadata, and compressed chunks in one shot, side-stepping the same columnstore-vs-ALTER restriction. Removed the redundant manual `DROP POLICY` + `DISABLE RLS` calls that would have hit the same engine rejection.
- **Cross-audit:** `apps/sensor-service/src/database/migrations/1735900000000-CreateSensorMetrics.ts` also uses `timescaledb.compress` but does **not** add RLS — no ordering conflict, no change required. No other migrations in `apps/**/database/migrations/` touch both compression and RLS on the same table.
- **Prevention:** the ordering invariant ("RLS before compression on hypertables") is documented inline in the migration's RLS block as a load-bearing comment — any future engineer reordering the operations will see the rationale + the exact engine error they will trigger.

---

## INFRA-CRITICAL-007 — RLS ⊥ columnstore mutual exclusion: chose RLS, dropped compression

- **Severity:** CRITICAL (deploy chain still red after INFRA-CRITICAL-006 reorder)
- **Layer:** 1
- **Evidence:** Run `24636448772` deploy job `72033366423` log:
  ```
  Migration failed
    schema: observability
    migration: AddTenantCostRollup1805000000000
    error: columnstore cannot be used on table with row security
  ```
- **Root cause:** TimescaleDB ≥2.18 enforces a HARD MUTUAL EXCLUSION between RLS and columnstore on the same hypertable. The INFRA-CRITICAL-006 reorder (RLS-first) traded one engine rejection for another:
  | Order tried | Engine response |
  |---|---|
  | compress → RLS | `operation not supported on hypertables that have columnstore enabled` |
  | RLS → compress | `columnstore cannot be used on table with row security` |
  Order does not unlock either side.
- **Architectural fork (must pick exactly one):**
  - **(A)** keep columnstore, drop RLS → tenant isolation moves entirely to the service layer.
  - **(B)** keep RLS, drop columnstore → preserves DB-level defense-in-depth, loses ~50% storage savings on cold buckets.
- **Decision: (B).** User-confirmed. Rationale:
  - Multi-tenant SaaS: tenant isolation is the load-bearing platform invariant; RLS is the DB-level enforcement of that invariant.
  - Documented retention scale: ~29k rows/day × 90 days = ~2.6M rows total; PostgreSQL handles this trivially without compression.
  - Compression savings (~1-2 GB/year) are immaterial vs the integrity guarantee RLS provides.
  - Future cold-storage compression can be reintroduced via a continuous aggregate (no RLS on the aggregate, RLS-equivalent filter pushed into the materialized query) when the dataset grows enough to justify it.
- **Fix landed:**
  - Removed `ALTER TABLE … SET (timescaledb.compress, …)` block.
  - Removed `add_compression_policy(…, INTERVAL '14 days', …)` call.
  - Kept `create_hypertable` (for chunking) and `add_retention_policy(…, INTERVAL '90 days', …)` (time-based pruning).
  - Kept full RLS (ENABLE + FORCE + tenant_scope policy + `observability_service_admin` bypass).
  - `down()`: removed `remove_compression_policy` call (nothing to remove).
  - Load-bearing inline comment in `up()` documents the constraint, the architectural fork, and the chosen branch — any future engineer attempting to re-add columnstore will see the trade-off and the path through continuous aggregate.

---

## INFRA-CRITICAL-008 — Boot signal `migration_runner_applied` never fires after db-migrate centralization

- **Severity:** CRITICAL (deploy gate stuck "23 signal(s) pending" indefinitely; all containers report healthy but boot signal assertion times out)
- **Layer:** 2
- **Evidence:** Run `24636862240` deploy log:
  ```
  === Boot signal assertion ===
    manifest: infrastructure/deploy/required-signals.yaml
    services: 12
  --- Round 1/18: 23 signal(s) pending ---
  --- Round 12/18: 23 signal(s) pending ---
  ```
  All 12 services healthy, all migrations applied centrally by `aqua-db-migrate`, but `migration_runner_applied` signal never matches.
- **Root cause:** the WS7 / ADR-016 Phase F deploy gate's `migration_runner_applied` signal pattern was `"migration(s)"` (substring of `Applied N migration(s): …`). After db-migrate centralization, every service's per-service migration runner sees 0 pending migrations on warm start and instead logs `No pending migrations on "<schema>"` — a string that does NOT contain `migration(s)` (with parens). The signal silently never fires; the gate silently rejects every deploy.
- **Architectural fix (T1, canonical single-source-of-truth signal):**
  - `MigrationRunnerService.onApplicationBootstrap()` now emits an unconditional end-of-run line — `Migration runner complete for schema "<sourceSchema>": tenants=<N>` — at the success exit. Fires on BOTH cold start (>0 pending applied) and warm start (0 pending). Failure paths (security throw, runner exception) intentionally do not emit it, so the contract still proves the runner reached the success exit.
  - `required-signals.yaml` signal_library pattern changed from `"migration(s)"` to `"Migration runner complete"` (substring of the new canonical line).
  - The pre-existing per-schema logs (`Applied N migration(s) on "X"` and `No pending migrations on "X"`) are unchanged — they still document per-schema progress; they are just no longer the contract surface for the deploy gate.
  - Refactored the orphan `if (!tenantAware) return;` early-return into a single `tenantAware` branch so the canonical complete log lands once per runner invocation regardless of fan-out shape.
- **Why not just loosen the pattern:** a substring like `"migration"` would match `migration failed`, `running migration`, etc. — any noise word would falsely satisfy the contract. The canonical-log approach pins the signal to a single code emission point, which is the discipline `required-signals.yaml`'s `signalSource` convention requires.

---

## Out of scope for this review

- **CI - Full** workflow failures (user team does not run it).
- **Branch protection on `main`** (user prefers fast direct-push iteration during the current dev phase).
- **Pre-push hook** (workstation cannot sustain `nx affected --target=build,lint` cost; explored and rejected).
- **Dangling docs:** `docs/runbooks/staging-environment.md:98–290` references `infrastructure/terraform/environments/staging/` which is forward-looking (Phase 2 plan, never created). Left intact — the runbook is a plan document, not an active code path.
- **`tools/scripts/database/backup-databases.sh`** itself — its env-validation block is the SSoT we mirrored; no changes required.
