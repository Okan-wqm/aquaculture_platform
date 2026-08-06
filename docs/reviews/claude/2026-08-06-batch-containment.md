# One bad item took the whole batch — 2026-08-06

## ORPHAN-HIGH-578 — a cycle learning hook commits inside an unguarded loop

### The shape

A hook iterates items and commits as it goes: a ledger row, a governance event,
an archived file. Item k raises. Three things then happen together:

1. items 1..k-1 are already **on disk**;
2. items k+1..n **never run**;
3. the hook's entire report is replaced upstream by one generic
   `learning_hook_failed` (`learning.py:126`).

The result is worse than either clean outcome, because a partial state becomes
indistinguishable from a total failure. An operator reading the cycle sees one
hook failed and cannot tell that two genesis requests were emitted, or that
three pressures did decay.

### How it was found, and why that matters

Not by a gate. `ORPHAN-HIGH-575` was this defect wearing a `TypeError`:
`plan_downstream_impact` raised on the repository's most ordinary commit shape —
code plus its own review document — and `_impact_graph_compute` contained only
`GovernanceError`, so the exception escaped the loop over **every** pending
dispatch. One pressure event disabled impact-graph computation for an entire
cycle.

Fixing that `TypeError` removed the instance. Asking the question mechanically
removed the assumption that it was one:

|                                               |        |
| --------------------------------------------- | ------ |
| cycle learning hooks                          | 16     |
| **hooks committing inside an unguarded loop** | **12** |
| modules holding them                          | 7      |

Twelve of sixteen is not a bug someone made once. It is the default way to write
a loop, and nothing in the repository disagreed with it.

### A second, quieter defect in the same function

`_impact_graph_compute` counted a refused computation as `skipped_no_evidence`.
The evidence was there; the graph declined it. Two different conditions
collapsed into one number, so `skipped_no_evidence: 3` could mean three
evidence-less pressures, three refusals, or any mixture. The counter now means
only what its name says, and refusals are reported as named failures.

## The fix

**`aria_kernel/batch_containment.py`** — `guard_item` runs one item's work and
records a failure instead of losing the batch. It lives in its own module rather
than in `learning` because the shape spans seven modules and `learning` imports
six of them.

Two decisions inside it are load-bearing:

- **`LedgerIntegrityError` is re-raised, never contained.** A corrupt ledger is
  not one item's problem; `_run_learning_hooks` re-raises it so the cycle
  aborts, and containing it here would silently demote the one failure a cycle
  must stop for into a line in a report.
- **It returns `(ok, value)`, not a bare value.** Returning `None` for failure
  would work for today's callers and rot the first time a hook's work returns
  nothing on purpose.

**Containment must not buy silence.** Per-item containment trades a loud
wholesale failure for a quiet partial one unless something says so, so
`_run_learning_hooks` reports a hook that lost items as `partial` rather than
`ok`, writes `learning_hook_items_failed` to workspace governance, and
`telemetry` emits `aria_learning_hook_item_failures_total`. A hook that lost
nothing omits the field entirely and stays `ok` — an always-present empty list
would make `partial` meaningless.

All twelve hooks are wired: `decay_recompute`, `artifact_prune`,
`impact_graph_compute`, `skill_or_agent_genesis`, `git_trailer_scan`,
`agent_satisfaction_scan`, `report_ingestion_scan`, `semantic_dedup_compute`,
`trust_escalation_derive`, `ref_staleness_check`, `triage_policy_apply`,
`agent_fitness_score`.

## The gate, and what it refuses to be

`tests/test_batch_containment_gate.py` fails when a learning hook commits inside
an unguarded loop. Two things about it were deliberate, and both were arrived at
by being wrong first.

**Nothing is a hardcoded list.** `ORPHAN-HIGH-569` was a discovery list that was
true when written and quietly stopped describing the repository, so:

- the **hook roster** is read from `_run_learning_hooks`'s own dispatch tuple —
  add a hook tomorrow and it is scanned tomorrow;
- **"committing"** is derived, not named. A curated list of writer names would
  miss the first writer called `persist_thing`. A function is a write primitive
  if its own body opens a file for writing or calls a filesystem mutator, and
  _committing_ if it can reach one through the call graph.

**Two false-positive classes were found by measuring, not by review.** A gate
that cries wolf gets waived into uselessness, so both were fixed rather than
tolerated:

| symptom                                                      | cause                                                                                                                                     |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `ledger.load_jsonl` — a pure read — came out committing      | the call graph was keyed by function _name_, so same-named private helpers across 2,400 functions merged their edges                      |
| `_age_days`, which parses a date, came out a write primitive | the seed matched the name prefix `record_`, sweeping in `_record_hash`; then bare `.replace` matched `str.replace` and `datetime.replace` |

Naming a writer is not writing. The seed now asks what the code does, and
ambiguous attributes (`replace`, `remove`, `move`, `copy`) require their module.
Nothing real is lost: every atomic write in this kernel calls `mkdir` and
`write_text` before it calls `tmp.replace`.

### The gate was blind and said nothing

Mutation G4 — empty the loop-body scan so the scanner sees nothing — left the
suite **green**. With zero real findings, a blinded scanner and a clean
repository produce the same empty result. That is #1110's lesson in a new form:
a green gate must be evidence that the gate can see.

