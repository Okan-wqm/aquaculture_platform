# ARIA — the L1 merge lane, reviewed end to end (2026-09-26)

Context: after plan 034 (merged in #1672 and #1673) and the first unit of plan 036, four independent
read-only reviews checked whether the L1 chain can actually complete, and whether the merged code is
sound. It cannot yet: five independent defects each stop every merge attempt, and three defects in
merged code let an unreviewed ARIA merge reach paths it must never reach. The plan that closes them
is
`docs/aria/plans/037-merge-lane-review.md`. Operator decisions of 2026-09-26: a required merge queue
instead of strict up-to-date protection; operator approval proven by a GitHub act of the operator's
account; findings outside L1 still produce pull requests, marked for human merge; closure PRs are
squash-merged by Claude on the operator's instruction once CI is green.

Owner: claude (implementation), okan (review, operator steps). Deadline 2026-10-31.

## ARIA-CRITICAL-214

A rename is classified by its new path only, so a code-owned file renamed into docs/ is lane L1 and
ARIA may delete it unreviewed.

Evidence: risk_policy.py:264-272 one path per file; gh pr view --json files and git diff --name-only
show the new name only. Files: `aria-kernel/aria_kernel/risk_policy.py`,
`aria-kernel/aria_kernel/github_adapters.py`.

Rule: Every path a change removes or adds is classified, including the source of a rename.

## ARIA-CRITICAL-215

L1 contains the repository's CI gate suites and contract inputs (e2e/tests/integration,
tools/lint-gates, \*\*/invariants, openapi yaml), so a gate can be weakened by an unreviewed ARIA
merge.

Evidence: `risk-policy.json` L1 globs `**/*.spec.ts`, `**/test_*.py`, `tests/**`; 69 files under
e2e/tests classify L1. Files: `docs/aria/policy/risk-policy.json`,
`aria-kernel/aria_kernel/risk_policy.py`.

Rule: The unreviewed lane is an explicit allowlist that excludes every file a required check
executes or reads as expected values.

## ARIA-CRITICAL-216

Operator approval references prove no operator act: `gov:<id>` accepts any governance event including
ARIA's own, `review:<path>#<x>` accepts any file containing the text.

Evidence: operator_approval.py:48-73. Files: `aria-kernel/aria_kernel/operator_approval.py`.

Rule: An authority grant is proven by an act the governed system cannot author.

## ARIA-HIGH-217

The merge lane checks out main, so the pre-merge perimeter (committed snapshot base == PR head,
branch tip lock) can never pass and expert-review requests are never created.

Evidence: aria-merge-runner.yml:53-55; merge_authority.py:527; implementation_safety.py:2113;
expert_review_gate.py:124-138. Files: `.github/workflows/aria-merge-runner.yml`,
`aria-kernel/aria_kernel/merge_authority.py`, `aria-kernel/aria_kernel/implementation_safety.py`.

Rule: A lane runs in the workspace shape the gates it calls require.

## ARIA-HIGH-218

Rollback bundle and retention proof files are written by the claim lane but are not declared
surfaces, so they are never published and the merge verifier cannot re-hash them.

Evidence: readiness_proofs.py:~586-600; enterprise_readiness.py:892-896,1123. Files:
`aria-kernel/aria_kernel/readiness_proofs.py`, `aria-kernel/aria_kernel/state_manifest.py`,
`aria-kernel/aria_kernel/enterprise_readiness.py`.

Rule: Evidence a gate verifies in another lane is published with a verifiable reference.

## ARIA-HIGH-219

A readiness claim expires five minutes after minting (the CAS lease) and a claim id is fixed per PR
and head, so a head whose CI finishes later can never merge.

Evidence: autonomous_host_lease.py:68,252; enterprise_readiness.py:448,554-558,778;
readiness_proofs.py:1075. Files: `aria-kernel/aria_kernel/readiness_proofs.py`,
`aria-kernel/aria_kernel/enterprise_readiness.py`,
`aria-kernel/aria_kernel/autonomous_host_lease.py`.

Rule: A durable claim carries no lease expiry; mutual exclusion is taken at the point of merge.

## ARIA-HIGH-220

The merge runner has no id-token: write so its attestation is never platform-verified, and
attestation rows are keyed by (pr, head, claim) only, so any host can reuse another host's row.

Evidence: runner_attestation.py:62-89,133-143,183-186,267-272. Files:
`.github/workflows/aria-merge-runner.yml`, `aria-kernel/aria_kernel/runner_attestation.py`.

Rule: An attestation binds the run that acts and is re-measured by that run at the point of action.

## ARIA-HIGH-221

Under strict branch protection an ARIA PR can merge only if main has not moved, because every piece
of merge evidence is pinned to the implementation head and base; nothing updates the branch.

Evidence: preflight.py:136-140; auto_merge.py:535; merge_authority.py:949,1010-1026. Files:
`aria-kernel/aria_kernel/merge_authority.py`, `aria-kernel/aria_kernel/auto_merge.py`,
`aria-kernel/aria_kernel/preflight.py`, `aria-kernel/aria_kernel/readiness_proofs.py`.

Rule: The merge model tests the change against current main without invalidating the evidence bound
to the change (operator decision 2026-09-26: required merge queue).

## ARIA-HIGH-222

Aria/state publish is single-attempt in every lane, so a lane that loses the fast-forward race drops
its rows (a lost merged row blinds self-revert), and the global readiness-claim concurrency group
silently drops claims.

Evidence: state_store.py:2002-2043 publish_with_contention_replay has no caller;
aria-readiness-claim.yml:27-29. Files: `aria-kernel/aria_kernel/state_store.py`,
`.github/workflows/aria-readiness-claim.yml`.

