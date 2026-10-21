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

**Landed (landing L3, bucket `G016-215-L1`).** The three whole-tree entries
`{apps,libs,web}/**/__tests__/**` became `{apps,libs,web}/**/__tests__/**/*.{spec,test}.{ts,tsx}`
(status A), and `_validate_l1_lane` refuses an L1 entry with any brace alternative whose last
segment holds `**`, `{` or `}` or lacks a test or prose suffix (`L1_FILE_SUFFIXES`), so the old
policy is refused at load. `canonical_path.expand_repo_glob` is the one brace expander. The matcher
is DOTALL with `\Z` and `normalize_repo_relpath` refuses control characters, so a newline-named path
can no longer slip past a deny glob into L1. Measured over 19,442 (status, tracked path) pairs: 0
paths widen, 20 support files move from L1 to L2. `test_risk_policy_l1_lane.py`,
`test_risk_policy_change_status.py` and `test_repo_path_canonical_form.py` were red before and are
green after.

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

## ARIA-HIGH-234 — The kernel's own git calls inherit ambient git config injection

`git_containment._publish_environment` copies the process environment minus the `GIT_DIR`
family, so `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` / `GIT_CONFIG_PARAMETERS`
reach the publication's ref writes and the delivery's push. A CI step can carry
`AUTHORIZATION: basic` in `GIT_CONFIG_VALUE_0`, so a delivery that mints no credential pushes
under the job's identity, and `url.*.insteadOf` can send the push elsewhere. `validation_env`
and `self_revert` already strip the triple; this path did not.

Evidence: `git_containment.py:667-672`; the delivery test's fake git saw `GIT_CONFIG_KEY_0` and
`GIT_CONFIG_VALUE_0` on a host that sets them. Files: `aria-kernel/aria_kernel/git_containment.py`,
`aria-kernel/aria_kernel/implementation_delivery.py`.

Rule: A push carries exactly the identity the kernel chose for it; ambient git configuration never
reaches the kernel's own git calls.

## ARIA-MEDIUM-235 — Self-revert judges its merge authority on bare paths

`self_revert._patch_id` reduced the revert diff's `(status, path)` pairs to a sorted path set, and
`revert_merge_authority` passed bare paths to `risk_policy.classify_change`. L1 admits a path only
under an allowed git status, so every revert classified `risk_change_status_unknown` and opened
awaiting a human merge; 24 tests in `test_self_revert.py` failed on the integration branch.

Files: `aria-kernel/aria_kernel/self_revert.py`, `aria-kernel/aria_kernel/risk_policy.py`.

Rule: Every reader of a change's lane reads each path under the git status the change gives it.

## ARIA-MEDIUM-236 — A retried delivery re-validates an already validated change

A delivery refused after `change_validated` is retried at the same tip; the retried apply gate's new
runs changed the attested refs, and `emit_change_validated` refused the second row as
`change_validated_content_drift`. Closed as a duplicate: 277141d80 (ARIA-MEDIUM-231) makes the refs
one ok run per command at the committed tip, so a retry writes identical content.

Files: `aria-kernel/aria_kernel/implementation_delivery.py`,
`aria-kernel/aria_kernel/validation_runs_ledger.py`.

Rule: An immutable chain row is written once; a retry reuses it.

## ARIA-HIGH-237 — A run's findings were appended one row at a time

`record_raw_findings_for_run` called `append_jsonl` once per finding, and every declared append
verified the whole hash chain and read the whole file first: 2.39 s per finding on aria/state's
57.5 MB `raw-findings.jsonl`. With lint-rules-adapter (about 5,575 findings per run) the tools phase
outgrew its 14,959 s budget, and every `aria-auto-cycle` run from 179 to 184 died with
`PhaseDeadlineExceeded`.

Files: `aria-kernel/aria_kernel/feedback_store.py`, `aria-kernel/aria_kernel/ledger.py`,
`aria-kernel/aria_kernel/calibration_bootstrap.py`.

Rule: A producer's cost is proportional to what it writes, not to the ledger's size times its rows.

## ARIA-HIGH-238 — Operator approvals that nothing verifies

