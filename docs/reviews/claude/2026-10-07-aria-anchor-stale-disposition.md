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

One function decides, `anchor_stale.decide_expiry_disposition(request, cause, owner, ...)`:

1. A request with a `remint_of` successor was recovered by the lane that minted it.
2. Every role has one owner (`expiry_ownership.ROLE_OWNERSHIP`, closed over `INVOCATION_ROLES`).
   A role nobody recovers, or a request whose claimed producer's signature is absent (an
   operator's own request), keeps an OPEN record with the kernel's reason, and the sweep
   notifies once per batch. No panel: the kind is not adjudicable.
3. A verified producer that recovers its own dead requests is left to it.
4. A projected maintenance request has its queue item re-offered
   (`next_cycle_queue.reoffer_item`), inside the orchestrator's own re-mint budget.
5. A fan-out judge request waits while the judge backlog is full; is dropped by name when its
   finding no longer needs that judge (`subject_closed:<rule>`, including the fan-out's own
   `rule_contract_undeclared`); goes to the operator when its lineage is spent; otherwise is
   re-minted at HEAD the way the fan-out mints today (`judge_remint`).

Every decision is a record in `human-required/`: resolved (`resolved_by=kernel`) or open for the
operator, with the decision in `kernel_disposition`. `anchor_stale` left
`ADJUDICABLE_CONTEXT_KINDS` and `OPERATIONAL_DISPOSITION_KINDS`; a historical fold still
replays and acts on nothing.

Backlog: the lease sweep runs every kernel cycle. The 170 open `anchor_stale` records go through
the same rule first, then the expiries with no record, newest first, 50 decisions per sweep.
Idempotent, no operator step. A panel envelope whose answer the panel sweep would never read is
neither selected (`next_pending_request`) nor leased by id (`claim_request`), by one predicate
shared with the sweep (`panel_skip_reason`).

## Review corrections (PR #1825)

- HIGH-1, every non-judge role was dropped silently: `expiry_ownership.py` gives each role one
  owner, proven by a cited line that a test reads. Unowned or unverified work stays OPEN and
  notifies.
- MEDIUM-2, the harness exemption never fired and had no cap: `anchor_expiry_cause.py` holds the
  outage reason contract and `MAX_EXPIRY_LINEAGE_REMINTS = 2`.
- MEDIUM-3, the re-mint went around the rule-contract gate: `judge_remint.py` rebuilds the
  envelope from the sampler's item and the contract resolved now.
- MEDIUM-4, sweep cost: each ledger is read once per sweep and none when nothing is due; a
  waiting judge reads nothing.
- LOW: `claim_request` refuses a moot envelope; a started governance row precedes any effect.
- CI, proof-surface roster: `judge_subject_liveness.py` is rostered as an observational
  finding-funnel consumer.
- CI, re-mint upcast pin: the panel's `re_mint` keeps its own `upcast_sealed_items` mint.

Role ownership of expired requests:

- Planning roles (4): convergence drainer, `convergence_drainer.py:623`, `step_request.py:92`.
- implementation: orphan reaper, `autonomy_orchestrator.py:1231`, `plan_convergence.py:941`.
- human_required_adjudication: panel re-open, `human_required_adjudication.py:1194`.
- evidence and adversarial judgment: kernel re-mint, `judge_fanout.py:152`.
- maintenance_utility: queue re-offer, `autonomy_orchestrator.py:233`.
- consensus_arbitration, verification, change_intelligence, goldset_curation, both authoring
  roles, specialist_domain_review: operator; each cites the line that never re-asks.

The outage contract for ARIA-HIGH-365: the `anchor_stale` row's reason is
`anchor_expiry_reason_in_outage(providers)`, `anchor_expired_during_provider_outage:` plus the
providers sorted and joined by `+`. The reasons production writes today (`anchor_expired`,
`anchor_undatable`, `anchor_unreachable`) spend budget; a test pins both.

Tests: `test_anchor_stale_disposition.py` (17) and `test_anchor_stale_migration.py` (11),
production writers; `test_y7_self_adjudication.py` pins the refusal of the kind.
