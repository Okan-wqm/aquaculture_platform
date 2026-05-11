# ARIA Plan 020 — Implementation Review v5 (sign-off)

> **Plan:** ARIA Plan 020 v3.3 — Harness Reliability, Context Budget, Agent Eval
> **Implementation window:** 2026-05-07 → 2026-05-08 (single autonomous arc, operator-supervised)
> **Branch:** `snowball` (worktree: `/var/aqua-saas/.worktrees/snowball`)
> **Plan v3.3 spec:** `/root/.claude/plans/s-md-b-z-bu-parsed-treasure.md` (1062 lines, 14-pass operator audit cycle locked)
> **Reviewer:** ARIA self-review under operator supervision
> **Sign-off scope:** all 16 phases (15 work + 1 verification)

---

## Executive summary

Plan 020 closed the harness reliability + governance gates for ARIA across 15
implementation phases + this verification phase. Net repo delta:

| Surface | Pre-Plan-020 | Post-Plan-020 | Delta |
|---|---|---|---|
| Python kernel test count | 544 / 1 failure | 750 / 0 failures | +206 |
| Spine gate invariants | 4 | 5 | +1 (`harness_security`) |
| Spine orchestrator adapters (fresh-run scope) | 0 | 6 | +6 |
| ARIA registry tools | 10 | 12 | +2 (test-gap + agent-harness-security as meta) |
| Backend adapter portfolio (real / total) | 5/10 | 7/10 | +2 (outbox + cqrs) |
| Total registry adapters real / total | 5/10 | 9/12 | +4 |
| Plan 016 metric counter set | 9 | 13 | +4 (mock/real eval, chain pct, dispatch rationale) |
| Runtime profile modes | 0 (no gate) | 4 | observe / standard / strict / frozen |
| New governance event kinds | n/a | 14 (locked taxonomy) | per Plan v3.3 §lock |
| New dedicated ledger surfaces | 0 | 8 | context-audits, handoffs, agent-evals/runs, agent-compliance, instinct-candidates, cost-telemetry, surface-validations, change-ledger/validated.jsonl populated |
| Commits ahead of `origin/snowball` | 15 (Plan 019) | 28 | +13 (Plan 020 phases) |

---

## Per-phase closure evidence

### Phase 0 — Preflight + push backlog + test env stabilize  (`de00e3e4`)

- `aria_kernel/workspace.py` ARIA_WORKSPACE_BASE env var support added — sandbox `/root/.aria/...` read-only failure root-caused at `workspace.py:43` resolved.
- `aria_kernel/tool_registry.ensure_tools_dir_readonly` helper added — frozen profile reads do not silently write-init.
- `tools/gates/banned-phrase.ts` `--ignore-exemptions` flag + two-stage argv parser; 4-case spec at `tools/gates/banned-phrase.spec.ts`.
- 3 fixtures under `tests/invariants/fixtures/plan-020/`.
- Plan doc `docs/aria/plans/020-...md` committed.
- Acceptance: 544 → 544 / 0 failures; baseline ready.

### Phase 1 — Runtime Profile  (`b8d38bc1`)

- `aria_kernel/runtime_profile.py` (387 lines) — 4-mode taxonomy + control-plane exception (`set_profile` always writable; `operator_approval_ref` mandatory) + scoped no-write enforcement.
- 14-surface PLAN_020_WRITE_SURFACES locked + observe-permitted allowlist (7 entries).
- `enforce_profile_for_action` at top of `claim_request` / `emit_change_committed` / `emit_change_validated` / `open_pr_for_action`.
- `enforce_profile_for_write('tool_runs', ...)` chokepoint inside `tool_runner.run_tool` covers Phase 4 + 10 + every backend adapter.
- CLI `aria-kernel profile {set,get,history}`.
- 34 tests in `test_runtime_profile.py`; 4 existing test files updated to `set_profile('strict')` for pr_open path.
- Acceptance: 544 → 578 / 0 failures.

### Phase 2 — Context Budget Gate  (`5e7b0660`)

