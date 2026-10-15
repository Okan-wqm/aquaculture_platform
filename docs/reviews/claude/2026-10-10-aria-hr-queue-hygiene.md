# ARIA — the HR queue holds only what the operator must act on (2026-10-10)

Owner: claude (implementation), okan (review).

Measured on an archive of `origin/aria/state` (f5c5c86a1, 2026-10-10 10:37Z). The archive holds
628 open HUMAN_REQUIRED records. Each section below closes one cause of that backlog.

## ARIA-HIGH-418 — 466 fan-out judges were handed to the operator as unverified and never read again

### Symptom (ARIA-HIGH-418)

505 of the 628 open records are `anchor_stale` records the kernel handed to the operator
(`expired_operator_required`):

| Reason                                         | Records |
| ---------------------------------------------- | ------- |
| `producer_unverified:anchor_stale`             | 466     |
| `queue_item_not_reofferable:queue_full`        | 20      |
| `no_recovering_producer:consensus_arbitration` | 19      |

All 466 are fan-out judge requests from August: 237 `evidence_judgment` and 229
`adversarial_judgment`. None of them carries `finding_fingerprint`. Their judgment groups have
two shapes:

- 414 are `judge:<tool>:<run uuid>:<finding id>`;
- 52 are `judge:<tool>:finding:<64 hex>`.

### Root cause (ARIA-HIGH-418)

Three defects stack, each in the reader of one fact:

1. **Ownership signature.** `expiry_ownership._fanout_judge` (`expiry_ownership.py:83-87`) rebuilt
   the group key from the request's own fields: `judge:<tool>:` + `finding_fingerprint` or
   `finding_id`. That matches only the key `judge_fanout._group_id` mints today
   (`judge_fanout.py:65-75`). Before Y2 (ddea6f1b9, 2026-08-17) the key was
   `judge:<tool>:<run_id>:<finding_id>`. Until ORPHAN-HIGH-765 the request did not carry the
   fingerprint its key held. So `owner_of` answered `producer_unverified` for every August judge,
   and `decide_expiry_disposition` (`anchor_stale.py:121-123`) handed each one to the operator.
2. **No re-read.** `anchor_stale._undecided_open_records` (`anchor_stale.py:179-185`) never reads a
   record that already carries `kernel_disposition`. A wrong ownership verdict was therefore
   final, even after the table that produced it changed.
3. **Fingerprint of a legacy request.** With ownership fixed, 234 of the 466 would be re-minted.
   `judge_remint.py:55` fingerprints a request without a fingerprint from
   `resolve_raw_finding(row)`. For 118 of the 234 that resolves only to a compact row's
   `{id, rule}` summary. The fingerprint computed from that summary is not the one the row
   recorded, so it is not the one the sampler offers the finding under (`feedback_store.py:1314`).
   That is also not the fingerprint the settled set, the judged pairs and the verdict bridge
   (ORPHAN-HIGH-765) key by. For the same reason, `JudgeSubjectLiveness.closure_reason` skipped
   `finding_settled` and the fingerprint half of `already_judged` for these requests
   (`judge_subject_liveness.py:115`, `:127`).

### Fix (ARIA-HIGH-418)

1. **One parser (tier 1).** A judge request is the fan-out's when its `judgment_group_id`
   starts with `judge:<tool_id>:`. This covers both legacy shapes and today's. The operator CLI
   sets neither field (`cli.py:5382-5397`). The goldset replay keys `replay:`
   (`judge_replay.py:35-39`). Every other mint that sets `judgment_group_id` on a judge role
   copies a fan-out key: the remint (`judge_remint.py:72`) and the panel's re-mint
   (`human_required_adjudication.py:960`). The citations now include
   `judge_fanout.py::_group_id` and `judge_replay.py::_replay_group`. Test:
   `test_every_group_key_shape_the_fanout_minted_proves_the_fanout`, which also pins the CLI,
   replay and other-tool shapes to `producer_unverified`.
2. **Re-read exactly the records whose verdict changed.** `expiry_ownership` names its three
   operator verdicts (`ROLE_UNOWNED`, `NO_RECOVERING_PRODUCER`, `UNVERIFIED_PRODUCER`), and
   `is_ownership_verdict` reads them. The sweep re-reads an open `expired_operator_required`
   record only when both hold:
   - its reason is an ownership verdict;
   - `owner_of` now names a non-operator owner.

   The re-read goes through the same `decide_expiry_disposition`, under the same 50-decision
   bound. The new disposition keeps the old one under `supersedes`. The 39 legitimate operator
   records are never re-read: 19 are still `no_recovering_producer`, and 20 were refused by a
   full queue, which is not an ownership verdict (their owner is `reoffer`). Re-reading them
   every sweep would take slots (the ARIA-HIGH-364 starvation) and notify again. Each re-read
   record is decided once, and the result is final. It ends resolved (drop or remint), or open
   with a non-ownership reason (`lineage_remint_cap_reached`, `remint_budget_spent`,
   `remint_refused`). A re-mint the admission door refuses writes nothing, so the next sweep
   asks again (ARIA-HIGH-364). Tests: `OwnershipHandOffsAreReRead` (2 tests).

