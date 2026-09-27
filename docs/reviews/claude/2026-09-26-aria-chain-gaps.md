# ARIA — what still stops the L1 chain after plan 034 (2026-09-26)

Context: plan 034 closed the code breaks between a finding and a reversible L1 self-merge. Four
independent read-only audits then checked whether its operator steps (M1, O1, O1b, O3, O4, O2)
would complete the chain if followed as written. They would not: ARIA still could not merge its
own pull request. The findings below are the gaps, and `docs/aria/plans/036-chain-gaps.md` is the
plan that closes them.

Owner: claude (implementation), okan (review, operator steps). Deadline 2026-10-24.

## ARIA-HIGH-205 — The merge lane can never hold pr_merge

`pr_merge` is granted only by the `autonomous` profile (`runtime_profile.py:175`). The nightly
cycle proposes at most `strict` (`runtime_profile.py:258`, `autonomy_unlock.py:380-385`) and writes
that proposal over the saved profile (`cli.py:5951-5960`), which is the profile the merge runner
restores from `aria/state`. `RealAutoMergeRunner` sets `dry_run` whenever the profile is not
`autonomous` (`auto_merge_runners.py:154`). An operator ceiling of `autonomous` changes nothing,
because the scheduler never proposes above `strict`. Merge authority has to be its own grant: set by
an operator, revocable, scoped to a lane, and impossible for the cycle to write.

## ARIA-HIGH-206 — The merge runner never retries after late required checks

`aria-merge-runner.yml` fires only on `workflow_run` of `aria-readiness-claim`. Three of the four
required checks (`sens-enterprise-summary`, `merge-gate`, `build-status`) come from the heavier
`ci-affected.yml`. When they are still running, the required-checks gate reports them missing or not
green, and nothing re-evaluates the PR until an unrelated event does.

## ARIA-HIGH-207 — The protection proof accepts unmeasured bypass actors

`readiness_proofs.py:433` reads `detail.get("bypass_actors") or []`. When the token cannot see the
field, GitHub omits it, and the proof records "no bypass actors". A proof must fail closed on a
field it could not measure.

## ARIA-HIGH-208 — Token scopes and the identity that opens a PR

The merge lane reads issues, check runs and commit statuses (`auto_merge.py:783,846,850`). The App
token it mints asks only for contents and pull_requests. The cycle opens ARIA PRs with the
`ARIA_GH_TOKEN` PAT, or else the job token (`aria-auto-cycle.yml:757-768`). A PR opened with the job
token leaves its workflows in `action_required`, so `aria-merge-authority`, and with it the readiness
claim and the merge runner, never starts.

## ARIA-HIGH-209 — Promotion approval is never resolved or recorded

`promotion.py:49,102` passes `bool(operator_approval_ref)`. Any non-empty string authorizes
CALIBRATE→SHADOW→ACTIVE, and `last_transition` (`tool_registry.py:1492-1500`) records only the
reason. The operator also has no view of the ACTIVE readiness blockers (`adapter_active_readiness` is
not exposed by any CLI command).

## ARIA-HIGH-210 — Branch protection cannot be measured on demand

A manual dispatch of `aria-readiness-claim.yml` reads `github.event.workflow_run.*`
(`:93,100`), which is empty, so it skips without measuring. Every proof the merge gate requires needs
an on-demand producer.

## ARIA-HIGH-211 — Work that can only be refused is started

`classify_change` runs only in `auto_merge` and `human_required_adjudication`. A doc-staleness
finding in `docs/aria/**`, `docs/adr/**` or `docs/plans/**` (all code-owned, so L3) is planned,
converged and implemented, then refused at merge. `risk-policy.json` has also drifted from the plan
034 PR 2 lane spec: it has no `l1_excluded_globs`, and CODEOWNERS parsing alone keeps it safe.

## ARIA-HIGH-212 — doc-staleness is not precise enough to be promoted

Operator feedback on `aria/state` holds 19 true positives and 27 false positives, a precision of
about 0.41, against the ACTIVE gate of 0.85 (`readiness.py:119-126`). The chain's first adapter
therefore cannot reach ACTIVE, and the chain cannot start.

## ARIA-HIGH-213 — The operator runbooks disagree with the code

`docs/runbooks/aria-github-app-setup.md` targets the retired `snowball` branch with one approval and
lists fewer permissions than the token factory mints (`gh_token_factory.py:286-290`). It has no step
for the repository secrets and does not name the merge runner. `aria-runner-rebuild.md` omits
`openssh-client`, which the commit-signing key mint needs.
