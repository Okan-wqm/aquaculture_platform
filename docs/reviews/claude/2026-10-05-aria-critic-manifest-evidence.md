# ARIA completeness critic cites the state store (2026-10-05)

Context: the first live plan, `plan-cyc-20261004T073028Z-auto` (F-007, operator request
OP-F007-20261004-1), passed its round-1 challenger and cross_review. Its coverage verdict was
`covered_with_waivers`, so the drainer minted a completeness critic to adjudicate the waivers. The
plan then closed HUMAN_REQUIRED without a round-2 revision, an implementation or a PR.

Owner: claude (implementation), okan (review). Deadline 2026-10-12.

## ARIA-HIGH-354

Measured from `origin/aria/state` (read-only):

- Cycle 37240283596 (`cyc-20261005T002109Z-auto`, strict profile) minted
  `AIR-aria-completeness-critic-50b9dd4a19e8` at 01:40Z. Its `evidence_refs[0]` is
  `tools/coverage/plan-cyc-20261004T073028Z-auto-r1.json`.
- Executor 37245553509 claimed it at 03:22Z. The result was recorded `rejected` at 03:23:54Z with
  `agent_evidence_path_missing` and `agent_evidence_not_repo_verified` on that one ref.
- Cycle 37276160945 recorded `plan_evaluated` at 08:54:16Z: `terminal_state: HUMAN_REQUIRED`,
  `reason_codes: ["convergence_envelope_dead:completeness_critique"]`, round 1.

Evidence (at `main@beb2d408d`):

- `aria-kernel/aria_kernel/plan_coverage.py:297`: the closure manifest is written to the state
  store, and its path is spelled `<tools root name>/coverage/<plan>-r<N>.json`. On the runner the
  store root is `.aria-state-store/tools`, so the path reads `tools/coverage/...`. That looks like a
  repository path, but the repository has no `tools/coverage/`.
- `aria-kernel/aria_kernel/convergence_drainer.py:887`: the critic envelope's evidence refs were
  `[closure_manifest_path, *current_refs]`.
- `aria-kernel/aria_kernel/cross_review_bridge.py:399`: the critic prompt told the agent to verify
  the manifest hash "on disk". The agent cannot do that, because the manifest is not in the
  repository it reads.
- `aria-kernel/aria_kernel/evidence_validator.py:498`: the submit law judges every cited ref against
  the repository, so the store path is refused.
- `aria-kernel/aria_kernel/plan_coverage.py:79`: every synthetic `coverage_gap` risk cites the same
  store path. A round-2 planner that cites the risk it addresses would be refused the same way.
- `aria-kernel/aria_kernel/agent_invocations.py:1368`: the mint accepted any non-empty string as an
  evidence ref. The disagreement could only surface after the paid run.

This is the fourth instance of one class: the mint side and the law side of the kernel disagree
about what an agent may cite. The earlier instances are ARIA-HIGH-243 (queue marker), ORPHAN-708
(human-required pointer) and ARIA-HIGH-194 (self-output-only planning envelope).

Rule: the kernel hands an agent only evidence refs its own submit law admits. A state-store record
reaches a non-arbitration agent as a ledger pointer, bound by the envelope that carries it. It is
never handed over as a repository-shaped path. The request mint refuses a state-store path for every
non-arbitration role.

Fix (branch `fix/aria-critic-envelope-repo-evidence`):

- `evidence_validator.coverage_manifest_pointer` names a manifest `coverage-manifest:<plan>-r<N>.json`
  under one strict grammar. `_is_ledger_pointer_ref` admits it the way it admits a human-required
  pointer. The response law refuses a cited coverage pointer that the answered envelope does not
  carry (`agent_evidence_pointer_unbound`). The manifest's bytes stay bound by the hash the
  coverage event and every waiver obligation carry.
- `issue_completeness_critic_envelope` takes `closure_manifest_path` and puts the pointer first
  itself. Callers pass only the plan's repository refs. The prompt tells the critic how to cite the
  manifest and no longer sends it to a file the repository does not hold.
