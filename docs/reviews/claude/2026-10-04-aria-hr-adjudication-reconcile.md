# ARIA HUMAN_REQUIRED adjudication reconcile (2026-10-04)

Context: in aria-agent-executor runs 37205463513 and 37221168808 (2026-10-04), one
`human_required_adjudication` request per run went through the same sequence:
`claude_returned_exit=0`, `pre_submit_validation_passed`, `submit_step_done rc=0`,
`native_runtime_result_reconciliation_unavailable:GovernanceError`, and then
`drain_child_without_summary rc=1`. The requests were `AIR-aria-evidence-judge-86a41b2ac632` and
`AIR-aria-adversarial-judge-0ef27e14e5ef`, both seats on a HUMAN_REQUIRED adjudication panel.
The drain counted each as `harness_failed=1`, so both jobs ended red even though the plan's own
work succeeded (`stop=planning_turn_complete`, 5 of 6 succeeded).

Owner: claude (implementation), okan (review). Deadline 2026-10-11.

## ARIA-HIGH-346

Evidence (at `main@690470509`):

- `tools/aria-poc/ci_executor.py:3663`: `_accepted_native_runtime_result` proves that the
  accepted row matches its request with `accepted.get(name) != request.get(name)` for
  `target_sha`, `context_hash` and `prompt_hash`, comparing against the raw request fields.
- `aria-kernel/aria_kernel/agent_invocations.py:5440`: the accepted-row constructor writes
  `target_sha=str(request.get("target_sha") or "")`, so the kernel stores "no anchor" as `""`.
- `aria-kernel/aria_kernel/human_required_adjudication.py:443`: the panel mint
  (`open_adjudication`) passes no `target_sha`. An escalation is judged on its record, not on a
  tree, and an unanchored request is legitimate (ORPHAN-CRITICAL-495, ARIA-HIGH-241).
- So for every unanchored request the proof compares `"" != None` and raises
  `native_runtime_result_request_evidence_unavailable`. `:4403` writes only the exception type
  to stderr and returns False, and `:5728` then exits 1 without a summary.

Live rows, read-only from the runner's `.aria-state-store/tools`:

- `AIR-aria-adversarial-judge-0ef27e14e5ef` (`claim_a35b5543222fb84d`): request `target_sha` is
  `null`, accepted row `target_sha` is `""`.
- `AIR-aria-evidence-judge-86a41b2ac632` (`claim_5c286c7b761df2c2`): request `target_sha` is
  `null`, accepted row `target_sha` is `""`.

On both pairs `role`, `context_hash` and `prompt_hash` are equal, and the result `status` is
`accepted`. I copied the store into a scratch directory and replayed
`_accepted_native_runtime_result` against it, using each attempt's own `session_id` and
`policy_digest` from its `runtime_attempt_started` row. Both requests raise
`native_runtime_result_request_evidence_unavailable`. With only the `target_sha` spelling
normalised, every later step of the proof (sealed hash, envelope binding, claim, attempt
binding) passes for both requests.

The other candidates are ruled out. The accepted row is on `agent-invocations/results.jsonl`
like every other role's. The claim, agent and session identity on the attempt row match. The
policy digest matches.

Why only this role: the live ledger holds 690 `human_required_adjudication` requests, and all of
them are unanchored. Every judge, arbiter and planner request is anchored. Six
`maintenance_utility` requests are unanchored too; they become reachable once ARIA-HIGH-344
routes that role, and they would fail in the same way. Every `runtime_attempt_reconciled` row in
the store belongs to an anchored request.

Rule: a proof that a row belongs to its request compares against the same projection the row was
written through. The writer and the reader of a field cannot spell its absence in two ways.

Fix (branch `fix/aria-hr-adjudication-reconcile`):

- Tier 2: `agent_invocations.accepted_result_request_binding(request)` is the one projection of
  the request evidence that an accepted row carries. `_prepare_claim_submission` checks the
  submitted context and prompt hashes against it and builds the row from it.
- `ci_executor._native_request_evidence_refusal` compares the accepted row against that
  projection instead of the raw request. The comparison stays exact for every field. An anchored
  request still needs its own SHA. An unanchored request still needs a row bound to no anchor, so
  a row naming some other SHA is still refused. No error is caught or ignored. The judge-batch
  path (`ci_executor_judge_batch.py`) reconciles through the same function.
- Tier 3: `aria-kernel/tests/test_native_reconcile_unanchored_request.py`:
  - A real mint, claim and kernel submit for each panel seat of the role, then the executor's
    proof (red before the fix, with the measured error).
  - An anchored request reconciles at its exact SHA.
  - A forged anchor is refused.
  - The row carries the projection.
  - The invariant: every dispatchable role is either routed natively or listed in
    `NON_NATIVE_ROLES` with a reason. That list is empty, because the routing table refuses to
    load without every dispatchable role. For every routed role, the accepted row built for an
    anchored, a `None`, an empty and an absent `target_sha` satisfies the executor's proof.

Not done:

- The reconciliation stderr line still names only the exception type, not the refusal code.
  Finding this cause took a replay against the live store. Adding the code to the line is a
  diagnostic change, separate from this fix.
- The finding stays OPEN until the fix merges. The close ceremony needs the merged SHA on
  `origin/main`.
