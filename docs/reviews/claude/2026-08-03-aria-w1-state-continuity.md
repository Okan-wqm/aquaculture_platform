# ARIA Wave 1 — a tree that forgot cannot be asked whether it forgot

Date: 2026-08-03
Branch: `claude/aria-w1-state-continuity`
Scope: `aria_kernel/memory_gap.py` (new), `cycle.py`, `circuit_breaker.py`
Plan: `docs/plans/2026-08-02-aria-full-autonomy-program/PLAN.md` — Wave 1 PR 2.5

## The defect

`aria-auto-cycle.yml` starts every night by restoring `aria-tools/` from the
previous run's artifact. When that restore produces nothing, the job
bootstraps an empty tree and proceeds — and an empty tree **passes**
`integrity verify`, because an empty tree is trivially consistent.

So "restored the accumulated state" and "started from nothing" produced the
same observation, and ARIA went on to plan, learn, raise pressure and count
acceptance evidence on a state tree that had forgotten everything, with every
surviving file still verifying.

PR 2.1 gave the tree a manifest. PR 2.2 gave it a `manifest_root` and a chain.
PR 2.3 made `publish_state` refuse on it. What was still missing is the
consumer at the other end: **nothing checked continuity before a cycle acted.**

## The reference has to come from outside the tree

This is the whole difficulty. A tree that lost its history also lost any
record that it had one, so no file inside `aria-tools/` can answer the
question — a bootstrap-empty tree will cheerfully report that it is
consistent, complete and beginning.

Two references exist outside it, and they are tried in that order:

1. **the `aria/state` branch tip** (`read_published_snapshot`) — carries the
   full surface map, so it answers both _does this descend from that?_ and
   _did a surface vanish?_;
2. **the daily anchors committed into the repository** under
   `aria-tools/reports/daily/` — carry `state_manifest_root` and no surface
   map, so they answer the first question only.

The second is why this lands now rather than after the lane cutover: the
anchors are already committed to git, already outside the tree they describe,
and already durable. PR 2.2 added the two fields to them for exactly this.

## `unknown` is the load-bearing outcome

Three statuses, not two. `unknown` is neither `ok` nor `critical`, and the
gate returns it whenever no reference is available.

Both alternatives are wrong, and specifically:

- **Guessing continuous** re-opens the hole the whole module exists to close.
- **Guessing amnesiac** would refuse every cycle on this repository _today_.
  Every daily anchor currently committed predates `state_manifest_root`, and
  the newest two are hand-written markdown with no frontmatter at all. A gate
  that fires on the absence of a field that did not exist yet is a gate that
  gets switched off within a week.

This is the same discipline as an empty acceptance ledger not being a broken
chain (ORPHAN-HIGH-530) and `outcome_status` defaulting to `unknown` rather
than `verified` (ORPHAN-HIGH-536): **do not assert what was not observed.**

One consequence, stated plainly rather than buried: **on `main` today this
gate will report `unknown` every night and block nothing.** That is not the
gate being inert — it is the gate correctly reporting that no authority can
yet vouch for the tree. It starts refusing the moment either reference
becomes real: the daily lane emitting an anchor with a root (#1053 fixed the
workflow; production verification is still outstanding), or the state-store
lane cutover in PR 2.6.

An empty tree with no reference is `genesis`, and that is the _only_ shape
allowed to be: a newborn ARIA must be able to start, and nothing else may
claim to be one.

## One freeze mechanism, not a second one

A positive finding records `record_failure(kind="state_integrity_gap")` — a
new member of the closed `FAILURE_KINDS` taxonomy — and nothing else.

`_cycle_preflight` already consults the circuit breaker for every profile in
`PROFILES_WITH_ACTION_AUTHORITY`, so a state-integrity gap stops the system
acting by the same route every other failure kind does. Inventing a `frozen`
flag beside it would be a second answer to _how does ARIA stop_, and
ORPHAN-CRITICAL-513 is what two answers cost the last time.

