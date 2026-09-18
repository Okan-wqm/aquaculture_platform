# Finding Registry — `findings.jsonl`

**Purpose:** append-only, hash-chained state store for every CATCHER-produced finding in the enterprise-v2 agent review cycle. Closes the CLAUDE.md traceability loop: `Closes: docs/reviews/{agent}/{date}-{topic}.md#{finding-id}` commit trailers are meaningless without a persistent registry that records every finding ID and its lifecycle state.

Landed 2026-04-16 as Phase 6 of `/root/.claude/plans/abstract-brewing-mochi.md`.

## Files

- `findings.jsonl` — one JSON object per line; append-only; hash-chained (each entry's `prev_hash` = previous entry's `content_hash`).
- `findings.jsonl.schema.json` — JSON Schema validating every entry structure.
- `<git-common-dir>/finding-registry-v1.lock` — process-owned lock present only while a mutation is active; it is not committed.
- `<git-common-dir>/finding-id-reservations-v1.json` — repository-local domain high-water ledger shared by active worktrees; it is not committed.
- `README.md` — this file.

## Lifecycle states

```
  OPEN ──── implementation-planner package created ────► IN-PROGRESS
   │                                                        │
   │                                            merged commit with `Closes:` trailer
   │                                                        │
   │                                                        ▼
   │                                                    RESOLVED
   │
   └── 30d without movement ──► STALE
   │
   └── arbiter ruling / override tracked ──► BLOCKED
```

### Reopening

`RESOLVED` is derived from merged history: `finding-registry reconcile` (and the
`finding-registry-closure-drift` gate) treat any `origin/main` commit whose `Closes:` trailer names
the finding as closure evidence. Two reopen paths exist, and they differ in what they say about that
evidence:

- `finding-registry reopen <id>` — registration repair. Only for a row registered `RESOLVED` at
  birth in error (no `closing_commits`). Clears the close fields; the real fix commit closes it later
  through `close`.
- `finding-registry reopen <id> --reject-closure=<sha> --reason=<why>` — override reopen. The row was
  closed through the ceremony, but the change did not actually close it (a version-gated tracking
  finding swept shut, a partial fix). The SHA moves from `closing_commits` to
  `rejected_closing_commits`; `close`, `reconcile` and the drift gate refuse it from then on, so the
  finding stays open until a NEW commit carries its trailer. Every closer must be rejected in the
  same decision: the recorded `closing_commits`, and every other `origin/main` commit whose trailer
  names the finding (`--reject-closure` may be repeated; the command lists what is still standing
  and refuses to write until nothing is). It also works on a row that is already OPEN, when the
  drift gate reports a merged commit as closing it. A free-text "[REOPENED ...]" note carries no such
  weight: the next reconcile would re-close the row from the same old commit, which is exactly what
  happened to PLAT-MEDIUM-901 on 2026-09-04.

## How to append a finding

Create a stub without an `id`, then let the CLI allocate and append it:

```bash
npm run findings:add -- INFRA /tmp/new-finding.json
```

`add` selects `max(NNN) + 1` from every existing classifier in the named
domain, regardless of the new finding's severity. For example, existing
`INFRA-LOW-045` makes the next HIGH id `INFRA-HIGH-046`. Allocation, duplicate
checking, schema validation, hash-chain extension, file fsync, and atomic rename
all execute under one exclusive lock. A caller-supplied `id` is rejected.

The fixed-id path exists only for governed historical import/replay:

```bash
npx ts-node --project tools/gates/tsconfig.json \
  tools/gates/finding-registry.ts add-explicit /tmp/historical-finding.json
```

All mutating subcommands (`add`, `add-explicit`, `close`, `sweep`,
`rechain-from`, and `dedupe`) share one lock in Git's common directory, so every
worktree of the same repository is serialized. Lock acquisition is bounded. A
stale lock is taken over only when its metadata is valid, it belongs to this
host, and its recorded process no longer exists. Malformed and foreign-host
locks fail closed. Ownership is fenced immediately before each atomic write and
release uses rename-then-token-verification, so a resumed stale owner cannot
unlink or overwrite a successor's lock.

Same-host stale-owner detection assumes all clients sharing the Git common
directory also share one PID namespace. Do not mount that common directory into
containers with isolated PID namespaces; use independent clones and the
sequential-PR rule below instead.

### Worktree and clone boundary

The allocator reads the current registry plus every registry in `git worktree
list`, then compares that maximum with the common-dir
`finding-id-reservations-v1.json` high-water ledger. It durably reserves the
chosen suffix before replacing the branch registry. A process crash after the
reservation can leave a gap, but that number is never reused by another active
worktree.