Rule: A lane's recorded facts survive a publish race; no claim is dropped by concurrency.

## ARIA-HIGH-223

The autonomy unlock 72-hour continuity rule applies to every consecutive pair of success rows
forever, so any later success row more than 72h after burn-in permanently invalidates L1.

Evidence: autonomy_unlock.py:38-43,143-152. Files: `aria-kernel/aria_kernel/autonomy_unlock.py`.

Rule: An unlock rule measures the window it was designed for.

## ARIA-MEDIUM-224

Path handling: normalize_repo_relpath keeps '.', '' segments and rewrites backslashes; CODEOWNERS
directory patterns without a trailing slash are matched as files; is_self_output_ref reads raw text;
codeowners_lane may be L2.

Evidence: canonical_path.py:94-102; risk_policy.py:209-234. Files:
`aria-kernel/aria_kernel/canonical_path.py`, `aria-kernel/aria_kernel/risk_policy.py`,
`aria-kernel/aria_kernel/evidence_trust.py`.

Rule: One canonical path form and GitHub's CODEOWNERS semantics.

## ARIA-MEDIUM-225

Adjudication panels: the principal is the minted target so one executor run on one model counts as
three principals; a contract-violating adjudicator is requeued forever as a harness fault.

Evidence: independence_check.py:88-95,226-247; agent_invocations.py:2412. Files:
`aria-kernel/aria_kernel/independence_check.py`, `aria-kernel/aria_kernel/agent_invocations.py`.

Rule: Independence is measured on the executing route; every retry path is bounded.

## ARIA-MEDIUM-226

Merge-lane grant and merge runner defects: non-UTC expiry stored shifted, grant not validated on
read, runner/adapter selection disagree with merge_authority_available, merged result unchecked,
closed PRs evaluated, check runs not paginated, audit lacks grant fields.

Evidence: runtime_profile.py set_merge_lane_grant strftime on aware non-UTC; auto_merge.py:846.
Files: `aria-kernel/aria_kernel/runtime_profile.py`,
`aria-kernel/aria_kernel/auto_merge_runners.py`, `aria-kernel/aria_kernel/merge_authority.py`,
`aria-kernel/aria_kernel/auto_merge.py`.

Rule: One predicate answers may-this-lane-merge and every external result is checked.

## ARIA-MEDIUM-227

Freeze and grant can deadlock (revert PR not covered by merge authority, no HUMAN_REQUIRED), and the
freeze reaches the merge lane only when the cycle publishes hours later.

Evidence: self_revert.py; self_merge_freeze.py. Files: `aria-kernel/aria_kernel/self_revert.py`,
`aria-kernel/aria_kernel/self_merge_freeze.py`.

Rule: A freeze that stops merging is visible immediately and always names its way out.

## ARIA-MEDIUM-228

Self-revert partial failures are not recovered (push without PR, PR without registration, killed
job), path-filtered reds are never attributable, parse refusals are retried forever, the revert
commit is not reproducible under ambient git config.

Evidence: self_revert.py \_attribution, \_create_pull_request, register ordering. Files:
`aria-kernel/aria_kernel/self_revert.py`.

Rule: An autonomous producer resumes every partial effect it can leave behind.

## ARIA-MEDIUM-229

Adapter promotion precision counts judgments of findings the current adapter version no longer
emits, so a fixed adapter stays below the gate (doc-staleness reads 0.41 after reaching 1.0 on
labelled rows).

Evidence: tool_health.compute_metrics. Files: `aria-kernel/aria_kernel/tool_health.py`,
`aria-kernel/aria_kernel/readiness.py`.

Rule: A promotion gate measures the version being promoted.

## ARIA-MEDIUM-230

Raw-findings publish has no bound below the 100 MB host limit and compaction failures are swallowed;
a negative --limit bypasses the backfill guard; cycle_guard reports a non-empty cycle empty on a
stale identity.

Evidence: state_snapshot.py:74; cycle.py:910-929; report_ingestion.py:59,102; cycle_guard.py:54-57.
Files: `aria-kernel/aria_kernel/state_snapshot.py`, `aria-kernel/aria_kernel/cycle.py`,
`aria-kernel/aria_kernel/report_ingestion.py`, `aria-kernel/aria_kernel/cycle_guard.py`.

Rule: Every published surface is bounded below the host limit and every guard rejects out-of-domain
input.

## ARIA-MEDIUM-231 — `change_validated` attests more than the tip

The row attests the staging baseline runs recorded at `base_sha` together with the tip's runs, and a
refused `change_validated` still lets the PR open.

Evidence: validation_runs_ledger.py:580-589; apply_engine.py:746-750;
implementation_delivery.py:612-625. Files: `aria-kernel/aria_kernel/validation_runs_ledger.py`,
`aria-kernel/aria_kernel/implementation_delivery.py`.

Rule: A validation row attests exactly the committed tip.

## ARIA-MEDIUM-232 — The charter and plans state false things

M-6.1 (pinned by a test) says there is no unreviewed self-merge, while L1 is unreviewed by design and
merge-lane grants exist; plan 034's status and operator steps are stale; BEHAVIOUR, CURRENT_STATE and
layer-1 omit the merge runner, the grant, the freeze and self-revert.

Evidence: MISSION_SPEC.md:213-219; test_nightly_profile_authority_contract.py:806-828. Files:
`docs/aria/MISSION_SPEC.md`, `docs/aria/plans/034-e2e-chain-closure.md`, `docs/aria/BEHAVIOUR.md`,
`docs/aria/CURRENT_STATE.md`.

Rule: The documents of record describe what the code does.
