# Cold Audit Remediation Plan — 2026-04-22

**Cycle:** `2026-04-22-cold-audit`
**Findings source:** [03-explore-findings.md](../../reviews/_audit/2026-04-22-cold-audit/03-explore-findings.md)
**Registry entries:** `AUDIT-CRITICAL-00{1..3}`, `AUDIT-HIGH-00{2..8}`, `AUDIT-MEDIUM-00{1,4,5,6,7,9,10,11,12,13}`, `AUDIT-LOW-001` (21 entries, positions 133–153 in `docs/reviews/_registry/findings.jsonl`).

## Context

A cold baseline audit of the 17-service monorepo surfaced 21 findings. Three CRITICAL plumbing defects render the local developer CI theater — `type-check`, `gates:all`, and `invariants:fast` each fail silently or incompletely, so every PR "passing" local gates is lying. Separately, 89 files across farm/sensor/auth/billing bypass tenant isolation via raw `getRepository()`, and ~5,000 lines of domain logic (water chemistry, ST-AST, AI safety, UI edges) are duplicated across services that already have shared libs. This plan sequences fixes so that (a) CI signal is restored first, (b) tenant-bypass becomes compile-time impossible before manual migration, and (c) each duplicate extraction is a single diff against a single commit.

**Out of scope:** the plan produces a backlog; each finding is closed by a separate PR with a `Closes: docs/reviews/_audit/2026-04-22-cold-audit/03-explore-findings.md#AUDIT-<ID>` line, per CLAUDE.md "Review Finding Traceability".

## Dependency DAG

```
                     ┌──────────────────┐
                     │ AUDIT-CRITICAL-3 │  invariants:fast duplicate-ids
                     │   (dedup + fix)  │  ← BLOCKS nothing new; but must
                     └────────┬─────────┘     be green BEFORE any further
                              │                finding-add in any cycle
                              ▼
┌───────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ AUDIT-CRIT-1  │    │ AUDIT-CRIT-2     │    │ eslint rule:     │
│ type-check    │    │ gates:all --mode │    │ no-direct-       │
│ (root tsconfg)│    │ (require arg)    │    │ getRepository    │
└───────┬───────┘    └────────┬─────────┘    └────────┬─────────┘
        │                     │                        │
        └──────── CI gate working ──────────┐         │
                                            │         │
                                            ▼         ▼
                                ┌───────────────────────────┐
                                │ AUDIT-HIGH-2,3,7,8        │  (farm, sensor,
                                │ getRepository migration   │   auth, billing)
                                │ AUDIT-MEDIUM-7 (auth edge)│   89 files total
                                └───────────────────────────┘

 Independent extraction work (parallelizable once CRITICAL-3 is green):
   AUDIT-HIGH-4 water-chemistry  → farm-expert
   AUDIT-HIGH-5 ST-AST           → sensor-expert
   AUDIT-HIGH-6 node-components  → frontend-expert
   AUDIT-HIGH-7 AI safety        → security-reviewer
   AUDIT-MEDIUM-11 Sidebar       → frontend-expert
   AUDIT-MEDIUM-12 aquamobil     → frontend-expert
   AUDIT-MEDIUM-13 nats cycle    → platform-kernel-expert

 Monitor-only (Tier 4, no PR unless next cycle escalates):
   AUDIT-MEDIUM-1,4,9,10   +  AUDIT-LOW-1

 Tier 2/3 gate work (after CRITICAL):
   AUDIT-MEDIUM-5 barrel split   → data-expert
   AUDIT-MEDIUM-6 messaging JOIN invariant → messaging-expert
```

## Phase A — Restore CI signal (CRITICAL, blockers for everything else)

| Finding | Tier | Owner | Expected commits | Closes |
|---|---|---|---|---|
| `AUDIT-CRITICAL-001` | 1 make-impossible | orchestrator | 1 | `Closes: docs/reviews/_audit/2026-04-22-cold-audit/03-explore-findings.md#AUDIT-CRITICAL-001` |
| `AUDIT-CRITICAL-002` | 1 make-impossible | orchestrator | 1 | `Closes: docs/reviews/_audit/2026-04-22-cold-audit/03-explore-findings.md#AUDIT-CRITICAL-002` |
| `AUDIT-CRITICAL-003` | 1 make-impossible | context-manager | 1 (split possible) | `Closes: docs/reviews/_audit/2026-04-22-cold-audit/03-explore-findings.md#AUDIT-CRITICAL-003` |

