# The gate suite could redden any PR from its own teardown

Date: 2026-09-08
Reviewer: zcode
Scope: `tests/invariants/**`, `tools/gates/**`

## How this surfaced

PR #1491 carries admin-panel TypeScript and one Markdown file. `invariants-fast`
went red on it:

```text
FAIL ./backup-restore-verification-contract.spec.ts
  ● backup and isolated restore verification contract › rejects a symlink entry in the protected runtime commit tree

    ENOTEMPTY: directory not empty, rmdir '/tmp/aqua-runtime-bundle-repo-2kLgwL/.git'

    > 424 |       rmSync(fixture.root, { recursive: true, force: true });

Test Suites: 1 failed, 291 passed, 292 total
Tests:       1 failed, 3166 passed, 3167 total
```

Line 424 is the spec's own `finally`. Every assertion in the test passed. The
suite failed on teardown, and no part of the diff can reach a temp-directory git
fixture.

## INFRA-HIGH-172 — 106 teardowns with no retry budget

### Mechanism

Recursive removal is not atomic. Node walks the tree with readdir + unlink and
closes each directory with `rmdir`, so any entry appearing between the walk and
the `rmdir` surfaces as `ENOTEMPTY`. Two writers open that window here.

**Git.** `git commit` finishes by running `git maintenance run --auto --quiet`.
Measured, not inferred — on git 2.43 under the same hermetic environment the
fixture uses:

```console
$ GIT_TRACE=1 git -c user.name=t -c user.email=t@t.invalid commit --quiet -m x
run-command.c:659  trace: run_command: git maintenance run --auto --quiet
git.c:463          trace: built-in: git maintenance run --auto --quiet
```

`gc.autoDetach` defaults to true, so that task daemonises and keeps writing under
`.git` after `spawnSync` has already returned to the test. A fixture repo deleted
moments after a commit is racing a child nobody waits for. That is why the
failure landed on `.git` and on no other directory in the fixture.

**The filesystem.** CI runners layer the workspace on overlayfs, where deleting
an entry writes a whiteout rather than removing it and `rmdir` can transiently
observe a directory as non-empty.

### Why `force: true` was never the answer

`force` suppresses `ENOENT` and nothing else. The option that covers this class
is `maxRetries`, which Node documents as retrying precisely `EBUSY`, `EMFILE`,
`ENFILE`, `ENOTEMPTY` and `EPERM` on a linear backoff, and which is ignored
unless `recursive` is set. Leaving it at its default of `0` is the
misconfiguration; passing it is using the API as specified.

### Scale

Measured across the two trees that run as gates on every PR:

| Tree                  | recursive removals | passing `maxRetries` |
| --------------------- | ------------------ | -------------------- |
| `tests/invariants/**` | 87                 | 0                    |
| `tools/gates/**`      | 19                 | 0                    |

So this was never one flaky spec. It was 106 teardowns each able to redden an
unrelated PR, in the suite whose whole job is to be the signal people trust. A
gate that cries wolf on someone else's diff teaches the team to re-run it, and
that is how a real failure gets waved through. Repairing only the spec that
happened to lose the race would have left the other 105 loaded.

### Fix

Tier 1 for the git writer, tier 2 for the semantics, tier 3 to hold it.

1. `tests/invariants/backup-restore-verification-contract.spec.ts` — the fixture
   git environment now carries `gc.auto=0` and `maintenance.auto=false` via
   `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`. Verified: with those set, `GIT_TRACE=1`
   shows `git commit` making no maintenance invocation at all. Supplied through
   the environment rather than per-call `-c` flags so every git call the helper
   ever makes inherits them, including ones added later.
2. `tools/gates/fixture-tree.ts` — new module owning `removeFixtureTree` (force,
   for teardown) and `removeExistingFixtureTree` (no force, for the two mid-test
   setup removals whose must-exist precondition is load-bearing). All 106
   callsites converted.
3. `tests/invariants/fixture-tree-removal-ssot.spec.ts` — fails on any recursive
   `rm`/`rmSync` outside the owner, and fails if the owner loses its retry
   budget. This is the shape the repo already used for INFRA-HIGH-152: one module
   owns the semantics, and a gate keeps it the only spelling.

### Verification

- Negative control A: reintroducing `rmSync(dir, { recursive: true, force: true })`
  in `tests/invariants/helpers/nx.ts` fails the gate, reporting
  `tests/invariants/helpers/nx.ts:82`.
- Negative control B: deleting `maxRetries`/`retryDelay` from the owner fails the
  second test.
- Full `tests/invariants` suite: 290 passed / 293. The three failing suites are
  `production-host-ssh-payload`, `production-host-runtime-bundle` and
  `production-host-control-plane-runtime`, which fail **identically (23 tests)
  with the change stashed** — pre-existing local-environment failures that pass
  in CI, not regressions from this change.
- All ten converted `tools/gates/*.spec.ts` run green under ts-node.
- `tsc --noEmit` clean on both `tools/gates/tsconfig.json` and
  `tests/invariants/tsconfig.spec.json`.

## INFRA-MEDIUM-173 — fixture git repos inherit the ambient global git config

Twelve files build throwaway git repos and run `git commit` in them. Exactly one
— `backup-restore-verification-contract.spec.ts` — builds a hermetic environment
(`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, pinned `HOME`, `LC_ALL`).
The other eleven inherit whatever the invoking user's global config says:

- `tests/invariants/markdownlint-event-range.spec.ts`
- `tests/invariants/production-host-control-plane-runtime.spec.ts`
- `tests/invariants/production-host-ssh-payload.spec.ts`
- `tests/invariants/production-host-runtime-bundle.spec.ts`
- `tests/invariants/affected-development-pipeline.spec.ts`
- `tools/gates/banned-phrase.ts`
- `tools/gates/git-reachability.spec.ts`
- `tools/gates/aria-authority-hash.spec.ts`
- `tools/gates/finding-registry-store.spec.ts`
- `tools/gates/finding-traceability.spec.ts`
- `tools/gates/commit-msg-validator.ts`

A developer with `commit.gpgsign=true`, a `commit.template`, a `core.hooksPath`,
or a non-C locale gets failures that CI cannot reproduce, and the reverse: a
config-dependent bug stays invisible on the runner because the runner's config is
empty. The same auto-maintenance detach INFRA-HIGH-172 closes in one fixture is
still open in these eleven.

This is **not** fixed here. It is a different defect — config bleed, not a
teardown race — and closing it means one shared hermetic `runFixtureGit` adopted
across eleven files with eleven different invocation shapes, which is its own
change with its own blast radius. Tracked with an owner and a deadline rather
than folded into a teardown fix.

Owner: okan. Deadline: 2026-10-13.
