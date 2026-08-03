# ARIA — adapter confidence fails open to maximum certainty

Date: 2026-08-03
Branch: `claude/aria-w1-contention-replay` (registered here; fixed in Wave 2)
Scope: `aria_kernel/tool_runner.py`, `aria_kernel/instinct_candidate.py`,
`aria_kernel/memory.py`
Plan: `docs/plans/2026-08-02-aria-full-autonomy-program/PLAN.md` §4d.1

## How it was found

Grounding an externally-supplied "mathematical kernel" design document against
the tree. Its typed-confidence proposal (§25.1) was adopted on principle; this
review is the check that the principle names a real defect rather than a
stylistic one. It does.

## The defect

Two modules disagree about what an out-of-range `confidence` means, and they
disagree in opposite directions:

- `instinct_candidate.py:84` — **refuses**:
  `if not (0.0 <= confidence_0_to_1 <= 1.0): raise GovernanceError(...)`.
- `tool_runner.py` (`_valid_memory_candidates`) — **clamps**:
  `_non_negative_number` accepts any non-negative number, then
  `"confidence": min(float(confidence), 1.0)`.

So an adapter that emits `confidence: 5` — a count, a severity grade, a
milliseconds reading, any quantity that is not a probability — is not rejected.
It is silently promoted to **1.0, maximum certainty**, and flows into
`memory._record_belief` as the belief's starting weight. A unit error becomes a
certainty, on the exact surface where certainty is the thing being protected.

Clamping is the wrong _direction_ even when it fires legitimately: on a trust
surface, coercion toward maximum trust converts malformed input into the most
dangerous well-formed value. The rejection path three modules away already
draws the correct line.

The same audit found the sibling defect one consumer downstream, distinct
enough to track separately (PLAN §4d.3): `judge_calibration`'s scoring branch
is `else:  # truth false_positive` — it _assumes_ `FEEDBACK_VERDICTS` is a
complementary pair. Sound today with exactly two members; it means a judge that
genuinely cannot decide is forced to guess, and an `unverifiable` verdict added
later would be silently counted as `false_positive` by arithmetic that never
fails. That noise would flow directly into the Wave 10 calibration measurement.

## The fix shape (tier 1 — make it impossible)

A validating `Confidence` construction path per kind — pattern score, belief
weight, judge probability, adapter score, instinct score — that refuses
out-of-range input the way `instinct_candidate` already does. The clamp is
deleted, not widened. Scheduled into Wave 2's first schema PR (`mission.py`,
PR 1.1) because the fix touches the adapter candidate contract — every adapter
that emits candidates — not one callsite; landing it with the other schema work
keeps the contract change in one reviewed place.

## Finding

- **ORPHAN-HIGH-541** — adapter candidate confidence clamps out-of-range input
  to maximum certainty instead of refusing it. OPEN; owner okan; deadline
  2026-08-17; closes with Wave 2 PR 1.1.

Owner: okan
