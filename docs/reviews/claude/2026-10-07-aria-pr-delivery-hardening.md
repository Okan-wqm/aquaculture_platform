# ARIA PR delivery after the implementer commits (2026-10-07)

Owner: claude (implementation), okan (review). Deadline 2026-10-14.

Scope: the path from the implementer's commit to a merged PR. It has never run live, and F-015
will be its first run. F-015 is a `ui_option_drift` finding on
`web/modules/hr-module/src/pages/leaves/LeavesPage.tsx` and
`apps/hr-service/src/leave/entities/leave-request.entity.ts`. Read-only evidence came from the
runner store (`.aria-state-store/findings/aria-findings/F-015.json`,
`tools/runtime-profile.json`) and from the live branch protection of `main`.

Measured on 2026-10-07:

- `main` protection: `required_status_checks.strict: true`, with four required contexts
  (`sens-enterprise-summary`, `merge-gate`, `aria-merge-authority`, `build-status`).
- No merge queue (`mergeQueue: null`), and `allowUpdateBranch: false`.
- Live ARIA profile: `strict` (`merge_lane_grant: null`).

## ARIA-HIGH-371

The push ran before the pre-PR-open checks.

`implementation_delivery.deliver_implementation` minted the credential and pushed the branch, and
only then called `pr_manager.open_pr_for_action`. That call runs the `GATE_PRE_PR_OPEN` perimeter
(`commit_contract_honoured`, `pr_body_templating`, the secret scan and the rest). A refusal there
left a pushed `aria-impl-*` branch with no PR. No code deletes such a branch, and the requeue
collides on it (`implementation_branch_exists`).

F-015 is an F-origin plan. Its contract (`plan_origin.commit_contract_for_plan`) admits only
`refactor`, `test` and `chore` subjects, with no trailer. A natural `fix(hr-module): …` subject
was therefore refused after the push.

Fix:

- `pr_manager.prepare_pr_open` runs every check of the live open, with no external effect. It
  returns a `PreparedPrOpen`.
- `open_prepared_pr` opens the PR at the judged head. If the branch moved, it is refused by name.
- The delivery runs a new request-class stage, `pre_pr_open`, after `change_validated` and before
  `credential` and `push`.
- `open_pr_for_action` is now `prepare_pr_open` plus `open_prepared_pr`. Its dry-run preview is
  unchanged.

Was the envelope clear enough? No. The prompt section said only "No `Closes:` trailer … write
none" and listed the admitted types. Meanwhile the repository `CLAUDE.md` that the agent also
loads demands `fix(...)` plus `Closes:` for every fix. `render_commit_contract_section` now also
prints:

- the subject shape;
- the refused types (`fix`, `feat`, `security` for this origin);
- that the contract replaces the `CLAUDE.md` commit rule for these commits;
- one literal command.

Tests:

- `test_a_commit_the_plans_contract_refuses_is_refused_before_the_mint_and_the_push` runs the
  real delivery chain under bwrap. On origin/main code it fails with
  `the refused branch was pushed`: the remote pre-receive hook logged
  `refs/heads/aria-impl-5f30b4…`.
- `test_a_trailerless_section_names_the_refused_fix_subject_and_the_literal_command`.

## ARIA-HIGH-372

Nothing kept an ARIA PR branch up to date.

The branch is cut from the anchor commit and never updated. Under `strict` protection it is
`BEHIND`, and so unmergeable, from the first commit that lands on main. That happens hourly here.

Do ARIA PRs touch the registry? No. `docs/reviews/_registry/` is in
`implementation_safety.READONLY_PATHS`, the PR body is only text, and ARIA's commit trailers name
`docs/reviews/orphan-findings.md` (`merge=union`) or nothing. So the reconcile PR that makes other
PRs `DIRTY` on GitHub cannot conflict with an ARIA branch. The problem is limited to main
moving.

Fix: `pr_branch_update.update_behind_aria_prs` runs in `cycle._phase_pr_ci_scan`, the cycle's
single-writer window, with the scan's reader.

- Scope: PRs on an `aria-impl-*` branch that ARIA's own `pr-lifecycle.jsonl` says it opened.
- Trigger: GitHub reports `BEHIND`, and the head's checks have settled green.
- Never `DIRTY` or pending. A pending head would have its runs cancelled, and a red head is not
  mergeable after an update either.
- Call: GitHub's `update-branch` with `expected_head_sha`. This is the same merge as
  `git merge origin/main`. The repository's registry merge driver is not needed, for the reason
  above.
- Credential: the delivery path (`hold_delivery_credentials`, new consumer `pr_branch_update`,
  one hold per batch, minted only when a PR qualifies) through `run_gh_write`, which requires an
  installation token.
- Profile gate: the `pr_open` action.
- Bounds and idempotence:
  - at most 3 requests per cycle;
  - one request per `(pr, head, base)`, keyed by the external-effects intent;
  - a receipt that never came is answered from the head on the next pass.

Tests (`tests/test_pr_after_open.py`, 3 cases + wiring):

- one request per head and base, with the exact argv and the installation token;
- pending, red, `DIRTY`, `CLEAN` and foreign heads are never updated;
- a profile without `pr_open` moves nothing.

On origin/main code the module cannot load: `ModuleNotFoundError` for the update and surface
modules, because neither step exists there.

## ARIA-HIGH-373

A PR that needed a human merge was not surfaced. `web/**/src/**` and `apps/**/src/**` are lane L2
(`docs/aria/policy/risk-policy.json`). The opener added `aria:human-merge` and stopped there: no
HUMAN_REQUIRED record, no notification, no daily-report line.

