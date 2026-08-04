# ARIA Wave 1 — repetition is not corroboration

Date: 2026-08-03
Branch: `claude/aria-w1-memory-hygiene`
Scope: `aria-kernel/aria_kernel/memory.py::_record_belief`
Plan: `docs/plans/2026-08-02-aria-full-autonomy-program/PLAN.md` — Wave 1 (gap 6)

## The defect

ARIA re-records the same discovery beliefs on **every** cycle, from the
same files. `_record_belief` raised the belief's confidence on every one
of those passes, whether or not anything new had been observed.

Measured, not argued: one unchanged file, eleven observations, confidence
**0.605 → 0.925**. The system was reading its own repetition as evidence.

Two mechanisms, and this is the part that matters — **fixing either alone
leaves a ratchet**:

```python
support_count = int((existing or {}).get("support_count", 0)) + 1   # always
next_confidence = _bounded_confidence(
    base_confidence + min(0.05, support_count * 0.005) + ...        # base = PREVIOUS
)
```

`base_confidence` is the _previous_ confidence for an existing belief, so
the support term compounds on the already-raised value. Freeze the
counter and the term still adds to a rising base; zero the term and the
counter still inflates a later one. Both are now gated on the same fact:
did the evidence actually change?

```python
evidence_is_new = existing is None or evidence_hashes != previous_hashes
support_count = previous + (1 if evidence_is_new else 0)
support_term  = min(0.05, support_count * 0.005) if evidence_is_new else 0.0
```

Both sides of the comparison come from `_evidence_hashes`, which returns
`sorted()`, so this compares content rather than iteration order.

Learning is not frozen — only repetition. Genuinely changed evidence
still increments support and still raises confidence; there is a test for
exactly that, because a fix that stopped ARIA learning would be worse
than the defect.

## Occurrence is kept, it just does not vote

Dropping the count entirely would lose a real signal: how often ARIA has
looked at a belief. The row now carries `observation_count`, in a field
nothing reads into confidence. `last_seen_cycle` is deliberately **not**
set here — a freshness helper that every belief writer must call already
stamps it, and a field with two writers is a field that drifts.

## Three existing tests asserted the defect

This is the part worth being explicit about, because "make the failing
tests pass" is exactly where a bad change hides. Each was read for its
intent before being touched:

- `test_memory_repeated_cycle_updates_latest_belief_state_without_duplicate_listing`
  ran two cycles over an unchanged `nx.json` and asserted
  `support_count == 2`. That is the ratchet stated as a requirement. Now
  asserts `observation_count == 2` **and** `support_count == 1` — both
  facts, kept separate.
- `test_feedback_note_substring_does_not_adjust_without_affected_belief_ids`
  proves a note substring must not adjust a belief, and proved it by
  asserting confidence **rose** — which only worked because
  re-observation inflated it. Equality is the stronger statement of the
  same intent: nothing moved at all.
- `test_adapter_candidate_confidence_does_not_override_existing_memory_score`
  asserts an adapter declaring `confidence=1.0` cannot override memory's
  own score. Its real assertion is the `< 0.5` bound, which still holds —
  and now holds more strongly, because the score does not creep upward at
  all between two cycles over unchanged evidence.

None of the three lost coverage; each gained a sharper assertion.

## Verification

- `aria-kernel/tests/test_memory_support_ratchet.py` — 3 tests, written
  BEFORE the fix and failing against the unfixed code with
  `0.925 != 0.605`.
- **Mutation-checked separately per half**: restoring the unconditional
  increment fails 2 tests; restoring the unconditional support term fails
  1. That is the evidence for the claim that one fix alone is not enough.
- Full kernel suite green.

## Finding

- **ORPHAN-HIGH-535** — re-observed evidence re-raised belief confidence.
  CLOSED here.

Owner: okan
