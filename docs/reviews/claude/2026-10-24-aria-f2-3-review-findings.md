# ARIA F2.3 one acceptance bar: non-blocking review points (2026-10-24)

The F2.3 package puts one acceptance bar on consensus promotion: a row must be ground truth
(`feedback_store.is_ground_truth_row`) and every ref must be `repo_verified` at the row's own
`target_sha` (`evidence_trust.classify_evidence_ref`). Its review ran two lenses (ssot and
evidence) on branch `feat/aria-f23-one-acceptance-bar` at d79c2d9dc. The package advances
ARIA-HIGH-737 (a `Part of` trailer, not `Closes`).

The rows below are the review points that are not blockers for the package. Each one was
checked against the tree at d79c2d9dc before registration. Ten points came in and one was
dropped; the other nine became five rows by merging three groups:

- the evidence decided twice (ssot) and the same twice-graded probe (evidence), together with
  the other `GovernanceError` sites inside the loop (evidence): one row, ARIA-MEDIUM-906;
- the permanent refusal of an anchor whose file moved on (ssot and evidence): one row,
  ARIA-MEDIUM-908;
- the consensus-time gate that grades without `target_sha` (ssot and evidence): one row,
  ARIA-LOW-909.

One point was dropped. The review noted that two intermediate commits, b9bc6a5c3 and
501dc838b, call the new three-argument `_target_sha` with two arguments, so they raise
`TypeError` and are red; d79c2d9dc repairs both call sites. At the tree the finding would cite
(`finding.py:864` and `:943`) the defect does not exist, and a published history is not
rewritten, so no commit could close such a row. The branch tip is green.

## ARIA-MEDIUM-906

The promotion loop decides each row's evidence twice, and `emit_finding` can still stop the
batch. `finding_promotion._unverified_at_target` grades the refs in its own `GitProbeSession`.
`emit_finding` then grades the same refs in a fresh session and raises `GovernanceError` on
anything other than `repo_verified`.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Evidence:
  - `aria-kernel/aria_kernel/finding_promotion.py:87-101`: the bar's grade, in its own session.
  - `aria-kernel/aria_kernel/finding_promotion.py:246-256`: the refusal by name.
  - `aria-kernel/aria_kernel/finding_promotion.py:273-294`: `emit_finding` is called with only
    the refs, not the grades or the session.
  - `aria-kernel/aria_kernel/finding.py:515-521`: a new `GitProbeSession` per emission.
  - `aria-kernel/aria_kernel/finding.py:324-329`: the second decision raises.
  - `aria-kernel/aria_kernel/finding.py:401-405`: `finding_file_collision` raises.
  - `aria-kernel/aria_kernel/finding.py:203-209`: a banned phrase in the claim text raises.
  - `aria-kernel/aria_kernel/cycle.py:2195-2203`: the `GovernanceError` is caught outside the
    loop, so the remaining rows of the tick are skipped and retried on the next tick.
- Why it matters: commit 501dc838b says `emit_finding` cannot raise over evidence the bar
  admitted. That holds only while both grades agree. A git stall on a loaded host makes the
  second grade `verification_unavailable`, and a write to the working tree between the two
  grades changes the blob. The rule that one bad ref never stops later promotions then fails.
  The collision and the banned phrase pre-date the branch and stop the loop the same way.
- Rule violated: the acceptance bar is one fail-closed decision per row and one refused row never
  stops later promotions (PLAN-v2 §2 "Bulgu kabul çıtası"); one owner per decision.
- Close condition:
  - the bar's per-ref envelopes, or its probe session, are passed into `emit_finding`, so a
    row's evidence is graded once (this also halves the git probes per promoted row);
  - a test shows that every other refusal `emit_finding` can raise for one row is decided
    before the call, or refuses that row by name, while the next good row still promotes.
- Related: ARIA-HIGH-737 holds the bar itself; this row is the part of F2.3 that the package
  leaves open.

## ARIA-MEDIUM-907

The promotions ledger stays a second record of what was accepted. The earlier non-anchor
promotions are still in `promotions.jsonl`. The promoter skips them as already promoted, the
sampler and `judge_subject_liveness` treat them as `finding_settled`, and the one acceptance bar
never re-checks them.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Evidence:
  - `aria-kernel/aria_kernel/finding_promotion.py:160`: `already` is read from the ledger.
  - `aria-kernel/aria_kernel/finding_promotion.py:197-198`: a fingerprint in `already` is
    skipped before the bar is applied.
  - `aria-kernel/aria_kernel/judge_subject_liveness.py:193-201`: a promoted fingerprint closes
    the judge requests as `finding_settled`.
  - `aria-kernel/aria_kernel/feedback_store.py:575-585`: the reader of the ledger.
  - `aria-kernel/aria_kernel/feedback_store.py:1736`: the sampler excludes settled fingerprints.
- Why it matters: PLAN-v2 §3 F2.3 sends the 8 non-anchor promotions back for re-judgment.
  ARIA-HIGH-737 counts 7 two-judge rows and one row that matches no consensus row. The branch
  changes the seam for new promotions only. Those fingerprints can not be sampled again while
  they sit in the settled set, so a re-judge has no way in.
- Rule violated: what counts as an accepted finding is decided by one predicate, and a settled
  record is derived from it instead of being kept as an independent ledger (PLAN-v2 §2).