- `build_synthetic_risk` cites the pointer.
- `create_agent_invocation_request` refuses, for every role outside `ARBITRATION_ROLES`, an evidence
  ref that resolves to a file in the state store (`request_evidence_state_store_record`). In the
  2026-10 request ledger (158 rows), the critic envelope above is the only producer of such a ref.
  The kernel suite found a second producer that has never fired live:
  `goldset.dispatch_goldset_curation` cited `aria-tools/goldsets/proposals.jsonl`. The curator's
  checkout does not hold that file, so the curator could see only the corpus counts. Its envelope
  now cites the gold items' own repository evidence and lists the items in the prompt as DATA.
- `agent_invocations._FUSED_ENVELOPE_KEYS` carries `evidence_scope` and `predecessor_rejection`.
  The renderer prints both, so a claim response without them would fail its own prompt-hash
  binding on every envelope that carries them (`test_claim_envelope_binding`).
- `aria-kernel/tests/test_critic_manifest_evidence.py` replays the live layout: a store root named
  `tools` beside a committed repository. An answer citing every ref of the minted critic envelope
  passes the submit law.

Not done here: the F-007 plan stays HUMAN_REQUIRED. Re-opening it is an operator act on the
operator lane after this merges.

## ARIA-HIGH-355

Fixing ARIA-HIGH-354 alone would not have saved the plan. The drainer could not read an answered
critic, whatever the answer was.

Evidence (at `main@beb2d408d`):

- `aria-kernel/aria_kernel/convergence_drainer.py:669`: `_ensure_envelope` raised `_EnvelopeDead`
  on any prior request that was not PENDING, CLAIMED, REQUEUED or STALE. ACCEPTED is not in that
  set.
- `aria-kernel/aria_kernel/convergence_drainer.py:878`: the critic step called `_ensure_envelope`
  before `_read_critic_result_once`. An accepted or refused critic raised first.
- `aria-kernel/aria_kernel/convergence_drainer.py:1262`: `_EnvelopeDead` forced the plan
  HUMAN_REQUIRED.
- `aria-kernel/aria_kernel/plan_round_controller.py:114`: the CLI round controller minted a
  successor with `remint_of` lineage when a planner request died of queue mechanics (Y3,
  ORPHAN-703). The drainer, the producer every cycle runs, had no such rule.
- `aria-kernel/aria_kernel/plan_coverage.py:149`: `adjudicate_waivers` already fails an
  unadjudicated waiver closed to `gaps`. The drainer never reached it.
- `aria-kernel/tests/test_convergence_resumable_step.py:739` pinned the defect: it asserted that
  a dead envelope is never minted again.

Two producers disagreed about one step, and the stricter one ran every cycle. A refused answer
from a planning-round agent is a fact about that answer, such as a citation the law refuses or a
malformed matrix. It is not a fact about the plan.

Rule: a planning step's requests are judged by one rule that every producer shares.

- Wait for a live request.
- Read an answered, annotation-only request.
- Mint a successor for a request that died of queue mechanics, or whose planning-round answer was
  refused. The successor carries `remint_of` lineage and the refusal's reasons, within a per-step
  budget.
- Escalate only an outcome no successor can change, or a spent budget.
- An exhausted critic fails closed to `gaps`; it never kills the plan.

Fix:

- `aria_kernel/step_request.py` holds the rule (`step_request_disposition`: `absent`, `live`,
  `remint`, `outcome`, `exhausted`; `MAX_STEP_REQUEST_REMINTS = 2` per step, shared by both causes).
  The drainer and the round controller both call it.
- The drainer reads an ACCEPTED critic and folds it into the coverage verdict. A refused or dead
  critic is minted again within the budget. An exhausted one leaves every waiver unadjudicated, so
  `adjudicate_waivers` turns it into `gaps` and the plan moves to round 2.
- `create_agent_invocation_request` copies the predecessor's refusal codes into
  `predecessor_rejection` on the successor row. The prompt renders it as a DATA block, so the next
  attempt is told what to correct.
- Tests: `test_critic_answer_folds_into_coverage.py` (accepted, refused, exhausted critic) and
  `test_convergence_resumable_step.py` (the old pin is inverted: a dead planner envelope is
  minted again with lineage, up to the budget).

## ARIA-HIGH-356

Measured on `main`: every `aria-readiness-claim` run that met the executor's held lease failed at
"Acquire the aria/state writer lease" with exit 3 after its 300 s wait (for example runs
37249919142 and 37259375696). The step was written to yield green in that case.

Evidence (at `main@beb2d408d`):

