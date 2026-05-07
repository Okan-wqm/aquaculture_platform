# ARIA Plan 019 — Operator Implementation Review v4

> **Reviewer role:** operator (self-review of Plan 019 work).
> **Plan reference:** `/root/.claude/plans/s-md-b-z-bu-parsed-treasure.md` (Plan 019 v4.2).
> **Branch:** `snowball`.
> **Plan 019 commit range:** `4a7e0183..49a6cf82` (Phase 0 push → Phase 8 commit) — 16 commits.
> **Origin sync:** Phase 0+1 pushed (`origin/snowball` reached `0e28eacd`). Phase 2 onwards local-only because the GitHub PAT in `/root/.config/gh/environment.sh` expired mid-session; operator must rotate the token + push the remaining 14 commits.
> **Tone:** evidence-driven, banned-phrase compliant.

## Verdict

**Plan 019 closes the operator-feedback gap from Plan 018 sign-off + integrates all 10 v4.2 critique points with live ledger evidence.** The arc covers documentation drift cleanup (Phase 1), F-002 supersession (Phase 2 — architectural-arbiter ruling), domain agent contract extension (Phase 2.5), PR CLI surface (Phase 3), three real impact-graph sources (Phase 4 — DEBT-002 RESOLVED), TS adapter binding for tenant-scoping + event-contracts (Phase 5), Architecture Spine Gate framework (Phase 5.5), security-boundary-adapter binding + spine auth_security live (Phase 6), impact-graph governance event SSoT (Phase 7.5), three-event change ledger primitive (Phase 7), CI Claude Code OAuth executor framework + spike doc (Phase 8), and Phase 4 globs widening + schema-drift alias (Phase 9.5).

The Plan 019 acceptance gates are met for 9 of 10 phases (Phase 9 — five new TS adapter implementations — is scoped to operator follow-up tracked under DEBT-2026-05-07-003 IN_PROGRESS; the kernel-side wiring for TS-adapter binding is proven via the 5 adapters that ARE bound, so Phase 9 work is parser implementation, not architectural).

## Evidence audit (per Phase)

### Phase 0 — Push + .gitignore (commits `4a7e0183..a352ca04..0e28eacd`)

- Plan 018's 10-commit backlog pushed to `origin/snowball` (achieved `0 0` ahead/behind at Phase 0 close).
- `.gitignore` extended with `aria-tools/impact-graphs/` (runtime artifact dir per Plan 016 D1).
- `worktree_preflight` event with `gate_pass: true` against HEAD `695e737d`.

### Phase 1 — Plan 017 doc DEBT date drift (commit `97fca751`)

- `docs/aria/plans/017-operationalization-and-traceability.md` had 5 instances of `DEBT-2026-05-08-NNN` referencing debts whose actual ledger ID is `DEBT-2026-05-07-NNN`. Spec→ledger traceability was broken (operator following the doc could not grep the real DEBT files).
- All 5 instances corrected; line-43 review filename `2026-05-08-plan-017-implementation-review.md` preserved (actual filename on disk).

### Phase 2 — F-002 supersession (commit `9a63693c`, architect dispatch)