- `aria_kernel/agent_resolver.py` shared utility (3-dir lookup: root + `_maintenance/` + `product-audit/`).
- `aria_kernel/context_budget_gate.py` (~330 lines) — role-cap policy (judges 0.35 / planners 0.55 / executors 0.45 / emergency 0.65 / default 0.40) + tiktoken-or-char/4-fallback + audit ledger + governance events.
- `agent_invocations.create_agent_invocation_request` opt-in `enforce_context_budget` kwarg (lazy import).
- CLI `aria-kernel context {audit,list}`.
- 27 tests; `aria-tools/context-audits.jsonl` Plan 020 surface.
- Acceptance: 578 → 605 / 0 failures.

### Phase 3 — Session/Handoff Ledger  (`25a2cd3e`)

- `aria_kernel/handoff_ledger.py` (~330 lines) — 7-field snapshot (active_plan, open_findings, open_debts, pending_requests, claimed_requests, last_change_chain, last_validation, next_logical_step) + 4-trigger taxonomy.
- CLI `aria-kernel handoff {snapshot,list,read}`.
- `.github/workflows/aria-agent-executor.yml` extended with session_start (before find-pending) + session_stop (after upload, `if: always()`).
- 15 tests; `aria-tools/handoffs.jsonl` Plan 020 surface.
- Acceptance: 605 → 620 / 0 failures.

### Phase 4 — Fresh Spine Orchestrator + test-gap-adapter binding  (`324257c4`)

- 4.0: `test-gap-adapter` bound to `aria-tools/registry.json` (registry 10 → 11).
- `aria_kernel/spine_orchestrator.py` (~270 lines) — refresh_spine_adapters with cache-hit (same `repo_state_id` + within freshness window) vs fresh re-invoke logic; per-adapter failure isolated.
- `architecture_spine_gate.take_baseline` + `take_postcheck` extended with `require_fresh_adapter_runs: bool = True` kwarg + tier-2 "make automatic" rule (synthetic invariant_checks bypasses orchestrator).
- CLI `aria-kernel spine refresh`.
- 13 tests.
- Acceptance: 620 → 633 / 0 failures.

### Phase 5 — CI Real OAuth Smoke  (`c3cf7a2e` — operator-blocked)

- `tools/aria-poc/ci_executor_contract_spike.md` extended with "Plan 020 Phase 5 update — operator action required" section.
- Spike NOT closed in this implementation pass (operator-only OAuth provision).
- `DEBT-2026-05-08-001` emitted (severity HIGH, due 2026-06-07): cites F-003, captures 4 hard acceptance criteria, owner=okan-platform-operator.
- Phase 6 implication: ships mock-only with `aria_agent_eval_mock_only_total` segregated.
- Acceptance: explicit operator-action checklist + tracked DEBT.

### Phase 6 — Agent Eval Harness  (`2f6bbf11`)

- `aria_kernel/agent_eval.py` (~340 lines) — fixture schema `aria/agent-eval-fixture/v1`, 8 verdict classes locked, mock vs real STREAMS NEVER CONFLATED (`aria_agent_eval_mock_only_total` vs `aria_agent_eval_real_total`).
- 6-key aggregate (pass_rate, mean_rounds, mean_tokens, FP, FN, consistency).
- 5 fixtures under `aria-tools/agent-evals/fixtures/`: F001 (evidence-judge / TypeORM), F002 (adversarial / staleness), F003 (consensus / disagreement), F004 (arbiter / tighten), F005 (auth-security / cross-tenant join).
- CLI `aria-kernel agent-eval {add-fixture,run,aggregate,list,list-fixtures}`.
- `.github/workflows/aria-agent-eval.yml` weekly off-hours mock-mode run.
- Plan 016 metric set 9 → 11.
- 22 tests.
- Acceptance: 633 → 655 / 0 failures.

### Phase 7 — Agent Compliance Harness  (`f88b2465`)

- `aria_kernel/agent_compliance.py` (~310 lines) — separate ledger from agent_eval.
- 4 hard-reject + 2 soft-compliance check taxonomy locked; `SOFT_FAIL_REJECT_THRESHOLD = 2`.
- 10-state lifecycle PRESERVED (Plan 016 contract immutable) — `rejection_reason='compliance_rejected'` annotates existing REJECTED state; NO 11th state.
- `submit_claim_result` integrated post-validate, pre-accept-persist.
- CLI `aria-kernel agent-compliance {grade,list}`.
- 18 new tests + 3 existing test envelopes updated to write to `expected_output_path`.
- Acceptance: 655 → 673 / 0 failures.

### Phase 8 — Validation Matrix Gate  (`2b4c9842`)

