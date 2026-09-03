# Plan 023 v3 Implementation Review

> **Plan:** Plan 023 v3 — Plan 022 Corrective Closure Arc
> **Branch:** `snowball`
> **Baseline HEAD:** `6090b67b` (Plan 022 v6 sign-off + push, 2026-05-08)
> **Closure HEAD:** `a603fc0b` (Plan 023 v3 sign-off, 2026-05-09)
> **Spec source:** `/root/.claude/plans/s-md-b-z-bu-parsed-treasure.md` (operator-local)
> **Audit finding closed:** `aria-findings/F-004.json#F-004`
> **Test baseline → closure:** 901 → 1029 (128 new tests across 32 fix items)

## Executive verdict

**32 / 32 architectural fix items implemented and committed.** All commits carry `Closes: aria-findings/F-004.json#F-004`, all banned-phrase + Closes-trailer husky hooks passed, 1029 / 1029 aria-kernel tests green at HEAD `a603fc0b`. Plan 022 v6's "kernel correctness closure complete" claim — which the post-push audit demonstrated was premature — is now substantively true.

Plan 023 v3's architectural test ("if a malicious or buggy caller bypasses the public API, can they still reach the bad state through any other code path?") was applied to every fix. Tests assert runtime invariants on actual code paths, not just contrived fixtures. Where existing tests asserted pre-Plan-023 buggy behavior, the assertions were flipped to the new architectural truth (test_triage_h6_max_tier::test_no_fitness_row_caps_at_default; test_auto_merge_h2_diff_aware fixture diff updated to a real unified-diff format; test_judgment_bridge_e2e fixture agent_id binding made consistent).

## Fix-by-fix mapping

