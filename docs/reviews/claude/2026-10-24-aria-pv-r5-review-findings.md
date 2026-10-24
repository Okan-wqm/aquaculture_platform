# ARIA plan verdict, PV-R5 review: non-blocking points (2026-10-24)

The PV-R5 review (security and evidence lenses) of the R22/R23 round on
`feat/aria-plan-verdict-p1-p3-p5` raised five points that are not blockers under the operator's
lean bar (one review, one correction, findings instead of extra rounds). Each was checked against
the code at `51166f120` before it was registered. All five hold. The security and evidence lenses
found the same MEDIUM flaw independently, so those two points are one finding. The review's line
numbers had moved; the evidence below uses the current ones. Plan item: P1 and P3, the plan path
record law and the freshness gate of the plan verdict.

## ARIA-MEDIUM-932

`ARIA-MEDIUM-905`'s close condition leaves the `MAX_ARG_STRLEN` input open. A brace-free evidence
ref over 128 KiB is admitted by the plan path law, makes `commit_blob_paths` raise
`workspace_head_unreadable:OSError`, and is withheld uncounted on every offer instead of being
refused and parked.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20. Source: PV-R5 review, security and
  evidence lenses (merged).
- Evidence:
  - `aria-kernel/aria_kernel/plan_convergence.py:4935-4958`: `_plan_ref_reading` admits a
    brace-free 130 KiB path in 0.25 s. R19 bounds the alternatives of a glob. Nothing bounds the
    length of one literal path.
  - `aria-kernel/aria_kernel/workspace_view.py:187-199`: `_argv_chunks` lets one oversized path
    through as its own chunk. The exec fails with `E2BIG`.
  - `aria-kernel/aria_kernel/workspace_view.py:100-104`, `:169-172`: `_head_git` names that
    `OSError` `workspace_head_unreadable:OSError`.
  - `aria-kernel/aria_kernel/plan_convergence.py:1771`: the freshness gate returns
    `plan_verdict_unverifiable`. `:3558` is the record-side call, which reaches the same argv for
    a risk ref.
  - `aria-kernel/aria_kernel/converged_delivery.py:420-421`: delivery withholds the verdict
    uncounted on every offer. It never parks it and raises no operator item.
  - Reproduced by the reviewers: a 130 KiB body ref went through 3 offers, each withheld as
    `plan_verdict_unverifiable`, and the plan stayed CONVERGED.
- Why `ARIA-MEDIUM-905` does not cover it: commit `a3716a0ed` says R22's per-record budget removes
  this input, and the 905 notes call the refusal fail-closed. 905's close condition (1) makes
  refs literal (`resolve_repo_relpath` only). Its condition (2) sums the glob texts of a record
  (surfaces, key-change paths, `affected_files`). Refs are in neither, so after 905 closes, one
  130 KiB ref still reaches the git argv. It is fail-closed only in the withhold sense, not in
  the parking sense. It also reads a fact of the input as a fault of the checkout, the inverse of
  R23. It needs one path over 128 KiB from the plan author and has been on the branch since
  `59851523e`.
- Rule violated: a fact about the input is refused by the owner of path admission
  (`plan_path_refused` at record, `plan_verdict_path_refused` when already recorded, parked). It
  is never read as `workspace_head_unreadable`, which is reserved for the checkout's own failures.
- Close condition:
  - `canonical_path`, the owner of repo-relpath admission, bounds the byte length of one literal
    path with a named constant (`MAX_REPO_RELPATH_BYTES`). It is set from the longest tracked path
    measured in the repo, with that number cited in its comment, and no higher than Linux
    `PATH_MAX`.
  - The plan path law (`_plan_path_reading`, so refs and body paths, at record and at freshness)
    refuses a path over it: `plan_path_refused` at record, `plan_verdict_path_refused` (parked)
    for an already recorded plan.
  - No call-site try/except and no second length rule.
  - `ARIA-MEDIUM-905` is not closed before this bound lands, and its close condition should cite
    this finding.
- Tests that close it:
  - A 130 KiB brace-free body ref is refused by `start_plan` with `plan_path_refused` and no
    event.
  - A 130 KiB risk ref is refused at record with the event count unchanged.
  - A legacy recorded plan holding such a body ref is parked on the first offer with one
    `STALE_VERDICT_KIND` row and one operator item. `commit_blob_paths` is never called with the
    ref.

## ARIA-LOW-933

`workspace_view.commit_blob_paths` reads git's refusal of its own input as a checkout fault. An
empty pathspec and an absolute path both make `ls-tree` exit 128, and the function raises
`workspace_commit_unreadable` for any nonzero exit. Its contract silently relies on the plan path
law refusing both before the call.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20. Source: PV-R5 review, security lens
  (hardening only).
