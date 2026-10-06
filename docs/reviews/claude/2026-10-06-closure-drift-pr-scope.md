# The closure-drift gate blames every open PR for drift on main (2026-10-06)

Owner: claude (implementation), okan (review). Deadline 2026-10-13.

## INFRA-MEDIUM-207

Measured on 2026-10-06:

- #1791 merged at 12:06Z carrying `Closes: …#ARIA-HIGH-350`.
- The reconcile lane opened #1799 to record ARIA-HIGH-350 as RESOLVED.
- Until #1799 merges, `origin/main` itself carries that drift. #1733 had been green, and its next
  run failed `invariants-fast` with `ARIA-HIGH-350 is OPEN but 59ef872e4265 on origin/main carries
its Closes: trailer`. #1733 does not touch ARIA-HIGH-350.

Evidence (at `main@502a03f28`):

- `tests/invariants/finding-registry-closure-drift.spec.ts:98`: the assertion counts every drifted
  finding against the PR under test.
- The required checks run under strict branch protection
  (`required_status_checks.strict: true`).

Every merge with a `Closes:` trailer therefore makes every other open PR wait for the reconcile
PR. The reconcile PR must first merge, and then each PR needs one more update-and-CI round. That
is one extra round per merge for every PR in the train, ARIA's own PRs included.

Rule: a pull request answers for the drift it adds. Drift already on its base belongs to the
reconcile lane, which opens its own PR. A push to main inherits nothing, so main is still held to
zero drift.

Fix: in a `pull_request` run (`GITHUB_BASE_REF` set), the spec loads the base ref's registry and
fails only on drift ids absent from the base's own drift (`driftAdded`). A new test pins three
cases:

- A PR that reopens a RESOLVED finding fails.
- Drift inherited from the base passes.
- A push counts all drift.
