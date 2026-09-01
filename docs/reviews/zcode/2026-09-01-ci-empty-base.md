# CI affected-range empty-base outage — 2026-09-01

**Date:** 2026-09-01 · **Agent:** zcode · **Cycle:** 2026-09-01 advisory-gate-recovery
**Finding:** INFRA-HIGH-005 · **State:** OPEN → closed by this change

## What broke

The first push to `main` after merging the affected-development lane
(merge `0f01b52bf`, 14:57) turned `CI - Affected` red across four jobs
(type-check, lint, test, build-status) with:

```text
error: object 4b825dc642cb6eb9a060e54bf8d69288fbee4904 is a tree, not a commit
fatal: Invalid symmetric difference expression 4b825dc...0f01b52b
```

`4b825dc6…` is the empty-tree object. `scripts/ci/resolve-affected-range.ts`
returned it as `base_sha` whenever the `deployed/development` baseline tag
was missing, unresolvable to a commit, or not an ancestor of the head —
"validate everything" as a sentinel. But every consumer of `base_sha`
(`nx affected --base`, `lint-changed-files.sh`, `type-check-changed-files.mjs`)
runs `git diff base...head`, which requires a COMMIT.

## Root cause

A chicken-and-egg deadlock by construction: the baseline tag is only
created by a successful deployment run, and the pipeline that must go
green first cannot run against a non-commit base. `select-deployment-scope.ts`
special-cases the sentinel correctly, so the deployment lane survived —
the integration simply never gave the other CI jobs a usable base.

## The fix

The full-validation fallback is now the repository's oldest root commit
(`git rev-list --max-parents=0 <head>`, last line): `root..head` spans the
whole history, which IS the everything-affected intent, and it is always a
valid commit for every consumer. The three spec pins that codified the
sentinel were rewritten to the new contract (never deleted); RED reproduced
the exact production error before the change.