3. **One fingerprint rule.** `feedback_store.raw_row_fingerprint` is the sampler's expression,
   extracted with no change in behaviour: the row's recorded fingerprint, else one computed
   from the resolved finding (lazily). `JudgeSubjectLiveness.fingerprint(request)` returns the
   request's own fingerprint, else that rule applied to the newest report. `closure_reason`
   and `judge_remint` both read it. Test:
   `test_a_judge_keyed_before_fingerprints_is_reminted_under_the_samplers_fingerprint`. It covers
   inline (v1) and compact rows × both legacy group shapes, and checks that the successor's
   fingerprint equals the one `_sampleable_raw_findings` offers, and that its group is the dead
   request's.

Red on the parent commit: 6 subtests fail. Two are ownership shapes (`run_and_finding_id`,
`fingerprint_not_on_the_request`). Four are re-mints (`AIR-v1-*`, `AIR-v2-shadow-*`).
With the ownership fix alone, both compact-row re-mints still fail on the fingerprint: both
successors carried the same summary fingerprint.

### Expected production effect (dry run on a copy of the archive, door as measured)

The sweep ran on a full copy of the archive with this PR's code, at the archive's clock
(2026-10-10 10:37Z). The copy was deleted after the measurement.

- **Door as measured.** The request-admission door refuses `anchor_stale.remint`:
  `backlog_at_drain_budget`, backlog 181 against a budget of 87.7 (drain 43.9/day × 2 days).
  The parent commit's sweep on the same copy decides nothing: 42 fresh judge expiries wait on
  the door, 58.7 s.
  - With this PR, sweeps 0-5 re-read the 466 records and resolve 274, all DROP, at 50, 50, 50,
    50, 50 and 24 per sweep. 211 are `finding_not_reported_recently`, 35 `already_judged`, 26
    `finding_settled` and 2 `rule_quarantined`. The fingerprint fix decides 42 more settled or
    judged drops than the signature fix alone (232 → 274).
  - The other 192 are REMINT decisions waiting on the door. They write no record and send no
    notification, and the next sweep asks again.
  - No re-read record goes back to the operator, so `_notify_operator` gets no new ids.
  - Sweeps take 70-99 s.
- **Door open.** Re-mints were admitted as `anchor_stale.remint_critical` through the real door
  code. 62 successors were minted in 3 sweeps (22, 20, 20), and 10 judges whose rule has no
  contract were dropped by name (`rule_contract_undeclared`). After that, the judge backlog
  ceiling (`max_pending_per_role` 32) holds the rest as `waiting_backlog`. Executor load is
  therefore bounded by the existing ceiling and the door, not by this PR.
  - All 62 successors carry the raw row's recorded fingerprint. 4 of those rows resolve only to
    a summary and would have been mis-keyed before the fix. All 62 keep the dead request's group.
  - A sweep that re-mints about 20 takes 330-415 s, about 15 s per mint inside
    `create_agent_invocation_request`. That is the existing per-mint cost, also paid by the
    fan-out. This PR does not change it.
- **Draining the 192.** They go only at the pace the door admits them and the executor drains
  judges, under the 50-decision bound.

### Not done here (ARIA-HIGH-418)

- The 20 `queue_item_not_reofferable:queue_full` records stay with the operator. Whether a
  re-offer refused by a full queue should be retried is a queue-capacity question, not an
  ownership one.
- A legacy judge is re-minted into its legacy group, as `judge_remint` does for every judge (the
  other judge of the finding may already have answered there). The fan-out's current key for the
  same finding is a different group. The dry run found no live request for the same finding and
  judge under another key, so no duplicate is minted today. Legacy groups are not merged into
  today's key, because that would rewrite consensus history.
- While the door refuses, every sweep reads the raw-findings and feedback ledgers once to decide
  the drops. That is not a new cost: the 42 fresh judge expiries the door refuses today already
  cost the same read (baseline sweep on the same copy: 58.7 s, 0 decided, 42 waiting on
  admission).

## ARIA-MEDIUM-419 — an exhausted panel escalation was folded and disclosed again every cycle

### Symptom (ARIA-MEDIUM-419)

`governance.jsonl` holds 802 `human_required_adjudication_reopen_exhausted` rows, written from
2026-09-04 20:26Z to 2026-10-10 08:30Z, every one with `attempts: 3, budget: 2`. Each of the last
six cycles (10-09 11h, 16h, 21h; 10-10 01h, 03h, 08h) wrote exactly 28. The 28 escalations are
24 `consensus_escalation` (16 MEDIUM, 8 HIGH), 3 `lease_lifecycle` and 1 `genesis_candidate`.
All 28 are still open, unstamped, at their original severity.

### Root cause (ARIA-MEDIUM-419)

When a dead panel's re-open budget (`MAX_PANEL_REOPENS = 2`) is spent, the exhaustion arm in
`sweep_human_required_adjudications` (`human_required_adjudication.py:1405-1414`) appends the
governance row and does nothing to the record. Every other arm that hands a record to the
operator calls `_stamp_escalated_to_operator` (`:808-825`; callers at `:873`, `:890`, `:900`,
`:924`, `:943`, `:1021`). The stamp sets `panel_disposition = escalate_operator`, which
`panel_skip_reason` (`:760`) reads to skip the record. Without it, the next sweep listed the
record again, folded the dead panel again, found it terminally dead again, and disclosed the
exhaustion again.

### Fix (ARIA-MEDIUM-419)

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

### Not done here (ARIA-MEDIUM-419)

No exhausted escalation is resolved or re-panelled. "A human genuinely must act" is the
designed terminal (X4, ORPHAN-699). The plan's "~6 min per cycle" cost of the re-fold was not
measured: UNVERIFIED.
