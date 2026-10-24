# F0.7 review: the non-blocking points (2026-10-24)

The F0.7 package sends judgment uncertainty to the arbiter instead of a human (PLAN-v2 section 3
F0.7, SEPT-HARVEST row J4). It went through one review round with two lenses, single owner (ssot)
and architecture (arch). The blockers of that round were fixed by the corrective commits 168d8376c,
2da96ccdd and 8cf960d43. This file registers the points the reviewers marked non-blocking.

Eleven points were relayed. Each was checked at 8cf960d43, the head of
`feat/aria-f07-escalation-to-arbiter`, and none was dropped: every claim still holds. Two pairs of
near-duplicates are merged, so there are nine findings. The review file for all nine is this one;
none of them is appended to the shared program review document.

## Registered rows

- ARIA-MEDIUM-885: ssot MEDIUM (legacy envelopes re-asked) and arch MEDIUM (transition gap).
- ARIA-MEDIUM-888: ssot MEDIUM (two producers write one belief correction) and arch LOW (belief
  idempotency per digest).
- ARIA-MEDIUM-890: arch MEDIUM (one arbiter seat moves a belief).
- ARIA-LOW-891: ssot LOW (hand-rolled ledger readers).
- ARIA-LOW-894: ssot LOW (`split_verdict_groups` has no production caller).
- ARIA-LOW-896: ssot LOW (stale consumer and doc of a kind no longer produced).
- ARIA-LOW-897: arch LOW (belief rows in the unverifiable rate).
- ARIA-LOW-899: arch LOW (arbiter contract).
- ARIA-LOW-902: arch LOW (names).

## Evidence moved since the review

The corrective round changed line numbers, so the relayed citations were re-cut. The claims held,
with two exceptions: the sweep is no longer read-only, and the arch half of ARIA-MEDIUM-885 was
fixed. One citation was also aimed at the wrong lines. All are listed here.

- `feedback_store.py`: the reader moved from :2148 to :2183, the re-emission dedupe from :1545 to
  :1549, and the rate (the old :2173) is now :2204-2212.
- `human_required.py`: the sweep moved from :788 to :806. It is no longer read-only: since 8cf960d43
  it also resolves open pre-F0.7 `consensus_escalation` records by kernel disposition. It still
  creates no `HUMAN_REQUIRED` record (ARIA-LOW-902).
- `memory.py`: the constant contradiction reason is at :1581, not :1580.
- `stability_reask.py:131` is only the path helper; the parsing reader is at :103-120
  (ARIA-LOW-891).
- `belief_escalation.py:169-179` and :176, cited for the mint idempotency, hold the fold's
  per-request check. The digest the mint is keyed on is at `belief_escalation.py:100-109` and
  `judge_fanout.py:1249` (ARIA-MEDIUM-888).
- The arch half of ARIA-MEDIUM-885, two authorities on one group until the old
  `consensus_escalation` records close, was fixed by 8cf960d43. The second ask of legacy arbiters
  remains.

## ARIA-MEDIUM-885

An arbiter envelope minted before F0.7 carries no `arbiter_inputs`, so `_minted_arbiter_inputs` does
not see it and every unsettled group that already had an arbiter is asked a second time; the
`expiry_ownership` row and the docstring claim the opposite

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F0.7 review, round 1 (ssot and arch lenses), reviewed at dbc56e347 and re-checked
  at 8cf960d43. Non-blocking.
- Plan item(s): F0.7 (PLAN-v2 section 3), J4 (SEPT-HARVEST), ARIA-MEDIUM-730.
- Evidence:
  - `aria-kernel/aria_kernel/judge_fanout.py:686-695` (`_minted_arbiter_inputs` keeps only envelopes
    that hold an `arbiter_inputs` dict)
  - `aria-kernel/aria_kernel/judge_fanout.py:777-788` (a legacy envelope is refused as
    `arbiter_inputs_unbound`)
  - `aria-kernel/aria_kernel/judgment_bridge.py:419` (the bridge call that refuses a legacy answer)
  - `aria-kernel/aria_kernel/expiry_ownership.py:173-176` (says the mint counts the dead arbiter as
    dispatched)
