# Finding Registry — `findings.jsonl`

**Purpose:** append-only, hash-chained state store for every CATCHER-produced finding in the enterprise-v2 agent review cycle. Closes the CLAUDE.md traceability loop: `Closes: docs/reviews/{agent}/{date}-{topic}.md#{finding-id}` commit trailers are meaningless without a persistent registry that records every finding ID and its lifecycle state.

Landed 2026-04-16 as Phase 6 of `/root/.claude/plans/abstract-brewing-mochi.md`.

## Files

- `findings.jsonl` — one JSON object per line; append-only; hash-chained (each entry's `prev_hash` = previous entry's `content_hash`).
- `findings.jsonl.schema.json` — JSON Schema validating every entry structure.
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

## How to append a finding

**Manual (until Phase 2 CLI lands):**

```bash
# Inspect current last entry's content_hash:
tail -n 1 docs/reviews/_registry/findings.jsonl | jq -r '.content_hash'
# Compose new entry with prev_hash = that value.
# Compute content_hash = sha256 over JSON with content_hash field excluded.
# Append to findings.jsonl.
```

**Via Phase 2 CLI (once landed):**

```bash
# tools/gates/finding-registry.ts add <finding-json>
# tools/gates/finding-registry.ts transition <id> <state> [--commit <sha>]
# tools/gates/finding-registry.ts sweep             # STALE auto-escalation
```

## Hash chain integrity

- First entry has `prev_hash: "0000...0000"` (64 zeros).
- Every subsequent entry: `prev_hash = SHA-256-hex(prev_entry.content_hash)` — NO, simpler: `prev_hash = prev_entry.content_hash` directly. The chain is tamper-evident because any mid-chain modification changes the hash and every downstream entry.
- `content_hash = SHA-256-hex( canonical JSON of this entry WITH content_hash field removed )`.
- Canonical JSON = key-sorted, no-whitespace serialization.

**Verification:** CI job `.github/workflows/closes-footer-check.yml` (Phase 6 deliverable) re-computes the chain on every PR; drift fails the build.

## Finding ID format

Per `_shared/output-format.md`: `{PREFIX}-{SEVERITY}-{NNN}`. Recognised prefixes:

```
DATA  SEC   PLAT  FE    EDGE  MT
FARM  SENSOR HR   MSG   ADMIN
ANTI  ADR   AUDIT CTX   INFRA  PROC
P0                              (Phase-0 audit bootstrap)
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
