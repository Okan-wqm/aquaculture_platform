# ARIA — one owner per fact: merge decisions and merged PRs (2026-10-10)

Owner: claude (implementation), okan (review).

## ARIA-MEDIUM-423 — the CI observer wrote the merge lane's decision ledger

### Symptom (ARIA-MEDIUM-423)

`tools/auto-merge-decisions.jsonl` on aria/state f5c5c86a1 holds 185 rows, dated 2026-09-04 to
2026-10-10. All 185 are `decision: blocked` with `dry_run: true`. Each carries the same four
reasons:

- `diff_text missing`
- `branch protection lookup failed`
- `review state unreadable`
- `unresolved conversation state unreadable`

Read in order, each row pairs 1:1 with a `ci/pr-ci-gates.jsonl` row for the same PR, head and
cycle (185 of 185), and its reasons are a subset of that gate row's `blocked_by`. The merge lane
wrote none of them. All 185 were counted as `pre_merge_perimeter` evidence
(`premerge_decision_blocked`) and in the cycle reflection's `auto_merge_summary.blocked`.

### Root cause (ARIA-MEDIUM-423)

`ci.evaluate_pr_ci_gate` (`ci.py:172-180`) evaluates the PR through
`auto_merge.evaluate_auto_merge`, so that the merge lane's reasons gate `ready_for_human_merge`
(`ci.py:181-190`). It passed its own `base_dir`, and `evaluate_auto_merge` appends its decision
whenever it is given one (`auto_merge.py:443`, `:1578-1585`).

The observer's snapshot does not fetch the diff, the reviews or the conversations
(`ci.py:820-821`). Every evaluation was therefore blocked, and every row was noise in the ledger
that `merge_authority`, `self_revert` and `reflection` read for merge-lane decisions.

Three producers reach this call:

- `own_pr_ci.scan_own_prs`;
- the readiness lane's `readiness record-ci-report` (`aria-readiness-claim.yml:197-205` →
  `cli.py:4003-4012`);
- `wait_pr_checks`.

All 185 rows carry `cyc-*` cycle ids, so the readiness lane never wrote one.

### Fix (tier 3: detectable)

The gate now calls `evaluate_auto_merge(..., base_dir=None)`. This is the merge authority's own
idiom for an evaluation without a record: its fresh re-check does the same
(`merge_authority.py:248`). The gate row carries the same evaluation as before: reasons, required
checks, check result and enterprise lane.

`tests/test_enterprise_ci_loop.py::TheCiObserverRecordsNoMergeDecision` pins four things:

- every CI producer leaves the decision ledger untouched (red before the fix);
- the gate's `blocked_by` equals the evaluation's reasons, and `required_checks`, `check_result`
  and `enterprise_risk` are carried unchanged;
- inside `evaluate_auto_merge`, the only load of `base_dir` is the argument to its own
  `_append_decision`, so `None` cannot change the decision (a change that makes the decision read
  state through `base_dir` fails here first);
- on a store only the observer touched, every `pre_merge_perimeter` count is 0 (red before the
  fix: `premerge_decision_blocked` was 1).

### Behaviour change, declared (ARIA-MEDIUM-423)

The 185 existing rows stay, because the ledger is append-only. In production the counts stop
growing; they do not drop. From now on, the counts and the reflection's `auto_merge_summary`
count only rows the merge lane writes.

The semantic authority (`capability_semantic_authority.json`) is unchanged: the fold is the same,
and one producer stopped writing.

### Not done here (ARIA-MEDIUM-423)

The gate is still structurally blocked. Its snapshot reads no diff, reviews or conversations, so
`ready_for_human_merge` is never true, and nothing outside `ci.py` reads it. This change does not
alter what the gate decides.

## ARIA-LOW-424 — pr_tracking keeps its own copy of the merged-PR fact (OPEN)

Recorded, not fixed in this PR. Scope decision 2026-10-10: a LOW cleanup that ARIA does not need
in order to run. Owner: claude. Deadline: 2026-11-07.

### Symptom (ARIA-LOW-424)

The change_intelligence phase copies every new `merged` row from `pr-lifecycle.jsonl` into
`merge-events.jsonl` and `pr-events.jsonl`:

- `cycle.py:1785` calls `pr_tracking.ingest_merged_pr_lifecycle` (`pr_tracking.py:114-170`);
- that calls `observe_pr_event`, which appends to both files (`pr_tracking.py:108-110`).

It then reads the copy:

- impact planning takes the copy's last row (`pr_tracking.py:365`);
- change intelligence walks the copy newest first (`pr_tracking.py:213`).

On aria/state f5c5c86a1, both copies hold the one row for PR 1906, copied at 03:08:55 with
`attributed_to_aria: false`. The owner's row was attested `base_merged` at 08:17:57, so the copy
already disagrees with its owner.

