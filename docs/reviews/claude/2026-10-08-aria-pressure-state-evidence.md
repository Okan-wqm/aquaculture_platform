# The most urgent pressure was unanswerable by construction (2026-10-08)

Context: since 2026-10-05, every `aria-autonomy-planner` request minted from a
`pipeline_stalled` pressure has been rejected. That is four of four:
`AIR-aria-autonomy-planner-70499fdb4f52`, `-e0677ef82cfc`, `-648a7566ae76` and
`-71ec6fd28072`, all for `pressure:pipeline-stalled:funnel-convergence-f-finding`. Every
rejection names the same ref:

```text
agent_evidence_ref_malformed       knowledge-graph/pressure-source-effectiveness.jsonl:f_finding
agent_evidence_path_missing        knowledge-graph/pressure-source-effectiveness.jsonl
agent_evidence_not_repo_verified   knowledge-graph/pressure-source-effectiveness.jsonl:missing
```

`pipeline_stalled` has weight 100 and severity critical: "every other pressure waits behind
it".

Owner: claude (implementation), okan (review). Deadline 2026-10-15.

## ARIA-HIGH-384

What the submit law refuses, the mint refuses. A kernel-minted envelope carries in
`evidence_refs` only refs an agent can cite back. Where a pressure came from travels as
provenance, never as evidence.

The chain on main:

- `pressure.run_pressure` named the stall's evidence
  `knowledge-graph/pressure-source-effectiveness.jsonl:<source_type>`. That is a tools-root
  state ledger, and its suffix is not a line number.
- `autonomy_orchestrator._drain_next_cycle_queue` copied `explain_pressure(...)["evidence"]`
  verbatim into the request's `evidence_refs`.
- The planner cites the envelope's refs, as its contract says. The submit law
  (`evidence_validator._judge_agent_ref`) grades every ref against the repository at
  `target_sha`, so no answer could pass.
- The mint guard in `create_agent_invocation_request` (ARIA-HIGH-354) refused only refs that
  parse and resolve into the state store. These refs do neither, so they minted.

The test that pinned the projection's refs claimed they were "concrete repo paths by
construction". Nothing enforced that, and one producer's comment called pressure evidence
"free-form by design". The live request ledger (`aria/state`,
`tools/agent-invocations/requests.jsonl`) shows the same class from more producers:

| Source               | Ref minted as evidence                          | Requests |
| -------------------- | ----------------------------------------------- | -------- |
| `own_pr_ci`          | `pr-<n>:<sha>`                                  | 9        |
| `uncertainty_repeat` | `aria-tools/memory/uncertainties.jsonl`         | 8        |
| `repo_pr_health`     | `pr-<n>:<head_ref>`                             | 4        |
| `pipeline_stalled`   | `knowledge-graph/...jsonl:<source>`             | 4        |
| `post_merge_ci`      | `pr-<n>:<merge_sha>`                            | 3        |
| missions             | `pr:<n>`, `branch:<name>` (`mission_reconcile`) | —        |

`contradiction` (`aria-tools/memory/contradictions.jsonl`) and `discovery_incomplete` (an
absolute store path) write the same class but minted no live requests.

Fix. The split already existed for plans: ORPHAN-HIGH-519 keeps a plan's origin in
`provenance_refs` and judges its `evidence_refs` with `admissible_agent_evidence_refs`. The
fix reuses both rather than adding a second rule.

- `evidence_validator.agent_ref_shape_refusal` is the part of the agent law that needs no
  checkout: grammar, repo-relative and not ARIA's own output. It returns the submit law's
  own codes.
- `pressure._pressure` refuses any evidence ref that fails that check, by name
  (`pressure_evidence_not_agent_citable`). It also takes a `provenance_refs` channel (tier 1).
  - Kernel-authored origins move to provenance: the effectiveness ledger, PRs and store
    files.
  - Refs a pressure reads off someone else's record (belief refs, tool read paths, runtime
    code refs, migration paths) are split by `pressure_evidence.split_citable_refs`.
- `funnel_health.FUNNEL_STAGES` declares each stage's owner code:
  - convergence: `convergence_drainer.py` and `plan_convergence.py`;
  - merge: `converged_delivery.py` and `auto_merge.py`.

  A stall cites its stage's owner code as evidence. `discovery_incomplete` cites
  `discovery.py`, which writes the proof. So the critical pressure is now answerable.

- The autonomy projection (`pressure_evidence.project_refs_for_agent`) hands the planner
  only the refs `admissible_agent_evidence_refs` admits at the envelope's `target_sha`. This
  applies to pressure items and mission items alike (tier 2).
  - The pressure's `reason`, its `provenance_refs` and every refused ref go into the prompt
    as data.
  - A stored payload from before this fix is judged the same way, so it can no longer mint.
  - If no ref is admitted, the item is disclosed as `next_cycle_queue_item_unevidenced`,
    with its refused refs and provenance.
  - If the only refusals come from a host that could not verify, the item stays pending
    (`next_cycle_queue_item_evidence_unverifiable`) instead of being spent.

Detection (tier 3): `aria-kernel/tests/test_pressure_evidence_citable.py`.

- It fires every source in `SOURCE_WEIGHTS`, and fails if a registered source does not fire.
- Every evidence ref must pass the shape law and be admitted by the full agent law at a
  committed tree, and every non-repo origin must ride as provenance.
- It replays the four rejected requests' payload through the drain.
- It checks that the shape law never refuses a relative ref the submit law would admit.
- It confirms the mission lane: `pr:<n>` and `branch:<name>` never reach `evidence_refs`
  (`test_service_mission_line.py`).

Against main's producers and projection it fails 21 checks (tests and subtests). With the fix it passes.

Not changed: the PR-sourced pressures (`own_pr_ci`, `post_merge_ci`, `repo_pr_health`),
`contradiction` and `uncertainty_repeat` have no repository anchor. A PR head is not the tree
at `target_sha`, and their ledgers record no code refs. Their queue items are now consumed
and disclosed as `next_cycle_queue_item_unevidenced`, with their provenance named. Before
this fix they minted requests no answer could satisfy.

## ARIA-MEDIUM-385

The mint itself does not yet refuse the class for every role. A role-wide refusal in
`create_agent_invocation_request` (using `agent_ref_shape_refusal`) was tried in this change. It
failed suites whose producers bind non-repo pointers in `evidence_refs` on purpose:

- `review_runner.py:301` and `specialist_review_runner.py:521` mint `cycle:<cycle_id>`
  (`test_gate_accepted_result_binding.py`);
- `decision_questioning.py:201` mints `plan:<plan_id>` (`test_decision_questioning.py`,
  `test_must_satisfy_shape.py`);
- ARIA-HIGH-194 (`agent_invocations.py:1426`) admits ARIA self-output beside a repo ref, and
  `test_planner_mint_self_output.py` pins that.

Each of these pointers has to move to its own channel, or become a ledger pointer the law binds
at mint (as `coverage-manifest:` does), before the role-wide refusal can land. No live request
in `aria/state` carries a `cycle:` or `plan:` ref as of 2026-10-08. Owner: claude. Deadline
2026-10-22.