- `.github/actions/restore-aria-state/action.yml:177`: the acquire ran as a bare command. GitHub
  runs `shell: bash` as `bash -eo pipefail`, and the step's own `set -uo pipefail` does not lift
  errexit.
- `.github/actions/restore-aria-state/action.yml:182`: `LEASE_EXIT=$?` was never reached on a
  non-zero exit, so the yield branch was dead code.
- `aria-kernel/tests/test_state_single_writer.py:757`: the pin read the YAML as text, and a dead
  branch satisfies a text match.

Rule: a workflow step that branches on a command's exit code captures that code where errexit does
not apply. The branch is pinned by running the step's script under GitHub's flags, not by reading
its text.

Fix: `|| LEASE_EXIT=$?` on the acquire, with `LEASE_EXIT=0` before it.
`aria-kernel/tests/test_restore_action_lease_yield.py` extracts the step's script from the action,
replaces the kernel call with a stub that exits with each verdict code, and runs it under
`bash --noprofile --norc -eo pipefail`. On `main` the held-lease case exits 3. With the fix it
exits 0 and writes `writer_lease=yielded`. A refusal without a holder, and an unreadable verdict,
stay red.

## ARIA-HIGH-357

The F-007 round-1 cross_review (`AIR-aria-cross-reviewer-d231ca154c99`) raised CR-005 as
material. The challenger derived the leave-status options by importing the hr-service entity
(`apps/hr-service/src/leave/entities/leave-request.entity.ts:18`) into the web module. That pulls
TypeORM and `@nestjs/graphql` into the hr-module graph. The contract the web module actually
consumes is the generated GraphQL type `LeaveRequestStatus` at
`web/shared-ui/src/generated/graphql-types.ts:8679`. hr-module imports shared-ui, but shared-ui
is not in the plan's write closure, so no planner could cite it.

Evidence (at `main@beb2d408d`):

- `aria-kernel/aria_kernel/evidence_validator.py:713`: the response law's citable globs were
  `request.allowed_scope`, the same set that bounds writes.
- `aria-kernel/aria_kernel/plan_round_scope.py:107`: a planning round's reach and `allowed_scope`
  are the admitted surfaces, closure roots and policy pins. Nothing names what the changed
  projects import.
- `aria-kernel/aria_kernel/impact_graph.py:69`: `plan_downstream_impact` computed only the
  reverse closure.
- `aria-kernel/aria_kernel/plan_origin.py:243`: admission scope v2 had no field for read-only
  roots.

What an agent may cite and what a body may write are two scopes, and the kernel had one set for
both. ADR-0021 bounds writes, and it should. It never meant to blind planners to the contracts
their change consumes.

Rule: a planning-round envelope carries a read-only evidence scope. It covers the roots of the
projects the admitted surfaces import, and the response law admits citations inside it. The write
bound stays the closure (ADR-0021 D9).

Fix:

- `impact_graph.plan_downstream_impact` records `upstream_projects` and `upstream_project_roots`.
  These are the projects the changed ones import directly, minus the closure. One hop is enough,
  because that is where a consumed contract is declared.
- `plan_origin.compute_admission_scope` writes schema version 3 with `dependency_roots`: the
  upstream roots that are not already under a closure root. `validate_admission_scope` accepts
  versions 1 to 3. It refuses a malformed `dependency_roots`, and it refuses the field on a version
  1 or 2 record.
- `plan_round_scope.PlanRoundContract.evidence_scope` is `<root>/**` for each dependency root. The
  mint writes it as `evidence_scope` on every planning-round envelope and renders it in the prompt.
- `evidence_validator` admits a citation that matches `allowed_scope` or `evidence_scope`.
  `allowed_scope`, `implementation_allowed_scope` and `revision_scope_exceeds_admission_closure`
  do not read `evidence_scope`, so a body still cannot write there.
- `aria-kernel/tests/test_plan_dependency_evidence_scope.py` builds an hr-module plan that imports
  shared-ui. A citation in shared-ui is admitted. A key change that writes there is refused at
  submission. A version-2 record validates and grants no evidence scope. A version-2 record that
  names `dependency_roots`, or a version-3 record with a non-canonical root, is refused.

Not done here: the F-007 plan stays HUMAN_REQUIRED. Its stale reference (`LeavesPage.tsx:355`; the
options now sit at `:382-396`) is corrected in the new operator request that restarts it after
this merges.