- Rule: J4 (SEPT-HARVEST row J4): the arbiter is bound to its inputs and a question is asked once;
  one owner per group. A group that already had an arbiter envelope must not be minted a second one,
  and the docstring 'never asked the same question twice' and the expiry row must be true.
- Details: Merges the ssot MEDIUM (legacy envelopes re-asked) and the arch MEDIUM (transition gap).
  The reviewer's probe (`probe_live.py`, a read-only copy of `origin/aria/state`, last commit
  2026-10-16; not re-run by the clerk) read 56 arbiter envelopes with 0 holding `arbiter_inputs` and
  83 groups owed an arbiter, 36 of which already had a legacy envelope: 12 ACCEPTED (a verdict
  already folded) and 16 `ANCHOR_STALE`, whose expiry owner per the table is the operator, so for
  them 'counts the dead arbiter as dispatched' is false. The arch half 'two authorities on one group
  until the pre-F0.7 `consensus_escalation` records close' was closed by 8cf960d43 (the consensus
  sweep resolves those records as `routed_to_arbiter`); what remains is the second ask. Admission
  (`_arbiter_admission`) bounds the volume per cycle.
- Close condition: a pre-F0.7 envelope counts for its group, by `_minted_arbiter_inputs` or one
  named migration, so a group that already had an arbiter is not minted again; the
  `expiry_ownership` row and the docstring are made true; a test holds a pre-F0.7 ACCEPTED and a
  pre-F0.7 `ANCHOR_STALE` envelope and asserts no new mint.

## ARIA-MEDIUM-888

One standing belief contradiction can lower the belief more than once: the arbiter fold and the
legacy panel fold write under different ledger identities (`run_id` `belief:<id>` versus the
HR-belief escalation id) and neither sees the other, and the arbiter mint is idempotent per inputs
digest, not per belief

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F0.7 review, round 1 (ssot and arch lenses), reviewed at dbc56e347 and re-checked
  at 8cf960d43. Non-blocking.