`freeze_autonomous_writes` **raises** on any status other than `critical`, so
`unknown` structurally cannot trip a breaker. That is the same line RC-2 drew
when it stopped a dry-run observation from counting as a rejected
implementation.

## Where the phase sits, and the three-way split

A new `preflight` stage, first in `CYCLE_STAGES`, because the question is
whether there is a cycle to run at all — every later stage, discovery
included, reads or writes the tree under suspicion.

Responsibilities are split three ways on purpose:

- the **runner** assesses and returns a verdict payload;
- `run_enterprise_cycle` **decides** — it appends the `aborted` terminal row
  and returns, because only it owns the `cycles.jsonl` lifecycle (a phase that
  raised would leave a cycle opened and never terminated, which is exactly
  what the `ARIA_STOP` path was fixed for in Plan 024 §E);
- `freeze_autonomous_writes` **records**.

`on_error="record_and_continue"`, not `propagate`: a gate that **crashed** did
not observe a gap, it failed to look. That is the `unknown` class and must not
brick the lane — while still leaving a `failed` outcome row, so "the gate is
broken" and "the gate passed" remain different observations.

The phase is in the **burn-in** lane too. That is the reviewed decision the
`modes` column exists to demand, and the reason is what burn-in is _for_: its
output is the acceptance evidence the autonomy ladder counts toward an
unlock. Evidence gathered on a tree that forgot its history is precisely the
evidence that must not count.

## Two plan corrections

**PLAN §2.5 said to delete `aria-auto-cycle.yml`'s bootstrap step. Doing that
would have broken restored trees.** `migrate-tools-bootstrap` is not a
bootstrap-only path — it is an idempotent contract migration that upgrades a
restored tree from v0/v1/v2 to v3. Deleting it, or gating it on
`bootstrap == 'true'`, would leave an older restored tree unmigrated. Read
before edited; the plan named the wrong line.

**The silence was never in that step.** The restore action already fails hard
on a genuine error and writes `restored=true` only on the success path, so the
transport-level proof is sound. The real gap was that the job's restore-proof
gate is evaluated at the _end_ — both lanes acted first and went red
afterwards. The kernel gate is the missing consumer, and it asks a different
question than the workflow's: not _did the download work_ but _is this the
state we left_.

No workflow change ships here. Adding a redundant early check that the action
already enforces would be a second copy of a rule, which is the disease this
wave keeps treating.

## What is NOT here

`restore_and_replay`. Restoring needs a transport, and PLAN puts the lane
cutover in PR 2.6. A restore primitive with no lane to carry it would be a
capability with no caller — the exact defect class this PR closes one instance
of. `equivalence_check` IS here, because 2.6 needs it and it is testable
standalone.

## Verification

`aria-kernel/tests/test_memory_gap.py` — 18 tests, written before the module.

Mutation-checked, five ways:

| Mutation                                                         | Result                |
| ---------------------------------------------------------------- | --------------------- |
| no-reference treated as continuous                               | 2 tests fail          |
| any empty tree is genesis (reference precondition dropped)       | 3 failures + 2 errors |
| surfaceless reference hides its blind spot                       | 1 test fails          |
| equivalence walks the intersection, not the union                | 1 test fails          |
| anchor scan stops at the newest file, not the newest with a root | 1 test fails          |

Two existing gates failed on first run, both by design, and both were edited
as the reviewed decisions they demand rather than worked around:

- `test_perimeter_observe_has_no_breaker_edge` — the breaker producer set is
  closed. `memory_gap.py` is added to it with the reasoning above.
- `test_cycle_burn_in_mode` — the burn-in phase set is pinned as a literal.
  `state_continuity` is added with the reasoning above.

Kernel suite 3075 OK; `invariants:fast` 2261 green; run sequentially.

## Finding

- **ORPHAN-HIGH-539** — no gate consumed tree-level continuity before a cycle
  acted, so a bootstrap-empty tree and a restored one were the same
  observation to everything downstream. CLOSED here.

Owner: okan
