# The expert panel could be minted, claimed and answered — and never admitted; now it is the fifth live merge predicate

**Date:** 2026-09-11 · **Agent:** claude · **Cycle:** 2026-09-11 Codex handoff — merge predicates
**Finding:** ARIA-HIGH-072 — closed by this branch; this document is its evidence.

## Symptom

The Codex memory lane's last increment (`expert-consumer-first-red`, 1 FAILED +
6 passing subtests, 101.66 s) minted two `specialist_domain_review` requests
through the real expert producer, submitted two declared fixture opinions
through the real claim/submission owners, and stopped at the first
submission: `response_schema: agent-response.role unknown:
specialist_domain_review`. Its handoff instruction was precise: "Trace the
actual role admission ownership (request producer permits the specialist
role, response contract rejects it); … do not weaken the schema blindly."
Behind that first failure the intended assertion — the fifth pre-merge
predicate, `expert_consensus_evidence_verified`, passing on two accepted
expert results — was unreachable because no consumer existed: the registry
entry was still `_not_implemented`.

## Ownership, traced

- `agent_invocations.ROLES` is `agent_surface.INVOCATION_ROLES` =
  `{*REQUEST_ROLES, "specialist_domain_review"}`. That is the vocabulary the
  request WRITER obeys, and `surface_reachability`'s
  `agent_surface_request_role` binding already records why the narrower tuple
  is wrong there: "Binding the narrower vocabulary made the surface describe
  a rule the writer does not obey."
- `agent_contract.validate_request` / `validate_response` checked
  `REQUEST_ROLES`. So the one role the expert producer mints
  (`expert_review_gate` → `create_agent_invocation_request(role=
"specialist_domain_review")`) passed minting, passed claim, and failed
  response admission. E14's own rationale for removing five roles applies in
  mirror image: a surface that admits a role nothing can fulfil, or that
  mints a role nothing can answer, is a caller waiting forever.
- The producer binds every expert request to the implementation's identity
  inside its `must_satisfy[0].implementation_binding` (request/claim/result
  row hashes, plan revision/content hash, head/base sha, diff hash) and to
  `target_sha = head_sha`; `evaluate_expert_consensus` already evaluates a
  panel (≥2 distinct experts, unanimous `satisfied`, mean confidence ≥ 0.80,
  every `evidence_ref` repo-verified). What was missing was the join between
  them at pre-merge capture.

## Fix

- `agent_contract`: request and response role validation reads
  `INVOCATION_ROLES`. Not a widening beyond the writer's set — an alignment
  with it; `REQUEST_ROLES` keeps its E14 hygiene role and its re-export.
- `merge_authority._capture_pre_merge_expert_consensus`: after the
  implementation join, select the specialist requests bound to THIS
  implementation by the embedded binding (result row hash, request id, claim
  id, head sha, plan content hash) plus `convergence_id`,
  `plan_revision_hash` and `target_sha` — never by role alone. For each,
  re-run the writer's strict view and envelope-binding assertions, take the
  ACCEPTED result, verify its claim row, sealed output hash and response
  contract against the request and lease, require the matrix entry to answer
  the request's own `must_satisfy` id, and collect `{expert, verdict,
confidence, evidence_refs}`. Hand the panel to `evaluate_expert_consensus`
  with evidence re-verified at the implementation HEAD (the producer asks
  each expert to judge the final source at `target_sha`). Sealed expert
  artifacts join the capture's change-during-capture recheck.
- `_PreMergeEvidence` gains `expert_request_ids`, `expert_result_hashes`,
  `expert_target_sha`, `expert_distinct_reviewers`,
  `expert_consensus_approved`, `expert_consensus_reason`,
  `expert_unavailable_reason`.
- `implementation_safety._check_expert_consensus_evidence_verified` replaces
  the `_not_implemented` binding: unbound implementation →
  `native_implementation_binding_unavailable`; a named capture gap → that
  reason; a target that is not the implementation head →
  `native_expert_binding_unavailable`; a panel the evaluator refuses → the
  evaluator's own reason; otherwise `native_final_expert_consensus_verified`.
- The v9 gate invariants that still described "seven unimplemented pre-merge
  checks" are rewritten deliberately, as their own docstring demanded: five
  pre-merge predicates now refuse a bare action context by name
  (`native_implementation_binding_unavailable`), the two still unbuilt
  (`operator_feedback_signature`, `cycle_and_turn_budget_cap`) say
  `check_not_implemented`, and that set is pinned so building one means
  editing the test on purpose. Those invariants had been red in the Codex
  worktree since the first predicate landed.

## Proof

- The memory lane's own consumer control, adopted unchanged as the canonical
  `test_merge_authority_pre_merge_perimeter.py` (a superset of root's version
  by exactly the three lines it extends): 6 tests OK in 148.9 s — one accepted
  expert leaves the predicate failed (`insufficient_reviewers`), two accepted
  experts pass it with `native_final_expert_consensus_verified` and the
  evidence carries the request ids, result hashes and target sha in ledger
  order, a later commit on the implementation branch removes the binding, a
  rejected implementation refuses, and the request ledger prefix is
  byte-identical throughout.
- `tests.invariants.v9.test_phase_v9_0_d_implementation_safety`: 92 OK after
  the deliberate rewrite (5 failures before it, in both trees).
- Contract suites (`test_agent_contract`, `test_agent_surface_ssot`,
  `test_role_hygiene_e14`, `test_surface_reachability`,
  `test_lease_expiry_fail_closed_and_role_match`,
  `test_judge_envelope_migration`): 76 OK.

## What this is not

Declared fixture opinions through real claim/submission owners prove the
join, the binding discipline and the refusals. They are not a model's
opinion, not an operator endorsement, and not the two remaining predicates
(operator feedback authority, subscription-aware cycle/turn budget), which
still refuse by name.

## Addendum 2026-09-12 — the sixth predicate: `operator_feedback_signature`

Closes `docs/reviews/aria/2026-08-22-autonomy-closure-plan-audit.md#ARIA-CRITICAL-007`
(V9.5 hard-fail check 12, ai-safety HIGH-010).

