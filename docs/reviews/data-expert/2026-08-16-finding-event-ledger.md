# 2026-08-16 - The finding registry's PostgreSQL side has no immutable history and no cutover proof

## DATA-HIGH-011 - a finding's state is a mutable row, so its history is unreplayable and authority cannot move off JSONL

**Severity:** HIGH. **Owner:** data-expert. **State:** IN-PROGRESS, opened and addressed by this PR.

### What is wrong

`docs/reviews/_registry/findings.jsonl` is the authority for finding state. The PostgreSQL side that was
supposed to take over from it — `libs/backend-common/src/finding-registry/` — models a finding as a **mutable
row**:

- `finding.entity.ts` maps `event_store.findings`, a table **no migration creates**. The mapping compiles, the
  table does not exist, and nothing notices because nothing reads it: no service imports
  `FindingRegistryService`. `libs/backend-common/src/constants/protected-tables.ts:133` still lists
  `event_store.findings`, so the protection list guards a table that was never built.
- State transitions overwrite the row. There is no record of _what changed, when, or on which `main` commit_,
  so a finding's history cannot be replayed and a wrong transition cannot be distinguished from a correct one
  after the fact.
- Closing-commit attribution is mutated **in memory after persistence**, so the durable row and the object the
  caller holds disagree.
- Concurrency is unserialised: two writers racing on the same finding both win, last-write-wins.

The consequence is not a bug in a feature — it is that **authority cannot move**. JSONL stays authoritative
because nothing in PostgreSQL can prove it holds the same truth.

### Why a row cannot be fixed into a ledger

Adding columns to `event_store.findings` would not help. The defect is that a row _is_ the state: any correction
is another overwrite, and the evidence of the correction lives only in the diff of a file nobody replays. The
recording model has to change, not its columns.

### What this PR does

- `libs/backend-common/src/finding-registry/finding-event.ts` becomes a **pure replay contract**: an append-only
  event carries the finding id, its version, the `main` commit it was observed on, and a content hash. State is
  a fold over events, so history is reconstructible by construction and a wrong transition is corrected by
  appending, never by overwriting.
- `apps/event-store-service/src/finding-registry/` owns persistence: `event_store.finding_events`, hash-chained
  and optimistically versioned, with a **single writer**. Migration `1801200000000-CreateFindingEventsLedger`
  creates it, makes it immutable in the database (`BEFORE UPDATE OR DELETE` and `BEFORE TRUNCATE` triggers that
  raise, plus `REVOKE UPDATE, DELETE, TRUNCATE ... FROM PUBLIC`), and `protected-tables.ts` is corrected to name
  the tables that now exist.
- Authority does not move on assertion. `tools/gates/finding-event-ledger.ts` refuses to hand over until **two
  consecutive JSONL-parity cycles** pass, recorded in `event_store.finding_ledger_parity_runs`. Until then JSONL
  stays authoritative and the ledger is a shadow.

### Boundary with PR #1040

PR #1040 deletes the same `libs/backend-common/src/finding-registry/` files and puts **nothing** in their place,
leaving `protected-tables.ts:133` pointing at a table that will never exist. Both approaches cannot land. This
one is preferred because it replaces the mutable row with a working ledger and a gate, rather than removing the
mapping and leaving the phantom reference behind.

### Evidence

- `libs/backend-common/src/finding-registry/finding.entity.ts` — maps `event_store.findings`
- `libs/backend-common/src/finding-registry/finding-registry.service.ts` — in-memory closing-commit mutation
- `libs/backend-common/src/constants/protected-tables.ts:133` — guards the never-created table
- `apps/event-store-service/src/migrations/` — no migration creating `event_store.findings`

### Provenance

Recovered from a codex worktree stopped on 2026-08-16 with the work uncommitted. The capability exists nowhere
on `main`. Its migration was additionally made idempotent (`IF NOT EXISTS` on both tables and all three indexes,
`IF EXISTS` on the rollback drops) and its genuinely destructive `down()` statements carry `-- DESTRUCTIVE:`
markers, neither of which the source worktree had.