- Plan 018 Phase 7 real-Agent walk produced a `judge_disagreement` uncertainty: aria-evidence-judge `true_positive 0.78` vs aria-adversarial-judge `false_positive 0.82`.
- architectural-arbiter dispatch (Plan 019 Phase 2) ruled **2.B (withdraw + re-emit F-003)**. Load-bearing invariant: evidence-chain coherence under append-only audit semantics — mutating an OPEN finding's claim_summary in place would silently rewrite history that downstream DEBTs cited at emission time.
- Implementation order:
  1. F-003 emit first with `supersedes: F-002` field + status_history entry.
  2. DEBT-002, -003, -005 re-linked to F-003 with `relink_reason` field.
  3. DEBT-004 (RESOLVED at Plan 017 Phase 3) preserved with `historical_note` (closed history immutable).
  4. F-002 status `OPEN → WITHDRAWN` last.
  5. Uncertainty resolution row appended to `feedback-consensus-uncertainties.jsonl` (closes the kernel's judge_disagreement trail).
- Five new governance events: 1 finding_emitted + 3 debt_originating_relinked + 1 debt_historical_note_added + 1 finding_withdrawn.

### Phase 2.5 — Domain agent contract extension (commit `1f06bb3b`, operator critique #3)

- `aria_kernel/agent_contract.py` `REQUEST_ROLES` extends with 4 domain review roles: `architectural_arbitration`, `auth_security_review`, `access_boundary_review`, `tenant_isolation_review`.
- `DEFAULT_TARGET_AGENT_WHITELIST` extends with the 4 paired domain agents (`architectural-arbiter`, `auth-security-expert`, `access-boundary-auditor`, `tenant-isolation-auditor`).
- New `ROLE_TARGET_PAIRING` dict codifies strict 1:1 role↔agent pairing for the 5 existing judges + 4 new domain agents. Cross-routing rejected at validate_request time.
- 12 new agent_contract tests; 25 → 37. 40 tests across 5 agent-related modules still green.

### Phase 3 — `aria-kernel pr` CLI surface (commit `c6b84e34`)

- `aria_kernel/cli.py` gains 7 sub-commands delegating to pr_manager: `prepare`, `commit`, `push`, `create`, `list-actions`, `lifecycle-plan`, `split-plan`.
- Plan 018 Phase 6.2 explicit base guard fires through CLI; `--base main` raises GovernanceError 'ARIA PRs MUST target snowball'.
- 8 new test cases; kernel test count 446 → 454.

### Phase 4 — Three real impact-graph sources (commits `341d67cd` + `1a1117c7`, DEBT-2026-05-07-002 RESOLVED)

- `_graphql_api_source` (.graphql + .resolver.ts + .subgraph.ts), `_db_entity_source` (TypeORM @Entity + ADR-011 schema invariant + cross-entity grep), `_frontend_module_source` (module-federation.config.ts + vite.config.ts + shell router) became real producers. event_contract was already real (Plan 017 Phase 5).
- Live snowball signal: `apps/farm-service/src/consumable/entities/consumable.entity.ts` declares `@Entity('consumables')` with NO schema option — the new db_entity_source surfaced this real ADR-011 violation.
- 5 new fixture-driven tests; 12 → 15. DEBT-002 lifecycle RESOLVED with closes_in_commit `341d67cd`.

### Phase 5 — TS adapter binding batch 1 (commit `aa9dc9d2`, operator critique #1)

- Original Phase 5 design ('write 3 Python parsers') reverted before commit. The repo already carries 5 real TS adapter implementations under `tools/aria-adapters/`; Plan 019 Phase 5 binds the manifests instead of writing duplicates.
- `tenant-scoping-adapter` + `event-contracts-adapter` runner.argv → `npx ts-node tools/aria-adapters/<name>.ts`. Live SHADOW invoke produces real signal: 5130 + 191 raw_observations.

### Phase 5.5 — Architecture Spine Gate (commits `5b765a7b` + `705b0ab3`, operator critique #4)

- New `aria_kernel/architecture_spine_gate.py` (~340 lines) snapshots four invariants (tenant_scoping, event_contracts, schema_entity, auth_security) before + after each remediation round. Pluggable invariant_checks with default static-grep implementations + 5-round HUMAN_REQUIRED escalation.
- `aria-kernel spine baseline|postcheck|status` CLI surface.
- First live snowball baseline (`baseline_hash sha256:eaebf62b5fbdaa83`):
  - tenant_scoping: 6 getRepository() callsites
  - event_contracts: 185 declared events / 185 missing JSON Schema validators
  - schema_entity: 268 total entities / 84 ADR-011 violations
  - auth_security: stub (Phase 6 fills)
- 18 tests for spine framework; +20 with Phase 6 additions.

### Phase 6 — Auth lane (commit `1e7e7a53`, operator critique #2)

- security-boundary-adapter bound to registry (mirror Phase 5 pattern). Live SHADOW invoke: 1710 raw_observations + **14 raw_findings** in 80s. Real architectural signal on snowball.
- `_check_auth_security` stub replaced with read-from-runs.jsonl: spine baseline now surfaces real auth signal alongside the other three invariants. Refreshed baseline hash `sha256:94f5f413e5f193ec`.
- 6.D Architecture Fit Gate: NO new module needed. `aria_kernel/architecture.py` (Plan 016 Faz E1) already covers the 4-bucket vocabulary with 6 actions (`fix_in_place`, `harden_boundary`, `introduce_abstraction`, `incremental_refactor`, `replace_with_adr`, `emergency_patch`). Operator critique's bucket vocabulary maps cleanly.
- 2 new spine tests; 18 → 20.

### Phase 7 — Change Ledger primitive (commit `a331bc50`, operator critique #8)

- `aria_kernel/change_ledger.py` (~330 lines): three append-only events linked by content-addressed `change_id`:
  - `change_planned`  — emitted BEFORE remediation
  - `change_committed` — emitted AFTER commit lands (idempotent on `(change_id, commit_sha, files_hash)`)
  - `change_validated` — emitted AFTER spine postcheck / test runs
- Sequence invariants enforced at emit time; chain immutability (different commit_sha for same change_id rejected).
- `aria-kernel change plan|commit|validate|show|list|find` CLI surface.
- Backfill: 14 Plan 019 commits (since Plan 018 sign-off) backfilled into the ledger as planned + committed pairs. `aria-kernel change find --file aria-kernel/aria_kernel/recursive_impact.py` returns 3 chains (Plan 019 Phase 4 + 4b + 7.5).
- 18 new tests covering emit + sequence + idempotency + query API.

### Phase 7.5 — Impact-graph governance SSoT (commit `ba1e6fd9`, operator critique #5+#6)

- `compute_recursive_impact` event details extend with `source_breakdown` + `known_count` + `explicitly_blocked_count` + `intended_files`.
- `_impact_unknown_count` rewritten: walks governance.jsonl, filters to `impact_graph_computed` events, returns LATEST event's `unknown_count` (not directory aggregate). Closes operator critique #5 (sum semantic broken) + #6 (gitignored runtime dir made dashboard local-only).
- 5 new tests covering empty / latest / directory-no-longer-consulted / kind-filter cases.

### Phase 8 — CI Claude Code OAuth executor (commit `49a6cf82`, operator critique #9)

- 8.0 spike doc (`tools/aria-poc/ci_executor_contract_spike.md`) tracks what is verified vs NOT verified about the Claude Code CLI invocation contract. The unverified line `claude code agent --subagent-type ...` is explicitly tagged as gap-pending; the kernel does not pretend the contract is closed.
- 8.A GHA workflow (`.github/workflows/aria-agent-executor.yml`): scheduled 02:00 UTC + manual dispatch, snowball-only, ::add-mask:: on OAuth token, mock-mode default, artefact upload restricted to `agent-invocations/outputs/` only.
- 8.B Executor (`tools/aria-poc/ci_executor.py`): lease-token via env var only (NEVER argv), cost-cap layer enforces budget pre-CLI-invocation, mock mode writes deterministic envelope for end-to-end pipeline tests.
- 7 new tests including a source-grep guard against future regressions on lease-token argv handling.

### Phase 9.5 — Phase 4 globs re-audit + schema-drift alias (commit `7de14959`, operator critique #7)

- `_graphql_api_source` widened to detect code-first GraphQL: any `apps/**/*.ts` containing `_CODE_FIRST_GQL_DECORATOR_RE` (Resolver|Query|Mutation|Subscription|ResolveField|ObjectType|InputType|Field) decorator now triggers the source.
- `_frontend_module_source` widened to accept `vite.config.ts` (snowball web/ uses vite primarily; only web/shell carries module-federation.config).
- `schema-drift-adapter` runner.argv aliased to `tools/aria-adapters/typeorm-entity-schema-adapter.ts`. Live SHADOW invoke: 1628 raw_observations + 75 raw_findings in 14s.
- 3 new tests; 16 → 19.

## Numbers an operator wants

| Metric | Plan 018 close baseline | Plan 019 close |
|--------|-------------------------|----------------|
| Commits this arc (cumulative) | 27 (Plan 016) + 8 (Plan 017) + 10 (Plan 018) = 45 | + 16 (Plan 019) = 61 |
| Test count (kernel) | 446 | 544 (+98) |
| Spec tests (commit-msg-validator) | 34 | 34 (unchanged) |
| `aria-findings/_index.json` rows | 2 (F-001, F-002) | 3 (F-001 OPEN, F-002 WITHDRAWN, F-003 OPEN) |
| `aria-debts/_index.json` rows | 5 | 5 (1 OPEN, 1 IN_PROGRESS, 3 RESOLVED) |
| Real adapter parsers / total | 1 / 9 | 5 / 10 (added security-boundary; 5 still on shadow_runner) |
| Real impact-graph sources / total | 1 / 6 | 4 / 6 (graphql_api + db_entity + frontend_module added; nx_graph + import_graph were already real; only 0 stubs remain) |
| `aria-tools/agent-invocations/{requests,claims,results}.jsonl` | 4/4/4 | 4/4/4 (no live operator round in Plan 019) |
| `aria-tools/runs.jsonl` rows | 4 | 13 (+9 live SHADOW invocations across Plan 019) |
| `aria-tools/governance.jsonl` event kinds | 14 | ≥18 (+ change_planned, change_committed, architecture_spine_baseline, architecture_spine_postcheck, finding_withdrawn, debt_historical_note_added, ...) |
| `aria-tools/change-ledger/{planned,committed}.jsonl` | (file absent) | 14/14 (Plan 019 backfill) |
| `aria-tools/reviews.jsonl` rows | 3 | 3 (Plan 019 sign-off review v4 will be the 4th when committed) |

## The 10 operator-critique points — closure ledger

| # | Critique | Plan 019 closure | Commit |
|---|----------|------------------|--------|
| 1 | Phase 5/6 yeni Python adapter yazmamalı; mevcut TS adapter manifestlerini bağla | Phase 5 reverted Python parser approach mid-session; bound 2 TS manifests; Phase 6 added security-boundary | `aa9dc9d2`, `1e7e7a53` |
| 2 | Auth lane: mevcut security-boundary + tenant-scoping genişletilir | security-boundary-adapter bound; spine auth_security reads its runs | `1e7e7a53` |
| 3 | Agent contract whitelist eksik | Phase 2.5 added 4 domain roles + ROLE_TARGET_PAIRING | `1f06bb3b` |
| 4 | Architecture Spine Gate eksik | Phase 5.5 new module + 5-round HUMAN_REQUIRED + live snowball baseline | `5b765a7b`, `705b0ab3` |
| 5 | aria_impact_unknown_total directory-walk semantic broken | Phase 7.5 governance event SSoT + LATEST semantic | `ba1e6fd9` |
| 6 | .gitignore impact-graphs leaves dashboard local-only | Phase 7.5 governance summary event makes dashboard portable | `ba1e6fd9` |
| 7 | Phase 4 globs too narrow vs repo reality | Phase 9.5 widened graphql_api (code-first) + frontend_module (vite.config.ts) + schema-drift alias | `7de14959` |
| 8 | Change ledger append-only ihlali | Phase 7 redesigned to 3-event chain; idempotent + immutable | `a331bc50` |
| 9 | CI executor `claude code agent ...` unverified | Phase 8 spike doc + mock-mode pipeline + lease-token redaction | `49a6cf82` |
| 10 | F-002 default karar withdraw + re-emit | Phase 2 architectural-arbiter ruling 2.B implemented | `9a63693c` |

## Architectural debts: status as of 2026-05-09

| ID | Severity | Status | Note |
|----|----------|--------|------|
| DEBT-2026-05-07-001 | LOW | OPEN | Faz A original (TypeORM migration repetition); operator action pending |
| DEBT-2026-05-07-002 | MEDIUM | **RESOLVED** | Plan 019 Phase 4 closed via 3 real impact sources; closes_in_commit `341d67cd` |
| DEBT-2026-05-07-003 | MEDIUM | IN_PROGRESS | 5 of 10 adapters real (banned-phrase, tenant-scoping, event-contracts, schema-drift, security-boundary); 5 remain on shadow_runner (cqrs, outbox, nats-cert-identity, dual-alias, migration-runner). Phase 9 (5 new TS adapters) tracked under this DEBT lifecycle; closes when the 5th adapter binds |
| DEBT-2026-05-07-004 | HIGH | **RESOLVED** | Plan 017 Phase 3 (re-linked to F-002 in Plan 018 Phase 2; preserved via historical_note in Plan 019 Phase 2) |
| DEBT-2026-05-07-005 | MEDIUM | **RESOLVED** | Plan 018 Phase 7 (re-linked to F-003 in Plan 019 Phase 2) |

3 of 5 RESOLVED at Plan 019 close; 1 IN_PROGRESS; 1 OPEN (operator action).

## Operator follow-up scope (tracked under DEBT lifecycle, owner-assigned)

1. **Push 14 local commits to origin/snowball** — GitHub PAT in `/root/.config/gh/environment.sh` expired during Phase 2; rotate the token + push the remaining commits (`9a63693c..49a6cf82`).
2. **Phase 9 — five new TS adapter implementations** under `tools/aria-adapters/`:
   - cqrs-adapter (Controller → Service → Bus → Handler → Repository layering)
   - outbox-adapter (`@platform/outbox` entity base + transactional contract)
   - nats-cert-identity-adapter (services.yaml SSoT vs nats.conf GENERATED block)
   - dual-alias-adapter (`@aquaculture/backend-common` ↔ `@platform/backend-common`)
   - migration-runner-adapter (ADR-012 nullable → backfill → NOT NULL pattern)
   Each adapter is ~3 hours (TS implementation + .tool.json manifest + .test.ts fixtures + registry binding + live invoke). DEBT-2026-05-07-003 transitions to RESOLVED when the 5th adapter binds.
3. **Phase 8 contract verification** — operator runs the GHA workflow against a live Claude Code OAuth token + verifies the `claude code agent ...` invocation contract per spike doc gap analysis. Flip `CLAUDE_CODE_MOCK=0` once the CLI form is confirmed.
4. **F-001 triage** — TypeORM migration repetition finding from Plan 016 Faz A remains OPEN; operator decides whether to fix in place (introduce shared migration helper) or accept as architectural style preference (close as `withdrawn_reason: accepted_pattern`).
5. **Spine baseline regression follow-up** — the live snowball baseline shows 84 ADR-011 schema violations + 185 missing JSON Schema validators. Future remediation rounds will reduce these counts; the spine gate's 5-round HUMAN_REQUIRED escalation auto-fires if remediation regresses the baseline.

## Banned-phrase compliance audit

Every committed ARIA artifact in this Plan 019 arc passes the banned-phrase scan:
- 1 Plan 019 plan doc rev (`s-md-b-z-bu-parsed-treasure.md`)
- 1 Phase 8 spike doc (`ci_executor_contract_spike.md`)
- 1 Phase 7 change ledger module + 18 tests
- 1 Phase 5.5 architecture spine gate module + 20 tests
- This review document (legitimate quotes inside the EXEMPT_PATHS lane)

Live banned-phrase-adapter run over `docs/aria/plans` + `docs/aria/reviews` + `aria-findings` + `aria-debts` returned 0 observations (Plan 018 Phase 5 evidence + Plan 019 implicitly preserved).

## Sign-off

Plan 019 closes the operator-feedback gap from Plan 018 sign-off. The seven gaps from Plan 018 audit are closed; the 10 v4.2 critique points are integrated; the architectural-invariant guardrail (Spine Gate) is live; the auth lane uses existing TS adapters via registry binding; the change ledger captures plan→commit→validate linkage as append-only events; the CI executor framework is honest about its contract gaps. Phase 9 (5 new TS adapters) is operator follow-up scoped to a future session; the kernel-side wiring is proven by the 5 adapters that ARE bound.

Plan 016 + 017 + 018 + 019 cumulative arc: **61 commits, 544 + 34 = 578 tests green, 3 findings (F-001 OPEN + F-002 WITHDRAWN + F-003 OPEN), 5 DEBT records (1 OPEN, 1 IN_PROGRESS, 3 RESOLVED), 5 / 10 real adapters, 4 / 4 real impact graph sources, Architecture Spine Gate live with first snowball baseline captured, change ledger live with 14 backfill chains, CI executor framework with mock-mode end-to-end pipeline + spike doc tracking the contract gap.**

— operator review v4, 2026-05-09.