What the pre-fix code did: `plan_synthesizer` admitted any
`operator-feedback.jsonl` row whose `signature` and `signature_kid` were
non-empty strings, so `"signature": "x"` carried the highest plan-source
priority in the system, and the drop count rode on the first surviving
candidate where nothing read it.

What is now true:

- The kernel signs every operator-feedback row it records — keyed HMAC-SHA256
  over `aria-operator-feedback/v1\n` + the canonical row minus the chain
  fields — under a rolling key at `aria-tools/secrets/operator-feedback-hmac.key`
  (0600; `signer_kid` = key id). The custody is the ack ledger's, extracted
  into `hmac_keyring.HmacKeyring` so there is one copy of the primitive;
  `ack_ledger` delegates with its API, path and error strings unchanged.
- One kernel write path: `operator_feedback_signature.append_signed_operator_feedback_row`.
  `feedback_store` verdict rows, `calibration_bootstrap` corpus fixtures and
  the new `record_operator_request` (behind `aria-kernel feedback request`,
  the only channel that yields an admissible request row) all go through it;
  an AST pin refuses any other kernel append to the surface.
- `operator_feedback_ingestion.ingest_operator_feedback` verifies each
  `unaddressed` row at the synthesizer's scan, drops an invalid one with one
  `unsigned_operator_feedback` governance event (id / line / reason / kid,
  never the body) and records the scan as an `ingestion` row on the new
  strict-read, write-driving surface `operator-feedback-ingestion.jsonl`;
  `V9PressureSourceProvider` binds the selected synthesis to that scan
  (`synthesis_bound`, keyed by the plan_content hash `plan_started` carries).