- Close condition:
  - settledness for consensus promotions is derived from findings that pass the one bar, or the
    earlier non-anchor fingerprints leave the settled set through a recorded re-judge;
  - a test shows that a promotions row for a non-anchor consensus does not close judge requests
    as `finding_settled`;
  - the synthetic rule-defect rows that `rule_health` writes to the same ledger
    (`rule_health.py:167-175`) are kept.
- Related: ARIA-HIGH-737 stays open for the re-judge as its own close condition; this row owns
  the structure behind it.

## ARIA-MEDIUM-908

An anchor whose cited file changed after the judged commit is refused at the promotion bar on
every tick. `evidence_trust` grades `repo_verified` only when the working-tree blob equals the
blob at `target_sha`, so any later commit to the subject file turns a sound anchor into
`worktree_candidate`. The cycle keeps only `promoted_count`, so the named refusal is lost.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Evidence:
  - `aria-kernel/aria_kernel/evidence_trust.py:297-302`: the comparison hashes the working-tree
    file and compares it with the blob at the baseline commit.
  - `aria-kernel/aria_kernel/evidence_trust.py:350-351`: an existing file that does not match
    is graded `worktree_candidate`, a grade that blames the evidence.
  - `aria-kernel/aria_kernel/finding_promotion.py:87-101`: the bar takes exactly that grade.
  - `aria-kernel/aria_kernel/finding_promotion.py:246-256`: the refusal is returned in
    `skipped`.
  - `aria-kernel/aria_kernel/cycle.py:2198-2203` and `:2225`: the cycle reads only
    `promoted_count`; the skipped list is not stored.
  - `aria-kernel/tests/test_promotion_funnel_e2e.py:297-317`: anchors settle on a later tick
    than the pair, so HEAD can move in between.
- Reproduction: two probes under `/root/aria-handover/2026-10-21/build/F2.3/`
  (`reviewer-r1-ssot/probe_moved_head.py`, `reviewer-r1-evidence/probe_changed_file.py`). An
  anchor is judged at commit A and an unrelated edit is committed at B. Two runs both give
  `evidence_not_verified_at_target_sha {'apps/target.ts:1': 'worktree_candidate'}`, while
  `git cat-file -t <A>:apps/target.ts` says `blob`. The previous bar (working-tree existence,
  verified at HEAD) would have promoted the same anchor.
- Why it matters: it fails closed as the spec asks, so it is not a blocker. The cost is a
  permanent refusal that blames the evidence and is stored nowhere durable, and nothing sends
  the row back for re-judgment.
- Rule violated: evidence is verified at the row's `target_sha`
  (`classify_evidence_ref` / `quote_matches_at`); a refusal is named and recorded.
- Close condition:
  - the bar grades "the ref holds at `target_sha`" (`quote_matches_at`, which PLAN-v2 also
    names, or a read of the blob at `target_sha`) instead of "the working tree is
    byte-identical to `target_sha`"; or a refused anchor is recorded by name and sent back for
    re-judgment at a current commit;
  - a test shows that an unrelated later commit to the subject file does not permanently
    refuse an anchor judged earlier.

## ARIA-LOW-909

The consensus-time evidence gate `_has_unverifiable_evidence` still classifies refs with no
`target_sha`, so it checks only the working tree. It gives `worktree_candidate` the benefit of
the doubt by design. It is a second, looser judgment of the same refs, separate from the one bar
at `target_sha`, and `expert_review_gate` mirrors its grade set in a third place.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Evidence:
  - `aria-kernel/aria_kernel/feedback_store.py:1145-1159`: `classify_evidence_ref` is called
    without `target_sha`; only `missing` and `invalid` count.
  - `aria-kernel/aria_kernel/feedback_store.py:1377`: the gate decides whether a consensus is
    published.
  - `aria-kernel/aria_kernel/expert_review_gate.py:71-75`: a copy of the grade set, kept in step
    by a comment.
- Why it matters: this pre-dates the package and is named in the F0.9 atlas. The branch keeps
  the gate on purpose as a pre-filter (tier0 stays a fail-open pre-filter, not the bar) and does
  not change it. The row gives the atlas item an owner.
- Rule violated: one owner per concept. A ref's trust is graded by `evidence_trust` at the
  row's `target_sha`, not by a second predicate with its own commit and its own tolerance.
- Close condition: either the gate calls `classify_evidence_ref` with the group's `target_sha`
  and one named policy for the tolerated grades, or a test shows it is a strict subset of the
  bar (it can only refuse what the bar also refuses). `expert_review_gate` imports the grade set
  instead of mirroring it.

## ARIA-LOW-910

Two byte-identical readers of the promotions ledger exist:
`finding_promotion.promoted_fingerprints` and `feedback_store._promoted_fingerprints`. Each reads
`promotions.jsonl` into the settled-fingerprint set. One concept has two owners, and its four
callers are split between them.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Evidence:
  - `aria-kernel/aria_kernel/finding_promotion.py:46-53`: the first reader.
  - `aria-kernel/aria_kernel/feedback_store.py:575-585`: the second reader.
  - `aria-kernel/aria_kernel/rule_health.py:167-171`: uses the `finding_promotion` copy, as does
    `finding_promotion.py:160`.
  - `aria-kernel/aria_kernel/judge_subject_liveness.py:195-199`: uses the `feedback_store` copy,
    as does `feedback_store.py:1736`.
- Rule violated: one owner per concept. The reader of a ledger lives beside the ledger's path
  (`feedback_store.promotions_path`); a second copy is deleted in the same change that finds it.
- Close condition: one reader remains, in `feedback_store` beside `promotions_path`, every
  caller imports it, and a test or invariant shows no second definition.
