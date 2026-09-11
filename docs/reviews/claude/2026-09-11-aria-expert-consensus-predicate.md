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