- `merge_authority._capture_pre_merge_context` walks
  `plan_started.content_hash → synthesis_bound → ingestion → consumed rows`,
  re-verifies every consumed signature against the store's key file at
  capture time (the key file's bytes join the post-capture recheck), and
  `_check_operator_feedback_signature` refuses on any named gap
  (`operator_feedback_synthesis_binding_unavailable`,
  `…_ingestion_unavailable`, `…_consumption_mismatch`,
  `…_consumed_row_unavailable`, `…_consumed_row_unsigned:<reason>`) and
  passes only as `native_operator_feedback_ingestion_verified`.
- Key rotation is `aria-kernel feedback rotate-signing-key` (governance row
  `operator_feedback_signing_key_rotated`); retired keys keep historical rows
  verifiable until they leave the five-entry window.
- §12 of `docs/aria/v3-v9-5-safety-contracts-policy.md` now states this
  contract instead of "lands later in the V9 arc".

Proof (this host, 2026-09-12): `tests/test_operator_feedback_signature.py`
(9), `tests/test_operator_feedback_ingestion.py` (13), v9 pressure-source and
implementation-safety invariants, `test_replay_logical_consumers`, the ack
ledger A5 invariants, the manifest validators and `test_autonomy_evidence_status`:
316 passed. `tests/test_merge_authority_pre_merge_perimeter.py`, whose
nx-backed fixture the delegated run could not finish under IO load: 6 passed
in 155 s, including the new assertion that the predicate refuses a fixture-
started plan with `operator_feedback_synthesis_binding_unavailable` and that
`operator_feedback_plan_started_hash` equals the plan's content hash. The
pre-fix tree fails the behavioural inversions (`test_stub_signature_is_not_a_signature`:
stub-signed row admitted, no governance event; `test_unsigned_row_dropped`).

Left as it is, on purpose: verdict rows are signed but their other readers
(`load_feedback`, judge calibration, goldset, FP suppression) do not verify —
§12 scopes verification to the plan synthesizer, and widening it is a
separate decision. The last placeholder predicate is
`cycle_and_turn_budget_cap`, which lands next.

## Addendum 2026-09-12 — the seventh predicate: `cycle_and_turn_budget_cap`

### ARIA-HIGH-088 — the seventh pre-merge predicate was a placeholder; nothing bounded an implementer's turns

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-09-19
- **Evidence:** `aria-kernel/aria_kernel/implementation_safety.py`,
  `hooks.py`, `claude_settings.py`, `merge_authority.py`,
  `docs/aria/v3-v9-5-safety-contracts-policy.md` §14.
- **What was wrong:** `HARD_FAIL_CHECKS[cycle_and_turn_budget_cap]` bound the
  placeholder that refuses every merge by name, so no implementer request had
  its Edit/Write/Bash turns bounded at all; §14 declared the cycle half as a
  per-cycle USD reservation (`--max-budget-usd-per-cycle`) after
  ORPHAN-HIGH-472 had retired the USD dispatch gate and ARIA-HIGH-074/079 had
  made notional dollars telemetry under the managed-subscription policy.
- **What is now true:**
  - The cycle cap is the run-scoped job deadline. `turn_budget.py` owns
    `JOB_DEADLINE_EPOCH_ENV`, `parse_deadline_epoch` and the close-out-margin
    predicate `job_deadline_reached` (120 s); `cycle.py`'s between-phases skip
    delegates to it, so the phase loop and the hook cannot disagree on the
    margin. `cycle.job_deadline_epoch` stays the only writer.
  - The turn cap is `IMPLEMENTER_TURN_BUDGET = 10` budgeted turns per
    implementer request (`BUDGETED_TOOL_NAMES` = Bash, Edit, Write, MultiEdit,
    NotebookEdit). `claude_settings.build_settings` compiles `--turn-budget 10`
    into the PreToolUse hook command of write-scope profiles only (implementer,
    worker); the PreToolUse matcher is derived from the same set, so the
    consulted tools and the budgeted tools are one list.
  - `hooks.admit_budgeted_turn` counts the request's admitted budgeted turns
    from `hooks/decisions.jsonl`, decides, and appends the verdict inside ONE
    `state_transaction` — two parallel tool calls serialise on the ledger
    lock, so the eleventh admitted turn cannot exist. Refusals are
    `cycle_budget_exhausted:…` (checked first) and
    `implementer_turn_budget_exhausted:used=10:cap=10`, always at the
    boundary; a policy-denied turn never counts; every budgeted verdict
    carries a `turn_budget` observation (cap, used_before, deadline_epoch,
    remaining_seconds, margin). `hook_decisions` is declared write-driving
    because its loss resets the cap.
  - `merge_authority._capture_pre_merge_context` reads
    `hooks/decisions.jsonl` as an optional source under the final prefix
    recheck; `_capture_pre_merge_turn_budget` reduces the request's rows via
    the pure `turn_budget_evidence`; `_check_cycle_and_turn_budget_cap`
    refuses an unbound implementation, absent/malformed/other-cap evidence,
    either refusal class, or more admitted turns than the cap
    (`implementer_turn_budget_exceeded_unrefused`), and passes as
    `native_cycle_and_turn_budget_respected`. Dollars are not read.
  - With ARIA-CRITICAL-007 (previous addendum) this leaves no placeholder in
    the registry: the `_not_implemented` binder is deleted, and the v9
    invariants pin that every pre-merge predicate answers an empty context
    with `native_implementation_binding_unavailable` and never with
    `check_not_implemented`. ARIA-CRITICAL-009 ("seven declared pre-merge
    controls still resolve to placeholders") is therefore closed in code;
    its closure mode is `task_commit_and_live`, so it stays open until a
    native merge observes all seven.
  - §14 of the safety-contracts policy and the implementer safety contract
    (`.claude/agents/_shared/aria-implementer-safety-contract.md`) now state
    the wall-clock + N=10 contract instead of `budget.DEFAULT_MAX_BUDGET_USD_PER_CYCLE`.
- **Proof (this host, 2026-09-12):** `tests/test_turn_budget.py` (16: ten
  admitted, the eleventh refused with exit 2; `cycle_budget_exhausted` at
  deadline − 120 s; CLI plumbing; settings compile the cap for implementer
  and worker only; predicate matrix), v12 hook/checkpoint/MCP invariants,
  the v9 implementation-safety invariants after their deliberate rewrite,
  `test_job_deadline_scope`, state-guard, roster and usage-ledger invariants,
  `test_autonomy_evidence_status`, `test_auto_merge`, plus the operator-
  feedback suites: 345 passed. `test_merge_authority_pre_merge_perimeter.py`
  with both new predicates live on the same fixture: the perimeter passes
  `cycle_and_turn_budget_cap` with three admitted turns and refuses it with
  `implementer_turn_budget_exhausted` after the eleventh.
- **Open for the operator:** N=10 is the contract as written and is one
  literal (`turn_budget.IMPLEMENTER_TURN_BUDGET`); a real implementation that
  edits, runs its tests and commits will spend Bash turns on each test run,
  so the first native implementer trial will show whether 10 is a cap or a
  wall. Raising it is a policy decision, not a code shape change.
