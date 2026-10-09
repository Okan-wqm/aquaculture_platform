# ARIA PR landing gate (runbook)

Added 2026-10-08 after PR #1892 auto-merged with the aria-kernel lane red
(suite shard 7: a real capability-roster regression, fixed by #1897) — main
stayed red for 8h46m because no kernel lane was a required context and the
local pre-merge gate had been invoked incorrectly (`aria-suite-run.sh full`;
the runner takes module paths, not modes — see `/tmp/aria-suite-baseline.log`
from that night).

## The rule

An ARIA-surface PR may be merged (manually or via auto-merge) only when ALL
of these hold:

1. The scoped local suite gate is green on the PR head:
   ```bash
   node scripts/ci/aria-suite-changed.mjs
   ```
   (exit 0). Run it from the repo root of the PR branch, after the final
   commit. `ARIA_SUITE_FULL=1` forces the full suite for release-grade
   pushes. The gate takes module paths via the runner — never pass it a mode
   word (`full`, `all`): `scripts/ci/aria-suite-run.sh <module>...`.
2. The `aria-kernel` check (suite+lane+state verifier) is green on the PR.
   It is a REQUIRED context since this change — auto-merge cannot close a
   PR while any kernel lane is red.
3. After every merge to main, the latest main run's conclusions are
   checked (`gh run list --branch main --limit 3`). A red main is treated as
   a stop-the-line event: no further merges until it is green.

## Why the invariant floor exists

The selector is import-graph based. Tests that assert over the whole
discovered surface set (capability rosters, surface reachability) import
nothing they cover, so the graph cannot reach them. Any change under
`aria-kernel/aria_kernel/` selects
`tests/test_autonomy_evidence_status.py` and `tests/test_surface_reachability.py`
into every scoped run at the `floor` tier (`applyInvariantFloor` in
`scripts/ci/aria-suite-changed.mjs`): last priority, inside the budget
discipline, never displacing a changed module. The hard guarantee is the
required `aria-kernel` check, which always runs the full suite.

## Night budget

Empirical rate on 2026-10-08: ~0.6 defects per merged PR (3 real defects in
6 merges). Cap a night campaign at 3 PRs unless every PR above ran the full
scoped gate.
