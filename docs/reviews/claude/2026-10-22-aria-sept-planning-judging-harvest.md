# ARIA planning and judging defects from the September plan harvest (2026-10-22)

The session owner asked on 2026-10-22 to bring the planning and judging lessons of the September
"new ARIA" plan into ARIA. The harvest compared those methods with the live planning chain and
the live judging chain. It re-verified the 64 unregistered P1-P3 findings of
`docs/reviews/2026-09-01-aria-full-system-audit.md` (umbrella PROC-HIGH-020) against origin/main.

The rows below are the planning and judging defects that still hold and that no other row covers.
Each one was re-verified at origin/main 34ffe3842 before registration.

The plan item names a fix from the harvest adoption list (P1, J1 and so on), or a PLAN-v2 item.
The slot is that item's place in the build SEQUENCE (waves A-I and the Fix-safety wave).
The audit-sourced rows are children of PROC-HIGH-020.

## ARIA-HIGH-779

Plan cross-review risks are closed by the plan author's own unchecked claim.
`addresses_review_risk_ids` is unioned into one plan-wide resolved set.
Risk ids restart at CR-001 every round, so a new material or blocking risk in a later round is
dropped before the material gate counts it.

- Severity: HIGH; owner: Okan-wqm; deadline: 2026-11-05.
- Evidence:
  - `aria-kernel/aria_kernel/cross_review_bridge.py:170-182`: the revision prompt asks the author
    to list "every risk_id you resolved".
  - `aria-kernel/aria_kernel/plan_convergence.py:2498-2500`: those ids are unioned, unchecked,
    into `resolved_review_risk_ids`.
  - `aria-kernel/aria_kernel/plan_convergence.py:3511-3518`: every current-round risk whose id is
    in that set is dropped before the material count.
  - `.claude/agents/aria-cross-reviewer.md:141`: the contract example id is `CR-001`, and ids are
    not round-scoped. Only the synthetic `COV-R{N}` and `IMP-R{N}` ids are round-scoped
    (`plan_convergence.py:2522-2526`).
  - `aria-kernel/aria_kernel/cross_review_bridge.py:104-143`: the next reviewer never sees the
    prior risks or the author's claims.
  - Replay of `origin/aria/state` 8e39b2eeb `tools/plans/events.jsonl` (367 events, 42 plans,
    32 evaluations), re-run 2026-10-22. In 18 of 18 CONVERGED verdicts, at least one round-N
    material or blocking risk was hidden this way. In 18 of 18, the hidden risk's summary occurs in
    no earlier round, so it was a new objection.
- Rule violated: a producer cannot approve its own artifact. Only the independent reviewer seat
  may clear a risk, and risk ids must be round-scoped.
- Plan item: P1, verified risk closure. It has three parts:
  - round-scoped `CR-R{N}-*` ids;
  - the author's ids are stored as a claim;
  - the round N+1 reviewer returns `prior_risk_dispositions[]`.
- Slot: Wave B, the first September-harvest item. It must land before ARIA regains implementation
  authority (PLAN-v2 §9-A7).

## ARIA-MEDIUM-780

The evidence collector reads scope files from the working tree but seals them as evidence at
`base_commit_sha`. Only three sampled observations are re-checked with `git show`.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-19. Source: ARIA-AUDIT-008.
- Evidence:
  - `aria-kernel/aria_kernel/evidence_collector.py:205-209`: `path.read_text` on the worktree.
  - `aria-kernel/aria_kernel/evidence_collector.py:191`: the SHA is resolved.
  - `aria-kernel/aria_kernel/evidence_collector.py:254`: the pack is labelled `base_commit_sha`.
  - `aria-kernel/aria_kernel/evidence_collector.py:245`: the three-sample re-check.
  - `aria-kernel/aria_kernel/evidence_collector.py:388-408`: the body of that re-check.
- Rule violated: PLAN-v2 §2 names `evidence_trust` as the one at-SHA evidence reader. Evidence
  labelled with a commit must be read at that commit.
- Plan item: fold the collector into `evidence_trust` (PLAN-v2 F2.3/F2.4).
- Slot: SEQUENCE.md names no slot for F2.3/F2.4. This row goes with the F2 evidence-trust items.

## ARIA-MEDIUM-781

A worker result with zero validation commands is verified as passed.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-19. Source: ARIA-AUDIT-052.
- Evidence:
  - `aria-kernel/aria_kernel/verification_gate.py:294-301`: the gate loops over an empty list and
    ends with `status = "passed"`.
  - `aria-kernel/aria_kernel/promotion_controller.py:280`: `Path(validation_ref)` resolves against
    the ambient working directory.
  - `aria-kernel/aria_kernel/promotion_controller.py:284-285`: malformed JSON becomes `[]`.