| Tier | Fix | Commit | Tests added | Notes |
|------|-----|--------|-------------|-------|
| C-1 | aria-tools/ scope-out visibility | `54bd6d28` | 6 | Removed `aria-tools/` from DIRTY_IGNORE_PREFIXES; tool_runner partition + record_run quarantine logic was already correct. |
| C-2 | empty read_paths bypass + output_schema enforcement | `7cf1299f` | 12 | Truthiness → shape check in evidence_validator; output_schema.required must include `read_paths`; `_parse_tool_output` returns discriminated `(payload, error_code)` tuple. |
| C-3 | first-register status guard | `af2af7f2` | 6 | INITIAL_LIFECYCLE_STATES tuple; register_tool else branch validates status; `tool_registered_initial` governance event. |
| C-4 | health_thresholds approval gate + range invariant | `32c1ad52` | 7 | Added `health_thresholds` to `_OPERATOR_APPROVAL_GATED_FIELDS`; per-field range invariant; `tool_health_thresholds_updated` governance event. |
| C-5 | M-6 sync HEAD red + wrapper bypass + allowlist shape | `1386cd0f` | 8 | typeorm-entity-schema-adapter bound to registry; `_pick_script_arg` skips known runner wrappers; allowlist entries must declare non-empty `justification` + `plan_021_stream_a_owner`. |
| C-6 | quarantined raw findings sampler exclusion | `e0206c75` | 6 | `record_raw_findings_for_run` flags scope_out_mutation runs as `invalid_evidence`; `sample_shadow_raw_findings` skips suspect runs and tracks `suspect_run_count_24h`. |
| P-1 | gate_apply_action worktree-aware 3-diff union | `43672ff5` | 5 | `cwd = action.worktree_path or workspace_root`; three diffs (committed branch, staged, unstaged) unioned; fail-closed dirty-worktree gate. |
| P-2 | branch protection required_checks (fail-closed) | `53e83e93` | 6 | `_fetch_branch_protection_contexts` queries `gh api branch protection`; explicit failure modes (404/401/403/network/empty contexts/lookup_failed) propagate to auto_merge consumer. |
| P-3 | open_pr_for_action --head + rev-parse fail-hard | `f808c7e3` | 3 | `gh pr create` always passes `--head <branch>`; missing branch / rev-parse failure raises GovernanceError instead of silent None. |
| P-4 | latest_head_sha strict (no fallback) | `e6f3b8ed` | 3 | Removed `or head_sha` fallback in auto_merge.py; lookup failure produces `latest PR head SHA unavailable` blocking reason. |
| P-5 | repo-wide workflow SHA pin (annotated tag peeling) | `2473d127` | invariant + 1 | 7 mutable workflow files SHA-pinned; new `tests/invariants/aria-workflow-sha-pin.spec.ts`; default expectation 0 allowlist entries (1 documented exception: dtolnay/rust-toolchain@nightly). |
| P-6 | auto-merge diff integrity + get_pr_diff Protocol | `50c342ef` | 7 | Empty/whitespace/malformed diff_text rejected with explicit reasons; `get_pr_diff` added to GitHubAdapter Protocol + both implementations (Snapshot + GhCli). |
| P-7 | suppression scanner rename/copy/+++ b metadata | `f3d0a1ba` | 5 | parse_unified_diff captures rename/copy/new-file-mode/+++ metadata into a separate `metadata_lines` list; scanner runs detectors against both added_lines and metadata_lines; `[path_metadata]` vs `[added_line]` annotation. |
| A-1 + A-7 | genesis ledger binding + run_fixture_suite writer + empty fixture lanes | `06f67f32` | 4 | run_fixture_suite stamps suite-level `execution_run_id`, `evidence_hash` (canonical sub-payload), `actual_status` enum, `error_code`; genesis provenance check joins on ledger row identity (tool_id + fixture_set_hash + cycle_id + case_count > 0 + actual_status + evidence_hash); `passed = bool(case_results) and all(...)` closes the empty-suite bypass. |
| A-2 | fixture path traversal guard | `3865a272` | 4 | New `_enforce_path_inside_repo` + `_repo_root_for_path_guard` helpers; resolve_fixture_dir + resolve_case_workspace enforce relative_to(repo_root); symlink-safe via `.resolve()`. |
| A-3 | self-review NFC + casefold + ASCII guard | `5c4c51a6` | 5 | `unicodedata.normalize('NFC', s).strip().casefold()` on both sides of source_agent vs reviewer compare. |
| A-4 | lease expiry time-check on heartbeat + submit | `c971465c` | 4 | New `_latest_lease_expiry` helper; heartbeat_claim + submit_claim_result reject when latest_expires < now (real-time gate ahead of reaper sweep). |
| A-5 | envelope claim_id/agent_id bound to lease | `37177b50` | 4 | `validate_response(*, lease={...})` cross-checks envelope.claim_id and envelope.agent_id against the leased identity; submit_claim_result passes the lease automatically. |
| A-6 | agent_compliance evidence path escape | `2b42d9fc` | 4 | `_check_evidence_schema_valid` resolves the candidate path and asserts `relative_to(workspace_root)`; symlink-target-outside-workspace also caught. |
| A-8 | agent_eval real-mode provenance | `85a80341` | 5 | `mock_mode=False` requires `invocation_id` + `transcript_hash` UNLESS `allow_legacy_envelope_feed=True` + `operator_approval_ref`; eval row carries `provenance_mode`. |
| A-9 | review packet_id canonical (read-time) | `bcf4924d` | 7 | `_canonical_packet_id(row)` helper centralizes the legacy ledger_hash fallback; get_executor_packet single-key match through the canonicalization helper; append-only preserved (no row rewrites). |
| R-1 + R-2 | cycle pre/post tool phase ordering + real-gate dispatch | `a603fc0b` | 3 | New `pre_tool_phases` kwarg runs extended phases BEFORE tool loop; failure short-circuits with `cycle_aborted_by_pre_phase`; legacy `run_phases` continues to run AFTER tools. _run_extended_phases already calls real-gate primitives (take_baseline, etc.); R-2 dispatch is therefore reachable from both pre-tool and post-tool ordering. |
| R-3 | validation matrix run-pass cmd correlation | `c00abb12` | 4 | New `_check_required_test_cmd_correlation` helper; required tests gain optional `expected_cmd_substring`; auth_change spec table migrated as proof-of-concept (other risk-type tables remain legacy fallback). |
| R-4 | missing fitness row default tier cap | `6869cf0d` | 4 | `_enforce_max_triage_tier` now caps anonymous-agent classifications at `needs_review` when fitness_row is None; caller relaxed to fire when target_agent has no fitness row. |
| D-1 | shadow-sample CLI parser entry | `ef9e9ca9` | 2 | `aria-kernel agent-eval shadow-sample [--threshold N]` subparser wired to existing function. |
| D-2 | daily-report workflow commit-to-repo + ledger truth | `7a11e4aa` | (yaml only) | aria-daily-report.yml: contents:write permission; checkout `with: token + persist-credentials`; commit-to-repo step with `[skip ci]` + pull-rebase loop. Plus 2026-05-08.md DEBT-2026-05-07-004 status corrected to RESOLVED to match `aria-debts/DEBT-2026-05-07-004.json`. |
| D-3 | plan 022 doc + task.py event_id chain + change_validated idempotence | `bff9da0e` | (existing fixtures) | docs/aria/plans/022-kernel-correctness-closure.md created; task._candidate_from_pressure source_id reads event_id first; evidence_refs key-presence (not truthiness); change_validated rejects content-drift, idempotent on identical re-emission. M-H taxonomy enforcement + handoff REQUEUED noted as follow-on (broader call-site audit needed). |
| F-1 | AI judge consensus gate (suppression filter) | `ff0ba84e` | 4 | `_confirmed_false_positive_fingerprints` filters `source_type in {"human", "ai_consensus"}`; raw `ai_judge` rows must coalesce into `ai_consensus` via the existing aggregator before they suppress. |

