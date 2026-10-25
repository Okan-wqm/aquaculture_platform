# ARIA J1 stale-suppression review: non-blocking findings (2026-10-24)

The J1 package (ARIA-MEDIUM-783) makes a ground-truth false-positive anchor suppress only while the
code it cited is unchanged. The package review raised the points below. None blocks the J1 landing,
so the lean process of 2026-10-24 (one review, one correction, the rest as findings) registers them
here instead of reopening the package. Each point was re-checked at `8cfc393d2` by reading the cited
lines and by re-running the reviewer's probe.

## ARIA-MEDIUM-911

One settled verdict has two code identities: the J1 anchor stamp and the verdict-cache key hash
different files.

The stamp hashes the judges' consensus `evidence_refs` at the closing SHA. The verdict-cache key
(`judgment_funnel._cited_code_hash`, `judgment_cache`) and the pr_tracking merge-impact match use
the finding's own path and evidence. When the judges cite a different file than the finding (for
example a guard file), the finding's own code can change and the anchor still suppresses it, while
the cache misses and pr_tracking flags the row `needs_revalidation`. Re-run of the reviewer's probe:
suppressed at the first SHA True; verdict-cache key changed after the finding's own file changed
True; suppressed at the second SHA True. Not introduced by the branch: on origin/main suppression
never expired.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: J1 package review (lean process 2026-10-24: one review, one correction, the rest as
  findings); registered by the findings clerk, not blocking the J1 landing. Verified at `8cfc393d2`.
- Plan item(s): J1 (ARIA-MEDIUM-783).
- Evidence:
  - `aria-kernel/aria_kernel/feedback_store.py:1484`
  - `aria-kernel/aria_kernel/feedback_store.py:1565`
  - `aria-kernel/aria_kernel/feedback_store.py:2141-2153`
  - `aria-kernel/aria_kernel/judgment_funnel.py:178-197`
  - `aria-kernel/aria_kernel/judgment_cache.py:97-104`
  - `aria-kernel/aria_kernel/pr_tracking.py:358-369`
  - `aria-kernel/aria_kernel/pr_tracking.py:372-389`
  - `/root/aria-handover/2026-10-21/build/J1/reviewer-ssot/probe_two_identities.py`
- Rule: One owner per concept: a settled verdict has one code identity, computed once; the anchor
  stamp, the verdict-cache key and the merge-impact revalidation must name the same code, or an
  anchor outlives the code it judged.
- Close: Compute the stamp over the finding's own citations together with the judges' refs, under
  one owner shared with `judgment_funnel._cited_code_hash`. A test where the judges cite a guard
  file and the finding's own file changes after the mint asserts that the anchor no longer
  suppresses and that the cache key changes.

## ARIA-MEDIUM-912

The J1 suppression read compares against the HEAD of the store's declared bound_repo_root, not the
tree that was scanned.

`ensure_tools_binding` writes `bound_repo_root` only on a fresh bind and keeps it when a worktree of
the same repo rebinds. In probe P1 (store bound to checkout A, rebound from worktree B, cited file
changed and committed in B) the anchor still suppresses. On origin/main the anchor suppressed
forever anyway, and the runner path binds per host, so this narrows J1's guarantee for worktree-
scanned stores rather than regressing anything.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: J1 package review (lean process 2026-10-24: one review, one correction, the rest as
  findings); registered by the findings clerk, not blocking the J1 landing. Verified at `8cfc393d2`.
- Plan item(s): J1 (ARIA-MEDIUM-783).
- Evidence:
  - `aria-kernel/aria_kernel/feedback_store.py:2141-2153`
  - `aria-kernel/aria_kernel/tool_registry.py:372-395`
  - `aria-kernel/aria_kernel/tool_registry.py:452`
  - `aria-kernel/aria_kernel/tool_registry.py:477-496`
  - `aria-kernel/aria_kernel/tool_registry.py:501-512`
  - `/root/aria-handover/2026-10-21/build/J1/reviewer-evidence/probe.py`
  - `/root/aria-handover/2026-10-21/build/J1/reviewer-evidence/probe.log`
- Rule: A verdict holds only while the evidence it judged is unchanged (ARIA-MEDIUM-783): the
  comparison must run against the tree that was scanned, not a path recorded by an earlier bind.
- Close: The suppression read compares the code of the tree the run scanned, or the bind keeps the
  declared root current for a worktree of the same repo. A test with a store bound to checkout A and
  rebound from worktree B whose cited file changed asserts that the anchor no longer suppresses.

## ARIA-LOW-913

`cited_blobs_code_hash` records an unreadable commit or blob as `path:absent`.