- Rule violated: a verdict needs evidence. `passed` requires at least one validation that ran.
- Plan item: the F3.5 apply gate and the D5 (F3.2) one-prover red test.
- Slot: Wave F (D5 one prover) and the Fix-safety wave (D5/F3.2 plus F3.5).

## ARIA-MEDIUM-782

`record_operator_feedback_batch` appends one signed feedback row per label. It uses no transaction
and no idempotency key, and it marks the sample recorded only after the loop. So a mid-batch
failure plus a retry duplicates labels and inflates judge calibration samples.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-19. Source: ARIA-AUDIT-086.
- Evidence:
  - `aria-kernel/aria_kernel/feedback_store.py:874-902`: one row is appended per label.
  - `aria-kernel/aria_kernel/feedback_store.py:903-911`: the terminal `recorded` sample row.
  - `aria-kernel/aria_kernel/feedback_store.py:816-817`: the only replay guard, which a partial
    batch never reaches. `record_operator_feedback` has no dedup.
- Rule violated: ledger writes that feed judge calibration must be idempotent per sample item.
- Plan item: the harvest adoption list names none. The proposal is to land it together with J2,
  since both protect judge calibration samples.
- Slot: Wave B with J2 (proposed).

## ARIA-MEDIUM-783

Ground-truth false-positive suppression never goes stale. `_confirmed_false_positive_fingerprints`
suppresses a fingerprint forever and never checks whether the code the anchor cited has changed.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-19. Source: new from the harvest (S12).
- Evidence:
  - `aria-kernel/aria_kernel/feedback_store.py:1747-1790`: no code-hash check. `git grep` for
    `code_hash|cited_blobs_code_hash` in `feedback_store.py` and `finding_promotion.py` finds 0.
  - `aria-kernel/aria_kernel/pr_tracking.py:358`: `_mark_findings_for_revalidation` already flips
    rows to `needs_revalidation`, but suppression ignores it.
- Rule violated: a verdict holds only while the evidence it judged is unchanged. When that is
  unknown, the finding is not suppressed.
- Plan item: J1. At consensus mint, stamp `cited_code_hash` with
  `evidence_trust.cited_blobs_code_hash`, and honour an anchor only while that hash still matches.
- Slot: Wave F/G.

## ARIA-LOW-784

`record_change_outcome` is not crash-atomic. It appends the outcome row and only then folds
`cycles_rejected`. A crash between the two steps loses the rejection increment for good, because
the idempotent early return never re-applies the aggregate.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-22. Source: ARIA-AUDIT-080.
- Evidence:
  - `aria-kernel/aria_kernel/change_outcome.py:704-711`: the row is written, then
    `_record_aggregate` runs.
  - `aria-kernel/aria_kernel/change_outcome.py:666-669`: the early return.
  - `aria-kernel/aria_kernel/change_outcome.py:727-750`: the aggregate writer.
  - The ordering is documented at `:699-703` as an accepted under-count.
- Rule violated: under F3.3, the "did it hold" verdict and its effectiveness counter must not
  diverge.
- Plan item: name it in F3.3, the change_outcome core.
- Slot: the Fix-safety wave (F3.3).

## ARIA-LOW-785

The implementation request id ignores `implementation_ids`. A re-mint with new implementation ids
hashes to the old request and returns the old row, and `base_sha` is read from those ids.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-22. Source: ARIA-AUDIT-048.
- Evidence:
  - `aria-kernel/aria_kernel/agent_invocations.py:1557-1584`: the identity fields leave out
    `implementation_ids`.
  - `aria-kernel/aria_kernel/agent_invocations.py:1585-1587`: an existing row is returned.
  - `aria-kernel/aria_kernel/agent_invocations.py:1726`: `implementation_ids` is stored.
  - `aria-kernel/aria_kernel/agent_invocations.py:3401-3403`: `base_sha` is derived from those ids.
- Rule violated: a request's identity must cover every fact the request carries.
- Plan item: with P3, which binds the plan verdict to the reviewed commit (`request_implementation`).
- Slot: Wave B with P3.

## ARIA-LOW-786

Registry finding ingestion can duplicate `missed_signal` feedback rows. The dedup cache is written
once, after the loop, and `add_feedback` appends without an `event_id` check. A crash or a
concurrent run therefore re-ingests the same findings.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-22. Source: ARIA-AUDIT-006.
- Evidence:
  - `aria-kernel/aria_kernel/report_ingestion.py:209-240`: the cache is written at `:240`.
  - `aria-kernel/aria_kernel/report_ingestion.py:262-263`: the `missed_signal` event is appended.
  - `aria-kernel/aria_kernel/feedback.py:201-210`: an append with no dedup.
- Rule violated: append-only ledgers that feed recall denominators must be idempotent per stable
  `event_id`.
- Plan item: the DESIGN D9 miss feed.
- Slot: Wave E (D9 recall block plus the DEV miss feed).