The gateway's PR route is the copy's second writer (`gateway/router.py:150-161`). It has never
run: there are no gateway rows on aria/state.

### Root cause (ARIA-LOW-424)

`merge_record.record_merge` is the only writer of `merged` (ARIA-HIGH-390,
`auto_merge.py:559-562`). Readers are meant to read merges through
`merge_record.fold_merged_rows` (ARIA-HIGH-409). `pr_tracking` keeps a second ledger of the same
fact and reads that one instead.

### The plan's "retire the two state surfaces" cannot be done by undeclaring them

Every published `snapshot.json` (origin/aria/state) claims `pr_events` and `merge_events`. The
publish validates its parent's snapshot against the current manifest:

1. `state_store.py:2110` calls `evidence_checkpoints_due`.
2. That calls `autonomy_evidence.py:2730`, which validates at `:2353-2359`.
3. `validate_snapshot_manifest` refuses a claim of an undeclared surface
   (`state_snapshot.py:504-506`).

Checked against the published snapshot:

| Check                                                                           | Current manifest             | Both surfaces removed                              |
| ------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------- |
| `validate_snapshot_manifest`                                                    | passes                       | raises `snapshot_manifest_invalid:surface_unknown` |
| `evidence_checkpoints_due` on a store whose parent commit carries that snapshot | proceeds to the claim stream | raises `state_snapshot_invalid`                    |

`_record_evidence_checkpoints` turns that error into
`StateStoreRefusal(state_publish_evidence_checkpoint_failed:…)` (`state_store.py:2117-2120`). So
undeclaring the two surfaces would refuse every publish, and aria/state would stop moving.
Deleting the files is not an option either, because ARIA's history is never deleted.

### Designed fix (patch kept at the session's `patches/ARIA-LOW-424.patch`)

The two declarations stay, frozen, with the reason written beside them. `heartbeat_ticks` is the
precedent. The rest of the fix:

- `pr_tracking` reads `fold_merged_rows(lifecycle_rows(root))`. The change-intelligence subject
  stays `merged-pr:<pr>:<head>`, so a merge already asked about is never asked again.
- A new `plan_new_merge_impact` uses the impact ledger's `pr_event` (PR and head) as its own
  cursor. An idle night writes nothing, and a failed plan is planned again next cycle.
- `observe_pr_event`, `ingest_merged_pr_lifecycle` and `PR_EVENTS` are deleted.
- The gateway's PR deliveries route `ignored` (`pr_lifecycle_has_one_writer`). `pr_event` leaves
  `ROUTE_ACTIONS`, with an amendment to one-way door 14.
- `tests/invariants/test_merged_single_writer.py` fails any module except `state_manifest` that
  names the copies, and pins that the copies stay declared.
- No second `pr-lifecycle` writer is added.

The patch was checked in a scratch tree:

- red before and green after;
- the phase was dry-run on a copy of the bound store: `impact_status: no_new_merge`, 0 requests
  minted, and `pr-lifecycle`, `evidence-impact` and both copies byte-identical.

## ARIA-LOW-424 — fixed (wave 2, 2026-10-10)

The designed patch was applied on `0b88b2ccb` and re-proved there. It needed no changes:
`cycle.py` moved 15 lines since `7ded78260`, and no other touched file had changed.

### Fix (tier 1 for the copy, tier 3 for its return)

- `pr_tracking` reads merges where their one writer records them:
  `_merges(root) = fold_merged_rows(lifecycle_rows(root))`.
  - `dispatch_change_intelligence` walks those rows newest first. Its subject is still
    `merged-pr:<pr>:<head>`.
  - `plan_pr_impact` plans the newest of them.
  - The new `plan_new_merge_impact` uses the impact ledger's own `pr_event` (PR and head) as
    its cursor. An idle night writes nothing, and a plan that failed is planned again next
    cycle.
- `observe_pr_event`, `ingest_merged_pr_lifecycle`, `PR_EVENTS` and
  `_latest_pr_or_merge_event` are deleted. The phase result loses `merges_ingested`; nothing
  read it.
- The gateway's PR deliveries route `ignored` with reason `pr_lifecycle_has_one_writer`
  (`gateway/router.py`), and `pr_event` leaves `ROUTE_ACTIONS`.
  - One-way door 14 carries the amendment (`docs/aria/v3-one-way-door-decisions.md`).
  - `docs/runbooks/aria-gateway.md` no longer says PR events become `pr-events.jsonl`.
- `pr_events` and `merge_events` stay declared and frozen in `state_manifest.py`, with the
  reason beside them (the proof is above: undeclaring them would refuse every publish).
- `tests/invariants/test_merged_single_writer.py` pins three things:
  - any module except `state_manifest` that names either copy (by file name or by surface name)
    fails;
  - both copies stay declared;
  - a forged writer or reader of either spelling is caught.

