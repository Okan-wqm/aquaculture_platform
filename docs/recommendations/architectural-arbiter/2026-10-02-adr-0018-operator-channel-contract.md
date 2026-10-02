# ADR-0018 — Operator Channel Contract: One-Time Decisions Travel Only Through the Signed Priority-0 Request

**Status:** accepted
**Date:** 2026-10-02 (amended the same day after review round 2)
**Resolves:** architectural-arbiter rulings I1, I3, I4, D1, D3, D4, D5, D6 and round-2 rulings i–iv
(2026-10-02)
**Finding reference:** docs/reviews/claude/2026-10-02-aria-operator-channel.md#ARIA-CRITICAL-255
**Upholds:** ADR-0003 (`2026-05-20-adr-0003-aria-self-feed-deferred.md`); does not supersede it

Alias: ARCH-CRITICAL-201 (arbiter ruling 2026-10-02) = ARIA-CRITICAL-255; ARCH-HIGH-202 =
ARIA-HIGH-256.

## Context

The operator wanted the next strict nightly cycle to plan one of ARIA's own findings (F-007) instead
of a failing CI run. Two ways were on the table: edit the standing source priority
(`plan_synthesizer._SOURCE_PRIORITY`, pinned by
`tests/invariants/v9/test_phase_v9_4_pressure_sources.py` and
`tests/invariants/v12/test_phase_v12_f_gateway.py`) so findings outrank failing CI, or use the
operator-feedback source that already ranks at priority 0.

ADR-0003 settled the first way already. Its ARCH-HIGH-002 records the V9.4 design rationale for the
source order — "operator signal > production breakage > all other auto-discovered sources" — and
its decision item 5 reads "NO modification to `_SOURCE_PRIORITY` table or `rank_candidate_sources`
function". This ADR upholds both: the operator signal is the slot that already outranks production
breakage, and a one-time decision is expressed through it, never by reordering the table.