- `aria_kernel/validation_matrix_gate.py` (~310 lines) — 4 risk-type taxonomy + 13 required-test specs + 3-layer enforcement (existence + pattern + run-pass via structured refs).
- `validation_mode` taxonomy: `enforced` (Plan 020+ default; gate fires) vs `historical_attestation` (Plan 019 backfill; gate bypassed).
- `change_ledger.emit_change_validated` extended with `validation_mode` + `enforce_validation_matrix` + `workspace_root` kwargs.
- **Existing-payload immutability rule enforced**: `change_validated` governance event detail payload locked at Plan 019 — `validation_mode` lives ONLY on `validated.jsonl` row + new `validation_matrix_check` event detail. Test asserts.
- CLI `aria-kernel validation-matrix {check,list-required}`.
- 21 tests.
- Acceptance: 673 → 694 / 0 failures.

### Phase 9 — Change Ledger Validated Chain Closure  (`b2583c23`)

- `tools/aria-poc/backfill_validated_chains.py` — idempotent backfill for Plan 019 commits using `validation_mode='historical_attestation'` so backfilled rows do NOT inflate validation_pct numerator.
- `change_ledger.detect_stale_change_chains` + `emit_stale_chain_warnings` (`CHAIN_STALE_DAYS = 7`).
- 12th metric `aria_change_chain_validation_pct` (enforced/committed × 100; historical excluded from numerator).
- 10 tests.
- Acceptance: 694 → 704 / 0 failures.

### Phase 10 — Agent Harness Security Adapter  (`393e9e15`)