- Evidence:
  - `aria-kernel/aria_kernel/workspace_view.py:138-184`, `:173-176`: the function and its single
    nonzero-exit branch.
  - `aria-kernel/aria_kernel/plan_convergence.py:4896-4932`: `_plan_path_reading`, the caller-side
    law. Re-run at `51166f120`, it refuses `''` ("a path is a non-empty string"), `.`
    (`repo_relpath_empty`) and `/abs` (`repo_relpath_absolute`) before `commit_blob_paths`. The
    defect is latent, not live.
- Rule violated: a function that maps a git exit to a checkout fault states the inputs it accepts
  (canonical, non-empty, relative repo paths) and rejects anything else as a caller error at
  entry. Git refusing the input itself then cannot be read as a fault of the checkout.
- Close condition: `commit_blob_paths` states the precondition in its docstring and enforces it
  at entry with a typed programming-error exception that is not `WorkspaceViewRefused`. If the
  repo has a type that only `canonical_path.resolve_repo_relpath` produces, taking that type is
  the higher tier.
- Test that closes it: `commit_blob_paths(repo, commit, {''})` and `{'/abs'}` raise that error
  and run no `git ls-tree`. A valid set still answers as before.

## ARIA-LOW-934

The PV-R5 R23 commit message counts seven tests as red at `59851523e`. Two of them fail only
because `commit_blob_paths` did not exist yet; the old per-path lookup gave the same subset and
the same raise.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20. Source: PV-R5 review, evidence lens.
- Evidence:
  - `aria-kernel/tests/test_plan_verdict_roots_r5.py:122-142`: class
    `R23ABlobIsAListedBlobEntryOfExactlyThatPath`, with `test_the_blob_subset_of_the_asked_set`
    (`:123`) and `test_a_commit_the_checkout_does_not_hold_raises` (`:139`).
  - `aria-kernel/aria_kernel/workspace_view.py:138-184`: the function the tests call.
  - The red run at `59851523e` shows 7 failed. Three fail with `AttributeError` (no attribute
    `commit_blob_paths`). One of those three,
    `test_the_call_raises_for_a_held_commit_whose_tree_git_cannot_read`, is a real behaviour red:
    the old lookup returned False for a missing tree. The other two pass against the old
    function under its old name. `cat-file -t <commit>:<path>` gave `blob` for the file and the
    `[id]` file, and a failure or `tree` for the absent path, the `#L1` name, the glob text and
    the directory (re-run in a throwaway repo). The held-commit check that raises for an absent
    commit was R21's. The honest count is 5 behavioural reds and 2 name-only reds.
- Rule violated: a commit message reports which tests were red for a behavioural reason. A test
  that fails on a missing name only is a characterization of preserved behaviour and is counted
  as that.
- Impact: the claim only. Both tests stay valid as proof that the redesign kept the subset and
  the raise. The commit cannot be rewritten.
- Close condition: the PR description and merge commit for `feat/aria-plan-verdict-p1-p3-p5`
  state the count as 5 behavioural plus 2 characterization reds, and the test class carries a
  comment saying the two pin behaviour preserved across the redesign. Closed by the merge commit
  that carries the corrected statement.

## ARIA-LOW-935

`workspace_view._LS_TREE_ARGV_CHUNK_BYTES` budgets path bytes only. Linux also counts 8 bytes per
argv pointer and the environment against the same limit (stack rlimit / 4, floor 128 KiB), so a
512 KiB chunk fails with `E2BIG` under a small stack limit.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20. Source: PV-R5 review, evidence lens.
- Evidence:
  - `aria-kernel/aria_kernel/workspace_view.py:58-64`: the constant and the comment that reasons
    from the default 8 MiB stack.
  - `aria-kernel/aria_kernel/workspace_view.py:187-199`: `_argv_chunks` costs `len(path) + 1` per
    path.
  - Probe: executing `/bin/true` with 512 KiB of 60-byte arguments succeeds at an 8 MiB stack and
    fails with `OSError 7` ("Argument list too long") at 1024, 512 and 256 KiB stacks.
    `os.sysconf('SC_ARG_MAX')` follows the stack limit (2,097,152, then 262,144, then 131,072
    twice).
  - The margin is large under the default 8 MiB stack. A failure refuses as
    `plan_verdict_unverifiable`, so it fails closed, and the checkout's own state is the right
    owner of that reason. The harm is a runner started with a small `ulimit -s` that cannot answer
    freshness reads at all.
- Rule violated: a budget set against an OS limit is derived from the limit the process runs
  under and counts everything that limit counts, instead of a constant that holds only under the
  default.
- Close condition: the chunk budget is derived from `os.sysconf('SC_ARG_MAX')` at call time minus
  the measured size of the environment, the per-path cost counts the 8-byte argv pointer, and the
  comment on the constant states the derivation.
- Test that closes it: with `RLIMIT_STACK` lowered in a subprocess, `commit_blob_paths` over a few
  thousand paths answers exactly as under the default.