Every non-zero `git show` is treated alike, so a mint at an unreadable `target_sha` gets a definite
stamp for unknown code instead of None. `test_an_unreadable_cited_blob_does_not_suppress` passes
only because unreadable collapses into absent, and absent differs from a real stamp. If an anchor
stamped `absent` later meets an unreadable blob, it still suppresses. Probe P2 re-run: the stamp at
a made-up commit equals the stamp at a commit where `src/f.ts` was really removed. Reachable only in
a corrupt or shallow repo. The law is pre-existing and shared with `judgment_cache`, so a change
moves cached-verdict keys only for unreadable commits.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: J1 package review (lean process 2026-10-24: one review, one correction, the rest as
  findings); registered by the findings clerk, not blocking the J1 landing. Verified at `8cfc393d2`.
- Plan item(s): J1 (ARIA-MEDIUM-783).
- Evidence:
  - `aria-kernel/aria_kernel/evidence_trust.py:648-651`
  - `aria-kernel/tests/test_j1_stale_fp_suppression.py:183`
  - `/root/aria-handover/2026-10-21/build/J1/reviewer-evidence/probe.py`
  - `/root/aria-handover/2026-10-21/build/J1/reviewer-evidence/probe.log`
- Rule: Unknown is never 'unchanged' (ARIA-MEDIUM-783): an object git cannot read must yield no code
  identity, not the identity of an absent file.
- Close: `cited_blobs_code_hash` returns None when git cannot read the commit or the object, and
  records `path:absent` only for a path missing from a readable tree. The unreadable-blob test uses
  a really absent path as its contrast, and `test_wpj_landing_named_resolutions` still passes for
  readable commits.

## ARIA-LOW-914

Each J1 suppression read spawns 1 + (anchors x refs) git subprocesses.

Nothing caches a blob hash per (path, HEAD) across anchors. The read runs per tool run in
`record_raw_findings_for_run` and `record_findings_for_run`, and again in the sampler and in judge
liveness. Probe P4 re-run: 200 anchors citing 5 distinct paths cost 201 git subprocesses, 0.67 s per
call.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: J1 package review (lean process 2026-10-24: one review, one correction, the rest as
  findings); registered by the findings clerk, not blocking the J1 landing. Verified at `8cfc393d2`.
- Plan item(s): J1 (ARIA-MEDIUM-783).
- Evidence:
  - `aria-kernel/aria_kernel/feedback_store.py:2117-2153`
  - `aria-kernel/aria_kernel/feedback_store.py:599`
  - `aria-kernel/aria_kernel/feedback_store.py:685`
  - `aria-kernel/aria_kernel/feedback_store.py:1782`
  - `aria-kernel/aria_kernel/judge_subject_liveness.py:195-198`
  - `/root/aria-handover/2026-10-21/build/J1/reviewer-evidence/probe.py`
  - `/root/aria-handover/2026-10-21/build/J1/reviewer-evidence/probe.log`
- Rule: Verification cost is bounded by distinct facts, not by rows: one blob hash per (path, HEAD)
  per suppression read.
- Close: The read hashes each (path, HEAD) blob once however many anchors cite it. A test with 200
  anchors over 5 paths counts `subprocess.run` calls and asserts the bound.

## ARIA-LOW-915

A dropped J1 suppression leaves no trace, and the spec's measurable gain was not measured.

A stale citation, an unstamped legacy anchor and a git that did not answer are one silent
`continue`, so a raw-findings row cannot tell them apart. The spec's measurable gain, the stale-
suppression count on the 8e39b2eeb store, was not measured; commit `8cfc393d2` says so in its body.
Once J1 lands every pre-J1 anchor stops suppressing at once, as the spec intends, so the before-
count is only recoverable now.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: J1 package review (lean process 2026-10-24: one review, one correction, the rest as
  findings); registered by the findings clerk, not blocking the J1 landing. Verified at `8cfc393d2`.
- Plan item(s): J1 (ARIA-MEDIUM-783).
- Evidence:
  - `aria-kernel/aria_kernel/feedback_store.py:2126-2127`
  - `aria-kernel/aria_kernel/feedback_store.py:2141-2153`
  - `docs/reviews/claude/2026-10-22-aria-sept-planning-judging-harvest.md:97-112`
- Rule: A silent drop destroys the evidence needed to measure it: every refusal to suppress needs a
  distinguishable cause.
- Close: A dropped suppression records its cause (cited code changed, no stamp, git did not answer)
  in the run summary or on the raw-findings row, and one test pins each cause. The stale-suppression
  count on the 8e39b2eeb store is measured once and recorded in the J1 build notes.