Unit O moved the grant, unfreeze, profile and promote surfaces to approvals proven by the
operator's GitHub act. About 25 other kernel modules (for example `self_modification`,
`autonomous_host_lease`, `cost_budget`, `circuit_breaker`, `agent_genesis`, `proposal`) still take
`operator_approval_ref` as a free string and never call `operator_approval.verify_operator_approval`.
Owner okan, deadline 2026-10-31.

Rule: Every operator approval is proven by the operator's own GitHub act; a ref no one verifies is
not an approval.

**Landed (ARIA order chain, `G010-238-pin-breakers`; slices 1-2, Part of).** The four verbs that
clear a stop no longer take a free string. Each one verifies an operator's GitHub act, bound to the
instance it undoes and spent once:

- `circuit_breaker.reset_breaker` and `cost_budget.reset_breaker`: `surface=breaker_reset`, scope
  `breaker` and `tripped_at`.
- `circuit_breaker.quarantine_breaker_evidence`: `breaker_evidence_quarantine`, same scope.
- `mcp_client.release_quarantine`: `mcp_unquarantine`, scope `server` and `quarantined_at`.

Each verb's `--print-approval-line` prints the line to post for the current instance.
`aria-kernel operator check-ref` is now the only grammar check a workflow runs. The executor's
free-string regex and the auto-cycle's regex copy are gone, and
`tests/invariants/aria-approval-ref-grammar-owner.spec.ts` keeps them gone.
`test_operator_approval_callers.py` pins the whole population: every function with an
approval-reference parameter, plus every verifier caller. Each one is classified and checked
against rules P1-P5. `control.record_control`, `agent_genesis.approve_agent_pr` and
`skill_genesis.approve_skill_pr` are strict `UNVERIFIED_UNTIL` entries.