Fix: `human_merge_surface.surface_human_merge_prs` runs after the update, with the same reader.
Each open ARIA PR that the merge lane cannot merge now gets one record, `human-merge-pr-<n>`
(MEDIUM, 7-day SLA).

The record's context carries:

- the PR URL;
- the CI state (`own_pr_delivery.ci_summary` over `statusCheckRollup`);
- `mergeStateStatus`;
- the reasons, from:
  - the recorded merge route;
  - `assert_merge_authorized` for the route's lane;
  - the head compared with the change ledger's delivered commit;
  - `DIRTY` or `BEHIND`.

Lifecycle:

- While the PR waits, the context is refreshed (`refresh_open_record_context`). The kind, reason
  and SLA are fixed.
- When GitHub reports the PR merged or closed, the record is resolved by
  `RESOLVED_BY_GITHUB_OBSERVATION`. This resolver is admitted only for the `human_merge_pr` kind.
- The daily report lists every such item in full, with URL, CI state and the reasons for not
  self-merging.

Tests: two cases, plus the cycle wiring. On origin/main code they fail with `ModuleNotFoundError`.

## ARIA-HIGH-374

Item 4 of the lane brief asked whether the merge lane would merge a green L1 ARIA PR under
`autonomous` and refuse otherwise.

What `merge_authority.merge_pr_if_ready` refuses, and where:

- No `pr_merge` authority and no grant: refused at entry (`assert_merge_authority_available`).
- A human-merge route or label: `human_merge_decision`.
- An uncovered lane: `assert_merge_authorized`.

For an L1 PR that is green and at the delivered head, every gate binds that head:

- the triple gate (`change_committed.commit_sha`);
- the native context (`observed.head_sha`, `committed.commit_sha`);
- `_join_pre_merge_implementation` (`branch_tip_sha`).

`aria-merge-authority.yml` is a required check that only runs the merge-authority test battery
on every PR. It does not decide a merge. The merge runs from `aria-merge-runner.yml`
(`merge-lane run`).

The break: `evaluate_auto_merge` never reads `mergeStateStatus`. Under strict protection, an L1
PR that is `BEHIND` reaches `gh pr merge --squash --match-head-commit`. GitHub refuses it, and
the lane records a `merge_failed` incident on every hourly run. After an update (ARIA-HIGH-372)
the head is no longer the delivered commit, so every self-merge gate refuses it.

Net effect: under `autonomous`, an L1 ARIA PR merges only if main did not move between the anchor
commit and the merge.

What is done here: the update never runs for a pending head, and ARIA-HIGH-373 names the
condition on the PR's record (`behind_base_under_strict_protection`,
`head_is_not_the_delivered_commit:…:ARIA-HIGH-374`). So a person sees it and merges.

Not done: the merge authority accepting a head that is a server-made update recorded by ARIA,
with a purity proof (`git merge-tree` of the recorded `(head, base)` equals the head's tree).
This touches the triple gate, the native merge context and the implementation join in
`merge_authority.py` and `auto_merge.py`, so it is a merge-authority change in its own right.
Tracked here: owner claude, deadline 2026-10-14.

## Review corrections

An independent review of #1828 found one HIGH, three MEDIUM and six LOW issues. All of them are
fixed in this branch.

- **H1 (ARIA-HIGH-371): a user-token lease pushed, and then the create was refused.** The PR
  create runs only on an installation token (`require_installation_credential`). The delivery now
  classifies the lease's environment (`credential_class`) before the push. A `pat_fallback` lease
  is refused at the `credential` stage as `credential_not_installation_token:<class>`, with nothing
  pushed.
- **M1 (ARIA-HIGH-371): the push named the ref, not the judged commit.** The delivery now refuses
  `branch_moved_since_publication` when the head that `prepare_pr_open` judged is not
  `branch_tip_sha`. The push sends `<branch_tip_sha>:refs/heads/<branch>`.
- **M2 (ARIA-HIGH-371): the rationale overstated the fix.** The local branch is kept on purpose.
  Every request-class refusal is escalated to HUMAN_REQUIRED. The requeue's
  `implementation_branch_exists` refusal is the existing design ("an operator decides"), and the
  refused commits are the evidence that person reads. 371 removes the remote branch with no PR.
  The comments in `pr_manager` and `implementation_delivery` now say exactly that.
- **M3 (ARIA-HIGH-372): any intent blocked its triple forever.** Rows are now paired in ledger
  order, because a retried triple reuses its operation id. Only an accepted or still-unanswered
  request blocks a repeat. A `failed` or `absent` one is retried, within the per-cycle cap.
- **LOW:**
  - Intents on PRs that have since closed are answered.
  - An `OSError` from `gh` becomes a named failure and no longer aborts the phase.
  - A reopened PR gets a new episode record (`human-merge-pr-<n>-2`).
  - `reflection` uses `HUMAN_MERGE_PR_KIND`.
  - `BLOCKED` with `behindBy > 0` (read from the compare API) is updated, and is named
    `behind_base_under_strict_protection`.
  - The CLI's `human-required resolve` has no `--resolved-by` option, so `github_observation`
    stays kernel-only. A test pins this.

Proof on the 371–373 head (`992067a5c`): 8 of the 11 new tests fail. The three that pass there pin
behaviour that already held: the cycle cap, `github_observation` refused for other kinds, and the
CLI.
