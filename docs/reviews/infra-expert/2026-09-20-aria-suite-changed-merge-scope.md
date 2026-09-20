# aria-suite-changed gate — merge-from-main scope (2026-09-20)

**Reviewer:** infra-expert · **Cycle:** 2026-09-20-pr1629-merge-from-main ·
**Surface:** `scripts/ci/aria-suite-changed.mjs`, `.husky/pre-push`

## Context

PR #1629 (`claude/wonderful-archimedes-msrlg9`) merged `origin/main` to resolve a conflict in the
finding registry. The branch's own content diff against main touches **no ARIA surface at all**:

    $ git diff --name-only origin/main...HEAD -- aria-kernel tools/aria-poc \
        tools/aria-adapters .github/workflows .github/actions \
        scripts/ci/aria-suite-changed.mjs scripts/ci/aria-suite-run.sh package.json
    (empty)
    $ git merge-base --is-ancestor origin/main HEAD && echo ancestor
    ancestor

The gate nevertheless selected 431 of the ~440 kernel test modules:

    aria-suite-changed: 47 ARIA-surface file(s) changed since
      origin/claude/wonderful-archimedes-msrlg9; running 431 affected test module(s)

Those 47 files are main's, brought in by the merge commit. `origin/main` is an ancestor of HEAD, so
every one of them is already on main and already verified by main's own aria-kernel lane. The push
ran 4 959 unittest tests in 3 716 s (62 min) plus 88 native-pytest tests, and passed — proving the
selection was not just expensive but redundant.

## Findings

### PROC-MEDIUM-033 — the pre-push ARIA gate re-verifies what the base branch already verified

**Severity:** MEDIUM · **Owner:** @okan-wqm · **Deadline:** 2026-10-31

`baseRef()` prefers `origin/<branch>` — the honest "already verified" point for the branch's own
history. After `git merge origin/main`, however, every ARIA file main has touched since the last
push falls inside `origin/<branch>...HEAD` and reads as new. The gate then selects effectively the
whole kernel suite for a branch that authored none of it.

This is the same failure class the sibling clippy gate already rejects in its own docblock —
"`origin/main...HEAD` would catch ALL that accumulated debt every push" (ORPHAN-LOW-035) — and that
`PROC-MEDIUM-027` fixed for `clippy-affected` on 2026-09-05, by intersecting the branch-side set
with the integration base. `aria-suite-changed.mjs` was added afterwards and reintroduced the
defect through the base branch instead of through the branch's own history. Two gates in one hook,
one already immunised, the other not: the lesson had not been made structural.

**Why MEDIUM and not HIGH:** unlike `PROC-MEDIUM-027`, this one does not make the push impossible.
It was pushed, honestly, with every gate run to completion and none bypassed. The cost is time —
but the time is not bounded by the branch: `main` advanced twice (`2ee11ed62` → `0239eecc8` →
`25070186c`) during the 62-minute run, so each merge-to-resolve begets another 62-minute gate
against a base that has moved again. Against a fast-moving main that is a livelock, which is why
it is not LOW.

**Fix (this cycle):** a file counts as unverified only when it differs from BOTH the remote branch
tip AND `origin/main`. `surfacesChangedSince(ref)` is called for each and the two sets intersected.
The three-dot form measures from the merge-base, so the exclusion holds whether the branch merged
main's tip or an older main; when the base IS `origin/main` (a branch's first push) the second
lookup is skipped and the behaviour is unchanged. The gate logs how many files it excluded and
why.

Coverage is not reduced. A file the branch actually authors differs from main too, so it stays in
the intersection and still selects its tests. Verified on this branch after the fix:

    aria-suite-changed: 2 ARIA-surface file(s) reached this branch by merging origin/main;
      already verified there, not selected here.
    aria-suite-changed: no ARIA surface touched since origin/claude/...; suite skipped.

`ARIA_SURFACES` contains `aria-suite-changed.mjs` itself, so this change correctly triggers the
gate's own self-validation clause and runs the FULL suite on the push that lands it. That is the
design working, not an obstacle.

**Not changed:** the affected-test mapping, the safety floor that falls back to the full suite on a
mapping hole, `ARIA_SUITE_FULL=1`, and the gate self-validation clause. `tests/invariants/
aria-doc-runtime-ssot.spec.ts` and `tests/invariants/git-hook-binding.spec.ts` (32 assertions)
pass unchanged.

## Environment notes (not findings against this repository)

The kernel suite could not run at all in the Claude Code remote container until four packages were
installed; each failure mode is worth recording because none of them names its own cause clearly
from the test output alone:

| Missing          | Symptom                                                | Tests affected in an 8-module sample |
| ---------------- | ------------------------------------------------------ | ------------------------------------ |
| `bubblewrap`     | `SandboxUnavailable: bwrap is not usable on this host` | 3 errors + 3 failures                |
| `openssh-client` | `RuntimeError: ssh-keygen not on PATH`                 | 40 errors                            |
| `pytest`         | `_FailedTest` import errors                            | 4 errors                             |
| `gh`             | PR-lane tests                                          | included above                       |

`bubblewrap`'s message warns that "installed is not enough — a container without unprivileged user
namespaces will install it cleanly and fail every invocation". Here `user.max_user_namespaces` was
64313, so the kernel prerequisite was satisfied and the package alone was missing.

Three platform-injected environment variables also break hermetic assertions the suite makes. Both
affected tests pass once the variable is absent; neither is a test defect:

- `GIT_CONFIG_KEY_0..2` (the proxy's `credential.interactive` and two `url.insteadOf` rewrites)
  surface in `test_implementation_delivery` as `credential_names == ['GIT_CONFIG_KEY_0',
'GIT_CONFIG_VALUE_0']` against an expected `[]`. The credential accounting matches env var
  _names_; `GIT_CONFIG_*` is not a credential. On any host that configures git through the
  environment, the credential-refusal gate misreports what a push carried.
- `RUSTUP_HOME=/root/.rustup` makes the sandbox ro-bind the real home's rustup instead of the
  test's fake home, while `CARGO_HOME` (unset) resolves correctly under it — the two toolchain
  paths are resolved by different rules.

Both are ARIA-side observations raised here for the record; closing them is not this cycle's work.