**A.1 type-check** — add root `tsconfig.json` that extends `tsconfig.base.json` with `include: ["apps/**/*.ts", "libs/**/*.ts", "platform/**/*.ts", "web/**/*.ts"]` and `exclude: ["**/node_modules", "**/dist", "**/*.spec.ts"]`. Alternatively keep the base-only pattern but rename the script: `"type-check": "tsc --noEmit -p tsconfig.type-check.json"` and create that file. Acceptance test: `npm run type-check` must print at least one file name on stdout OR fail with "No inputs were found" (exit code 18 vs 0 from help page).

**A.2 gates:all** — extend `tools/gates/banned-phrase.ts` to accept `--mode=staged` as a default when no `--mode` is given; OR wrap `npm run gates:banned-phrase` in a shim that passes `--mode=staged`. Parallel change: `gates:all` invocation in package.json passes the mode explicitly. Acceptance test: running `npm run gates:all` with zero args exits 0 (or non-zero for an actual violation) — never exits 2 with "Usage:".

**A.3 invariants:fast** — two independent defects:
1. `finding-registry-integrity.spec.ts:144` — `expect(duplicates).toEqual([])`. Duplicates exist in the registry (e.g., `INFRA-CRITICAL-001`, `INFRA-HIGH-002`). Fix: run `ts-node tools/scripts/seed-finding-registry.mjs --dedupe` if such mode exists; otherwise hand-correct the JSONL (sort + dedupe by id, keep earliest `created_at`) and re-chain via `finding-registry rechain-from 0`. After: invariant goes green.
2. `knowledge-ssot.spec.ts` — expected 17 services; `apps/` has 17 dirs (15 runtime + `db-migrate` CLI + `sensor-ingestion`). Either adjust the expected count to 17 in the spec OR correct CLAUDE.md which claims "16 services" (should be "17" — `sensor-ingestion` and `db-migrate` are both present). Recommendation: correct CLAUDE.md to `17 services (15 classic runtime + sensor-ingestion + db-migrate CLI)` to match reality.

**Exit criterion for Phase A:** `npm run type-check && npm run gates:all && npm run invariants:fast` exits 0 locally and in CI.

## Phase B — getRepository() → getScopedRepository() migration (HIGH, 5 findings, ~89 files)

**Precondition:** Phase A complete.

**B.0 Ban new violations first** (Tier 1, new work not yet covered by a finding but required before migration):
- Add ESLint rule `no-restricted-imports` + `no-restricted-syntax` to block `TypeOrmModule.forFeature` callers from using `getRepository` or `this.dataSource.getRepository` outside `libs/backend-common/src/database/tenant-aware.repository.ts`.
- File this as a new finding `AUDIT-CRITICAL-004 (ESLint rule for no-direct-getRepository)` when Phase B begins.

**B.1–B.5 Migration per service** (parallelizable after B.0):

| Finding | Service | Files | Owner | Expected commits |
|---|---|---|---|---|
| `AUDIT-HIGH-002` | farm-service | ~18 | data-expert + farm-expert | 3–4 (by domain: storage / scheduler / feeding / equipment) |
| `AUDIT-HIGH-003` | sensor-service | ~7 | data-expert + sensor-expert | 2 (ingestion / automation) |
| `AUDIT-HIGH-008` | billing-service | ~8 | billing-expert + data-expert | 2 (invoicing / subscription) |
| `AUDIT-MEDIUM-007` | auth-service | ~5 | auth-security-expert | 2 — split between (a) legit cross-tenant resolver calls (document + keep) and (b) actual bypasses (migrate) |
| (combined)  | hr, messaging, admin | ~10 | respective domain expert | 3–5 |

**Migration pattern per file** (same for all):
```ts
// before
const repo = this.dataSource.getRepository(BatchEntity);
await repo.findOne({ where: { id } });

// after
const repo = this.scopedRepoFactory.for(BatchEntity);   // auto-scopes by TenantContext
await repo.findOne({ where: { id } });
```

Each commit carries `Closes: docs/reviews/_audit/2026-04-22-cold-audit/03-explore-findings.md#AUDIT-<SEVERITY>-<NNN>` and leaves the ESLint rule in place.

**Blue-green note:** no schema change — pure code swap. Safe to land behind a feature flag, but the rule is runtime-transparent so flags add cost without benefit.

## Phase C — Duplicate extraction (HIGH + MEDIUM, 7 findings, ~5000 lines of dupe elimination)

