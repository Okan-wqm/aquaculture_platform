# The published tail hash does not survive one night

Date: 2026-08-05
Branch: `claude/aria-state-recovery`
Scope: `memory_gap.py` (`restore_and_replay`), `state_store.py`
(`read_snapshot_at_worktree_head`, `rebase_store_onto_remote`), `cycle.py`
Plan: `docs/plans/2026-08-02-aria-full-autonomy-program/PLAN.md` — Wave 1, §2.5

## What this branch set out to do

PLAN §2.5 promised `restore_and_replay` and PR 2.6 deferred it, correctly: a
restore primitive with no transport would have been a capability with no
caller. The transport exists now, so the recovery was written — and writing it
surfaced why it cannot yet run.

## ORPHAN-HIGH-552 — two writers, one file, two formats

`append_declared_jsonl` writes ledger rows **without** a `schema_version`
field. `migrate_tools_v1_to_v2` / `v2_to_v3` stamp it and re-chain every row
from the first unstamped one onward. And the migration runs on **every**
restore, because `tools_contract_version` reads `repo_identity.json` — the file
the state branch deliberately does not carry, because it records a
runner-absolute `bound_repo_root`.

So each night's bind rewrites the rows the previous night appended, changing
their `ledger_hash` and with it the surface's `tail_ledger_hash`.

Measured over the exact production loop — restore → bind → append → publish →
restore → bind — seeded with the **real rows from the live `aria/state`
branch**:

```text
night 1: published tail 9ec3d7f5… -> after bind 9ec3d7f5…   SURVIVES=True
         appended row schema_version=<ABSENT>
night 2: published tail 0127a841… -> after bind a7f8ed2b…   SURVIVES=False
```

Night 1 survives because those rows already carry `schema_version: 3`. The row
appended that night does not, and night 2's bind stamps it.

**The consequence.** `append_only_suffix` proves a local prefix by comparing
the row at the base's last index against the base's recorded tail hash. That
comparison can never hold across a restore, so
`publish_with_contention_replay` raises `replay_prefix_diverged` for every real
contention between the 01:00 producer and the 02:00 executor: a lost publish
race is **unrecoverable rather than replayed**. The same refusal blocks
`restore_and_replay`.

**Not an emergency tonight**, and the distinction is worth keeping. The nightly
is single-lane, so nothing contends; and `state_continuity` proves descent by
comparing the store worktree's HEAD against the remote tip — commit SHAs, not
row hashes — so the gate is unaffected. The defect bites when the executor lane
genuinely races the producer, and when recovery is needed.

## My first two readings were both wrong

Worth recording, because the correction is the method.

Reading the migration suggested "it re-chains once, then stops". A two-night
test agreed — and it was wrong, because row 0 stabilises while the **tail**
keeps moving, and the tail is the only row `append_only_suffix` checks.

A sandbox test then suggested "it re-chains every night from the start". Also
wrong: the live tree's rows already carry `schema_version: 3`, so night 1
survives.

Only the exact production loop, seeded with the real branch rows, gave the true
shape. Three readings, two wrong, and the difference each time was whether I ran
it against production data or reasoned about it.

## What landed here

`read_snapshot_at_worktree_head` — the snapshot **this worktree was built on**,
which is a different question from `read_published_snapshot`'s "what does the
remote say is published". The latter anchors on the remote-tracking ref by
design (`_publication_anchor`: nothing local may vote on what is published). A
replay base is the other question, and passing the tip instead makes
`append_only_suffix` refuse — correctly, having been asked the wrong thing.
Found by running the recovery, not by reading it.

`rebase_store_onto_remote` is public now: two callers, two reasons, one copy.
The publish race adopts the winner; the recovery adopts the published tip. Same
three guarantees either way — rows leave disk before the reset, the reset is
exact rather than approximate, and the replay re-chains through the normal
appender.

`restore_and_replay` itself, wired into `run_enterprise_cycle` **before** the
freeze. That ordering deviates from PLAN §2.5 deliberately: the plan says
freeze, restore, then `reset_breaker` — but `reset_breaker` requires an
`operator_approval_ref` and truncates the failure ledger. Calling it
automatically would forge an operator's signature and destroy unrelated
evidence, so a freeze followed by a successful recovery would leave a row only a
human could clear — precisely the manual step recovery exists to remove.
Recovering first leaves no residue.

