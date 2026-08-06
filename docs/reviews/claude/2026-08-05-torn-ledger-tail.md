# A torn tail is not tampering

Date: 2026-08-05
Branch: `claude/aria-crash-findings`
Scope: `aria-kernel/aria_kernel/ledger.py` (strict verification),
`.github/workflows/aria-external-watchdog.yml`
Plan: `docs/plans/2026-08-02-aria-full-autonomy-program/PLAN.md` — Wave 2
completion criterion

## How this surfaced

PLAN Wave 2 completes on a crash-injection suite: _"crash-injection
testlerinin tamamında mission kaldığı yerden devam eder."_ The obvious way to
build one is to race a `SIGKILL` against a transition. The better way is to ask
what residue a crash actually **leaves**, and produce that deterministically.

A crash mid-append leaves three things: a partial final line, a possible
duplicate on retry, and a stale lock. The first one was measured before
anything was written.

## ORPHAN-CRITICAL-561

`_append_jsonl_locked_body` writes a row with a single `os.write` followed by
`os.fsync`. A crash between them leaves an incomplete final line — ordinary,
expected, and not evidence of anything except an interrupted process.

`_verify_jsonl_from_text` wraps its whole line walk in one `try`, so a
`json.JSONDecodeError` **anywhere** — including on the last line — returns
`valid=False`. Both `load_jsonl(verify=True)` and
`_verify_existing_declared_chain_before_append` then raise.

Measured on a mission ledger holding two good rows plus a truncated third:

```text
rows before crash: 2
fold RAISED:              LedgerIntegrityError … Unterminated string …
next transition REFUSED:  LedgerIntegrityError … Unterminated string …
```

The surface can be neither read nor advanced. Not the mission — **the
surface**, and with it every mission recorded in it. One interrupted process
ends the mission layer until a human repairs a JSONL file by hand.

The blast radius is not missions. Every strict-read declared surface goes
through this path, so this is a property of the state manifest as a whole.

**The two conditions are distinguishable, and collapsing them is the defect.**
An unparseable **last** line behind a hash-verified prefix is a torn write, and
the incomplete row was never acknowledged to any caller — the append returns
only after `fsync` — so discarding it loses nothing that anyone was ever told
existed. An unparseable line in the **middle**, or any `ledger_hash` mismatch
on a complete row, is corruption or tampering and must stay exactly as fatal as
it is today.

This is the day's recurring shape in the most load-bearing module in the
kernel: two different conditions, one verdict, and the verdict chosen for the
dangerous one applied to the harmless one.

**Deliberately not fixed in the commit that found it.** `ledger.py` is what
every surface writes through, and this landed hours before a nightly whose
executor lane was already failing for reasons only half diagnosed. A change
there earns its own PR, its own mutation checks, and a morning.

## ORPHAN-MEDIUM-562

The external watchdog (#1091) shipped the detect half of PLAN's _"anomalide
breaker MERGE_FROZEN + operator notification"_. It files and updates an
incident issue and fails its own run; it does not freeze merges.

The omission is structural, not an oversight. Freezing writes the breaker
ledger, which means importing the ARIA kernel — and every failure the watchdog
exists to catch is a failure of that kernel. A watchman that dies of the
illness it watches for is not a watchman.

So the freeze cannot be a write the watchdog performs; it has to be an alarm
the **merge side reads**. `aria-merge-authority` is already a required check
and already runs on the merge path: it can refuse while a watchdog incident is
open, which keeps the dependency pointing the safe way — the enforcing side
depends on the watchdog's output, never the reverse.

Registered rather than assumed, so "the watchdog does not freeze" is a tracked
gap with an owner and a date instead of a fact someone discovers during an
incident.

## Findings

- **ORPHAN-CRITICAL-561** — a torn trailing line permanently bricks a governed
  ledger for both reads and writes.
- **ORPHAN-MEDIUM-562** — the watchdog detects a memory stall but cannot
  enforce one; the freeze belongs on the merge side.

Owner: okan
