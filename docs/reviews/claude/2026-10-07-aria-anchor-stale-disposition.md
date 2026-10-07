# An expired request is a fact the kernel disposes of, not a panel question (2026-10-07)

Context: a request nobody claims inside its anchor window derives ANCHOR_STALE. Since Y7
(ORPHAN-708) each one became an open HUMAN_REQUIRED record of kind `anchor_stale`, and the
adjudication sweep opened a three-judge panel for it: three new requests on the queue that had
just failed to reach the first one.

Owner: claude (implementation), okan (review). Deadline 2026-10-14.

## ARIA-HIGH-360

Measured on copies of the runner state store (read-only):

- 2026-10-06, 1,866 requests: 693 (37%) were adjudication panel envelopes. 3,023 panel folds
  were recorded and every one was `still_escalated`. None of the 213 open records was ever
  resolved. On 2026-09-29 one sweep opened 99 panels (297 requests).
- 2026-10-07: 236 records open, 0 resolved. 170 of them are `anchor_stale` (82 evidence judge,
  82 adversarial judge, 4 challenger plan, 2 maintenance). 1,157 requests derive ANCHOR_STALE,
  all `anchor_expired`: 547 panel envelopes, 534 judge requests, 53 maintenance, 19
  arbitration, 4 challenger plan.
- `aria-config/genesis_policy.json` sets the anchor window to 7 days, equal to the sampler's
  recency window (`SAMPLE_RECENCY_HOURS = 168`). Every expired judge request is older than the
  window, so a liveness rule keyed on the request's age drops all 534. Keyed on the newest
  raw-finding row instead, 304 of them name a finding a run reported in the last 168 h (49 by
  fingerprint, 255 by finding id on the 466 requests minted without a fingerprint).

Evidence (at `958eed5b7`, origin/main):

- `aria-kernel/aria_kernel/human_required.py:580`: the lease sweep records each ANCHOR_STALE
  request as an open `anchor_stale` record asking for a panel disposition (5 per sweep).
- `aria-kernel/aria_kernel/human_required_adjudication.py:164` and `:135`: the kind is admitted
  to the panel and its dispositions act on the dead request.
- `aria-kernel/aria_kernel/judge_fanout.py:152`: the fan-out never asks a (group, judge) pair
  again once any request exists for it, so the record was the only way back for a judge.

## Fix

One function decides, `anchor_stale.decide_expiry_disposition(request, cause, ...)`:

1. A planning-round step is the convergence drainer's (`step_request`); a panel envelope is its
   panel's re-open budget. No record is written for either.
2. A request with a `remint_of` successor was recovered by the lane that minted it.
3. A judge request whose finding still needs that judge is re-minted once against the current
   HEAD with `remint_of` lineage. "Still needs" is the judge lane's own rules
   (`judge_subject_liveness`): fingerprint not settled, rule not quarantined, this judge has not
   answered, the group has no consensus, and a run reported the finding inside the sampler's
   window. The re-mint waits while that judge role's backlog is at the fan-out's ceiling.
4. Everything else is dropped by name: `role_not_remintable`, `remint_budget_spent`,
   `subject_closed:<rule>`, `obligations_unmintable`, `remint_refused`,
   `request_not_in_ledger`.

The expiry cause is the `reason` on the request's `anchor_stale` claim row, classified by the
one release-reason table (`classify_release_reason`). A harness-class expiry spends no re-mint
budget. The clock and the harness-class expiry reasons belong to ARIA-HIGH-365; this rule reads
whatever they write and needs no edit when they change.

Every decision is a resolved record in `human-required/` (`resolved_by=kernel`, decision in
`kernel_disposition`), with one governance row per sweep. `anchor_stale` left
`ADJUDICABLE_CONTEXT_KINDS` and `OPERATIONAL_DISPOSITION_KINDS`; a historical fold still
replays and acts on nothing.

Backlog: the lease sweep runs every kernel cycle. The 170 open `anchor_stale` records go through
the same rule first, then the expiries with no record, newest first, 50 decisions per sweep.
A resolved record is never read again, so the migration is idempotent and needs no operator
step. A panel envelope whose answer the panel sweep would never read (record resolved, handed
to the operator, or of a kind no panel decides) is no longer handed out
(`adjudication_envelope_is_moot`, one predicate `panel_skip_reason` shared with the sweep).

The panel's own `re_mint` uses the same successor mint, which now carries a judge's
`forbidden_scope` and finding fingerprint.

Tests: `aria-kernel/tests/test_anchor_stale_disposition.py` (19 tests, production writers);
`test_y7_self_adjudication.py` pinned the kind as admitted and now pins the refusal.
