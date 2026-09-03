<!-- ARIA-HISTORICAL: Historical plan document. Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Plan 020 — Harness Reliability, Context Budget, Agent Eval

## Summary

Plan 019 closed the Plan 018 sign-off audit gap. Plan 020 absorbs ECC architectural primitives (context-budget, session-handoff, agent-eval, agent-compliance, validation-matrix, harness-security, instinct-candidate, surface-validator, cost-telemetry, runtime-profile) onto ARIA's existing kernel layer as **gates / audit primitives** — NOT as a 1:1 ECC install. The arc is a 14-pass operator audit cycle (v1 → v3.3) that locked the architecture before code: scope decisions, semantic separation, naming consistency, payload immutability, test surface segregation, and Plan 021 boundary all explicit.

The single operating reference is `/root/.claude/plans/s-md-b-z-bu-parsed-treasure.md` v3.3. This document is the Plan 020 doc per Plan 020 Phase 0.5 acceptance — every commit in the Plan 020 arc carries `Closes: aria-debts/...#...` per CLAUDE.md traceability rule.

## Key Changes (16 Phases)

### Phase 0 — Preflight + push backlog + test env stabilize
- 15 Plan 019 commit pushed to `origin/snowball` (operator GH PAT rotation pending).
- Worktree preflight `gate_pass: true`.
- `aria_kernel/workspace.py` `ARIA_WORKSPACE_BASE` env var support (operator gap #6 — sandbox `/root/.aria/...` read-only fix).
- `tempfile.mkdtemp(... dir=ARIA_TEST_TMPDIR)` pattern across `aria-kernel/tests/`.
- `tools/gates/banned-phrase.ts` `--ignore-exemptions` flag + argv two-stage parser; new `tools/gates/banned-phrase.spec.ts` (4 cases) + `package.json` `gates:banned-phrase:test` script; 3 fixture files at `tests/invariants/fixtures/plan-020/`.
- `aria_kernel/tool_registry.ensure_tools_dir_readonly(base_dir) -> Path | None` helper for frozen profile read paths.

### Phase 1 — Runtime Profile (4-mode + Plan 020 scoped no-write)
- `aria_kernel/runtime_profile.py` 4 profile (observe/standard/strict/frozen).
- L1 banned-phrase + L2 Closes-trailer + L3 suppression + auth/tenant adapter spine baseline reads non-bypassable.
- `enforce_profile_for_action()` dispatch sites EN BAŞINDA (agent_invocations, change_ledger, pr_manager).
- `enforce_profile_for_write(surface_kind)` SCOPED to Plan 020 surfaces + dispatch + tool_run; legacy mutators (finding/debt emit etc.) Plan 021 scope.
- `set_profile` control-plane exception (her transition `operator_approval_ref` ZORUNLU).
- observe profile yazma allowlist'i tablo lock'lu.

### Phase 2 — Context Budget Gate (role-based caps)
- `aria_kernel/context_budget_gate.py` + shared `agent_resolver.resolve_agent_md_path` (root → _maintenance → product-audit).
- ROLE_CAP_MAP: judge 0.35, planner/challenger 0.55, implementation 0.45, emergency 0.65, domain 0.45, default 0.40.
- `aria-tools/context-audits.jsonl` ledger + `context_budget_audited` + `context_budget_exceeded` events.
- `aria-kernel context audit|budget` CLI.

### Phase 3 — Session/Handoff Ledger
- `aria_kernel/handoff_ledger.py` `take_handoff_snapshot` (4 trigger: manual/session_start/pre_compact/session_stop).
- 7-field snapshot (active_plan, open_findings, open_debts, pending/claimed_requests, last_change_chain, last_validation, next_logical_step).
- `aria-tools/handoffs.jsonl` + `handoff_snapshot_recorded` event.
- GHA workflow extension (session_start + session_stop steps).

### Phase 4 — Fresh Spine Orchestrator (operator gap #1) + 4.0 test-gap-adapter binding
- `aria_kernel/spine_orchestrator.py` `refresh_spine_adapters` 5 adapter aynı `repo_state_id` ile fresh run; cache hit per state_id; parallel via ThreadPoolExecutor.
- `architecture_spine_gate.take_baseline/take_postcheck` `require_fresh_adapter_runs=True` default.
- Frozen profile altında fresh run YASAK (cached read OR `GovernanceError 'frozen_profile_no_baseline'`).
- 4.0 test-gap-adapter registry binding (manifest var, registry'de yoktu).

### Phase 5 — CI Real OAuth Smoke (operator-supervised, prerequisite for Phase 6)
- 4 hard criteria: envelope schema validity + submit ACCEPTED/REJECTED + metric segregation + lease-token leak audit.
- Phase 5 < Phase 7 ordering note (compliance gate Phase 7+'da gelir).
- Spike doc UPDATE OR DEBT-2026-05-08-006 emit.

### Phase 6 — Agent Eval Harness (mock/real branching)
- `aria_kernel/agent_eval.py` 5 pinned fixture (aria-evidence-judge / aria-adversarial-judge / aria-consensus-arbiter / architectural-arbiter / auth-security-expert).
- `aria_agent_eval_mock_only_total` + `aria_agent_eval_real_total` (metric counters 10 + 11 of final 13).
- Weekly off-hours CI workflow `.github/workflows/aria-agent-eval.yml`.
- Mock mode'da "agent quality verified" iddiası YOK; real-mode validation Plan 021 scope eğer Phase 5 fail ederse.

### Phase 7 — Agent Compliance Harness (operator gap #2 — Eval ≠ Compliance)
- `aria_kernel/agent_compliance.py` 6 check: 4 hard-reject (must_satisfy_completeness / evidence_schema_valid / output_path_match / banned_phrase_in_response_body) + 2 soft (response_order_valid / refusal_trigger_valid).
- Reject rule: `any hard fail OR 2+ soft fail` → REJECTED + `rejection_reason='compliance_rejected'` (10-state lifecycle preserved, NOT a new state).
- `aria-tools/agent-compliance.jsonl` + `agent_compliance_violation` + `agent_compliance_warning` events.

### Phase 8 — Validation Matrix Gate (operator gap #3, 3-layer enforcement)
- `aria_kernel/validation_matrix_gate.py` 4 risk-types: auth_change / tenant_change / schema_change / event_change.
- 3-layer: existence + pattern + run-pass (validation_run_refs structured `{cmd, exit_code, log_path, ran_at}` schema migration).
- `change_ledger.emit_change_validated` candidate refs ile gate ÖNCE çalışır; geçerse row persist.
- API migration: backward-compat string refs (historical_attestation only) + structured dict (enforced REQUIRED).

### Phase 9 — Change Ledger Validated Chain (operator gap #4 — hard closure)
- `validation_mode: 'enforced' | 'historical_attestation'` field eklenir SADECE `validated.jsonl` row + yeni `validation_matrix_check` event detail (existing `change_validated` governance event payload immutable).
- Plan 019 14 historical commit `historical_attestation` ile attest edilir (numerator'a girmez).
- Plan 020 `enforced` standard.
- 12. metric `aria_change_chain_validation_pct = (enforced_validated_count / committed_count) × 100`.
- 7-day strict-mode `change_chain_stale` event.

### Phase 10 — Agent Harness Security Adapter (operator gap #9 — refined rules)
- `tools/aria-adapters/agent-harness-security-adapter.{ts,tool.json,test.ts}` 7 detection rule.
- `workflow_run_or_pr_target_untrusted_checkout` (refined; standalone `actions/checkout` flag'lemez).
- Spine gate 5. invariant `harness_security`.

### Phase 11 — Surface Manifest Validator (operator gap #7 — parity rule fixed)
- `aria_kernel/surface_manifest_validator.py` 6 validator.
- `validate_target_agent_existence` shared `agent_resolver.resolve_agent_md_path` reuse (Phase 2).
- `validate_agent_frontmatter` README exclude (heuristic: `---` prefix → frontmatter).
- `validate_maintenance_agent_isolation` dar kural (domain reviewer / product-audit roster'a sızma; kernel-bound dispatch normal).
- CI invariant test `tests/invariants/aria-surface-manifest.spec.ts`.

### Phase 12 — Instinct Candidate Ledger (auto-mutation BANNED)
- `aria_kernel/instinct_candidate.py` schema + PROPOSED → UNDER_REVIEW → PROMOTED (operator_approval_ref + PR URL) | REJECTED.
- Kernel-side enforcement: auto-promotion REJECT.
- `learning.py:_skill_or_agent_genesis` extension — auto-genesis önce candidate kayıt + HUMAN_REQUIRED.
- `instinct_candidate_recorded` + `instinct_candidate_promoted` events (event #11+#12 of 14).

### Phase 13 — Cost Telemetry + 13. metric
- `agent_invocations.create_agent_invocation_request` `dispatch_rationale` kwarg.
- `aria_kernel/cost_telemetry.py` `compose_dispatch_rationale`.
- `aria-tools/cost-telemetry.jsonl` + `dispatch_rationale_recorded` + `cost_cap_exceeded` events (event #13+#14).
- `plan_016_metrics.py` 13. counter `aria_dispatch_rationale_total`.
- CI executor (Plan 019 Phase 8) integration.

### Phase 14 — Backend Adapter Completion (scoped: outbox + cqrs) + Plan 021 placeholder
- `tools/aria-adapters/{outbox,cqrs}-adapter.{ts,tool.json,test.ts}` (6 yeni dosya).
- Backend portfolio: 5/10 → 7/10 real.
- Total ARIA registry: 5/10 → 9/12 real.
- DEBT-2026-05-07-003 IN_PROGRESS (Plan 020 KAPATMAZ; Plan 021 closes).
- Plan 021 placeholder doc: `docs/aria/plans/021-backend-adapter-completion-and-legacy-frozen-hardening.md`.

### Phase 15 — Verification + Sign-off Review v5
- 3-suite test acceptance: (a) Python unittest ≥630 (b) `npm run gates:banned-phrase:test` 4/4 + commit-msg-validator 34 (c) `npx tsx --test` adapter `.test.ts` each ≥1 fixture.
- Live ledger evidence audit per phase.
- Push `git push origin snowball` (after PAT).
- `docs/aria/reviews/2026-05-09-plan-020-implementation-review.md` review v5.

## Acceptance

- 16 phase live evidence; 14 yeni governance event kind; 8 dedicated ledger surface + 1 writer surface (validation-matrix); 9/12 real adapter; 13 metric; 4-mode runtime profile (Plan 020 scoped no-write); 5-invariant spine gate + fresh orchestrator.
- Plan 016 + 017 + 018 + 019 + 020 cumulative: ~85 commit, 670+ Python test, full self-remediation chain operational with operator-supervised continuous-learning candidate path.
- DEBT-2026-05-07-003 IN_PROGRESS (3 backend adapter Plan 021 scope).
- Plan 021 placeholder commit'li.

## Assumptions

- Operator GH PAT yenilenmiş; 15 Plan 019 commit + Plan 020'nin ~30 commit'i pushlanmış.
- Phase 5 OAuth smoke operator-supervised; mock veya real path Plan 020 close'da explicit.
- Phase 14 scoped 2 adapter; 3 kalan Plan 021 placeholder doc'unda.
- L1/L2/L3 + suppression + auth/tenant gates hiçbir runtime profile'da bypass'lanmaz.
- Continuous-learning auto-mutation kernel-side BANLI; PR + finding + debt üç kanal.
- Frozen invariant Plan 020 protected surfaces only; legacy mutators Plan 021 hardening scope.
- Plan 020 v3.3 SPEC.md, IDENTITY.md, CONTRACTS.md, ROADMAP.md değiştirmez.
