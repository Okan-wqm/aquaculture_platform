# Finding Registry — `findings.jsonl`

**Purpose:** append-only, hash-chained state store for every CATCHER-produced finding in the enterprise-v2 agent review cycle. Closes the CLAUDE.md traceability loop: `Closes: docs/reviews/{agent}/{date}-{topic}.md#{finding-id}` commit trailers are meaningless without a persistent registry that records every finding ID and its lifecycle state.

Landed 2026-04-16 as Phase 6 of `/root/.claude/plans/abstract-brewing-mochi.md`.

## Files

- `findings.jsonl` — one JSON object per line; append-only; hash-chained (each entry's `prev_hash` = previous entry's `content_hash`).
- `findings.jsonl.schema.json` — JSON Schema validating every entry structure.
- `.github/workflows/finding-registry-authority.yml` — the only operator entry
  point for `add` and `close`; it binds each request to protected `main`, mints
  repository-scoped credentials, and publishes a reviewable automation PR.
- `.github/workflows/finding-state-sweep.yml` — the only `sweep` entry point.
- `<git-common-dir>/finding-registry-v1.lock` and
  `<git-common-dir>/finding-id-reservations-v1.json` — internal runner fences
  used beneath the repository-global authority. Their presence never grants a
  local process permission to mutate the registry.
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

## Mutation authority — one repository-global writer

Operators and agents MUST NOT edit `findings.jsonl`, invoke its mutating CLI
commands, or run historical seed/rechain/dedupe helpers from a checkout. A
worktree lock can serialize processes on one host, but it cannot establish
repository-global identity or prevent two independent clones from allocating
the same finding. The GitHub Actions authority is therefore the sole mutation
boundary.

Before every dispatch, fetch `origin/main`, record its full 40-character SHA,
and dispatch the workflow with `--ref main`. The run is valid only when its
recorded head SHA equals that protected-main SHA. The workflow resolves the
immutable `created_at` of its exact Actions run (stable across reruns), obtains
an operation-bound OIDC authority, verifies the complete registry, and
publishes exactly one signed commit on the logical
`automation/finding-registry-active` namespace. Its physical branch appends the
repository-global command-identity digest and is create-only: no publisher
deletes, force-updates, or reuses a competing ref. The complete request/retry
identity remains signed commit evidence; if a reused command changes its base,
input, body, operation, or content, the existing command branch makes the
attempt fail closed instead of opening a duplicate PR. Merge registry PRs
sequentially and only at their exact green head.

Every request carries a retry-stable `command_id` and `effective_at`. Record the
canonical UTC effective time in the external ticket/request before the first
dispatch, and reuse both values byte-for-byte on every retry. The workflow
rejects future values and values outside the 90-day evidence window. Never
reuse a command ID for different inputs. The protected-main commit trailers and
the immutable command branch preserve the idempotency key before and after
merge, so an exact replay is recovered or becomes a verified no-op and a
semantic mismatch fails closed.

### Add

Prepare a JSON object containing only caller-owned finding fields. Do not
include `id`, `state`, timestamps, closing commits, or hash-chain fields; the
authority allocates and derives them.

```bash
git fetch origin main
PROTECTED_MAIN_SHA="$(git rev-parse origin/main)"
test "${#PROTECTED_MAIN_SHA}" -eq 40
COMMAND_EFFECTIVE_AT='2026-07-30T12:00:00.000Z' # record once in the external request

gh workflow run finding-registry-authority.yml --ref main \
  -f operation=add \
  -f command_id='review-2026-07-30:infra-capacity:add' \
  -f effective_at="${COMMAND_EFFECTIVE_AT}" \
  -f domain=INFRA \
  -f finding_json="$(jq -c . /tmp/new-finding.json)"
```

Allowed add fields are `severity`, `title`, `layer`, `evidence`,
`rule_violated`, `owner_agent`, `raised_in_cycle`, `review_file`, `deadline`,
`owner_user`, `override_of`, `notes`, and `narrative`. The allocated ID is the
next repository-global suffix for the domain; callers cannot select or copy an
ID from another clone.

### Close

The fix commit must already be reachable from protected `main`, carry the
matching `Closes:` trailer, and be supplied as a full lowercase 40-character
SHA. Short SHAs and branch-only commits are rejected.

```bash
git fetch origin main
PROTECTED_MAIN_SHA="$(git rev-parse origin/main)"
test "${#PROTECTED_MAIN_SHA}" -eq 40
FIX_COMMIT_REF='origin/main' # set to the protected-main fix commit when it is an ancestor
CLOSING_SHA="$(git rev-parse "${FIX_COMMIT_REF}^{commit}")"
test "${#CLOSING_SHA}" -eq 40
git merge-base --is-ancestor "${CLOSING_SHA}" origin/main
COMMAND_EFFECTIVE_AT='2026-07-30T12:30:00.000Z' # record once in the external request

gh workflow run finding-registry-authority.yml --ref main \
  -f operation=close \
  -f command_id='finding-INFRA-HIGH-046:close' \
  -f effective_at="${COMMAND_EFFECTIVE_AT}" \
  -f finding_id=INFRA-HIGH-046 \
  -f closing_sha="${CLOSING_SHA}"
```

Retry the same close with the same `command_id`. Review and merge the generated
automation PR only after all required checks pass on its exact head.

### Sweep

Lifecycle aging remains owned by `.github/workflows/finding-state-sweep.yml`.
Its scheduled run is canonical; an operator may use that workflow's
`workflow_dispatch` for a dry run or an authorized sweep. Do not emulate a sweep
with add/close requests or a local CLI invocation.

Local commands are read-only diagnostics only:

```bash
npm run findings:verify
```

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