The scanner now runs against synthetic known-bad input it must always flag, plus
known-good inputs it must never flag (guarded, `try`, loop-iterable,
outside-any-loop). G4 and "treat every call as guarded" are both red now.

### The waiver machinery is tested even though nothing uses it

The repository declares no waivers today. Shipping the mechanism untested would
have been this programme's signature defect — a control that is correct,
exported, and exercised by nobody — so the rules are a pure function of their
inputs and are driven directly: expired, expiring-today, each missing field,
empty reason, a hook since guarded, a hook that no longer exists.

The expiry is compared **to the clock**, not merely parsed. That is the lesson
`invariant-reachability.spec.ts` paid for when it validated the shape of
`expires_on` and let 25 waivers sail a month past a shared deadline in silence.

## Verification

Every fix mutation-checked; each applied, run, then reverted.

| mutation                                                       | result                                    |
| -------------------------------------------------------------- | ----------------------------------------- |
| restore the exact pre-fix `except GovernanceError` impact loop | red                                       |
| contain everything but report nothing                          | red                                       |
| bare loop in genesis / decay / prune                           | red each                                  |
| runner reports a partial batch as `ok`                         | red                                       |
| `guard_item` swallows `LedgerIntegrityError`                   | red                                       |
| un-guard a real hook loop (`trailer_scan`)                     | red                                       |
| over-broad seed (bare `.replace` counts as a write)            | red                                       |
| hook-roster derivation returns nothing                         | red                                       |
| blind the loop-body scan                                       | red _(green before the positive control)_ |
| treat every call as guarded                                    | red                                       |

One of my own tests was weaker than its name and was fixed rather than kept: the
ledger-corruption case drove the raise through the **hook** rather than through
an item, so it pinned `_run_learning_hooks`'s pre-existing behaviour and said
nothing about whether per-item containment swallows a corrupt ledger. It now
raises from inside an item.

### Containment introduced a regression of its own, in `report_ingestion_scan`

Worth recording because it is a hazard of this fix in general, not a slip in one
hook. Before containment, a raise propagated out and `_write_cache` never ran, so
nothing was marked seen. Containment made the hook always reach `_write_cache` —
and the loop marked each finding known _before_ trying to ingest it. A finding
whose ingestion failed would therefore be recorded as seen and **never offered
again**: silent, permanent loss of exactly the item the containment was supposed
to protect.

The rule the fix encodes: **containment must not consume the item it failed to
process.** A finding joins `known` only after it is actually ingested; a failed
one is left unknown so the next cycle retries it. Mutation-checked by restoring
the mark-before-ingest order — red.

A second, quieter note on the same test: its first version ended in
`self.skipTest(...)` when the fixture produced no ingest candidates, because the
first scan _baselines_ the cache and leaves nothing to ingest. A test that skips
proves nothing while reading as a pass, so the fixture now adds the finding after
the baseline.

## What this does not do

`guard_item` makes containment the zero-effort default; it does not make a bare
loop impossible. A hook written tomorrow can still commit unguarded — the gate
is what catches that, and the gate covers the sixteen **cycle learning hooks**
only.

### The scope limit, now measured — `ORPHAN-MEDIUM-579`

That limit was written as "unmeasured". It has since been measured, and the
result is not what the number first suggests.

Reusing the gate's own machinery outside its sixteen hooks returns **91 functions
across 56 modules**. That is **not a defect count** — it is the screen losing
precision. "Committing" is defined here as _can transitively reach a filesystem
write_, which holds up inside the hooks (zero findings after wiring, and
`read_jsonl`, `_finding_key`, `classify_pressure` and `_age_days` all correctly
excluded) because those hook bodies do not call the kernel's lazy
root-initialisers inside their loops. Repo-wide it floods: `ensure_tools_dir`
writes `repo_identity.json` on first call, nearly every kernel function reaches
it, and so a pure reader like `change_ledger.get_change_chain` comes out
committing.

**A narrowing was tried and rejected on measurement rather than on taste.**
Dropping `mkdir`/`makedirs` from the write seed moved 92 to 91 — the leak is a
real file write, not directory creation. Widening the gate therefore needs a
stronger notion than reachability, roughly _"writes a ledger row keyed by this
item"_, which is a design change and not a threshold tweak. Widening it on the
current signal would ship a gate that cries wolf, and a gate that cries wolf gets
waived into uselessness.

**A real population does exist**, confirmed by reading rather than by the screen:
`memory.decay_stale_beliefs_by_age` is a cycle phase (`cycle.py:1064`),
`pressure.close_pressures_from_signals` runs from `feedback.py:208`, and
`memory._apply_diff_to_existing_beliefs` commits per belief. Their true count is
unknown until the definition is sharpened, which is why `ORPHAN-MEDIUM-579`
claims a limit rather than a number.

**One incidental defect, recorded because sampling found it.**
`feedback_store.record_operator_feedback_batch` has no production caller at all —
only `tests/test_incremental_learning.py`. That is the `ORPHAN-CRITICAL-498`
"called by nobody" class, and `control_reachability` cannot see it: that gate
scans control verbs (`validate_`, `enforce_`, `verify_`, …) and this is a
`record_` verb. The reachability gate's verb-based definition is its own blind
spot, on this evidence.