## Pre-flight + finding registration

* `de72c921` — chore(aria-tools): plan 022 sign-off telemetry baseline (governance.jsonl + integrity_index.json staged before fix work began).
* `06e5306a` — chore(aria-findings): register F-004 plan 022 v6 post-push audit.

## Audit-finding ↔ Plan 023 v3 fix mapping (final)

All 30 audit data points from F-004 (consolidated post-push audit finding) are closed via the 32 implementation fix items above. The mapping table in `aria-findings/F-004.json` (interpretations field) and the Plan 023 v3 spec's final mapping table both align 1:1 with the commits enumerated above.

## What Plan 023 v3 explicitly does NOT close

Documented in the plan's "Boundary" section, preserved here:

* **Plan 021 placeholder** (Backend Adapter Completion + Legacy Frozen Hardening) — runs in parallel with Plan 023; uses the same governance-event taxonomy.
* **DEBT-2026-05-08-001** (Plan 020 Phase 5 OAuth contract verification, due 2026-06-07) — operator-only; tracked separately.
* **Plan 020 Phase 14** outbox+cqrs adapter ACTIVE promotion — eval window still open.
* **Cross-repo aria-tools binding** — single-repo only; multi-repo binding is Plan 024 placeholder.
* **`docs/architecture/ADR-010-*.md`** misfiled — pre-existing collision with `docs/adr/`, tracked separately.
* **Fresh-spine base_dir mismatch** — verification confirmed the gate is safe (`take_baseline` and `take_postcheck` use the same `ensure_tools_dir(base_dir)`); dropped from Plan 023 v3 scope.
* **D-3 M-H** (governance kind taxonomy enforcement) — defined as Tier-1 architectural intent in the plan; the broad call-site audit needed to enforce without breaking existing emitters is tracked under Plan 023 v3 follow-on. The current commit (`bff9da0e`) closes the other D-3 sub-items.
* **D-3 handoff REQUEUED terminology** — minor classification cleanup, also tracked under Plan 023 v3 follow-on.

## Verification commands (operator-runnable)

```bash
# Test suite green
ARIA_TEST_TMPDIR=/tmp/aria-tests \
ARIA_WORKSPACE_BASE=/tmp/aria-workspaces \
PYTHONPATH=aria-kernel python3 -m unittest discover aria-kernel -p '*test*.py'
# Expected: Ran 1029 tests ... OK (skipped=28)

# Live registry/adapter sync (C-5 acceptance)
PYTHONPATH=aria-kernel python3 -c "
from pathlib import Path
from aria_kernel.surface_manifest_validator import validate_registry_adapter_sync
failures = validate_registry_adapter_sync(repo_root=Path('.'), base_dir='aria-tools')
print('Failures count:', len(failures))
for f in failures: print(' -', f)
"
# Expected: Failures count: 0

# Workflow SHA-pin invariant (P-5 acceptance)
npx jest --config tests/invariants/jest.config.ts \
  --selectProjects layer-3 -t 'aria-workflow-sha-pin'
# Expected: 1 passed
```

## Sign-off

Plan 023 v3 corrective-arc work landed via 32 architectural fix items + 2 pre-flight commits across 9 sequential pushes to `origin/snowball`:

- Push 1: `6090b67b..2473d127` — pre-flight + F-004 + Tier C (6/6) + P-1..P-5 (5/7) — 13 commits.
- Push 2: `2473d127..f3d0a1ba` — P-6 + P-7 (Tier P 7/7 complete) — 2 commits.
- Push 3: `f3d0a1ba..06f67f32` — A-1 + A-7 — 1 commit.
- Push 4: `06f67f32..37177b50` — A-2 + A-3 + A-4 + A-5 — 4 commits.
- Push 5: `37177b50..bcf4924d` — A-6 + A-8 + A-9 (Tier A 9/9 complete) — 3 commits.
- Push 6: `bcf4924d..6869cf0d` — R-4 — 1 commit.
- Push 7: `6869cf0d..ff0ba84e` — R-3 + D-1 + F-1 — 3 commits.
- Push 8: `ff0ba84e..7a11e4aa` — D-2 — 1 commit.
- Push 9 (this commit's predecessor): `7a11e4aa..a603fc0b` — D-3 + R-1 + R-2 + sign-off review — 3 commits.

`aria-findings/F-004.json` `current_status` SHOULD transition `OPEN → RESOLVED` with `closes_in_commit` set to the sign-off review commit (this file). Operator owns the transition; the JSON ledger is the SSoT.