- `tools/aria-poc/agent_harness_security_adapter.py` — 7 detection rules (refined per operator gap #9).
- `tools/aria-adapters/agent-harness-security-adapter.tool.json` manifest + registry binding (registry 11 → 12).
- Spine gate 5th invariant `harness_security` + `_check_harness_security` + DEFAULT_INVARIANT_CHECKS mapping.
- `spine_orchestrator.SPINE_ADAPTER_IDS` extended to 6 adapters.
- 10 tests + existing spine tests updated to `len(SPINE_ADAPTER_IDS)` constant references.
- Acceptance: 704 → 714 / 0 failures.

### Phase 11+12+13 — Surface Validator + Instinct Ledger + Cost Telemetry  (`683bc6ee`)

- `aria_kernel/surface_manifest_validator.py` — 6 validators (frontmatter, target existence, role pairing, registry runner paths, plan doc freshness, maintenance isolation).
- `aria_kernel/instinct_candidate.py` — kernel-side AUTO-MUTATION BANNED enforcement (PROPOSED → PROMOTED requires operator_approval_ref + promotion_pr_url).
- `aria_kernel/cost_telemetry.py` — dispatch_rationale ledger; observe BLOCKS (telemetry mutates dispatch path).
- 13th metric `aria_dispatch_rationale_total` — Plan 016 metric set reaches FINAL **13**.
- 32 tests across 3 suites.
- Acceptance: 714 → 746 / 0 failures.

### Phase 14 — Backend Adapter Completion (outbox + cqrs) + Plan 021 placeholder  (`2cd62cf5`)

- `tools/aria-poc/outbox_adapter.py` — 2 detection rules (transactional_outbox_violation + outbox_entity_base_missing).
- `tools/aria-poc/cqrs_adapter.py` — 2 detection rules (controller_skips_command_query_bus + controller_injects_repository_directly); two-signal CQRS detection avoids false positives.
- Registry rewired: outbox + cqrs from shadow_runner.py to real Python parsers (status SHADOW, version 0.2.0).
- Backend portfolio 5/10 → 7/10 real; total registry surface 5/10 → 9/12 real.
- `docs/aria/plans/021-backend-adapter-completion-and-legacy-frozen-hardening.md` — placeholder for Plan 021 Stream A (3 remaining adapters) + Stream B (legacy writer frozen-guard).
- 4 fixture-test cases.
- Acceptance: 746 → 750 / 0 failures.

### Phase 15 — Verification + Sign-off Review v5  (this commit)

- `docs/aria/reviews/2026-05-09-plan-020-implementation-review.md` (this file).
- Per-phase ledger evidence + governance event delta documented.
- Cumulative delta vs pre-Plan-020 baseline tabulated.
- Operator action items + Plan 021 hand-off scope explicit.

---

## Test acceptance — 3 separate suites (Plan v3.3 §Phase 15.1)

(a) **Python kernel regression** (load-bearing acceptance):
```
ARIA_TEST_TMPDIR=/tmp/aria-tests \
ARIA_WORKSPACE_BASE=/tmp/aria-workspaces \
PYTHONPATH=aria-kernel python3 -m unittest discover aria-kernel -p '*test*.py'
→ Ran 750 tests in 218s, OK (0 failures)
```

  - Pre-Plan-020 baseline: 544 (1 functional failure resolved by Phase 0 ARIA_WORKSPACE_BASE fix).
  - Plan 020 net new tests: 750 - 544 = **+206**.
  - Hedef ≥630 substantially exceeded.

(b) **TS gate spec tests** (Plan 020 Phase 0.4 + Plan 019 carry-forward):
- `npm run gates:banned-phrase:test` → 4/4 cases.
- `npm run gates:commit-msg:test` → existing pass count preserved.

(c) **Adapter TS test suite** (fixture-driven, NOT live-repo finding count):
- `tools/aria-adapters/test-gap-adapter.test.ts` → existing.
- `aria-kernel/tests/test_agent_harness_security.py` (Python equivalent for Phase 10 Python implementation): 10/10 cases.
- `aria-kernel/tests/test_outbox_cqrs_adapters.py` (Python equivalent for Phase 14 Python implementation): 4/4 cases.

---

## Operator-feedback closure mapping (10 operator gaps from v3.3 audit cycle)

| Operator gap | Phase | Closure evidence |
|---|---|---|
| #1 spine baseline freshness | 4 | `spine_orchestrator.refresh_spine_adapters` + `require_fresh_adapter_runs=True` default |
| #2 eval / compliance separation | 6 + 7 | `agent_eval.py` ⊥ `agent_compliance.py`; separate ledgers, separate event kinds |
| #3 risk-type-driven test matrix | 8 | 4 risk types × 13 required tests; 3-layer enforce with structured refs |
| #4 change_validated chain hard-required | 9 | `validation_mode` + `aria_change_chain_validation_pct` (12th metric); historical excluded |
| #5 CI real OAuth contract | 5 | DEBT-2026-05-08-001 emitted; 4-criteria operator-action checklist in spike doc |
| #6 backend adapter portfolio | 14 | outbox + cqrs real; Plan 021 closes remaining 3 |
| #7 surface validator parity rule | 11 | `validate_target_agent_existence` (one-way; whitelist→file existence); reverse not validated |
| #8 runtime profile early ordering | 1 | Phase 1 (not Phase 9) — safety boundary established BEFORE eval/compliance/etc. |
| #9 harness security rule refinement | 10 | `workflow_run_or_pr_target_untrusted_checkout` Rule 2 fires only on refined trigger surface |
| #10 test env stabilize | 0 | `ARIA_WORKSPACE_BASE` env var + `ensure_tools_dir_readonly`; 544/1 failure → 544/0 |

---

## DEBT lifecycle update (Plan 020 close)

| Debt ID | Status (pre-Plan-020) | Status (post-Plan-020) | Notes |
|---|---|---|---|
| `DEBT-2026-05-07-001` | OPEN | OPEN (operator triage pending) | TypeORM migration repetition, Plan 016 Faz A |
| `DEBT-2026-05-07-002` | OPEN | OPEN | unchanged |
| `DEBT-2026-05-07-003` | IN_PROGRESS | **IN_PROGRESS** (5/10 → 7/10 real) | Plan 020 Phase 14 took outbox + cqrs; Plan 021 closes 3 remaining |
| `DEBT-2026-05-07-004` | OPEN | OPEN | unchanged |
| `DEBT-2026-05-07-005` | OPEN | OPEN | unchanged |
| `DEBT-2026-05-08-001` | n/a | **OPEN** (NEW) | Plan 020 Phase 5 OAuth contract closure; severity HIGH; due 2026-06-07; owner okan-platform-operator |

---

## Plan 020 cumulative output

- **28 commits ahead of `origin/snowball`** (15 Plan 019 + 13 Plan 020).
- **750/750 Python kernel tests green**.
- **5-invariant spine gate** + 6-adapter fresh orchestrator chokepoint.
- **4-mode runtime profile** + 14-surface scoped no-write + L1/L2/L3 non-bypass invariants.
- **8 new dedicated ledger surfaces** + Plan 020 Phase 4 + Phase 10 reuse `runs.jsonl` (no new file).
- **14 new governance event kinds locked** (operator gap #2 — `validation_matrix_check` replaces the dropped frozen-no-baseline event):
  1. `runtime_profile_changed`
  2. `context_budget_audited`
  3. `context_budget_exceeded`
  4. `handoff_snapshot_recorded`
  5. `spine_orchestrator_refresh_complete`
  6. `agent_compliance_violation`
  7. `agent_compliance_warning`
  8. `validation_matrix_check`
  9. `change_chain_stale`
  10. `surface_validation_failed`
  11. `instinct_candidate_recorded`
  12. `instinct_candidate_promoted`
  13. `dispatch_rationale_recorded`
  14. `agent_eval_run_mock_only` / `agent_eval_run_real` (segregated kinds; counted as one taxonomy entry per operator gap)
- **13 metric counters** (final Plan 020 set):
  9 baseline + Phase 6 (+2) + Phase 9 (+1) + Phase 13 (+1) = **13**.

---

## Boundary — Plan 020 closes vs DOES NOT close

**Closes:**
- Harness reliability gaps (operator's 9-item priority list).
- L1/L2/L3 + auth/tenant non-bypass discipline (codified in Phase 1 + Phase 11).
- Spine baseline freshness invariant (Phase 4).
- Eval / Compliance separation (Phase 6 + Phase 7).
- Risk-type-driven validation matrix (Phase 8).
- Change-ledger validated chain hard-closure with `enforced` vs `historical_attestation` semantic (Phase 9).
- Continuous-learning auto-mutation prohibition (Phase 12).
- Cost rationale telemetry (Phase 13).

**Does NOT close:**
- `DEBT-2026-05-07-003` (full backend adapter portfolio) — Plan 020 5/10 → 7/10; Plan 021 closes 3 remaining.
- `DEBT-2026-05-08-001` (Phase 5 OAuth contract) — operator-supervised; 60-day deadline.
- Legacy writer frozen-guard hardening (Plan 020 frozen invariant intentionally NARROW; Plan 021 Stream B globalises it).
- Plan 020 git push to `origin/snowball` — operator GH PAT rotation pending; 28 commits stage on local `snowball` ahead of origin.

---

## Operator action items (post-Plan-020)

1. **GH PAT rotation** — 28 commits ahead of `origin/snowball` waiting to push.
2. **DEBT-2026-05-08-001 closure** (≤ 2026-06-07) — provision `CLAUDE_CODE_OAUTH_TOKEN`, dispatch `aria-agent-executor.yml mock=false`, validate 4 hard criteria, switch workflow default.
3. **Plan 021 spec authoring** — replace placeholder doc with full spec + 14-pass operator audit cycle.
4. **`aria-kernel surface validate` live run** on snowball repo to surface any whitelist drift or registry runner-path drift (CI invariant test wires this on every PR).
5. **Spine baseline `require_fresh_adapter_runs=True`** — first live invocation against `snowball` will refresh all 6 adapters under current `repo_state_id`.

---

## Banned-phrase self-compliance

- This sign-off doc passes `npx tsx tools/gates/banned-phrase.ts --mode=staged` clean.
- Every Plan 020 commit body passed husky `commit-msg-validator` Closes-trailer gate.
- DEBT-2026-05-08-001 captures the only "deferred" surface (Phase 5 OAuth contract) with explicit owner + deadline + finding ID per CLAUDE.md banned-phrase escape rule.

---

## Sign-off

ARIA self-review confirms Plan 020 v3.3 implementation against the 14-pass
operator audit cycle locked spec. All 16 phases (15 work + 1 verification)
delivered. Test baseline 544 → 750 (+206). Backend portfolio 5/10 → 7/10
real. Spine gate 4-invariant → 5-invariant + fresh orchestrator. Runtime
profile 0 modes → 4 modes. 8 new dedicated ledger surfaces + 14 new
governance event kinds locked. 13 metric counters final.

Two debt records carry forward (`DEBT-2026-05-07-003` IN_PROGRESS;
`DEBT-2026-05-08-001` OPEN-HIGH). One Plan 021 placeholder doc captures the
hand-off scope. Operator action items enumerated.

ARIA Plan 020 — IMPLEMENTATION COMPLETE pending operator push + DEBT closures.
