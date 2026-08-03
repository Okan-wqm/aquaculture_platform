# ARIA — the gate that corrupted the repository it guards

Date: 2026-08-03
Branch: `claude/aria-w2-mission-core`
Scope: `aria-kernel/tests/_helpers/hermetic_git.py`,
`aria-kernel/tests/test_suite_git_hermeticity.py`
Found: live, during a routine `git push`

## What happened

Pushing Wave 2 ran `.husky/pre-push`, whose last gate is
`scripts/ci/aria-suite-changed.mjs` — the local mirror of the ARIA kernel suite,
added so a red suite could not be pushed. It ran, and it **committed test
fixtures into the real repository**: `core.bare=true`,
`user.email=fixture@aria.test`, `remote.origin.url` rewritten to a fixture
literal, about twelve stray commits, four branches, two worktree registrations
pointing into `/tmp`, and the files `x.ts` and `src/a.ts` staged onto the real
index.

The gate damaged the thing it exists to guard.

## `cwd=` is not the same question as "which repository"

Every fixture in this suite is careful. `git_fixtures._git` passes
`cwd=<tempdir>` on every single call and its docstring says so. That is true,
and it is beside the point.

**`cwd` selects the WORK TREE. `GIT_DIR` selects the REPOSITORY.**

`git` exports an absolute `GIT_DIR` into its own environment whenever the git
dir is not the plain `.git` in the current directory — which is _always_ the
case inside a linked worktree. So `git push` from a worktree hands
`GIT_DIR=<repo>/.git/worktrees/<name>` to its hooks; `.husky/pre-push` hands it
to `aria-suite-changed.mjs`; that script forwards `process.env` verbatim into
the Python suite; and `subprocess.run(["git", ...], cwd=tmp)` passes `cwd=` but
never `env=`, so the variable rides all the way down.

With an explicit `GIT_DIR` and no `GIT_WORK_TREE`, git's
`setup_explicit_git_dir()` falls through to `set_git_work_tree(cwd)`. So
`git add x.ts` read the file out of `/tmp` and staged it into the **real**
index under that relative path, and `git commit` moved the **real** HEAD.

`core.bare = true` is the detail that identifies the mechanism rather than
merely describing the damage. `git init` run normally at a repo root writes
`core.bare = false`; the only way to get `true` is `guess_repository_type()`
seeing a `GIT_DIR` that neither equals cwd nor ends in `/.git` — and
`…/.git/worktrees/wt-w11` ends in the worktree name. For a linked worktree
`git_path("config")` then resolves through `commondir` to the **main**
`.git/config`. That is exactly the observed symptom, and no
"missing `cwd=`" hypothesis can produce it.

The fingerprint is unambiguous: `gc.auto`, `gc.autoDetach` and
`maintenance.auto` are written by exactly three lines in the entire codebase —
`git_fixtures.py:58-60` — and all three were sitting in the host config.

## Why the same suite was harmless ten minutes earlier

I had run the full suite twice by hand that afternoon, 3148 tests green, no
damage. The difference is not the tests and not the working directory: it is
that a hand-run suite has no `git` in its process ancestry, so no `GIT_DIR` to
inherit. **The suite is only dangerous when git itself launches it** — which is
precisely and only the case for the pre-push hook that exists to run it.

A latent defect that fires exclusively under its own gate is one that testing
the gate by hand can never find.

## The fix, and why it lives where it does

`apply_hermetic_git_env` already existed and already ran at package import
(`tests/__init__.py`). It redirected `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` and
claimed that made "ambient leakage structurally impossible for every fixture in
the process". It closed ambient _configuration_; it never touched the family
that decides ambient _repository_. The docstring's guarantee was wider than the
code's.

The nine repo-location variables are now **removed**, not overridden — there is
no value of `GIT_DIR` that means "use the directory I am standing in", so
absence is the only way to say it. `hermetic_git_env_is_active` folds that
absence into its definition, so the predicate cannot answer "hermetic" while
`GIT_DIR` points at the host repo.

Scrubbing at process start was chosen over passing a sanitised `env=` at each
call site for the same reason the original config fix was: one place covers
every fixture, factory-built or inline. Threading `env=` through the ~30 inline
`git init` sites would be the version that is one forgotten call site away from
recurring.

## Verification

Three new invariants beside the existing six:

- **I-HERM-07** — the location variables are scrubbed from a supplied
  environment (and unrelated variables are left alone).
- **I-HERM-08** — a leaked location variable makes the environment report
  itself INACTIVE.
- **I-HERM-09** — end to end: a child process inheriting `GIT_DIR` pointed at a
  sentinel repo builds a fixture in a temp directory the way ~30 test files do;
  the sentinel's HEAD and commit count must be unchanged.

Mutation-checked three ways:

| Mutation                                    | Result       |
| ------------------------------------------- | ------------ |
| the scrub deleted (the pre-fix world)       | 2 tests fail |
| `GIT_DIR` alone dropped from the vocabulary | 1 test fails |
| the predicate stops checking absence        | 1 test fails |

The first is the one that matters: it restores the exact pre-fix behaviour and
I-HERM-09 fails, which is what makes it a reproduction rather than an
illustration.

## What this does NOT fix

`scripts/ci/aria-suite-changed.mjs` still forwards `process.env` wholesale, and
`.husky/pre-push` still runs inside git's exported environment. Those are now
harmless because the suite defends itself, and that is the correct layering —
the suite cannot assume anything about who launches it. Hardening the launcher
as well would be defence in depth, not a second answer.

## Finding

- **ORPHAN-CRITICAL-543** — the kernel suite writes into the host repository
  when it inherits `GIT_DIR`. CLOSED here.

Owner: okan
