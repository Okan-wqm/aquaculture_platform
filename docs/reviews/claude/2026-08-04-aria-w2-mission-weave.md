# The trailer reconciliation adopts on finally has something that writes it

Date: 2026-08-04
Branch: `claude/aria-w2-mission-weave`
Scope: `aria_kernel/mission_reconcile.py`, `aria_kernel/pr_manager.py`,
`aria_kernel/promotion_controller.py`, `aria_kernel/worker_dispatch.py`,
`aria_kernel/cli.py`
Plan: `docs/plans/2026-08-02-aria-full-autonomy-program/PLAN.md` — Wave 2 PR 1.5

## The gap, and it was mine

PR 1.3 (#1066) gave `mission_reconcile` an adoption path keyed on an
`ARIA-Mission:` trailer in a PR body — a strict anchored pattern, an AST test
proving a PR body cannot mint work, the untrusted-input discipline all correct.

**And nothing anywhere writes that trailer.**

That is the defect class this programme has spent eight PRs closing — machinery
written and never called — introduced by one of its own changes, in the PR whose
review document criticised exactly that pattern. A consumer waiting on a string
no producer emits can never fire, and no test in #1066 could have caught it:
every one of them supplied the trailer itself.

## One definition, checked in both directions

`format_mission_trailer` lives in `mission_reconcile.py`, immediately beside
`MISSION_TRAILER_PATTERN`, and **validates its own output against that
pattern** before returning. Two literals in two modules is precisely how a
producer and a consumer come to disagree about a format; here a formatter that
could emit a shape the consumer misses fails at the moment it produces it,
rather than silently on some future night when a PR goes unadopted.

The trailer is a **bare line** appended after `## Provenance`, not a bullet
inside it. The pattern is anchored with `MULTILINE`, so the obvious placement —
`- ARIA-Mission: …` under the provenance bullets — would never match. A test
pins that, and the mutation that indents it kills five tests.

The claim that matters is not that the regex round-trips. It is that the two
halves connect: a body `build_pr_body` produced, handed to `reconcile_missions`
unmodified, binds the mission. That is one test, and it is the reason this PR
exists.

## The mission is derived, never re-supplied

`open_pr_for_action` takes **no `mission_id` parameter**. It calls
`mission_for_assignment` on the assignment it was already given, so the mission
the PR announces and the mission the dispatch row records cannot disagree —
there is only one of them, and it is the one promotion wrote.

Two tests hold this, and the split between them is deliberate. The first
asserts the parameter is absent; on its own that proves only that a caller
cannot pass a mission, and a body built with a hardcoded `mission_id=None`
would satisfy it while every PR went untrailed. The second is **structural and
named so**: it walks `open_pr_for_action`'s AST and asserts the argument handed
to `build_pr_body` is the lookup's call, not a constant. The mutation that
replaces the lookup with `None` survived until that test existed.

## The mission learns what it owns

Promotion writes `mission_id` onto the dispatch row and binds `plan_ids` +
`assignment_ids` back onto the mission. Without the second half the reference is
one-way: a row could name its mission while the mission could not name the plan
or assignment working on it, and reconciliation would have nothing to reconcile
against. `bind_mission` is content-keyed, so re-promoting the same plan does not
accumulate duplicates.

An id naming **no open mission is refused**, not written through. A dispatch row
bound to a mission that does not exist is an unresolvable reference, and the
reconciler would record `unknown_trailer` on its PR every night forever.

The mission check sits **after** PR 1.4's WIP blockers, and one test arranges
for both to be wrong at once — because with a valid mission the ordering
assertion passes no matter where the check sits. That mutation survived until
the two-faults-at-once fixture existed.

## What this PR does not do, and why

The `mission_id` reaches the dispatch row and the PR body. It does **not** yet
reach `emit_change_planned` or the worker envelope, and no automatic producer
supplies one — the operator CLI (`plan promote-to-dispatch --mission-id`) is
today's only caller. The scheduler that selects a mission and promotes its plan
is PLAN Wave 2 PR 1.6, and a successful-promotion fixture belongs with it. The
weave here is real and exercised end to end; the automatic driver is the next
tracked phase, not an omission discovered later.

## Verification

`aria-kernel/tests/test_mission_weave.py` — 22 tests, written before the code.

Collaborators are mocked where the unit under test is the weave:
`plan_status`, `verify_runtime_artifacts` and `classify_cycle_evidence` have
their own suites, and driving a real plan to CONVERGED inside this file would
test them rather than the binding.

**Mutation-checked ten ways.** Seven died on the first pass; three survived and
each exposed a test that proved less than its name claimed:

| Mutation                                        | Result                    |
| ----------------------------------------------- | ------------------------- |
| the formatter stops validating its own output   | 1 fail                    |
| the trailer is emitted as a bullet              | 5 errors                  |
| the body stops carrying the trailer             | 2 fail                    |
| the trailer moves inside the provenance bullets | 2 fail                    |
| `open_pr_for_action` stops deriving the mission | **SURVIVED**, then 1 fail |
| the dispatch row drops the mission              | 1 error                   |
| promotion stops binding plan and assignment     | 2 errors                  |
| an unknown mission is written through           | 1 fail + 2 errors         |
| the mission check displaces the WIP gate        | **SURVIVED**, then 1 fail |
| the assignment lookup accepts any truthy field  | **SURVIVED**, then 2 fail |

The three survivors are the same lesson in three costumes: a signature check
instead of a behaviour check, an ordering assertion with only one fault
present, and a type guard nothing fed a wrong type to.

Kernel suite 3279 OK; `invariants:fast` green; run **sequentially**.

## Findings

- **ORPHAN-HIGH-547** (new) — the mission trailer adoption path shipped in
  #1066 with no producer. CLOSED here.

Owner: okan
