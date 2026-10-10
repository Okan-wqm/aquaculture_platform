# ARIA — the HR queue holds only what the operator must act on (2026-10-10)

Owner: claude (implementation), okan (review).

Measured on an archive of `origin/aria/state` (f5c5c86a1, 2026-10-10 10:37Z). The archive holds
628 open HUMAN_REQUIRED records. Each section below closes one cause of that backlog.

## ARIA-MEDIUM-419 — an exhausted panel escalation was folded and disclosed again every cycle

### Symptom

`governance.jsonl` holds 802 `human_required_adjudication_reopen_exhausted` rows, written from
2026-09-04 20:26Z to 2026-10-10 08:30Z, every one with `attempts: 3, budget: 2`. Each of the last
six cycles (10-09 11h, 16h, 21h; 10-10 01h, 03h, 08h) wrote exactly 28. The 28 escalations are
24 `consensus_escalation` (16 MEDIUM, 8 HIGH), 3 `lease_lifecycle` and 1 `genesis_candidate`.
All 28 are still open, unstamped, at their original severity.

### Root cause

When a dead panel's re-open budget (`MAX_PANEL_REOPENS = 2`) is spent, the exhaustion arm in
`sweep_human_required_adjudications` (`human_required_adjudication.py:1405-1414`) appends the
governance row and does nothing to the record. Every other arm that hands a record to the
operator calls `_stamp_escalated_to_operator` (`:808-825`; callers at `:873`, `:890`, `:900`,
`:924`, `:943`, `:1021`). The stamp sets `panel_disposition = escalate_operator`, which
`panel_skip_reason` (`:760`) reads to skip the record. Without it, the next sweep listed the
record again, folded the dead panel again, found it terminally dead again, and disclosed the
exhaustion again.

### Fix

The exhaustion arm calls the existing `_stamp_escalated_to_operator(..., reason=
"panel_reopen_exhausted")` after its disclosure row. The record is then the operator's in the
same way as every other panel hand-off. It is folded once, disclosed once, and skipped by every
later sweep as `panel_escalated_to_operator`. Its panel envelopes are moot
(`adjudication_envelope_is_moot` reads the same skip rule). No second stamp or skip rule was
added.

Test: `test_x4_adjudication_reopen.py::test_an_exhausted_escalation_is_the_operators_and_never_folded_again`.
On the parent commit it fails (`KeyError: 'panel_disposition'`). With the fix it passes, and it
pins three things:

- one `reopen_exhausted` row and one `escalated_to_operator` row after two more sweeps;
- the record is stamped CRITICAL and stays open;
- the outbox is unchanged.

### Side effect, deliberate

On the first sweep after merge, the 28 records become CRITICAL operator records. The stamp
sends no notification. It writes only the record file and one governance row (`:819-825`), and
it never reaches `record_human_required`, the per-record notifier (`human_required.py:172`). The
test above pins that the outbox does not change. The records stay OPEN on the operator's list
and SLA ladder. Their `sla_deadline` is not recomputed for CRITICAL, as with every existing
stamp. `notify` (PR-3) confirmed it adds no notification to the stamp. The daily summary
reports the HR backlog counts.

### Not done here

No exhausted escalation is resolved or re-panelled. "A human genuinely must act" is the
designed terminal (X4, ORPHAN-699). The plan's "~6 min per cycle" cost of the re-fold was not
measured: UNVERIFIED.
