# The decision-points lane pinned superseded System One contracts (2026-10-09)

Owner: claude (implementation), okan (review).

Context: Jev core #1756 merged to `main` carrying the security hardening —
`ed92805d8` (egress built from references; the transport renamed
`call_systemone` → `post_systemone`, imported privately as
`system_one._transport`; `http.client` replaces `urlopen`) and `6db2ef3bd`
(admission only for what the public remote publishes; one fetch per ask; the
hermetic `GIT_*`-stripped git environment). The decision-points branch
(`feat/aria-system-one-decision-points-v2`, merge `1b4d55878`) had written
every ask against the PRE-hardening contract — callers building the state text
themselves, a free-text ledger subject, `urlopen` as the failure seam — so
after the merge the lane measured 26 failed / 64 passed
(`tests/test_system_one_points.py`).

## ARIA-MEDIUM-403

The decision-points tests pinned the superseded transport and hermetic-environment
contracts, and the production decision points still called the superseded
`ask` convention: `system_one_points` passed caller-built state text (refused
`state_shape:not_a_reference` — Jev was never called), the failure harness
patched `urllib.request.urlopen` (a seam the hardened `http.client` opener
never consults — the timeout/401 lanes would have attempted the real pinned
endpoint), the environ AST pin denied `os.environ` even though `ed92805d8`'s
`_git` deliberately reads it once to strip caller `GIT_*`, the fixture asked
at commits no public branch holds (`commit_not_on_public_remote` /
`reference_not_in_repository`), and `issue_implementation_envelope` gained the
`admission` keyword (ARIA-HIGH-364, main) the envelope mint did not pass — a
post-merge CI-red lane on every affected shard.

Rule: a merged contract change must port every in-tree caller and pin in the
same change; a branch that merges the new contract while keeping the old
call convention ships a red suite at merge time, not at review time.

Fix (test-vs-code, by category):

- (a) Source/AST pins — TEST. The environ pin now pins the true law: neither
  module READS the environment to decide anything; `system_one`'s single
  `os.environ.items()` inside `_git` is the hermetic-env construction
  (`ed92805d8`'s deliberate use — evidence: the function's own contract "no
  caller GIT\_\* environment"); `system_one_points` names no environment at
  all. `getenv`/`environb` and any subscript/read stay refused.
- (b) Transport seam — TEST. The failure harness now injects at the seam the
  transport's own suite uses (`post_systemone(opener=…)`), applying the real
  opener's socket-timeout refusal mapping; retry, breaker and ledger reasons
  (`transport_error:TimeoutError`, `auth_rejected_http_401`,
  `credential_not_configured`, `transport_raised:…`) run through the shipped
  `_post`.
- (c) Behaviour — CODE where the caller convention was superseded, TEST where
  only the fixture was: `system_one_points` now hands `StateRef`s only —
  J0/R5/J1 resolve finding, commit, path, line; R4's `problem` is the plan's
  `finding_id` (a plan that names no finding sends nothing, verified by a new
  test); subjects are id-shaped (the finding id / head sha); the PR title and
  body no longer travel (`pr_manager` passes `head_sha`; R5's message is the
  head commit's). Fixtures became real repos pushed to a bare origin standing
  in for `PUBLIC_REPOSITORY_URL`, with the finding-registry row committed on
  `main` (the registry as the public remote holds it), the contracted adapter
  registered (ARIA-HIGH-324), the mint passing `admission`, and file contents
  the hardened outline builder can see. The shadow properties are unchanged
  and re-verified end-to-end: identical gh argv/PR/merge decision/mint
  whatever Jev does, byte-identical prompts under the seed (golden sha256
  from origin/main c1d183969 still pinned), one row per ask with its ledger
  outcome, and the wall-clock budget still stops a slow Jev after R5+J0.

Verified: `PYTHONPATH=. python3 -m pytest tests/test_system_one_points.py
tests/test_system_one.py tests/test_jev_runtime.py tests/test_pr_manager_e2e.py
tests/test_pr_manager_provenance.py -q` → 114 passed, 85 subtests passed
(`tests/test_pr_manager.py` does not exist on this branch; the two real
pr-manager suites stand in for it), plus the adjacent
`test_judge_fanout/test_merge_authority_invariants/test_converged_delivery/
test_executor_pr_via_kernel/test_judgment_pipeline_phases` suites (63 passed,
31 subtests).

Known consequence, by design of the hardened core: an adapter finding whose id
is not in the public registry (today's `F-NNN` tool findings) records a
`refused/finding_not_registered` row instead of a vendor answer — the rule
text a tool holds is not a reference until registered. J1 answers resume the
day the family's findings are registered; the question, the row and the
shadow guarantee are intact in the meantime.