Still open: slices 3-4 (control resume, the gateway's `approval_ref`, genesis PR approval). They
belong to wave-3 bucket `G010-238-control-genesis`, deadline 2026-10-31. The residuals are
registered as ARIA-MEDIUM-664, ARIA-MEDIUM-665, ARIA-LOW-666, ARIA-LOW-667, ARIA-MEDIUM-668,
ARIA-LOW-669 and ARIA-LOW-670.

## ARIA-HIGH-234 — closed (2026-10-10, wave 2)

The push leg was fixed by #1676: `git_containment._publish_environment` stripped the ambient
triple. Two seams still handed the ambient set to a child.

- **`gh pr create`.** `pr_manager.py` built
  `create_env = {**os.environ, **command_environment}`. The named test,
  `test_implementation_delivery::test_a_lane_that_cannot_mint_at_the_push_is_refused_at_the_credential_stage`,
  run with the triple set, failed at its `gh` assertion
  (`docs/reviews/claude/2026-10-10-aria-adapter-sandbox.md`). This is also the create that
  `self_revert` opens its PR through.
- **The self-revert push and its PR lookup.** `self_revert.py` built
  `{**os.environ, **credential_env}`. The credential's own `GIT_CONFIG_COUNT=1` hid
  `KEY_n`/`VALUE_n` for n ≥ 1, but an ambient `GIT_CONFIG_PARAMETERS` (git's `-c` export, which
  git honours) still reached a kernel push.

Four modules each named these variables themselves:

| Module                    | What it named                                             |
| ------------------------- | --------------------------------------------------------- |
| `git_containment`         | `COUNT`, `PARAMETERS`, `KEY_*`, `VALUE_*`                 |
| `self_revert`             | `COUNT`, `PARAMETERS`, `KEY_*`, `VALUE_*` (and identity)  |
| `implementation_identity` | the same plus plain `GIT_CONFIG` (and location, identity) |
| `delivery_credentials`    | spelled its own triple by hand                            |

`validation_env` holds no copy: it builds the child's environment from an allowlist that admits
only git's config-file redirects (`GIT_CONFIG_GLOBAL/SYSTEM/NOSYSTEM`).

### Fix (tier 1 by construction, tier 3 for a second list)

`git_containment` owns env-borne git configuration in both directions:

- `without_ambient_git_config(environ)` strips `GIT_CONFIG`, `GIT_CONFIG_COUNT`,
  `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_KEY_*` and `GIT_CONFIG_VALUE_*`.
- `git_config_environment(entries)` spells the kernel's own configuration.

The consumers:

- `_publish_environment`, `pr_manager`'s `create_env`, and `self_revert`'s push and lookup
  environment and revert-commit environment build on `without_ambient_git_config`. The caller's
  chosen credential and helper configuration are laid over it.
- `implementation_identity.commit_identity_environment` builds on it too. Its location and
  identity lists stay its own: they are not configuration.
- `delivery_credentials.GIT_CREDENTIAL_HELPER_ENV` is spelled through `git_config_environment`.
  Its value is unchanged (pinned).

The one semantic difference between the copies was plain `GIT_CONFIG` (only
`implementation_identity` stripped it). It is kept, in the one list. git 2.43 honours it only in
`git config`: `git var GIT_AUTHOR_IDENT` ignored a `GIT_CONFIG` file naming a user, and
`git config user.name` read it. So stripping it is inert for every other call and closes the
redirect for that one.

`tests/invariants/test_git_config_env_single_owner.py` fails any production module (`aria_kernel`,
`tools/aria-poc`, `tools/aria`) except `git_containment` that has a string literal naming one of
these variables, including the literal part of an f-string.

### Evidence

Every consumer is tested with the full ambient set (`tests/_helpers/ambient_git_config.py`: the
triple with a header and a url rewrite, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG`):

- **`gh pr create`**: the named test, its second leg run under the ambient set. The fake `gh`
  records every `GIT_CONFIG*` name except the three file redirects. Red before: `gh` saw 7
  injected names. Green after: exactly `["GH_TOKEN"]`.
- **self-revert**: `test_self_revert::test_the_revert_push_lookup_and_pr_carry_no_ambient_git_config`.
  Red before: the push carried `GIT_CONFIG_PARAMETERS`, `KEY_1`/`VALUE_1` and `GIT_CONFIG`.
  Green after: the push, `gh pr list` and `gh pr create` carry exactly
  `GIT_CREDENTIAL_HELPER_ENV`, and the revert commit carries none.
- **publication and push**: `test_git_containment::PublishEnvironmentTests`. Red before on
  `GIT_CONFIG`.
- **identity check**: `test_implementer_commit_identity::test_no_ambient_git_config_reaches_the_check`.
  Green before too; it characterises the move.
- **validation child**: `test_validation_env::test_no_injected_git_config_reaches_the_child`. Green
  before too; it proves the allowlist holds no copy.
- **single owner**: `test_git_config_env_single_owner`. Red before: 12 offenders, starting at
  `delivery_credentials.py:108`.

Runs on `21e4b80e8` + this change:

- Snapshot (owner files): `test_git_containment`, `test_implementation_delivery`,
  `test_implementation_identity_hold`, `test_implementer_commit_identity`,
  `test_pr_manager_provenance`, `test_self_revert`, `test_validation_env` and the new invariant
  all pass. `test_executor_implementation_identity`: 24 passed.
- Worktree (needs `node_modules`): the targeted tests above, `test_implementer_commit_identity`,
  `test_validation_env` and `test_pr_manager_e2e`: 82 passed.

### Not changed here (recorded for the registry decision)

Other `gh` writes still build their child's environment from the ambient one:

- `github_writes.run_gh_write` with `env=None`, used by the merge adapter, the issue writer and the
  scheduler;
- `pr_branch_update.py` (`{**os.environ, **credential.env}`);
- `merge_lane_merge_state.py` (`dict(os.environ)`);
- `gh_token_factory.py`'s token revoke.

None of them is a push or a `gh pr create`. In CI the triple is ambient only inside the
publish/restore/release steps' own `env`. The state publish's push deliberately uses that ambient
header as its credential, so a blanket strip of every kernel child would be wrong.
`pr_manager.push_prepared_branch` (the operator CLI's `pr push`, which no workflow invokes) pushes
under the operator's own shell configuration.
