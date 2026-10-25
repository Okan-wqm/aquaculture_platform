# ARIA J2J5 review: non-blocking findings (2026-10-24)

The J2J5 package (a judge's contract and model version invalidate its calibration and the verdict
cache; a mixed-SHA consensus can neither anchor nor suppress) was reviewed on branch
`feat/aria-j235-judge-integrity` under lenses ssot and evidence. The points below did not block the
merge. They were re-checked at the branch head (981b19dc1) before registration. Near-duplicates were
merged. One review point was dropped (an effective `enforce` gate with no calibration map cannot
occur: `effective_calibration_gate` only answers `enforce` for a non-empty map, which the cycle then
passes to the consensus) and one was narrowed (see ARIA-MEDIUM-882).

## ARIA-HIGH-880

score_judges names a judge's current version by its newest ledger row, so the replay prefix, an
out-of-order bridge or a failover rung that answers last makes an old or foreign version current and
brings back its calibration, and the judge_id-keyed status then covers rows of every version

- Severity: HIGH; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the J2J5 review (lenses ssot and evidence), registered by the J2J5 findings clerk on
  2026-10-24; non-blocking at merge.
- Plan item(s): J2.
- Evidence:
  - `aria-kernel/aria_kernel/judge_calibration.py:486-492` (current_version is the last ai_judge row
    per judge_id of the filtered subset)
  - `aria-kernel/aria_kernel/judge_calibration.py:508-510` (every row of another version is counted
    under prior_version and scored nowhere)
  - `aria-kernel/aria_kernel/role_fitness.py:124` (the replay-prefix call filters the rows first, so
    the replay lane's last version stands as current)
  - `aria-kernel/aria_kernel/feedback_store.py:1345-1349` (generate_ai_consensus looks the status up
    by judge_id only, for rows of any version)
  - `tools/aria-poc/ci_executor.py:2347-2348` (a failover rung answers under its own model, which
    becomes the ran route)
- Rule: J2 (SEPT-HARVEST section 2) and one owner per concept: a judge's current version comes from
  the contract the executor delivers and the route it dispatches, not from which verdict was
  appended last.
- Failure scenario: 30 correct verdicts under version H1, then 2 under H2, then 1 under H1 (an
  out-of-order backlog drain, or a seat whose dispatched model alternates). The review's probe
  returned `calibrated` with 31 samples under H1, a version the seat no longer runs, and the 2 H2
  samples moved to prior_version; generate_ai_consensus then gives that status to rows of any
  version. One failover-rung verdict likewise makes the fallback model current and suspends the
  earned calibration until the primary answers again, and nobody measures how often that happens.
  The replay prefix has the same shape: it scores only replay rows, so the last replay version
  stands as current after the organic lane has moved on. Main pools every verdict, so the branch
  did not introduce this.
- Close condition: calibration is scored per (judge_id, version), the version read from the
  delivered contract hash and the dispatched model (one owner, shared with
  `judge_calibration._judge_version`), not from the newest row. generate_ai_consensus looks the
  status up by the row's own version. score_judges reports verdicts per version so failover
  flapping is measured. Tests: 30 H1 verdicts, then 2 H2, then 1 H1 give H1 its status and H2
  insufficient_data; a failover-rung verdict leaves the primary's calibration standing.

## ARIA-MEDIUM-881

generate_ai_consensus escalates target_sha_mixed only when the closing set names more than one
target_sha, not when \_common_target_sha is None, so a closing set whose rows all lack a target_sha
still mints an anchor-grade row with a null target_sha

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the J2J5 review (lenses ssot and evidence), registered by the J2J5 findings clerk on
  2026-10-24; non-blocking at merge.
- Plan item(s): J5.
- Evidence:
  - `aria-kernel/aria_kernel/feedback_store.py:1473-1477` (the trigger is
    `len(_target_shas(closing)) > 1`; a set of unstamped rows is `{''}` and passes)
  - `aria-kernel/aria_kernel/feedback_store.py:1574` (the consensus row is minted with
    `target_sha=_common_target_sha(closing)`, None for such a set)
  - `aria-kernel/aria_kernel/feedback_store.py:1636-1648` (\_target_shas and \_common_target_sha)
- Rule: J5 (SEPT-HARVEST section 2): an anchor-grade closing set with \_common_target_sha None
  records the uncertainty target_sha_mixed; the measurable gain is anchors with a null target_sha
  reaching 0.
- Failure scenario: Three agreeing false_positive seats whose rows carry no target_sha give
  consensus rows `[(2, None, False), (3, None, True)]` and no uncertainty in the review's probe: the
  three-seat row mints as an anchor with target_sha None, about no named tree, so the spec exit
  "anchors with null target_sha -> 0" is only partly met. The case is legacy rows without a
  target_sha, and it predates this branch.
- Close condition: the trigger is `_common_target_sha(closing)` being None for an anchor-grade
  closing set (the spec's law, one owner). The sub-anchor precision row still mints. A test where
  three agreeing seats with no target_sha give the uncertainty and no ground-truth row; or the spec
  row is amended with the reason the unstamped case may anchor. The count of anchors with a null
  target_sha on the live store is reported and reaches 0.

## ARIA-MEDIUM-882

The verdict cache's judge half (judges_hash) digests only the seats' rendered contract hashes, so a
judge model swap, or an edit of the model: line in an agent file (stripped before hashing), keeps
cached verdicts as hits although calibration scopes on model and contract

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the J2J5 review (lens evidence), registered by the J2J5 findings clerk on 2026-10-24;
  non-blocking at merge.
- Plan item(s): J2.
- Evidence:
  - `aria-kernel/aria_kernel/judgment_cache.py:64-66` (CACHE_KEY_FIELDS has no model leg)
  - `aria-kernel/aria_kernel/agent_contract_delivery.py:79` (the YAML frontmatter, which carries
    `model:`, is stripped before the contract hash)
  - `aria-kernel/aria_kernel/agent_contract_delivery.py:141-159` (judge_seats_contract_hash digests
    only each seat's contract_hash)
  - `aria-kernel/aria_kernel/judge_calibration.py:408-413` (the calibration version is the model
    plus the contract hash)
  - `.claude/agents/aria-evidence-judge.md:5` (`model: opus`, a frontmatter line outside the hash)
- Rule: J2 (SEPT-HARVEST section 2): no calibration authority or cached verdict survives a judge
  edit; a judge's version is its model plus its delivered contract, and the cache must name the same
  version calibration does.
- Failure scenario: A seat's model changes (its frontmatter, or the tier the dispatch route runs it
  under). Calibration starts a new version, while the cache keeps returning the consensus the old
  model produced for the same fingerprint, code hash and rule contract. The review point as raised
  also said the contract half ignored inlined knowledge files; that half was fixed by commit
  981b19dc1 (judges_hash now digests the delivered contracts from the kernel checkout) and is not
  registered.
- Close condition: the cache's judge half carries the model each seat is dispatched to beside its
  delivered contract hash, sharing one owner of the judge version with
  `judge_calibration._judge_version`, and a test where a seat's model changes with its contract
  unchanged is a miss; or the J2 spec row is amended to say the cache is contract-scoped only.

## ARIA-LOW-883

judgment_cache.\_consensus_gate restates generate_ai_consensus's rule that a consensus row without a
calibration_basis closed under measure_only, so the 'no calibration map means measure_only' default
has two owners

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the J2J5 review (lens ssot), registered by the J2J5 findings clerk on 2026-10-24;
  non-blocking at merge.
- Plan item(s): J2.
- Evidence:
  - `aria-kernel/aria_kernel/judgment_cache.py:73-78` (\_consensus_gate falls back to measure_only
    when there is no calibration_basis)
  - `aria-kernel/aria_kernel/feedback_store.py:1238-1239` (generate_ai_consensus forces measure_only
    when there is no calibration map)
  - `aria-kernel/aria_kernel/feedback_store.py:1365-1368` (calibration_basis is stamped only when a
    map exists)
- Rule: One owner per concept: the gate a consensus row closed under is decided in
  generate_ai_consensus and stamped on the row; a reader derives nothing.
- Failure scenario: A change to the no-map default in generate_ai_consensus leaves the cache
  recording measure_only for rows that closed under another gate, so lookups under the new gate miss
  or hit the wrong rows. The review's second point on the cycle's effective gate (every lookup
  missing under an effective enforce with no map) was dropped: an effective enforce implies a
  non-empty map, which the cycle passes to the consensus.
- Close condition: generate_ai_consensus stamps the effective gate on every consensus row, also
  when there is no map; judgment_cache reads that field; \_consensus_gate and its fallback are
  deleted; a test where a no-map consensus row is cached under measure_only through the stamped
  field.

## ARIA-LOW-884

The J2 cache-key tests pin only the judges leg; the rule_contract_hash leg, the calibration_gate leg
and the rule that a legacy row without the new legs is a miss have no test

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the J2J5 review (lens evidence), registered by the J2J5 findings clerk on 2026-10-24;
  non-blocking at merge.
- Plan item(s): J2.
- Evidence:
  - `aria-kernel/tests/test_judgment_funnel.py:704` (the one key-leg test, judges)
  - `aria-kernel/tests/test_judgment_funnel.py:667` (the cited-blob leg)
  - `aria-kernel/aria_kernel/judgment_cache.py:64-70` (the five-part key)
  - `aria-kernel/aria_kernel/judgment_cache.py:81-102` (cache_lookup: an unknown half or an absent
    leg is a miss)
- Rule: Test rules (CLAUDE.md, test after every solution): each leg of a cache key is a way to serve
  a stale verdict and carries the test that proves it.
- Failure scenario: A refactor drops rule_contract_hash or calibration_gate from CACHE_KEY_FIELDS,
  or treats a schema_version 1 row as a hit, and no test fails. A direct cache_lookup probe in the
  review showed all three behave correctly today.
- Close condition: tests in test_judgment_funnel.py pin a changed rule_contract_hash and a changed
  calibration_gate as misses and a schema_version 1 row (no new legs) as a miss.
