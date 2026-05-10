# Plan 024 v3 Implementation Review — Post-Push Audit Closure

> **Branch:** `snowball` (worktree: `/var/aqua-saas/.worktrees/snowball`).
> **Closure HEAD:** `754acb46` (Plan 024 §B-8 final commit, 2026-05-09).
> **Audit anchor:** `aria-findings/F-005.json` (15 audit data points + 6 evidence anchors).
> **Predecessor:** Plan 023 v3 + v3.1 (32 fix items, HEAD `e4f3218e`, sign-off `docs/aria/reviews/2026-05-09-plan-023-implementation-review.md`).
> **Sign-off date:** 2026-05-10 (Tier V verification + Tier S documentation; the corrective code itself landed on 2026-05-09).

---

## Closure context

Plan 023 v3.1 sign-off declared kernel-correctness closure complete at HEAD `e4f3218e`. A post-push audit (3 paralel Explore agent + operator pass-2 + pass-3 validation) identified 15 architectural-quality gaps Plan 023 v3 did not cover by design (creation-side strict fields, run_tool API contract, lock infrastructure) or by oversight (workflow injection, projection-time field strip, snapshot adapter fallback). Plan 024 v3 closes the residual chain via 16 fix items (8 Tier B BLOCKER + 7 Tier H + 1 H-0 prerequisite cross-platform `with_exclusive_lock` helper) plus the operator-pass-2 + pass-3 corrections of plan code-alignment errors that were caught BEFORE any code shipped (the v1 → v2 → v3 plan spec discipline).

This review documents the closure, evidences each anchor's CLOSED state via Tier V verification, and records the operator sign-off path for F-005 → RESOLVED.

---

## Closure surface — commit-by-commit

| # | Commit | Plan 024 §item | F-005 anchor(s) closed | Test delta |
|---|---|---|---|---|
| 1 | `0178328a` | Pre-flight telemetry baseline | — (operational) | — |
| 2 | `37a00e8f` | F-005 register | — (audit infra) | — |
| 3 | `e70f56d4` | §B-1 legacy `agent-invocations submit-result` removal + `_submit_legacy_invocation_result_internal` rename | 1 | +7 |
| 4 | `8a0e1a6b` | §B-2 strict fields creation API + `_strict_request_view` fail-closed + evidence_validator non-empty matrix + scope enforcement | 2, 17 | +8 (16 file migration, atomic) |
| 5 | `b7efcd21` | §B-3 workflow `${{ inputs.* }}` injection closure + `aria-daily-report.yml` two-job split + invariant | 3, 4 | +1 invariant |
| 6 | `ec24a6a1` | §B-4 `runtime_profile` fail-closed `(profile, diagnostic)` tuple + `FROZEN_PROFILE` constant + write-boundary governance emission | 6 | +8 |
| 7 | `0f5ae29a` | §H-7 JSONL corrupt-row diagnostic sink (recursion-safe; `aria-tools/diagnostics/ledger-corruption.jsonl`) | 19, 20, 21 | +7 |
| 8 | `563ea50b` | §B-5 `list_required_tests` projection preserves `expected_cmd_substring` + correlation gate fail-loud | 7 | +5 |
| 9 | `a588cacc` | §B-7 + §H-6 `run_tool` API split (`{envelope, health_decision}`) + spine_orchestrator status whitelist (atomic) | 10, 11, 18 | +5 |
| 10 | `5e5e5e52` | §B-6 auto-merge `SnapshotGitHubAdapter.get_latest_head_sha` strict + `merge_if_green` pre-merge full re-evaluation | 8, 9 | +3 |
| 11 | `22c60810` | §H-0 + §H-1 + §H-2 cross-platform `with_exclusive_lock` helper + `claim_request` atomic + CAS recheck + `submit_claim_result` idempotency | 13, 14 | +4 |
| 12 | `559c2906` | §H-3 + §H-4 `_latest_lease_expiry` fail-closed (heartbeat + submit) + `validate_response` envelope.role match | 15, 16 | +4 |
| 13 | `c16ffc18` | §H-5 evidence canonical-resolve helper (shared between `_check_agent_ref` string refs + `validate_evidence_path` dict refs) | 12 | +5 |
| 14 | `754acb46` | §B-8 mock CI executor real lease + role from request | 5 | +4 |

**Total: 14 fix commits + 1 telemetry baseline + 1 finding register = 16 commits push'landı `origin/snowball`'a.**

**Test delta: 1012 baseline (Plan 023 v3.1 sign-off) → 1072 final (60 new test methods).**

---

## Verification matrix — Tier V Explore-agent reproducer

Three parallel Explore agents re-verified each F-005 anchor against HEAD `754acb46` on 2026-05-10. Each agent read actual code at the cited file:line locations and reported CLOSED / OPEN / PARTIAL.

### Agent A (anchors 1–7)