A recovered gap is recorded in `governance.jsonl`, not as a breaker failure: the
breaker means "ARIA must stop", and a tree that has been restored and re-judged
continuous is not a tree that must stop. An unrecovered gap still freezes, and
the phase's verdict is left exactly as recorded — rewriting `blocks_action` to
False would edit the run's own history to match its outcome.

## The fix, and what running it found (2026-08-05, same branch)

The diagnosis above was itself one layer short, and the measurement that
proved it is worth recording. The first fix mirrored the migration's rule —
`schema_version < 2 → 2` — into the appender, on the theory that the two
writers merely needed one definition. The unit suite refused: a
cost-attribution row's `schema_version` is **1 by contract**
(`aria/cost-attribution/v1`), and the stamp had just rewritten it. Scanning
the live branch settled the real shape: **zero** rows have the field absent,
and fifteen ledgers (mission-events, plans/events, autonomy_state,
agent-invocations, …) carry explicit `1` — their own payload-contract
version. One field name, two meanings. The migration's restamp could not tell
"legacy row from before versioning" from "current row whose contract IS v1",
and its nightly "normalisation" of the latter — not the appender's missing
stamp — was the mechanism moving those fifteen tails on every bind.

So the ONE definition, `ledger.stamp_row_format`, says: **fill silence, never
overwrite speech.** An absent field becomes `ROW_FORMAT_VERSION`; an explicit
one is the surface's contract and passes through untouched. The governed
appender applies it (a silent row stops being possible), the migration imports
the same function (its rewrite is byte-idempotent by construction), and the
private `_restamp` is deleted.

Re-measured over the same production loop, seeded with the live branch rows:

```text
night 1: bind rewrites NOTHING (fifteen explicit-v1 ledgers preserved;
         governance grows by its own ceremony appends only)
         appended row schema_version=2
night 2: bind rewrites NOTHING; published tail survives   SURVIVES=True
night 3: contention replay across the restore boundary    REPLAY_OK=True
```

Night 3 is the capability 552 blocked, and running it found the next defect —
**ORPHAN-HIGH-555**: snapshot keys for glob surfaces are `name:relative/path`,
and the replay used that key both as a staging FILENAME (a path into a
directory that does not exist) and as `expected_surface` (which the
declared-surface gate refuses, because it speaks manifest names). Every
plain-surface unit test passed; the live tree carries glob-fanned ledgers, so
every real contention and every recovery would have refused. Fixed here:
`surface_key_name` lives in `state_manifest` — the module that owns the
vocabulary — the replay stages by ordinal and appends by manifest name, and
`test_a_glob_surface_survives_the_replay` pins it. The fourth instance this
week of a control correct only while its real input did not exist.

Running the loop also measured what the bind actually is: a full migration.
Each restore snapshots the tools tree into `.backups/`, rewrites every ledger
under a legacy allowance that **expires 2026-12-31**
(`MIGRATION_REWRITE_EXPIRES_AT`; `_raw_jsonl_legacy_allowed` requires
`expires_at > now` — measured, not read), and appends ~9 migration-ceremony
governance rows per night. Three symptoms, one cause — binding and migrating
share a code path — recorded as **ORPHAN-HIGH-556** with a 2026-09-30
deadline, deliberately not attempted in the 552 commit: with the rewrite now
byte-idempotent the bind is _correct_ today, and a bind-only restore changes
the restore action's contract, which is a separate change needing its own
proof.

## Findings

- **ORPHAN-HIGH-552** — registered here, with the measured production loop as
  evidence. Fixed on this branch; close ceremony rides the next PR
  (PROC-HIGH-001).
- **ORPHAN-HIGH-555** — glob surface keys break replay staging and the
  declared-surface assertion. Found by running the recovery; fixed here.
- **ORPHAN-HIGH-556** — the restore bind is a migration: backup churn,
  per-night ceremony rows, and a 2026-12-31 rewrite-permit expiry that kills
  every nightly restore on 2027-01-01. OPEN, owner + deadline registered.

Owner: okan