**Precondition:** none (independent of A/B). Can begin immediately after Phase A.

| Finding | Source | Target | Owner | Expected commits |
|---|---|---|---|---|
| `AUDIT-HIGH-004` | web/modules/farm-module/.../water-chemistry/engine/* | `libs/aquaculture-engines` (exists) | farm-expert | 1 (delete + import rewrite) |
| `AUDIT-HIGH-005` | apps+web sensor AST copies | new `libs/sensor-automation-types` | sensor-expert + edge-expert | 2 (lib create + consumer rewrite ×2) |
| `AUDIT-HIGH-006` | web/modules/sensor-module edge copies | `libs/node-components` (exists) | frontend-expert + sensor-expert | 1 (delete + import rewrite) |
| `AUDIT-HIGH-007` | apps/ai-service + apps/messaging-service safety | new `libs/backend-common/src/ai-safety/` | security-reviewer + data-expert | 1 (lib move + 2 consumer rewrite) |
| `AUDIT-MEDIUM-011` | web/admin-panel AdminSidebar | parameterize `web/shared-ui` Sidebar | frontend-expert + admin-expert | 1 |
| `AUDIT-MEDIUM-012` | aquamobil record pages | `web/apps/aquamobil/src/pages/_shared/RecordEntityPage` | frontend-expert | 1 |
| `AUDIT-MEDIUM-013` | platform/libs/event-bus cycle | extract bare `NatsEventBus` class | platform-kernel-expert | 1 |

**Rubric:** whenever a lib already exists (`libs/aquaculture-engines`, `libs/node-components`, `web/shared-ui`) the target is that lib. Only create a NEW lib when no home exists (ST-AST types, AI safety).

**Blue-green note:** each deletion+rewrite is atomic — the deleted files have no runtime importers other than the ones being updated. CI should go green in a single PR per finding.

## Phase D — Tier 2/3 hardening (MEDIUM)

| Finding | Tier | Owner | Expected commits |
|---|---|---|---|
| `AUDIT-MEDIUM-005` | 2 make-automatic | data-expert | 1–2 (split backend-common barrels; move schema-manager into migration-runner) |
| `AUDIT-MEDIUM-006` | 3 make-detectable | messaging-expert + database-reviewer | 1 (add no-orphan-query invariant test) |
| `AUDIT-MEDIUM-009` | 4 document + 3 detect | admin-expert | 1 (ADR: admin-write boundaries + CI invariant) |

## Phase E — Monitor / informational (Tier 4, no PR unless re-surfaced)

- `AUDIT-MEDIUM-001` (web/sensor-module churn) — revisit next cycle; escalate if churn + failing e2e correlate.
- `AUDIT-MEDIUM-004` (hr-service churn) — monitor; expected during feature work.
- `AUDIT-MEDIUM-010` (web/tenant-admin churn) — monitor.
- `AUDIT-LOW-001` (Nx scaffolding dupes) — document-only; pre-empt future audits re-raising this class.

## Verification (post-plan execution)

1. `npm run findings:verify` — chain remains valid.
2. `npm run findings:list | grep AUDIT- | wc -l` — drops from 21 to 0 once Phase A/B/C/D commits land (each carries `Closes:` that the state-sweep cron transitions OPEN → RESOLVED).
3. `npm run invariants:fast` — zero failures.
4. `npm run type-check` — actually checks files (exit code 0 WITH file count > 0 on `--listFiles`).
5. `grep -rnE 'getRepository\(' --include='*.ts' apps libs | grep -vE '(__tests__|tenant-aware.repository.ts)'` — empty.
6. `npx jscpd --min-tokens 100 apps libs platform web --reporters json` — expect ≥ 50% reduction in ≥100-line clones vs. pre-plan baseline (currently 33).

## Estimated effort

| Phase | Findings | Parallelizable PRs | Sequential time estimate |
|---|---|---|---|
| A (CRITICAL) | 3 | 3 (fully parallel) | 1–2 engineer-days |
| B (getRepository) | 5 | 5 (after B.0 rule) | 3–5 engineer-days total |
| C (Duplicate extraction) | 7 | 7 (fully parallel) | 2–4 engineer-days total |
| D (Hardening) | 3 | 2 sequential | 1–2 engineer-days |
| E (Monitor) | 4 | — | — |

**Total for closing all CRITICAL + HIGH (10 findings):** ~5–10 engineer-days, majority paralleliseable across 4–5 domain experts.