| Anchor | Finding | Verdict | Evidence |
|---|---|---|---|
| 1 | Legacy `agent-invocations submit-result` CLI bypass | **CLOSED** | `agent_invocations.py:209` `_submit_legacy_invocation_result_internal` rename + `:237-240` operator approval guard + `cli.py:631-637` removal comment + `cli.py:602+638` `request`/`list` preservation + `:258-265` governance event emit |
| 2 | `_strict_request_view` empty defaults | **CLOSED** | `agent_invocations.py:1104-1142` reject-on-empty + `:62-84` signature extension + `:100-111` `create_agent_invocation_request_strict_fields_required` + `:168-170` row write |
| 3, 4 | Workflow `${{ inputs.* }}` shell injection | **CLOSED** | `aria-daily-report.yml` two-job split + `env:` blocks + regex validate; `aria-agent-executor.yml` request_id env-only; `aria-workflow-input-injection.spec.ts` invariant |
| 5 | CI executor mock hardcoded `claim_mock` | **CLOSED** | `ci_executor.py:98-109` kwargs added; `:130-135` raises `ci_executor_mock_missing_lease_identity`; `:155-156` envelope uses passed values |
| 6 | `runtime_profile.get_profile` fail-open | **CLOSED** | `runtime_profile.py:174-230` `get_profile_with_diagnostic`; `:210, :218, :225` `FROZEN_PROFILE` returns; `:373-408` write-boundary emission; `:467` `__all__` export |
| 7 | `list_required_tests` strips `expected_cmd_substring` | **CLOSED** | `validation_matrix_gate.py:238-244` projection includes field; `:229-237` runtime guard; `:344-349` correlation gate fail-loud |

### Agent B (anchors 8–14)

| Anchor | Finding | Verdict | Evidence |
|---|---|---|---|
| 8 | `SnapshotGitHubAdapter.get_latest_head_sha` fallback | **CLOSED** | `auto_merge.py:524-535` strict; comment "Strict semantics: None signals lookup failure" |
| 9 | Pre-merge partial re-check | **CLOSED** | `auto_merge.py:395-443` re-runs `collect_github_snapshot` + `get_pr_diff` + `evaluate_auto_merge`; block payload carries `stage='pre_merge_re_evaluation'` |
| 10 | Tool run CLI exit-0 unconditional | **CLOSED** | `cli.py:139-146` `_TOOL_RUN_EXIT_CODES` constant; `:1268-1269` envelope-status-driven exit code |
| 11 | `run_tool` health-only return | **CLOSED** | `tool_runner.py:195-209` returns `{**decision, "envelope": envelope, "health_decision": decision}` |
| 12 | Evidence path SELF_OUTPUT prefix-before-resolve | **CLOSED** | `evidence_validator.py:200-234` `_canonical_evidence_path` shared helper; both callers (line 161 + 258) call helper before SELF_OUTPUT |
| 13 | `claim_request` non-atomic | **CLOSED** | `file_lock.py:1-128` `with_exclusive_lock`; `agent_invocations.py:604-644` lock + CAS recheck |
| 14 | `submit_claim_result` no idempotency | **CLOSED** | `agent_invocations.py:854-877` existing-result lookup + `idempotent: True` return |

### Agent C (anchors 15–21)

| Anchor | Finding | Verdict | Evidence |
|---|---|---|---|
| 15 | `_latest_lease_expiry` parse failure → None pass-through | **CLOSED** | `agent_invocations.py:761-765` raises `lease_not_found` / `lease_expires_at_unparseable_or_missing`; caller `is not None` guards removed |
| 16 | `validate_response` membership-only role | **CLOSED** | `agent_contract.py:404-409` `response_role_mismatch_with_request` cross-check; `:322` membership preserved as defense-in-depth |
| 17 | `evidence_validator` empty matrix bypass | **CLOSED** | `evidence_validator.py:332-333` `evidence_satisfaction_matrix_must_be_non_empty`; `:364-365` `evidence_request_missing_allowed_scope` |
| 18 | `spine_orchestrator` blacklist | **CLOSED** | `spine_orchestrator.py:262-266` whitelist + exclude set; `:288` envelope status read; `:311-318` unknown-status raise |
| 19 | Handoff ledger JSONDecodeError silent skip | **CLOSED** | `handoff_ledger.py:360-372` strict-mode raise + diagnostic emit |
| 20 | Finding index rebuild silent skip | **CLOSED** | `finding.py:161-184` continues to skip (deadlock-avoidance) but emits `ledger_index_rebuild_skip` to diagnostic sink |
| 21 | governance.jsonl recursion risk | **CLOSED** | `diagnostics.py:40-44` separate sink at `aria-tools/diagnostics/ledger-corruption.jsonl`; `tool_registry.py:214-223` `append_tools_governance` writes only to governance.jsonl (no recursion path) |

**21 / 21 anchors CLOSED. 0 OPEN. 0 PARTIAL.**

---

## Test suite verification

```bash
ARIA_TEST_TMPDIR=/tmp/aria-tests \
ARIA_WORKSPACE_BASE=/tmp/aria-workspaces \
PYTHONPATH=aria-kernel python3 -m unittest discover -s aria-kernel/tests -p 'test_*.py'
# Ran 1072 tests in 236.524s — OK (skipped=28)
```