### Evidence (ARIA-LOW-424)

- **Red before**, in a snapshot of HEAD with only the new tests added: 3 failed.
  - `test_a_merge_is_planned_and_asked_about_without_a_copy`: the copy was written.
  - `test_the_copies_stay_as_history_and_do_not_grow`: the copy grew to `[1906, 1907]`.
  - `test_no_module_keeps_a_copy_of_the_merged_rows`: 10 offenders, starting at
    `pr_tracking.py:46`.
- **Green after**, in the same snapshot with the patch, over the 8 touched test files: 143 passed
  and 2 failed. Neither failure is caused by this change:
  - `test_phase_v12_f_gateway::test_I_V12_GW_06` reads `infrastructure/aria/aria-gateway.service`,
    which the snapshot did not hold. It passes in the worktree.
  - `test_request_admission::AThrottledPanelReMintIsDeferredNotResolved::test_deferred_this_sweep_reminted_the_next`
    fails the same way on the unpatched HEAD code (`[] != ['AIR-dead-work-1']`). It is red
    before this change.
- **Dry run.** The phase ran on a copy of the bound store's needed subtrees (aria/state
  `f5c5c86a1`: the four ledgers, `agent-invocations/`, `memory/`, `governance.jsonl` and the
  binding files).
  - The copy's subjects and the owner's are the same: `[(1906, 1ac2048c…)]`. The impact ledger
    already names that merge.
  - Result: `impact_status: no_new_merge`, `change_intelligence_requests_minted: 0`, `blocked: []`.
  - Admission refused the mint as production did: `backlog_at_drain_budget`, backlog 181.
  - `pr-lifecycle`, `evidence-impact`, `merge-events` and `pr-events` were byte-identical before
    and after.
  - The copy was then deleted.

### Not done here (ARIA-LOW-424)

The two frozen files keep their single row (PR 1906). They are history, and ARIA history is never
deleted.

## ARIA-MEDIUM-430 — the CI observer claimed a merge verdict it could never reach

Owner: claude. Raised and fixed 2026-10-10 (wave 2).

### Symptom (ARIA-MEDIUM-430)

`ci.evaluate_pr_ci_gate` sets `ready_for_human_merge` only when the merge lane's evaluation has no
reasons and no protected or failed workflow blocks (`ci.py:190-199`). On aria/state f5c5c86a1,
`ci/pr-ci-gates.jsonl` holds 185 rows (2026-09-04 to 2026-10-10). All 185 are `blocked`, and 0 have
`ready_for_human_merge: true`. Every row is blocked by the same four facts:

- `diff_text missing` (`auto_merge.py:296`);
- `branch protection lookup failed: branch_protection_lookup_permission_denied`
  (`auto_merge.py:368`);
- `review state unreadable` (`:407`);
- `unresolved conversation state unreadable` (`:414`).

177 rows also carry `enterprise risk policy rejected diff: risk_change_paths_unavailable`.
`ci-reports.jsonl`'s `ready_state` mirrors the gate. Nothing in code reads either field; the
readiness lane's workflow printed `ready_state` with `jq`.

### Root cause: the observer cannot know, so it must not claim

The brief offered two ways out: make the snapshot read what the gate requires, or stop claiming.
The first is not reachable. Each of these is enough on its own:

1. **Branch protection.** `required_status_checks` needs Administration: read. The observer runs on
   the cycle's job token (`aria-auto-cycle.yml:125-150`: contents, actions, checks, pull-requests,
   issues), and a workflow cannot grant `GITHUB_TOKEN` administration. Only the App installation
   token carries it (`gh_token_factory.py:314-318`), and only the merge lane mints that token with
   the merge-gate reads (`:330-336`, `aria-merge-runner.yml:219-251`).
2. **The PR's commits.** The lane is read from git in the checkout (ARIA-CRITICAL-215). The cycle
   checkout lacks the PR's head: 177 of 185 rows say `risk_change_paths_unavailable`. Only the merge
   lane builds a workspace that holds the head.
3. **The predicate contradicts its own name.** No reasons requires a valid lane L1
   (`auto_merge.py:353-357`). A PR is routed to a person exactly when it is not a valid
   `auto_merge_candidate_lanes` lane (`risk_policy.py:324-326`), and that list is `["L1"]`
   (`docs/aria/policy/risk-policy.json:7`). So `ready_for_human_merge` could be true only for a PR
   no person is asked to merge, which is the merge lane's to merge.

The diff, the reviews and the review threads would be readable with `pull-requests: read`. With
(1)–(3) unchanged, fetching them would still leave the verdict unreachable.

The owner that reads everything is `merge_authority`. Through `GhCliGitHubAdapter` it reads
`gh pr diff`, the reviews, the GraphQL review threads and branch protection, on the installation
token, in its own workspace. It records the verdict in `auto-merge-decisions.jsonl`
(`auto_merge._append_decision`).

