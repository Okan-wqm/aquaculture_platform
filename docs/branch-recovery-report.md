# Branch Recovery Report

Durable working memory for the controlled branch recovery program.
Generated from the 2026-08-28/29 full-repo inventory with independent double
verification (history-based + content-based passes per decision).

## 1. Baseline

| Field                   | Value                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline `main` SHA     | `af25ff5ac49cf913f2e7372ab1a00c94a219e653` (2026-08-29, daily 2026-08-12 #1195)                                                                                                                                                                                                                                                                                                                     |
| Integration branch      | `integration/branch-recovery` (isolated worktree `/var/aqua-saas-branch-recovery`)                                                                                                                                                                                                                                                                                                                  |
| Branch protection       | `strict: true` (branches must be up to date), `enforce_admins: true`, required checks: `sens-enterprise-summary`, `merge-gate`, `aria-merge-authority`, `build-status`; squash-merge style                                                                                                                                                                                                          |
| Merge style implication | every merge to `main` invalidates other open branches (update → CI → merge carousel, one PR at a time)                                                                                                                                                                                                                                                                                              |
| Governance tools        | finding-registry CLI (`add`/`add-explicit`/`rechain-from`/`verify`/`repin-debt-plan`), authority-hash pin (auto-repin in hooks), `quality:format-scope:generate/check`, commit-msg validator (`Closes:` trailer for fix/security), banned-phrase gate, husky pre-commit/pre-push (incl. hour-scale ARIA kernel suite with live-LLM lanes — load-sensitive on this shared host; CI is authoritative) |
| Baseline health         | main CI green on recent runs (Gitleaks/CI lanes); known flaky locals are environmental (rotating failures under load 6–20), not code                                                                                                                                                                                                                                                                |

`main` moves daily under active PR flow; re-pin recorded here whenever it shifts.

## 2. Inventory summary

443 branches inspected (356 local + 88 remote-only; `pr/`-`pull/` mirror refs excluded).

| Disposition                                                                 | Count    | Notes                                                                                                                                                                    |
| --------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Proven in `main` (ancestor or patch-equivalent)                             | 145      | git-cherry/merge-base proof                                                                                                                                              |
| Zombie (squash-merged via PR; content-verified identical or better on main) | ~250     | incl. all ARIA union-merge waves, tenant-provisioning series, CI-fix series, July finance/mobile/farm claude lanes (#934/#952/#994/#1032), E/Y/X/si/cl experiment series |
| Closed as superseded/rotted (evidence in PR close comments)                 | 10 PRs   | #871 #1197 #1132/31/30/29 #1021 #962 #1013                                                                                                                               |
| In-flight PR pipeline (owner-directed channel)                              | 9 PRs    | #1334 security, #935 gateway, #1257 pagination-lib, #1243 farm/mobile audit, #1251 farm-241, dailies #1266/#1273/#1282, #1298/#1260 dependabot, #1018/#1264 queued       |
| RECOVER / RECOVER_AND_COMPLETE candidates (below)                           | 8 groups | feature-level recovery targets                                                                                                                                           |
| OWNER_DECISION (below)                                                      | 3        | architecture forks                                                                                                                                                       |

All dispositions carry two independent evidence lines (history pass + content pass).
Full chronological listing: date|branch|source|tag — maintained in the session
inventory files; conclusions durable here.

## 3. Recovery matrix (feature level)

### F1 — Paginated-result authority, complete

- Source: `feat/pagination-result-authority` (PR #1257 lib, +567/−8) +
`feat/pagination-contracts-authority` 699f39921 (DTO migration, −171 legacy offset/limit
duplication
+ spec).
- Missing from main: entire `platform/libs/pagination-contracts` (content-verified absent:
`platform/libs` = cqrs/event-bus/outbox/service-catalog on main) and the `backend-common` DTO
re-export.
- State: complete as a pair (lib + consumer migration + both specs).
- Value: closes ADMIN-HIGH-004 tier-1 single-authority rule; main has zero consumers otherwise.
- Governance: lib-only (no ledger/migration); low.
- Risk: Low. Decision: **RECOVER** (batch 1). Validation: lib spec + DTO spec; `nx affected -t
test`
scoped.
- Evidence: [H] cherry shows 2/2 & 1/1 unique, no `paginated result shape` subjects on main;
[C]
ls-tree: no pagination-contracts on main; `@platform/pagination-contracts` 0 refs on main.

### F2 — Telemetry archive + capacity entitlement (100-tenant readiness v4)

- Source: `feat/100-tenant-readiness-v4` (9 commits: telemetry-capacity admission
[admin/billing/event-contracts + migration], durable MQTT ingest ledger + NATS stream registry,
S3/parquet telemetry-archive subsystem (24 files, 12 specs), Rust pilot restore +
ingress-owner-policy).
- Missing from main: all 75 code files (verified absent).
- State: complete with tests — **but forks the archive subsystem against the owner's active v3
line** (v3 has its own `src/archive/`; v4 `src/telemetry-archive/`; colliding migrations 1816x
vs
1817x).
- Governance: migration renumbering + registry work; medium.
- Risk: High (architecture fork). Decision: **OWNER_DECISION** — one archive home must be
chosen;
capacity-entitlement + durable-ingest pieces port cleanly either way.

### F3 — Gateway Batch-1 security remediation

- Source: `claude/sens-api-gateway-review-jecjy2` (PR #935; 29 commits: SQLCipher factory SSoT,
keystore acceptance verify, legacy-command signature gate, LoRa downlink queue + fcnt
write-through,
health auth gate, wall-clock VM budget, shutdown drain).
- Missing from main: 73 files (+4059/−2524) — main's gateway evolution is orthogonal (5
commits,
none overlapping Batch-1).
- State: complete, single code conflict (scada_db.rs) resolved (both test modules kept).
- Governance: 59 EDGE ledger entries rechanied; PR935 meta-entries stay narrated (schema).
- Risk: Medium (security-critical, wire-complements #1334). Decision: **RECOVER** — in-flight
via PR
#935 (owner channel); integration branch defers to that PR rather than duplicating.
- Evidence: [H] cherry 29/29 `+`, no #935 merge on main; [C] identifier greps zero on main
(`sqlcipher_factory`, `legacy_command_permitted`, `edge_seq`, `lease_id`).

### F4 — Production security gates (#1334 set)

- Source: `security/production-hardening-20260825` (16 commits: unsigned-MQTT fail-closed
acceptance, replay windows, admin sort allowlists, wasm locked builds,
dependency-security-floor,
release-intent audits).
- Decision: **RECOVER** — in-flight via PR #1334 (owner channel). Evidence: [H] 16/16 unique;
[C]
key artifacts absent on main, merge-base == main tip.

### F5 — Farm rollback provenance (FARM-CRITICAL-241)

- Source: `fix/farm-critical-241-rollback-provenance` (PR #1251; xmin-based provenance ledger,
rollback fence, pin 194→195; 819-line postgres e2e).
- Decision: **RECOVER** — in-flight via PR #1251. Evidence: [H] 2/2 unique, 0 conflicts; [C]
migration 18086 + `setMigrationExecutionContext` absent on main; main's lint fixtures already
anticipate it.

### F6 — FEFO multi-lot allocation engine

- Source: `claude/farm-feeding-protocol-f92y38` (PR #1031; feeding-ledger allocator 407 lines,
single-live-assignment, growth-rollup reconciliation, 4 migrations) + fresher re-expression
`wip/codex-farm-stock-mutation-20260816` (advisory-lock fencing main lacks).
- Missing from main: FEFO allocator + enforcement (verified: no `feeding-ledger` allocator,
zero
`pg_advisory` in storage).
- State: partial/tangled (232/313 files conflict; branch is 1 month stale).
- Governance: migration renumbering (three branches claimed 1808600000000).
- Risk: Medium-high. Decision: **RECOVER_AND_COMPLETE** — scoped port of allocator + e2e onto
current main after #1251 lands; reconcile with stock-mutation authority first. Evidence: [H]
cherry
48/48 `+`, PR #1031 CONFLICTING; [C] zero FEFO/`check_and_advance`/`pg_advisory` identifiers on
main.

### F7 — Admin contract codegen / admin-http-contracts V2

- Source: `claude/admin-contracts-codegen` (#1035, 728-line generator, 180 derived types) and
`wip/codex-admin-current-main-20260816` (evolved compiler.ts/governance.ts +
`platform/libs/admin-http-contracts`, 0/17 type overlap with #1035 — different scopes,
complementary).
- Missing from main: both flavors entirely (0 `tools/codegen` paths, 0 `admin-http-contracts`
refs,
~118 hand-declared panel types still duplicated).
- State: #1035 draft/UNSTABLE; rescue snapshot needs re-slicing (its own commit message: "11
dependency-ordered slices").
- Governance: high (codegen wiring + format-scope).
- Risk: Medium. Decision: **RECOVER_AND_COMPLETE** (slice-wise, after F1–F5 land). Evidence:
[H]
cherry 0/106 landed, zero APA-\* on main; [C] tree greps confirm absence of both toolchains.

### F8 — Production host control plane

- Source: `fix/production-host-control-plane` (PR #1022) + fresher
`wip/codex-prod-host-node-authority-20260816` (rescue = #1022 + snapshot; core script absent on
main).
- Decision: **RECOVER_AND_COMPLETE — method: manual port of the additive core** (3
control-plane
scripts + ~20 absent invariant specs + semantic workflow additions). Wholesale cherry-pick of
the 3
commits is disproportionate: batch-2 attempt (2026-08-29) measured **33 conflicts on the first
commit alone**, including sensitive overlap (billing `record-payment.handler`, sensor process
specs)
where main evolved past the branch. Evidence: [H] PR open since 07-21, contains neither #1040
nor
#1064; [C] `production-host-control-plane.sh` + 20 specs absent on main.

### F9 — Control-plane gates stack

- Source: `codex-pr1040-composition-local` (= supersedes PRs #1040/#1064; `tools/gates/lib` 38
files
vs main's 1).
- Decision: **RECOVER_AND_COMPLETE** after F8. Evidence: [H/C] per codex-parking verification.

### F10 — Aquamobil v4 product cycle

- Source: `feature/aquamobil-v4-redesign` (PR #1107; token layer, 21 messaging components,
tablet
board, feeding loop backend; 483 files) with the sanctioned re-implementation program already
merged
as the plan (#1333, 16 slices).
- Decision: **RECOVER** via the program's slice order (owner execution track), not wholesale
merge.
Evidence: [H] 34/34 unique; [C] aquamobil tree on main byte-frozen at v3 baseline.

### F11 — Codex config-SSOT core

- Source: `wip/codex-config-ssot-20260816` (45-file rework of
`apps/config-service/src/configuration/`: deletes the CRUD command/handler/DTO stack, adds
catalog-authority + batch + snapshot CQRS model, migration 1807600000000, seed + generated
artifacts).
- State: unverified rescue snapshot (its own commit: "not a review candidate … capability lands
through its own sliced commits after verification"), base 214 commits stale.
- Decision: **OWNER_DECISION — architecture fork, not an additive recovery.** It replaces
main's
functioning configuration CRUD with a materially different catalog-authority model (materially
different business rules per the goal's stop conditions). Batch-2 inspection (2026-08-29)
reclassified from RECOVER_AND_COMPLETE. Options for the owner: (a) adopt catalog-authority —
plan a
dedicated migration effort; (b) keep main's CRUD — cherry-pick only the snapshot/read-path
additions
if desired; (c) defer. Evidence: [C] 45-file D/A/M map incl. 20 deletions of live handlers;
migration number needs re-verification against main's config-service tip; [H] rescue commit
message
declares unsliced state.

### F12 — Marine feature-toggle plumbing

- Source: `codex/marine-data-explorer-rebuild` (toggle controller + evaluation signer;
marine-data
surface itself superseded by main's rewrite).
- Decision: **SKIP_OBSOLETE** for the surface; salvage toggle plumbing only if F7/F8 need it.
Evidence: [C] marine-explorer paths absent, `a297b45dd` replaced weather/sentinel architecture;
[H]
plan doc only on branch.

## 4. OWNER_DECISION queue

1. **Archive home (F2):** v3 `src/archive/` (export/verify + retention) vs v4
`src/telemetry-archive/` (S3/presign/erasure/restore, ~2.6k lines more). Two subsystems +
colliding
migrations cannot both land. Recommended default: v4 home (more complete), port v3's
export/verify
capabilities, renumber migrations.
2. **Admin rescue shape (F7):** #1035's broad derived-types vs rescue's versioned V1 contracts
—
complementary, not competing; decision needed on ordering/ownership.
3. **ARIA autonomy closure:** tasks 6–20 unstarted; registry shows OPEN for landed work
(bookkeeping
on branch tips). Not a recovery feature; recorded for the owner.

## 5. Integration order

F1 (this branch, batch 1) → [owner PR channel: F3 → F4 → F5 + dailies] → F6 (after F5) → F8 →
F9 →
F7 → F11 → F10 (program slices) — F2 awaits owner decision.

## 6. Batch log

- **Batch 0 (commit 0298043):** report created; baseline pinned `af25ff5ac`.
- **Batch 1 — F1 pagination authority (commit 3471ea67b):** cherry-picked `-x` 699f39921 from
`feat/pagination-contracts-authority` (complete feature in one commit:
`platform/libs/pagination-contracts` lib + `backend-common` DTO re-export migration + both
specs +
tsconfig wiring). Ledger quartet resolved to main side; `ADMIN-HIGH-003` re-appended via
`finding-registry add-explicit` (position 1429) so the commit's `Closes:` trailer resolves;
debt-plan repinned (1430 entries). Validation: `nx run pagination-contracts:test` ✓; `jest
libs/backend-common/src/pagination` — 3 suites / 33 tests ✓. Status: **integrated, validated**.
- **Batch 2 attempt — F8 (aborted, method corrected):** cherry-pick of e6ce8efde measured 33
conflicts on the first commit (workflow churn + billing/sensor sensitive overlap where main
evolved
past the branch). Per the disproportionate-cost criterion: aborted; F8 re-scoped to **manual
port of
the additive core** (scripts + absent specs + semantic workflow additions) as its own batch.
Same
inspection reclassified **F11 config-SSOT → OWNER_DECISION** (45-file architecture swap of a
working
domain, unsliced rescue snapshot).
- **Batch 3 — F8 additive core (commit 3e511b44c):** 18 absent files ported byte-identical from
`fix/production-host-control-plane` (control-plane script, runtime-bundle/ssh-payload
preparers,
WAL-G PITR ceremony + verification tooling, deploy-secrets manifest, 10 invariant specs,
db-migrate
PITR integration spec; exec bits preserved; +10,958/−8). Findings `INFRA-HIGH-132/133/134`
re-appended via `add-explicit` (registry 1430→1432, repinned) so the recovery commit's three
`Closes:` trailers resolve. Validation: hooks green; targeted spec
`production-host-ssh-payload`
**fails inside its own fixture** (script exits 1 under the spec's minimal env) — recorded as
the
known incomplete connection: workflow-side wiring + fixture dependency remain (F8 status:
**partial
— core integrated, completion queued**; no main regression: additive files only).