**Pre-Plan-024 baseline:** 1012 tests OK / 28 skipped.
**Post-Plan-024 v3:** 1072 tests OK / 28 skipped.
**Delta:** +60 new test methods across 14 fix commits.

### CI invariants (`npm run invariants:fast`)

The new `tests/invariants/aria-workflow-input-injection.spec.ts` PASSES under the `layer-3` Jest project. Its scope is intentionally limited to `aria-*.yml` workflows; non-ARIA workflow injection findings are documented separately as ORPHAN-HIGH-055 in `docs/reviews/orphan-findings.md` (4 production deploy / release pipelines: `deploy-digitalocean.yml`, `deploy-staging.yml`, `edge-agent-release.yml`, `sensor-ingestion-release.yml`). The 18 unrelated invariant failures in the broader `:fast` shard are pre-existing baseline issues outside Plan 024 v3 scope.

### Plan 023 invariants (regression)

* `tests/invariants/aria-workflow-sha-pin.spec.ts` (Plan 023 v3 §P-5) — green.
* `aria-daily-report-debt-truth` (Plan 023 v3 §D-2 ledger-truth) — green.

---

## Audit-finding ↔ Plan 024 v3 mapping (final)

| F-005 anchor | Severity | v3 fix | Closure commit | Status |
|---|---|---|---|---|
| 1 | BLOCKER | B-1 | `e70f56d4` | Closed |
| 2 | BLOCKER | B-2 | `8a0e1a6b` | Closed |
| 3, 4 | BLOCKER | B-3 | `b7efcd21` | Closed |
| 5 | BLOCKER | B-8 | `754acb46` | Closed |
| 6 | BLOCKER | B-4 | `ec24a6a1` | Closed |
| 7 | BLOCKER | B-5 | `563ea50b` | Closed |
| 8, 9 | BLOCKER | B-6 | `5e5e5e52` | Closed |
| 10, 11 | BLOCKER | B-7 | `a588cacc` (atomic with H-6) | Closed |
| 12 | HIGH | H-5 | `c16ffc18` | Closed |
| 13, 14 | HIGH | H-1 + H-2 (with H-0 prereq) | `22c60810` | Closed |
| 15 | HIGH | H-3 | `559c2906` | Closed |
| 16 | HIGH | H-4 | `559c2906` (paired with H-3) | Closed |
| 17 | HIGH | B-2 | `8a0e1a6b` | Closed |
| 18 | HIGH | H-6 | `a588cacc` (atomic with B-7) | Closed |
| 19, 20, 21 | HIGH | H-7 | `0f5ae29a` | Closed |

**21 evidence anchors → 16 fix items (1 prereq + 15 fix commits, several anchors closed by the same commit per atomic theme groupings).**

---

## v1 → v2 → v3 plan spec discipline

Plan 024 v1 was written, **never executed**, then operator pass-2 found 10 spec/wording errors against the actual code (e.g. CLI subcommand structure, `evidence_refs` type, GHA env-no-cross-job, etc.). v2 corrected those 10. Operator pass-3 found 10 MORE spec errors (e.g. `agent-invocations` parser surface count, lock target ledger, `with_exclusive_lock` helper presence, governance recursion risk, npm run invariants pattern). v3 corrected those 10 too. **All 20 corrections happened BEFORE any code shipped.**

The v1 → v2 → v3 discipline is the architectural rule operationalised: every fix must verify against ACTUAL code, not against the assumed code. Plan 024 v3 proves the spec discipline catches errors at plan time so the corrective arc lands clean.

---

## Closes vs Does NOT close

**Closes (21 evidence anchors, 16 fix items):**
- All 8 Tier B BLOCKER (B-1 through B-8).
- All 7 Tier H High Risk (H-1 through H-7).
- 1 H-0 prerequisite (cross-platform `with_exclusive_lock` helper).

**Does NOT close (out of scope, tracked separately):**
- **ORPHAN-HIGH-055** (`docs/reviews/orphan-findings.md`): 4 non-ARIA production workflows still carry raw `${{ github.event.inputs.* }}` interpolation. Documented file:line + remediation pattern; future platform-CI plan extends the invariant.
- **Plan 021 placeholder** (Backend Adapter Completion + Legacy Frozen Hardening) — parallel arc, separate.
- **DEBT-2026-05-08-001** (Plan 020 Phase 5 OAuth) — operator-only, due 2026-06-07.
- **Plan 020 Phase 14 outbox+cqrs adapter ACTIVE promotion** — eval window open.
- **Cross-repo aria-tools binding** — Plan 025 placeholder.
- **`docs/architecture/ADR-010-*.md`** misfiled — pre-existing.

---

## Operator sign-off path

1. Operator review of this document.
2. Operator approves F-005 status transition `OPEN → RESOLVED` (the next commit lands the index update + this review file).
3. Final `git push origin snowball` (operator-approved per `feedback_ask_before_push`).

After step 3, Plan 024 v3 corrective arc is closed-on-record. Future audits start from the new HEAD; the same architectural discipline (every fix tier-1, every plan v1→v2→v3 spec validation, every audit anchor closed with file:line evidence) applies to the next corrective arc.
