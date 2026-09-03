<!-- ARIA-HISTORICAL: Historical plan document. Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Plan 022 — Kernel Correctness Closure

> **Status at sign-off:** v6 declared closure complete. **Status post-audit:** Plan 023 v3 corrective arc is closing 30+ architectural bypass routes that survived the v6 sign-off; this Plan 022 doc is the historical anchor.
> **Branch:** `snowball`.
> **HEAD at sign-off:** `6090b67b`.
> **Closes:** 20 audit findings via 21 implementation fix items across 3 tiers (C, H, M).

This document anchors Plan 022 in the repo so the `aria-plan-doc-presence` invariant holds (Plan 022 §M-3 added the invariant; the operator-local spec at `/root/.claude/plans/s-md-b-z-bu-parsed-treasure.md` pre-dates the in-repo location). The full Plan 022 v2 spec content is preserved in the operator-local file.

## Tier C (CRITICAL kernel correctness, 8 fix items)

- **C-1** Feedback evidence_refs data loss (`feedback.py:265`) — Plan 022 v2 added `evidence_refs` to pressure events.
- **C-1b** Pressure evidence normalization in `task.py:86` — task candidate now reads `evidence_refs` first with `evidence` legacy fallback.
- **C-2** Tool registry overwrite bypasses lifecycle (`tool_registry.py:362-365`) — `register_tool` overwrite path now enforces transition rules.
- **C-2b** `update_tool` lifecycle bypass — status changes route through `transition_tool`; runner/scope changes require operator approval.
- **C-3** `ensure_tools_binding` fail-open on repo hash mismatch — explicit branch raises `tools_root_repo_hash_mismatch`.
- **C-4** PR provenance head_sha + PR number (`pr_manager.py:111-134`) — head_sha resolved via `git rev-parse <branch>`, PR number parsed via robust regex.
- **C-5** Scope-out mutation invisible (`tool_runner.py:262-286`) — raw vs scoped snapshot separation; scope-out mutations populate envelope and trigger quarantine.
- **C-6** Executor self-review bypass (`executor.py:177-200`) — source_agent ≠ reviewer guard added.
- **C-7** `wait_pr_checks` via `_gh_pr_snapshot` fake-success (`ci.py:649-678`) — `checks.runs` now mirror real workflow_runs state.

## Tier H (HIGH silent failure modes, 6 fix items)

- **H-1** Suppression scan bypass via `diff_text=None` (`apply_engine.py`) — None branch reads diff via git fallback, fail-closed.
- **H-2** Auto-merge path-only classification (`auto_merge.py:118-133`) — diff-content scan added; suppression hits demote risk to `unknown`.
- **H-3** Fitness timestamp drift (`fitness.py:180` ↔ `triage.py:215`) — alias-aware reads (`recorded_at` first, `computed_at` legacy fallback).
- **H-4** Genesis sandbox doesn't execute fixtures (`agent_genesis.py:66-75`) — `execute_fixtures=True` by default; provenance shape required.
- **H-5** SHADOW raw findings silent (`tool_runner.py:139-141`) — `sample_shadow_raw_findings` + `agent-eval shadow-sample` CLI added.
- **H-6** `max_triage_tier` dead code (`fitness.py:174` ↔ `triage.py`) — `triage.classify_pressure` now reads agent fitness max_triage_tier and applies the cap.

## Tier M (MEDIUM cycle integration + drift cleanup, 7 fix items)

- **M-1** Main cycle gate integration (`cycle.py:85`) — `run_phases` kwarg accepts opt-in extended phases.
- **M-2** `tool_runner` sandbox `read_paths` mandatory match — evidence subset enforcement in `evidence_validator`.
- **M-3** Plan 019 spec doc backfill — `docs/aria/plans/019-architecture-spine-gate-and-pr-lifecycle.md`.
- **M-4** Daily report 2026-05-08 + future automation — initial daily report generated; daily workflow scheduled.
- **M-5** F-002 lineage clean-up — DEBT-2026-05-07-004 relinked to F-003 with historical preservation.
- **M-6** Registry/adapter manifest sync invariant — `validate_registry_adapter_sync` validator + `registry-stub-allowlist.json` + invariant test.
- **M-3 invariant** `aria-plan-doc-presence` — every plan referenced in commit messages MUST have a `docs/aria/plans/0NN-*.md` file (this document).

## Plan 022 v6 sign-off ↔ Plan 023 v3 corrective arc

Plan 022 v6 declared closure complete on 2026-05-08 at HEAD `6090b67b`. A post-push external audit (2 sub-agent reviews + operator deep-look + 3 parallel Explore-agent code verification on 2026-05-09) identified 30 architectural bypass routes still reachable in the merged code despite the test-suite-green status. The pattern: several Plan 022 fixes were test-shaped (asserting invariants on contrived fixtures) but not runtime-shaped (the underlying runtime bypass paths survived).

Plan 023 v3 is the corrective-arc tracking closure of those 30 bypasses via 32 implementation fix items across 7 tiers (C, P, A, R, D, F, H). See `aria-findings/F-004.json` for the consolidated finding and `/root/.claude/plans/s-md-b-z-bu-parsed-treasure.md` for the operator-local Plan 023 v3 spec.