The operator source was the designed answer, but it could not deliver (ARIA-CRITICAL-255): a request
was re-admitted on every scan forever, its plan cited only `aria-tools/operator-feedback.jsonl`
(ARIA's own output, refused by the planner mint), its signature key lived on the runner and was
swept every self-hosted job, the merge lane could not re-verify it, and revisions could drop the
finding the plan was about.

Options considered and rejected:

- **A — demote FAILING_CI below the finding sources.** Rejected: it is the reorder ADR-0003
  ARCH-HIGH-002 and item 5 forbid, and it would make every later cycle rank ARIA's self-reflection
  above production breakage to serve one decision.
- **B — fix the FAILING_CI subject and carry the K-A target through it.** Rejected as the carrier:
  which workflows judge `main` is a real defect (ADR-0019, proposed), but it decides what failing CI
  means, not which finding the operator wants planned; using it as the channel would couple an
  operator decision to the CI state on the night.
- **C — the channel as originally built.** Rejected: it could not deliver one request
  (ARIA-CRITICAL-255).
- **D — require an all-green `main` as a gate before any finding is planned.** Rejected: it hands
  the decision to whichever workflow is red, and eight were red on 2026-10-02 for unrelated causes.

## Decision

1. **The standing source priority is never edited to express a one-time decision.**
   `_SOURCE_PRIORITY`, `rank_candidate_sources` and the `PlanCandidateSource` member set stay as
   they are; a one-time operator decision travels only as a signed operator request at priority 0
   (I1).
2. **A request names an F finding and signs its terms.** Every request row carries `finding_id`
   (`F-\d{3,}`) and an operator signature (ADR-0020) over the row, including `audience` (the
   repository it is for), `expires_at` (at most 168 hours, the operator-act lifetime of
   `docs/aria/policy/operators.json`) and `grounding_digest` (the admitted evidence refs at record
   time). A row without them, or with them wrong, is refused with a named reason and one
   `unsigned_operator_feedback` governance event, reported once (I2, round-2 B1).
3. **One admission for every finding-sourced candidate (D5).** The aging F-finding source and the
   operator source go through the same function (`finding_grounding.admit_finding`): status AND
   evidence come from the finding-event fold record (`finding.fold_findings`, folded once per
   synthesis — the frozen `F-*.json` is not the authority); both ref shapes pass one trust and
   self-output filter; each ref must match a closed safe path charset (a bad ref is a per-ref
   refusal, named by hash); a ref must name a file in the tree of the anchor commit proven on
   `main` (`git ls-tree`, not the index); at least one surface must be writable
   (`implementation_safety.classify_declared_surface` returns None). Refused surfaces and refs are
   listed in the conversion governance event. An operator request additionally requires the
   recomputed grounding digest to equal the signed one.
4. **A target that is not a plan ground never converts (I4).** The converter returns None, the
   provider records `plan_candidate_conversion_skipped` with the reason, and for an operator
   request writes a `request_refused` row on the hash-chained ingestion ledger; the reason comes
   from a closed list (`operator_request_spend.REQUEST_REFUSAL_REASONS`).
5. **Consume once, keyed on the signed id (D3, round-2 B1).** A request is spent when a
   `synthesis_bound` row consumed its id and that row's `plan_content_hash` equals a `plan_started`
   content hash, or when a `request_refused` row names its id. Spent and claimed ids are read from
   the kernel's own hash-chained ingestion history, independent of where a row sits in the feedback
   ledger; a row reusing a claimed id with another signed subject is refused and spends nothing. A
   binding whose plan never started does not spend the request. Abandoned or HUMAN_REQUIRED plans
   leave it spent: each retry is a new signed operator act. Only rows in the hash-chain-verified
   prefix of the feedback ledger are admissible.
6. **Runner faults never spend (round-2 ruling iii).** No anchor proven on `main`, no verifier, a
   verifier timeout, an unreadable checkout or a finding store that did not restore are reported as
   runner faults and judged again next cycle; they are not in the refusal list, so they cannot write
   `request_refused`.
7. **The origin is fixed at start (D4).** `plan_convergence._validate_submitted_plan` refuses any
   challenger draft or revision whose `finding_id` differs from, adds to or drops the started
   plan's (`plan_origin_changed`), for every origin kind. The planner bridge carries the started
   origin onto a body that names none, because the planners cannot read it. No `Closes:` trailer is
   minted for an F origin (`plan_origin.commit_contract_for_plan`); closure is proven by
   `finding_fix_verified`.
8. **The plan text is the operator's, not the finding's (D6).** The summary is fixed text naming
   the request id, priority and finding id, plus the operator's own sanitized request text. No
   finding-body field (title, lesson, scope, risks, claim summary, recommendation, message, facts,
   interpretations) reaches the title, summary, key changes, evidence refs or surfaces.
9. **Delivery (D1).** The operator records the row with the kernel CLI into a local checkout of
   the `aria/state` store and publishes it as the operator lane (`state checkout` →
   `integrity bind-tools-root` → `feedback request` → `integrity verify` → `state publish`). The
   self-hosted cycle restores `aria/state` and ingests it. There is no runner `.env`, no host inbox
   and no import step.

## Operator procedure

- Sign only from a ROOT-OWNED checkout the runner uid cannot write (for example `/root/aria-8b`),
  on `main` after `git pull`: the recorder reads the allowed-signers file and the evidence tree
  from that checkout's commit and refuses one that is not on `origin/main`.
- The recorder prints the canonical signed subject to stderr before it invokes ssh-keygen; read it
  before you confirm the passphrase prompt. What you read is exactly what is signed.

## Consequences

- An operator decision outranks failing CI for exactly the cycles it takes to plan it, then
  stops; the standing ranking is untouched, as ADR-0003 requires.
- The K-A target is chosen by the operator, not by ARIA: ARIA plans the finding the operator
  signed, grounded in repository files a challenger can cite, and keeps that finding through
  convergence to merge.
- A request against a closed, ungrounded or readonly-only finding is refused once, visibly, and
  never retried silently; a runner fault never spends a request.
- Requests expire (168 hours at most) and bind their audience and grounding digest, so a row copied
  from another store, or re-admitted from a rolled-back `aria/state`, cannot act after its window,
  and the merge lane refuses an expired request or one already merged through another plan.
- The losing side: a request can no longer be free text about anything; it must point at an OPEN F
  finding with tracked evidence. Work without such a finding needs one minted first.
