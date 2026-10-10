# main requires no status checks; the manifest could not be applied (2026-10-10)

`docs-check` failed on every main push from #1937 (0d900df06) until #1945. #1937 had merged at
09:56Z with `docs-check` and `build-status` red. That is possible only because main's live branch
protection requires no status checks:

```text
$ npm run gates:required-status-checks:live
GitHub raw required status contexts=[], manifest contexts=["aria-kernel","aria-merge-authority","build-status","merge-gate","sens-enterprise-summary"]
```

`strict` and `enforce_admins` are still on. Who cleared the list, and when, is not recorded
anywhere the repo can read. The parallel session (f2) did not clear it.

Owner: claude (implementation), okan (review).

## INFRA-HIGH-215

`.github/manifests/main-required-status-checks.json` has listed `aria-kernel` as a required
context since #1937 (INFRA-HIGH-212). `.github/workflows/aria-kernel.yml` ran on `pull_request`
only for the paths in its filter. A workflow whose filter excludes a PR starts no run for it, so
the required context never reports and GitHub waits on it forever. Applied to GitHub as written,
the manifest would have left every PR outside the ARIA paths unmergeable. #1945, a docs-only PR,
got no `aria-kernel` check at all.

Fix (this change):

- `aria-kernel.yml` runs on every PR, unfiltered. A new `changes` job reads the same path list
  (`KERNEL_SURFACE`, moved unchanged from the filter) and diffs the PR merge commit against its
  base parent. `suite`, `lane` and `state` run only when `kernel=true`.
- The `aria-kernel` verdict accepts `skipped` only when `changes` succeeded with `kernel=false`.
  When the kernel surface changed, every job must be green. A failed or empty scope decision is
  red.
- `tools/gates/required-status-checks.ts` refuses a `paths` or `paths-ignore` filter on the
  `pull_request` trigger of any workflow that produces a required context, and a contracted
  workflow with no `pull_request` trigger at all. `aria-merge-authority` runs the gate on every
  PR, so the class is caught before merge.
- Tests:
  - `aria-doc-runtime-ssot.spec.ts` runs the `changes` job's own script against a PR-shaped
    merge checkout, so each glob keeps the meaning it had as a filter.
  - `test_state_compaction_gate.py` runs the verdict script across job outcomes.
  - Both were mutation-checked, as was the gate rule.

## INFRA-MEDIUM-216

The kernel lane's PR surface is narrower than the pre-push selector's. `ARIA_SURFACES` in
`scripts/ci/aria-suite-changed.mjs` includes `.github/workflows`, `.github/actions`,
`package.json` and the selector's own files, because kernel tests read them. For example,
`aria-kernel/tests/test_state_compaction_gate.py` compares the `state` job to
`aria-state-maintenance.yml` byte for byte. A PR that changes only `aria-state-maintenance.yml`
does not run the kernel suite, and a break it causes surfaces first on main.

Two lists describe one concept. The fix gives one owner to "paths whose change the kernel suite
can see", and the lane and the selector both read it. Until then, the CI list stays as it was
before this change, so the set of PRs that run the full suite does not change. Deadline
2026-10-24.

## INFRA-HIGH-217

No CI job compares the live protection with the manifest. `aria-merge-authority.yml` runs
`npm run gates:required-status-checks` without `--live`, which checks the manifest against the
workflows but never against GitHub. The live check exists (`--live`), but nothing runs it. That
is how an empty required-check list went unnoticed.

Fix path:

1. Restore the protection from the manifest, once INFRA-HIGH-215 has landed. Approved by okan on
   2026-10-10 (relayed by the parallel session).
2. Add a scheduled job that runs the `--live` check. It needs a token that can read branch
   protection; the default `GITHUB_TOKEN` cannot. If that requires a new secret, okan decides.

Deadline 2026-10-13.
