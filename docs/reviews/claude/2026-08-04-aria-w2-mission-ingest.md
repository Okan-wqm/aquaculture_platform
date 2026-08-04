# The candidate generator finally gets a caller

Date: 2026-08-04
Branch: `claude/aria-w2-mission-ingest`
Scope: `aria_kernel/mission.py`, `aria_kernel/cycle.py`, `aria_kernel/task.py`
Plan: `docs/plans/2026-08-02-aria-full-autonomy-program/PLAN.md` — Wave 2 PR 1.2

## The gap

PR 1.1 gave work a durable identity. `task.generate_task_candidates` has
existed the whole time with **no production caller**, so nothing ever turned
discovery into tracked work — the same defect class six of Wave 1's seven PRs
closed. This is the call.

## The property is folding, not creating

"Candidates become missions" is not the interesting claim. The one that matters
is that the **same** candidate, re-observed on a later night, folds into the
**same** mission. That is what `mission_id = sha256(source_kind|source_id|repo_hash)`
buys, and it only holds if every candidate's `source_id` is cycle-independent.

Three were already: pressure uses `event_id`/`pressure_id`, finding uses
`finding_id`, shadow uses `tool_id`.

**The fourth was not, and I shipped the wrong claim before checking it.** An
earlier draft of this document asserted all four were stable "verified in
`task.py`" — I had verified the field _names_ and not what the fields are
_derived from_. `capability_gap._gap` computes
`gap_id = sha256(f"{cycle_id}:{gap_type}:{source_id}")[:12]`, so the same gap
re-detected tomorrow carries a different id, a different mission id, and a
fresh mission every night. That is precisely the per-cycle churn persistent
missions exist to end — present inside the PR that exists to end it.

Checking a field name is not checking an identity. The stable key already
existed one layer up: `capability_gap_key` is content-derived
(`registry:ghost:<tool_id>`, `coverage:<service>`, …) and is exactly what
`detect_capability_gaps` dedups on (`capability_gap.py:64`). It simply never
reached the candidate. It does now, with `gap_id` as the fallback — a gap
without a key is a `capability_gap.py` defect, and dropping the work would hide
it.

An AST test now guards all four builders, because a behavioural test cannot see
this: within a single cycle a cycle-derived id is perfectly stable and passes
any same-run assertion.

**With one trap.** `_candidate_from_pressure` falls back to the literal string
`"pressure"` when a row carries neither identifier. Adopting that verbatim
would hash every identifier-less pressure to **one** mission id, silently
collapsing unrelated work into a single mission that then accumulates
contradictory bindings. Identity that cannot identify is worse than no
identity, so `UNUSABLE_SOURCE_IDS` refuses them — and records the refusal,
because a candidate that vanishes without a trace is indistinguishable from one
that was never generated.

A malformed candidate costs only itself. One bad row must not cost the night.

## Where the closure check actually goes

PLAN says wire `assert_cycle_closure` into a **`cycle_seal` phase**. There is no
such phase. The pipeline ends at `post_tool` and `run_enterprise_cycle` writes
the terminal row itself, scanning phase results for `status == "fail"` to choose
between `_failed_event` and `_complete_event`.

Inventing a `cycle_seal` phase to match the plan's wording would have put the
check in a table row that runs **before** the terminal decision it is meant to
describe. It goes where the cycle actually seals, so it observes exactly the
cycle the row about to be appended describes. This is the third time in this
programme that the plan named a shape the code does not have; the code's shape
wins and the plan gets corrected.

**Observe-only in this PR, deliberately.** Every mission `mission_ingest` opens
starts in `DISCOVERED` with no `next_action`, so a downgrading gate on day one
would redden the nightly for the expected state of brand-new missions rather
than for anything wrong. Promotion to a cycle-downgrading gate belongs with the
scheduler that gives missions their `next_action`. A test pins the observe-only
property so the promotion is a reviewed edit rather than a drift.

Fail-soft on its own error, for the same reason the continuity gate is: a check
that **crashed** did not observe a clean cycle, but it must not be able to brick
the lane either.

## Verification

`aria-kernel/tests/test_mission_ingest.py` — 15 tests, written before the code.

**Mutation-checked five ways**, and two are worth recording:

| Mutation                          | Result                                  |
| --------------------------------- | --------------------------------------- |
| unusable source ids accepted      | 2 fail + 1 error                        |
| refusal recorded but not written  | 1 fails                                 |
| `mission_ingest` joins burn-in    | 1 fails                                 |
| the seal-point closure deleted    | **SURVIVED**, then 2 fail after the fix |
| `capability_gap` back to `gap_id` | 1 fails                                 |

The survivor: my first version searched the seal region for the string
`assert_cycle_closure`, which **also appears in `cycle.py`'s import line**, so
deleting the call outright left the test green. The call site is now located by
AST inside `run_enterprise_cycle`, where an import cannot satisfy it.

A second catch came from the same discipline applied to imports rather than
tests: `append_tools_governance` was used at the seal point and never imported.
No test took that branch, so the suite stayed green over a latent `NameError`.
There is now a test that asserts every name the seal point uses resolves.

Kernel suite 3166 OK; `invariants:fast` green; run **sequentially**.

## Finding

- **ORPHAN-HIGH-542** — work identity is cycle-scoped and the candidate
  generator has no production caller. The identity half closed in #1062; the
  production-caller half CLOSES here, so the finding closes complete.

Owner: okan