- Plan item(s): F0.7 (PLAN-v2 section 3), J4 (SEPT-HARVEST), ARIA-MEDIUM-730.
- Evidence:
  - `aria-kernel/aria_kernel/belief_escalation.py:175-182` (the arbiter fold: idempotent per
    `request_id`, `run_id` is the arbiter request's `belief:<id>`)
  - `aria-kernel/aria_kernel/belief_escalation.py:312-322` (the legacy panel fold: idempotent on its
    own escalation id, cannot see the arbiter row)
  - `aria-kernel/aria_kernel/belief_escalation.py:33-38` (the docstring says pre-F0.7 records remain
    open in live stores)
  - `aria-kernel/aria_kernel/belief_escalation.py:100-109` (the inputs digest holds `source_tool_id`
    and reason)
  - `aria-kernel/aria_kernel/judge_fanout.py:1249` (the mint is keyed on group and digest)
  - `aria-kernel/aria_kernel/memory.py:1581` (the only contradiction reason written today)
  - `aria-kernel/aria_kernel/human_required_adjudication.py:1170-1194` (the panel lane that still
    folds `belief_escalation` records)
- Rule: One owner per concept: a belief correction has one writer identity, and a belief is lowered
  once per standing contradiction whichever producer or re-emission reaches it (JJ-3 ground-truth
  boundary, ORPHAN-HIGH-755).
- Details: Merges the ssot MEDIUM (two producers) and the arch LOW (idempotency moved from once per
  belief to once per belief and digest). Re-run by the clerk at 8cf960d43: `probe_belief_double.py`
  (a legacy HR-belief record plus the arbiter) gives -0.1 after the arbiter and -0.2 after the
  panel, two `false_positive` rows (belief:B and HR-belief-B, same `finding_id`
  belief-escalation:B). The reviewer's live probe found 0 HR-belief records in the 2026-10-16 copy
  of the store, so the kept panel lane is a dead second owner in practice and the docstring's
  'remain open in live stores' is false. The second half is by reading: the digest holds
  `source_tool_id`, so two adapters re-emitting the same withdrawn belief give two digests, two
  arbiters, possibly two -0.1 corrections; today the reason string is constant.
- Close condition: exactly one correction per belief and standing contradiction, by deleting the
  panel lane (`execute_belief_panel_correction` and the `belief_escalation` adjudicable kind) once
  no open `belief_escalation` record exists, or by sharing one ledger identity so each fold sees the
  other's row, and by keying the mint on the belief; two tests: a legacy record plus an arbiter give
  one -0.1, and two `source_tool_ids` give at most one correction.

## ARIA-MEDIUM-890

A single arbiter seat (`judge_count=1`) can now apply the -0.1 `false_positive` correction to a
belief; under JJ-3 the same correction needed a panel's resolve quorum, so authority moved from a
panel to one seat and the change is not named as an authority change

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F0.7 review, round 1 (ssot and arch lenses), reviewed at dbc56e347 and re-checked
  at 8cf960d43. Non-blocking.
- Plan item(s): F0.7 (PLAN-v2 section 3), J4 (SEPT-HARVEST), ARIA-MEDIUM-730.
- Evidence:
  - `aria-kernel/aria_kernel/belief_escalation.py:187` (the belief moves on a `false_positive`
    ruling)
  - `aria-kernel/aria_kernel/belief_escalation.py:194-195` (`judge_count=1` and `judges_voted=1`)
  - `aria-kernel/aria_kernel/belief_escalation.py:222-224` (JJ-3 boundary note: a row is an anchor
    only for a unanimous panel)
  - `aria-kernel/aria_kernel/belief_escalation.py:334-336` (JJ-3 note: a 2-1 panel still moves the
    belief)
- Rule: JJ-3 (ORPHAN-HIGH-755) ground-truth boundary: a belief correction came from an agent panel's
  resolve quorum. PLAN-v2 F0.7 routes beliefs to the arbiter, but moving authority from a panel to
  one seat must be a named, bounded decision.
- Details: The spec does route beliefs to the arbiter (F0.7 / J4), so the routing is not the defect;
  the defect is that nothing states that one seat may now lower a belief, nor bounds it. The ruling
  stays `ai_consensus` (never human) and a `true_positive` ruling moves nothing.
- Close condition: either the decision is recorded (PLAN-v2 F0.7 note or an ADR) together with the
  bound on a single-seat belief correction (for example a confidence floor and required file:line
  `evidence_refs` on the arbiter's ruling), or the belief ruling is made to meet the JJ-3 quorum; a
  test states the chosen rule.

## ARIA-LOW-891

Three hand-rolled readers of `feedback-consensus-uncertainties.jsonl` survive beside the new
`consensus_uncertainty_rows`, so the uncertainty ledger has four readers and each one re-parses the
row shape (the uncertainties wrapper, reason, `tool_id`)

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F0.7 review, round 1 (ssot and arch lenses), reviewed at dbc56e347 and re-checked
  at 8cf960d43. Non-blocking.
- Plan item(s): F0.7 (PLAN-v2 section 3), J4 (SEPT-HARVEST), ARIA-MEDIUM-730.
- Evidence:
  - `aria-kernel/aria_kernel/feedback_store.py:2183-2194` (`consensus_uncertainty_rows`, the reader
    this branch added)
  - `aria-kernel/aria_kernel/feedback_store.py:1549-1555` (the re-emission dedupe re-reads the file)
  - `aria-kernel/aria_kernel/label_queue.py:123-127` (parses the file for the escalated stratum)
  - `aria-kernel/aria_kernel/stability_reask.py:103-120` (parses the file for dead-end groups)
  - `aria-kernel/aria_kernel/stability_reask.py:130-131` (`root_uncertainties_path`, a second
    spelling of the ledger path)
- Rule: One owner per concept: a ledger has one reader, and a reader added to be that one must
  replace the hand-rolled ones in the same change.
- Details: `consensus_uncertainty_rows` was added by 19bfcc7d3 and is already the reader of
  `judge_fanout`, `human_required` and `_append_consensus_uncertainty`.
- Close condition: the three callers read through `consensus_uncertainty_rows` and
  `root_uncertainties_path` is deleted; a structural test pins the ledger file name to
  `feedback_store.py` and the state manifest.

## ARIA-LOW-894

`split_verdict_groups` survives as a filter over `arbitration_groups` with no production caller;
only one test module and an architecture diagram name it, so 'split' has two readers of one fact

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F0.7 review, round 1 (ssot and arch lenses), reviewed at dbc56e347 and re-checked
  at 8cf960d43. Non-blocking.
- Plan item(s): F0.7 (PLAN-v2 section 3), J4 (SEPT-HARVEST), ARIA-MEDIUM-730.
- Evidence:
  - `aria-kernel/aria_kernel/judge_fanout.py:760-766` (`split_verdict_groups`, a filter over
    `arbitration_groups`)
  - `aria-kernel/tests/test_role_hygiene_e14.py:332-388` (the only callers)
  - `ARIA-MIMARI-SEMALARI.md:484` (a diagram node that names it)
- Rule: One owner per concept: `arbitration_groups` is the owner of the groups the arbiter owes; a
  wrapper nothing in production calls is a second name for it. No compat shims or aliases.
- Details: Checked by grep over the worktree: `judge_fanout.py` defines it,
  `test_role_hygiene_e14.py` calls it, and the diagram names it.
- Close condition: the function is deleted, the e14 tests assert on `arbitration_groups` filtered by
  its split key, and the diagram node names `arbitration_groups`.

## ARIA-LOW-896

A kind that is no longer produced still has a consumer and a doc: `self_improvement` maps
`human_required:consensus_escalation` as calibration ground truth, and the ARIA doc still says the
`consensus_escalation` phase feeds `HUMAN_REQUIRED`

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F0.7 review, round 1 (ssot and arch lenses), reviewed at dbc56e347 and re-checked
  at 8cf960d43. Non-blocking.
- Plan item(s): F0.7 (PLAN-v2 section 3), J4 (SEPT-HARVEST), ARIA-MEDIUM-730.
- Evidence:
  - `aria-kernel/aria_kernel/self_improvement.py:145` (the map entry, commented as ground truth for
    calibration)
  - `aria-kernel/aria_kernel/self_improvement.py:196` (the lookup defaults to `OPERATOR_CONDITION`,
    so the entry changes nothing)
  - `docs/aria/ARIA-NASIL-CALISIR.md:178` (phase 9 row: `consensus_escalation` feeds
    `HUMAN_REQUIRED`)
- Rule: A doc and a consumer state what the code does: F0.7 stopped producing the kind
  (ARIA-MEDIUM-730), so a reader that treats it as operator ground truth is stale.
- Details: Acknowledged in the corrective round as not changed. The doc is Turkish; the row says the
  phase drains judge disagreement into `HUMAN_REQUIRED`.
- Close condition: the `self_improvement` entry is removed (its value is the lookup default) or its
  comment states that it only classifies historical records, and the doc row describes the phase as
  the lane report that routes records to the arbiter.

## ARIA-LOW-897

`unverifiable_rate` counts belief-arbitration rows as finding groups of the source adapter:
`ai_consensus` rows with `judgment_subject=belief` enter the settled denominator and a belief
arbiter's terminal unverifiable enters the numerator, so the belief lane moves the finding-judgment
rate that F0.7's exit criterion reads

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F0.7 review, round 1 (ssot and arch lenses), reviewed at dbc56e347 and re-checked
  at 8cf960d43. Non-blocking.
- Plan item(s): F0.7 (PLAN-v2 section 3), J4 (SEPT-HARVEST), ARIA-MEDIUM-730.
- Evidence:
  - `aria-kernel/aria_kernel/feedback_store.py:2204-2212` (both sets are built without a
    `judgment_subject` filter)
  - `aria-kernel/aria_kernel/belief_escalation.py:188-196` (the belief fold writes `ai_consensus`
    with `judgment_subject` belief)
- Rule: PLAN-v2 F0.7 exit: the unverifiable rate is a measure of finding judgment; a different
  subject must not move it (JJ-3 keeps belief work from suppressing finding judgment).
- Details: By reading: the belief fold keeps the source adapter's `tool_id`, so its `ai_consensus`
  rows and its terminal uncertainty rows (`probe_belief_nonverdict`, corrective round) land in the
  adapter's rate. Neither set filters on `judgment_subject`.
- Close condition: `unverifiable_rate` reads finding groups only, or reports the belief lane as its
  own rate with its own named ceiling; a test shows a belief ruling leaves the finding rate
  unchanged.

## ARIA-LOW-899

The arbiter contract's hard-limit lift now reads 'ONLY under a MODE marker' (any marker, not only
`anchor_refutation`), the 'never as any / suppress tests' hard limit was deleted, and BELIEF
CONTRADICTION MODE is a one-line entry with no output or evidence section

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F0.7 review, round 1 (ssot and arch lenses), reviewed at dbc56e347 and re-checked
  at 8cf960d43. Non-blocking.
- Plan item(s): F0.7 (PLAN-v2 section 3), J4 (SEPT-HARVEST), ARIA-MEDIUM-730.
- Evidence:
  - `.claude/agents/aria-consensus-arbiter.md:26` (BELIEF CONTRADICTION MODE, one line)
  - `.claude/agents/aria-consensus-arbiter.md:90` (limits lifted ONLY under a MODE marker)
  - `.claude/agents/aria-consensus-arbiter.md:28-53` (the anchor and evidence-weighing modes each
    state inputs, output and evidence rules)
- Rule: Least authority in an agent contract: each lifted limit is named for the mode that lifts it,
  and a mode states its output and evidence rules like the others.
- Details: The deletions are in cbe1e2a5c: the line 'never use as any, suppress tests, or recommend
  disabling validation' and the 'defense in depth' clause on duplicate `judge_id` are gone, and the
  lift sentence named only MODE: `anchor_refutation` before.
- Close condition: the lift names which markers lift which limit; the as-any / suppress-tests limit
  is restored or retired with a stated reason; belief mode gets its own section (output shape,
  evidence rule, the lawful non-answer); the agent-contract tests pin the sections.

## ARIA-LOW-902

Names that say `HUMAN_REQUIRED` or escalation now describe other work:
`sweep_consensus_uncertainties_for_human_required` and the `consensus_escalation` phase create no
`HUMAN_REQUIRED` record, and `escalate_stuck_contradictions` reports every standing belief under
`escalated_belief_ids` though it only asks the arbiter

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F0.7 review, round 1 (ssot and arch lenses), reviewed at dbc56e347 and re-checked
  at 8cf960d43. Non-blocking.
- Plan item(s): F0.7 (PLAN-v2 section 3), J4 (SEPT-HARVEST), ARIA-MEDIUM-730.
- Evidence:
  - `aria-kernel/aria_kernel/human_required.py:806-810` (the sweep: creates nothing, reports lanes
    and the rate, closes legacy records)
  - `aria-kernel/aria_kernel/cycle.py:1811-1815` (`_phase_consensus_escalation`)
  - `aria-kernel/aria_kernel/cycle.py:3784-3785` (the phase is registered with `state_key`
    `consensus_escalation`)
  - `aria-kernel/aria_kernel/belief_escalation.py:123-143` (`escalate_stuck_contradictions`;
    `escalated_belief_ids` at :141)
- Rule: A name states what the thing does; a lane that no longer escalates to `HUMAN_REQUIRED` must
  not be named for it.
- Details: The review called the sweep a read-only lane report; at 8cf960d43 it also resolves each
  open pre-F0.7 `consensus_escalation` record by kernel disposition and writes governance rows, but
  it still creates no `HUMAN_REQUIRED` record (created is always empty). The phase name is a
  registered `state_key`, so a rename carries every reader of that key in the same change.
- Close condition: the function, the phase and the report key are renamed to what they do, with the
  state manifest and every reader of the persisted key updated in the same commit.