The common directory does not span independent clones on different machines.
Do not copy an allocated entry between clones. Refresh from `origin/main`,
allocate on the branch that will carry the finding, and merge registry-writing
PRs sequentially. If a remote registry PR lands first, update the branch and
run `add` again so the suffix is selected from the new main tip. The CI
uniqueness and hash-chain invariants remain the final cross-clone collision
gate.

The common lock also cannot make an allocator-old worktree client participate
retroactively. During cutover, treat every active worktree that does not contain
`finding-registry-store.ts` as read-only for registry operations. Do not close
the allocator rollout finding until those legacy writers are removed, advanced
to the authority-bearing main tip, or explicitly frozen while protected deploy
and certificate checkouts remain intact. `git worktree list --porcelain` is the
cutover inventory; CI and sequential registry PRs remain mandatory throughout
that window.

### Rechain boundary

`rechain-from <N>` is restricted to a branch-only suffix. Before writing, it
loads the locally fetched `origin/main` registry, requires every canonical entry
to remain identical (including hashes), and requires `N` to be at or beyond that
canonical prefix. It then validates the complete suffix against the JSON schema
and the post-cutover evidence contract before recalculating hashes. This permits
merge concatenation and correction of an unmerged malformed tail without
turning rechain into a way to bless edits to canonical history. `close` remains
the only command that can transition an already-merged row.

## Hash chain integrity

- First entry has `prev_hash: "0000...0000"` (64 zeros).
- Every subsequent entry: `prev_hash = SHA-256-hex(prev_entry.content_hash)` — NO, simpler: `prev_hash = prev_entry.content_hash` directly. The chain is tamper-evident because any mid-chain modification changes the hash and every downstream entry.
- `content_hash = SHA-256-hex( canonical JSON of this entry WITH content_hash field removed )`.
- Canonical JSON = key-sorted, no-whitespace serialization.

**Verification:** CI job `.github/workflows/closes-footer-check.yml` (Phase 6 deliverable) re-computes the chain on every PR; drift fails the build.

## Finding ID format

Per `_shared/output-format.md`: `{PREFIX}-{SEVERITY}-{NNN}`. The schema is the
authoritative prefix list; the allocator validates its complete output against
that schema before writing.

```
DATA SEC PLAT FE EDGE MT FARM SENSOR HR MSG ADMIN ANTI ADR AUDIT CTX INFRA PROC
P0 COMPLIANCE PERF OBS SUPPLY CONTRACT CIRCUIT MEM CLAUDE BILLING ALERT LEGAL
AUDITTRAIL TENANTCOST AISAFETY PRODUCT DEPLOY RUST ULTRA ORPHAN RBAC MOB
```

## Commit trailer convention

Every fix commit closing a finding MUST include:

```
Closes: docs/reviews/<agent>/<YYYY-MM-DD>-<topic>.md#<FINDING-ID>
```

`commit-msg-validator.ts` (Phase 2 deliverable) enforces:

1. `Closes:` trailer exists on every commit under `fix()`, `security()`, or `refactor(...phase-*)` type.
2. The cited review file exists.
3. The cited finding ID exists in this registry.
4. Transitioning a BLOCKED override requires the commit to be signed by the override's `owner_user` per `.github/CODEOWNERS`.

## What lives here vs. what lives in `docs/reviews/<agent>/`

- `docs/reviews/<agent>/<date>-<topic>.md` is the prose description: evidence, root-cause analysis, proposed fix direction, verification plan. **Narrative source.**
- `docs/reviews/_registry/findings.jsonl` is the structured index: ID, state, deadlines, closing commits, hash chain. **State source.**

Both are mandatory; one without the other is incomplete. The narrative file carries the `#<finding-id>` anchor; the registry carries the lifecycle state machine.

## Seed content

The initial commit seeds Phase-0 audit findings (`P0-*`) from `docs/reviews/orchestrator/2026-04-16-v2-audit.md`. These represent the bootstrap state — they were RESOLVED (mostly) before Phase 6 registry existed, so their `closing_commits` reference the already-landed Phase 0 / 4 / 5 commits retroactively. Future findings enter the registry with `state: OPEN` as they are raised.

## References

- `/root/.claude/plans/declarative-riding-shamir.md` D.6 (original registry design) + W10 lifecycle
- `/root/.claude/plans/abstract-brewing-mochi.md#Phase-6`
- `_shared/tier-claim-syntax.md` override protocol
- `_shared/output-format.md` finding ID format
- `CLAUDE.md` — Review Finding Traceability section