### Fix (tier 1: the observer has no verdict field to set)

- The gate row and the `ci-reports` row drop `status`, `ready_for_human_merge` and `ready_state`.
  Both rows move to `schema_version: 2`; the rows with 1 carried the claim, always `blocked`.
- The gate row keeps `blocked_by`, `required_checks`, `check_result`, `protected_workflow_gates`
  and `enterprise_risk` as the observer's account of what blocks a merge, so ARIA-MEDIUM-423's pins
  hold. It adds `merge_verdict_surface: "auto_merge_decisions"`, which names the owner.
- `aria-readiness-claim.yml` prints `gate_ref` where it printed `ready_state`.
- `tests/test_enterprise_ci_loop.py::TheObserverClaimsNoMergeVerdict` pins three things:
  - the rows claim no verdict, are version 2, and name the surface;
  - that surface is the ledger `auto_merge._append_decision` writes;
  - `ci.py` holds no literal of either claim, so it cannot come back unnoticed.

`test_lane_readers_read_git` keeps its L1 case: everything the fixture supplies is clean, so
`blocked_by` is empty.

### Evidence (ARIA-MEDIUM-430)

- **Red before**, on `f5701d69e`: 4 tests of `test_enterprise_ci_loop` failed (`ready_state` present,
  both claims present in `ci.py`, no `MERGE_VERDICT_SURFACE`).
- **Green after**, in the snapshot:
  - `test_enterprise_ci_loop`, `test_lane_readers_read_git`, `test_readiness_proofs`,
    `test_readiness_claim_lane` and `test_own_pr_ci*`: 58 passed.
  - Every other test that imports `ci` or `own_pr_ci`: 145 passed.
  - The workflow-contract tests: 92 passed and 1 failed.
    `test_i_sbx_05_validation_room_lanes_provision_declared_toolchains` reads root toolchain files
    the snapshot did not hold.
- **Green after**, in the worktree: `test_enterprise_ci_loop`, `test_lane_readers_read_git`,
  `test_readiness_claim_lane`, `test_executor_workflow_sandbox_contract` (with `test_i_sbx_05`),
  `test_workflow_kernel_cli_contract` and `test_own_pr_ci_feedback`: 59 passed.

### Behaviour change, declared (ARIA-MEDIUM-430)

The 185 existing rows stay; the ledgers are append-only. New rows carry no verdict. A reader that
wants to know whether a PR may merge reads `auto-merge-decisions.jsonl`.

## ARIA-LOW-447 — the ambient-git-env owner passes git's transport and auth redirects (OPEN)

Registered with 0ffd209dd (owner claude, deadline 2026-10-17), found by the independent security
review of 0b88b2ccb..2d70a127e. This section is the finding's account, the one the registry row's
`review_file` points at. It is not fixed on this branch, and the line numbers are the current
tree's.

### Symptom (ARIA-LOW-447)

`without_ambient_git_config` is the one owner of "the ambient environment minus what redirects
git", and it strips only the `GIT_CONFIG*` names (`aria-kernel/aria_kernel/git_containment.py:680-694`).
Git's program lookup, transport and credential prompts pass through: `GIT_EXEC_PATH`,
`GIT_SSH_COMMAND`, `GIT_ASKPASS`, `SSH_ASKPASS` and `GIT_PROXY_COMMAND`. Every seam built on it
inherits them: the kernel's delivery push (`_publish_environment`, `git_containment.py:709-714`)
and `gh pr create` (`aria-kernel/aria_kernel/pr_manager.py:811`). The state publish does not use
the owner at all and passes `{**os.environ}` (`aria-kernel/aria_kernel/state_store.py:6187`).
The review's repro: with `GIT_EXEC_PATH` pointing at a planted `git-receive-pack`, a push through
`_publish_environment()` ran it with `GH_TOKEN` present.

### Root cause (ARIA-LOW-447)

The owner was named for the configuration channel, not for everything that redirects git, so its
invariant (`aria-kernel/tests/invariants/test_git_config_env_single_owner.py`) pins the literal
`GIT_CONFIG*` names and nothing else. That is a gap in ARIA-HIGH-234's every-seam claim. It is
LOW because exploiting it needs control of the runner process's environment: no workflow writes
untrusted data to `GITHUB_ENV`, the agent room cannot reach it, and no ARIA workflow sets these
names.

### Fix direction (ARIA-LOW-447, stub)

Fix at the one owner: `without_ambient_git_config` strips the redirect names as well, the state
publish (which keeps its own `GIT_CONFIG_*` credential on purpose) drops the redirect names
through the same owner, and the invariant widens from the literal `GIT_CONFIG*` names to every
variable that redirects git's configuration, program lookup, transport or credential prompt.
