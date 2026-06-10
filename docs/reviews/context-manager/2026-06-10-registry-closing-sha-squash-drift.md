# Registry closing_commits vs squash-merge drift (2026-06-10)

**Context.** The three-store invariant (`tests/invariants/three-store-invariants.spec.ts`,
store-2: "every closing_commits SHA exists in git history") began failing on
every fresh checkout after the #378 squash-merge + head-branch deletion.
Seven registry rows (AUDIT-CRITICAL-004, CLAUDE-HIGH-013/014/015,
CLAUDE-MEDIUM-012, MT-LOW-001, SEC-CRITICAL-001) recorded the *pre-squash
branch commits* `399f75497` / `595f3138d` as closing commits. Squash-merge
rewrote that history into `354c2a279`; deleting the merged branch removed the
last ref that kept the original SHAs fetchable, so CI clones could no longer
resolve them. The invariant did its job — the registry rows were the stale
artifact.

## Hotfix (this PR)

Remap the seven rows' `closing_commits` to `354c2a279` — the squash commit
that actually landed the content on `main` AND carries all seven matching
`Closes:` trailers in its message (verified: `git log -1 --format=%B
354c2a279` lists exactly the seven finding ids). Chain rebuilt with
`finding-registry rechain-from 262`; `findings:verify` green.

## PROC-HIGH-001 — close ceremony records branch SHAs that squash-merge invalidates

**Root cause (process/tooling, not this incident):** `finding-registry close
<id> <sha>` is run on the feature branch before merge, so it can only record
branch-local SHAs. Under the repository's squash-merge policy those SHAs are
structurally guaranteed to die with the branch. Any future
squash-merge + branch-delete of a branch that closes findings will reproduce
this failure.

**Architectural fix direction (owner decision needed, pick highest tier):**
1. *Make it impossible:* close ceremony moves post-merge — a `main`-side
   automation (or merge-queue step) resolves `Closes:` trailers in the squash
   commit and writes `closing_commits` with the merge SHA itself.
2. *Make it detectable earlier:* `cmdClose` warns/fails when the SHA is not
   reachable from `origin/main`, forcing the post-merge ceremony.
Until one lands, every manual `close` MUST use the post-merge (squash) SHA.

**Status:** OPEN — hotfix here only repairs the seven rows.
