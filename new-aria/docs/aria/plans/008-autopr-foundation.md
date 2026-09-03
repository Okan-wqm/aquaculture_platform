<!-- ARIA-HISTORICAL: Historical plan document. Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Plan 008: Auto-PR Foundation

## Summary

Plan 008 moves ARIA from read-only reports toward operator-approved Auto-PR without granting merge authority. The implementation adds budget-gated LLM amplification, deterministic task ranking, proposal state transitions, impact planning, dry-run worktree planning, and PR body generation. Human approval remains mandatory before apply, and human merge remains mandatory after PR creation.

## Key Changes

- Budget governance records estimated LLM spend in an append-only ledger and blocks per-action, daily, or monthly cap violations.
- LLM amplification is a kernel-validated interface, not a provider SDK call. Responses must use only packet-provided evidence refs and validation commands.
- Task candidates are generated from pressure items, ACTIVE findings, and SHADOW run summaries. SHADOW findings remain triage-only until operator feedback promotes action authority.
- Proposal records now carry `source_authority`, `risk_class`, `task_id`, `validation_scope`, `blocked_by`, and statuses including `ready_for_operator` and `approved_for_apply`.
- Impact planning classifies docs, runtime, auth/tenant/data, migration, forbidden, and unknown changes, then maps them to repo-native validation commands.
- Apply planning creates a fail-closed worktree action record and requires `approved_for_apply`; PR dry-run generation emits required sections for problem, evidence, solution, validation, baseline, rollback, and provenance.

## Acceptance

- Budget checks and usage records preserve hash-chain integrity.
- LLM-amplified proposal generation rejects uncited evidence and unapproved validation commands.
- Task ranking is deterministic for identical pressure/run inputs.
- Impact plans select stricter validation for auth/tenant/data and migration surfaces.
- Worktree planning refuses unapproved proposals and records base SHA for approved proposals.
- PR generation is available as dry-run and includes all required sections; merge remains outside this plan.
- Full kernel regression passes: `PYTHONPATH=aria-kernel python3 -m unittest discover aria-kernel -p '*test*.py'`.

## Assumptions

- Auto-PR means branch/PR creation after operator approval, not auto-merge.
- SHADOW adapter findings are calibration signals, not direct apply authority.
- ARIA delegates validation to existing repo scripts and Nx rather than reimplementing affected graph logic.
