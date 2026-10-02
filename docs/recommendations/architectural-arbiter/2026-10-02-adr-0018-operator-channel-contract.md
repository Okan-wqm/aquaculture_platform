# ADR-0018 — Operator Channel Contract: One-Time Decisions Travel Only Through the Signed Priority-0 Request

**Status:** accepted
**Date:** 2026-10-02
**Resolves:** architectural-arbiter rulings I1, I3, I4, D1, D3, D4, D5, D6 (2026-10-02)
**Finding reference:** docs/reviews/claude/2026-10-02-aria-operator-channel.md#ARIA-CRITICAL-255

## Context

The operator wanted the next strict nightly cycle to plan one of ARIA's own findings (F-007) instead
of a failing CI run. Two ways were on the table: edit the standing source priority
(`plan_synthesizer._SOURCE_PRIORITY`, pinned by
`tests/invariants/v9/test_phase_v9_4_pressure_sources.py` and
`tests/invariants/v12/test_phase_v12_f_gateway.py`) so findings outrank failing CI, or use the
operator-feedback source that already ranks at priority 0.

Editing the priority to express a one-time decision changes the behaviour of every later cycle to
serve one night, and the next one-time decision would edit it again. The operator source was the
designed answer, but it could not deliver (ARIA-CRITICAL-255): a request was re-admitted on every
scan forever, its plan cited only `aria-tools/operator-feedback.jsonl` (ARIA's own output, refused
by the planner mint), its signature key lived on the runner and was swept every self-hosted job,
the merge lane could not re-verify it, and revisions could drop the finding the plan was about.

## Decision

1. **The standing source priority is never edited to express a one-time decision.**
   `_SOURCE_PRIORITY`, `rank_candidate_sources` and the `PlanCandidateSource` member set stay as
   they are; a one-time operator decision travels only as a signed operator request at priority 0
   (I1).
2. **A request names an F finding.** Every request row carries `finding_id` (`F-\d{3,}`) and an
   operator signature (ADR-0020). A row without either is refused with a named reason and one
   `unsigned_operator_feedback` governance event (I2).
3. **One admission for every finding-sourced candidate (D5).** The aging F-finding source and the
   operator source go through the same function (`finding_grounding.admit_finding`): the finding
   must be OPEN in the finding-event fold (`finding.list_findings`; the frozen `F-*.json` status is
   not the authority), its refs (`plan_synthesizer._evidence_refs_from_finding_json`) minus ARIA's
   self-output must name files TRACKED in the cycle's checkout (`git ls-files`, not the producer's
   `repo_verified` label), and at least one surface must be writable
   (`implementation_safety.classify_declared_surface` returns None). Refused surfaces are listed in
   the conversion governance event.
4. **A target that is not a plan ground never converts (I4).** The converter returns None, the
   provider records `plan_candidate_conversion_skipped` with the reason, and for an operator
   request writes a `request_refused` row on the hash-chained ingestion ledger; the reason comes
   from a closed list (`operator_request_spend.REQUEST_REFUSAL_REASONS`).
5. **Consume once, computed at ingestion (D3).** A request is spent when a `synthesis_bound` row
   consumed it and that row's `plan_content_hash` equals a `plan_started` content hash, or when a
   `request_refused` row names it. A binding whose plan never started does not spend it. A reused
   request id is refused at record time and at ingestion. Abandoned or HUMAN_REQUIRED plans leave
   the request spent: each retry is a new signed operator act.
6. **The origin is fixed at start (D4).** `plan_convergence._validate_submitted_plan` refuses any
   challenger draft or revision whose `finding_id` differs from, adds to or drops the started
   plan's (`plan_origin_changed`), for every origin kind. The planner bridge carries the started
   origin onto a body that names none, because the planners cannot read it. No `Closes:` trailer is
   minted for an F origin (`plan_origin.commit_contract_for_plan`); closure is proven by
   `finding_fix_verified`.
7. **The plan text is the operator's, not the finding's (D6).** The summary is fixed text naming
   the request id, priority and finding id, plus the operator's own sanitized request text. No
   finding-body field (title, lesson, scope, risks, claim summary, recommendation) reaches the
   title, summary or key changes.
8. **Delivery (D1).** The operator records the row with the kernel CLI into a local checkout of
   the `aria/state` store and publishes it as the operator lane (`state checkout` →
   `integrity bind-tools-root` → `feedback request` → `integrity verify` → `state publish`). The
   self-hosted cycle restores `aria/state` and ingests it. There is no runner `.env`, no host inbox
   and no import step.

## Consequences

- An operator decision outranks failing CI for exactly the cycles it takes to plan it, then
  stops; the standing ranking is untouched.
- An operator-sourced plan is grounded in repository files a challenger can cite, so the planner
  mint accepts it, and it keeps its finding through convergence to merge.
- A request against a closed, ungrounded or readonly-only finding is refused once, visibly, and
  never retried silently.
- The losing side: a request can no longer be free text about anything; it must point at an OPEN F
  finding with tracked evidence. Work without such a finding needs one minted first.
