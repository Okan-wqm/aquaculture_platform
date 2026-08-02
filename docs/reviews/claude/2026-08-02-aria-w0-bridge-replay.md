# ARIA Wave 0 — bridge replay primitive (2026-08-02)

Program: `docs/plans/2026-08-02-aria-full-autonomy-program/PLAN.md`, Wave 0
PR 0.1. This is the first pipeline-collapse prerequisite: without it the
profiles the collapse exists to serve cannot finish a single cycle.

## ORPHAN-HIGH-520 — `replay_pending_bridges` was never written

The §C.5 bridge design (Plan 026R) shipped the ledger primitives
(`append_bridge_status`, `derive_bridge_state`, the crash-recovery rule) and
wired the orchestrator's `_default_bridge_drainer` to resolve
`bridge_status_ledger.replay_pending_bridges` by name — but the function
itself was never built. The drainer's `getattr` fallback returned
`status="skipped"` every cycle; `run_autonomy_orchestrator` treats
`skipped/unknown/failed` (or `pending_after > 0`) under `strict`/`autonomous`
as `bridge_replay_required` and breaks the cycle loop. Consequence: the two
action-capable profiles were structurally unable to complete a cycle, while
`standard` silently ignored the same skip. The defect class is
ORPHAN-CRITICAL-498's sibling: a consumer wired to a control that does not
exist.

**Fix (same commit):**

- `bridge_status_ledger.replay_pending_bridges` — walks accepted
  bridge-required result rows, derives each row's state, and replays
  crash-recovery `pending` rows (attempt 0) plus `pending_retry` rows with
  budget left under `ARIA_BRIDGE_MAX_RETRIES`; every outcome lands as an
  immutable transition row (`ok` / `pending_retry` / `permanent_fail` at
  budget exhaustion). Returns the orchestrator's exact consumer contract
  (`status`, `iterations`, `replayed_ok`, `retry_scheduled`,
  `permanent_fail`, `pending_after`); a structural ledger failure returns
  `status="failed"` instead of raising so the orchestrator loop stays in
  control.
- The three-bridge invocation (judge / supporting / plan_convergence) was
  extracted from `submit_claim_result`'s accepted path into
  `agent_invocations._invoke_bridges_for_result` and is reused verbatim by
  the replay's default invoker — a replay that drifts from the original
  invocation would be a second bridge implementation, the exact disease the
  program forbids.
- One deliberate divergence, documented in code: `BridgeContractViolation`
  propagates on the submit path (live consumer must see the breach) but is
  caught on the replay path (governance event
  `bridge_replay_contract_violation` + error detail), so one poisoned row
  cannot wedge the whole drain; the breach stays operator-visible through
  the ledger and governance trails.

**Validation:** 9 new tests (`aria-kernel/tests/test_bridge_replay.py`)
covering crash recovery, retry budget, `permanent_fail` at exhaustion,
`max_iterations` bounding, untouched non-replayable rows, the return-shape
contract, the no-raise structural-failure path, the drainer wiring (resolves
the real primitive, not a mock), and the default invoker's missing-request
error path. Full kernel suite on the branch: 3002 OK (34 skipped) — the
extraction did not move the submit path.

Owner: aria-acceptance-gap-fixer. Deadline: 2026-08-09 (post-merge close
ceremony).
