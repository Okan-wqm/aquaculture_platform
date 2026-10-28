# ARIA wave-4 findings: the K2 review points (2026-10-28)

The K2 integration pull request (#2184, merge a81bfa2d6: D9 with D9a and D9b, F1.8 with F1.8a,
PRPUSH and DOCROLES) landed with the non-blocking review points of its packages listed as
"registered after the landing". This file registers those points, each through
`finding-registry add`.

Method. Three read-only verifiers re-read every note at origin/main a81bfa2d6 (the code of both
merges), reproduced each claim where they could, merged notes that share one root cause, and
compared every candidate with the registry snapshot of that revision. A finding below is a real,
evidence-backed defect with one root cause, an owner, a deadline and a close condition a test or
invariant can check. Owner is Okan-wqm for every row; deadlines are 2026-11-18 for HIGH, 2026-12-09
for MEDIUM and 2026-12-23 for LOW.

## Source B1: PR #2184 (K2), D9 with D9a and D9b

3 findings.

### ARIA-LOW-1150

The replay_dev feedback source is accepted by the CLI add path, import_feedback and evidence_chain
entries, so the documented guarantee that only feed_dev_misses mints it and a DEV-check case never
writes one is not structural: an imported row can suppress or plant a DEV miss.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-23.
- Raised by: the review notes of the D9 package with D9a and D9b, verified at origin/main a81bfa2d6;
  registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main a81bfa2d6.
- Evidence:
  - `aria-kernel/aria_kernel/feedback.py:36-38` (replay_dev is added to the one FEEDBACK_SOURCES
    set; the comment claims feed_dev_misses is its only minter)
  - `aria-kernel/aria_kernel/feedback.py:157-158` (the CLI add path validates --source against the
    same set)
  - `aria-kernel/aria_kernel/cli.py:993` (feedback add --source is a free string, default operator)
  - `aria-kernel/aria_kernel/feedback.py:334-336` (import_feedback validates source against the same
    set)
  - `aria-kernel/aria_kernel/feedback.py:360` (an imported record is copied whole, so subject_ref
    and defect_id survive normalization)
  - `aria-kernel/aria_kernel/feedback.py:510-511` (every evidence_chain entry may also name
    replay_dev as its source_type)
  - `aria-kernel/aria_kernel/role_fitness.py:476-480` (the dedup set trusts any missed_signal row
    whose source is replay_dev)
  - `docs/aria/CONTRACTS.md:1275-1276` (the contract: a replay_dev row is minted once per known miss
    by feed_dev_misses; a DEV-check case never produces one)
- Rule: CLAUDE.md Architectural Approach tier hierarchy (make the wrong behaviour impossible, do not
  only document it) and docs/aria/CONTRACTS.md section 8.5 (replay_dev rows are minted only by
  role_fitness.feed_dev_misses).
- Failure scenario: FEEDBACK_SOURCES is the single validation set for the CLI add path,
  import_feedback and evidence_chain entries, and normalize_feedback_event copies every field of an
  imported record (feedback.py:360). An operator import of a missed_signal row with source
  replay_dev and the (subject_ref, defect_id) of a real DEV-train miss makes feed_dev_misses see
  that pair as already minted (role_fitness.py:476-480), so the real miss never reaches memory; the
  same row for a DEV-check subject puts into memory exactly the lesson the feed is designed to keep
  out (role_fitness.py:475). The row looks identical to a minted one, so nothing downstream can
  tell. It needs an operator or a deliberate process, not an ARIA cycle.
- Close condition: Keep replay_dev out of the operator-facing vocabulary: give feed_dev_misses its
  own internal source that the CLI add path, import_feedback and evidence_chain validation reject,
  and keep docs/aria/CONTRACTS.md and aria-kernel/tests/test_contracts_mirror_code.py mirroring both
  sets. A test in aria-kernel/tests/test_discovery_recall_d9.py imports and CLI-adds a replay_dev
  row and expects ValueError, while feed_dev_misses still mints its rows.

### ARIA-LOW-1151

A gold-corpus defect without defect_class is scored class-agnostic by measure_discovery_recall (any
overlapping report hits it, so recall is overstated) while feed_dev_misses raises KeyError on the
same defect when missed, and no entry point validates the gold case shape that the docstrings
promise.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-23.
- Raised by: the review notes of the D9 package with D9a and D9b, verified at origin/main a81bfa2d6;
  registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main a81bfa2d6.
- Evidence:
  - `aria-kernel/aria_kernel/role_fitness.py:339-342` (docstring: gold defects always name a class;
    only the zoo's labels carry none)
  - `aria-kernel/aria_kernel/role_fitness.py:345-348` (a defect with no defect_class key skips the
    class comparison entirely)
  - `aria-kernel/aria_kernel/role_fitness.py:414-416` (measure_discovery_recall hands cases straight
    to the fold with no shape check)
  - `aria-kernel/aria_kernel/role_fitness.py:490-494` (feed_dev_misses indexes
    defect['defect_class'] for a miss)
  - `aria-kernel/tests/test_discovery_scoring_one_matcher.py:156-164` (pins that a classless gold
    defect is hit by a report of any class; no pin refuses it)
- Rule: One owner of a fact: the two gold-side callers of the one fold (measure_discovery_recall and
  feed_dev_misses) disagree on what a valid gold defect is; the SPEC ruling 'class only when the
  defect names one' is meant for the zoo's labels, not for a data error in the gold corpus.
- Failure scenario: A DEV case whose defect lacks defect_class (a data error in whatever producer
  later loads the corpus) makes `_defect_is_hit` skip the class test (role_fitness.py:345-348).
  Probe at this revision: one classless gold defect plus an overlapping report of class 'anything'
  gives hits 1, recall 1.0 and Wilson [0.2065, 1.0], with no error; the same defect with no report
  is a miss, and the feed then raises KeyError 'defect_class' at role_fitness.py:490, aborting the
  DEV miss feed. So a data error widens recall quietly when the defect is found and crashes the feed
  when it is missed. No producer passes cases yet (ARIA-HIGH-758), so no wrong number is recorded
  today.
- Close condition: Validate the gold case shape once on the gold side (defect_id, path, integer
  lines, defect_class) and have both measure_discovery_recall and feed_dev_misses refuse a defect
  without defect_class by name, as score_zoo_discovery already refuses id disagreement; the zoo
  adapter keeps classless defects by calling the fold directly. A test passes a classless gold
  defect to both entry points and expects the same named refusal; the pin at
  aria-kernel/tests/test_discovery_scoring_one_matcher.py:156 is rewritten to the zoo path.

### ARIA-LOW-1152

judge_calibration.wilson_interval is the declared one owner of the proportion interval, but no
ownership-atlas family or invariant guards it kernel-wide: D9a's one-route pin reads role_fitness.py
only and its retired-spelling list is a second, unequal copy of the atlas family's, so a second
Wilson spelling in any other module stays green.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-23.
- Raised by: the review notes of the D9 package with D9a and D9b, verified at origin/main a81bfa2d6;
  registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main a81bfa2d6.
- Evidence:
  - `aria-kernel/aria_kernel/ownership_atlas.py:122-127` (the discovery_scoring family forbids two
    retired names and lists no Wilson spelling)
  - `aria-kernel/aria_kernel/ownership_atlas.py:210-221` (one_owner_offenders scans only names a
    FAMILIES entry lists, outside its owner module)
  - `aria-kernel/tests/invariants/test_atlas_one_owner.py:311` (the test's own retired list holds
    three names, one more than the family)
  - `aria-kernel/tests/invariants/test_atlas_one_owner.py:450-452` (the one-route pin reads
    role_fitness.py source only)
  - `aria-kernel/tests/invariants/test_atlas_one_owner.py:471-475` (the one Wilson route assertion,
    scoped to that one module)
  - `aria-kernel/aria_kernel/calibration_actuator.py:75-89` (a second Wilson spelling outside the
    owner: own formula, z=1.645, no pin sees it)
  - `aria-kernel/aria_kernel/judge_calibration.py:340-352` (the declared owner, whose docstring says
    it is the one owner of the interval)
- Rule: docs/aria one-owner rule enforced by ownership_atlas.FAMILIES (CLAUDE.md tier 3, make it
  detectable): a fact with one owner needs a family or a pin that is red when a second spelling
  appears.
- Failure scenario: one_owner_offenders only looks for the names a family lists, and no family lists
  a Wilson spelling; the D9a scans read role_fitness.py alone. A new def wilson or
  `_wilson_interval` in any other kernel module, or a copy like calibration_actuator.wilson (own
  formula, 90 percent, calibration_actuator.py:75-89), is red in no test. ARIA-LOW-950 tracks the
  one existing copy; once it is closed by hand, nothing detects the next one, and the retired name
  `_wilson_interval` is guarded only inside role_fitness.py.
- Close condition: Register the proportion interval as an ownership-atlas family (owner
  judge_calibration.py:wilson_interval, forbidden spellings including wilson and `_wilson_interval`;
  carry finding=ARIA-LOW-950 until calibration_actuator.wilson is folded), derive
  `_RETIRED_DISCOVERY_SPELLINGS` in aria-kernel/tests/invariants/test_atlas_one_owner.py from the
  family, and add a planted-forgery pin; the invariant is red on a second Wilson definition in a
  module other than judge_calibration.py, and OWNERSHIP-ATLAS.md is regenerated.

## Source B2: PR #2184 (K2), F1.8 with F1.8a

3 findings.

### ARIA-LOW-1153

compute_eval_window_superiority substitutes the instant of the look for a missing EVAL_WINDOW anchor
and still runs the paired comparison, against the reader's own contract and ruling 1, so an absent
or unreadable anchor is reported as a shortage of discordant pairs

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-23.
- Raised by: the review notes of the F1.8 package with F1.8a, verified at origin/main a81bfa2d6;
  registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main a81bfa2d6.
- Evidence:
  - `aria-kernel/aria_kernel/genesis_superiority.py:98-107` (entered is None becomes
    window_start=utc_now_datetime() and compare_eval_windows runs anyway)
  - `aria-kernel/aria_kernel/genesis_lifecycle.py:204-210` (the reader returns None for a chain that
    is not in EVAL_WINDOW or whose stamp cannot be read, and its docstring says the caller must not
    invent an anchor)
  - `aria-kernel/aria_kernel/genesis_lifecycle.py:136` (a row without recorded_at is stored as '' in
    a lawful chain, which parse_utc_stamp turns into None)
  - `aria-kernel/aria_kernel/tool_registry.py:157-178` (parse_utc_stamp: None is returned so each
    caller must decide, not inherit a default)
  - `aria-kernel/aria_kernel/genesis_policy.py:1071` (min_discordant_pairs is at least 1, so a
    comparison with zero pairs can never pass)
  - `aria-kernel/tests/test_sequential_gain_test.py:1189-1197` (the test pins the substituted
    instant and the insufficient_evidence verdict)
  - `aria-kernel/tests/test_sequential_gain_test.py:1224-1238` (a forged chain is pinned to the same
    substituted anchor)
- Rule: F1.8a SPEC ruling 1 (no anchor: the comparison 'does not run', fail closed) and the
  docstring of eval_window_entered_at ('The caller must not invent an anchor'); CLAUDE.md root-cause
  rule against defensive fallbacks that hide the missing upstream fact.
- Failure scenario: An entity that is not in EVAL_WINDOW, or whose EVAL_WINDOW entry row carries a
  recorded_at that does not parse (a hand-appended row, or a row without the stamp that `_replay`
  coerces to ''), gets anchor None from eval_window_entered_at. compute_eval_window_superiority then
  anchors the paired test at the instant of the look, finds no run dated at or after that instant,
  and returns window.verdict insufficient_evidence with reason 'need 6 discordant pairs, have 0' and
  window_start equal to the time of the look. Promotion is refused (the gate fails closed because
  pairs are 0 and the minimum is at least 1), but the proof names a missing anchor as a shortage of
  evidence and records a fabricated window_start; an entity whose entry stamp is unreadable stays in
  EVAL_WINDOW for good (a lawful chain enters each state once) with a diagnosis that points at the
  wrong cause. Read from the code; not reachable through record_transition, which always stamps with
  utc_now.
- Close condition: compute_eval_window_superiority returns passed False with a named reason (for
  example no_eval_window_entry) and makes zero calls to compare_eval_windows when
  eval_window_entered_at returns None; the two GateTests above are rewritten to assert that reason
  and a spy call count of zero, and `_replay` keeps an absent recorded_at as an absent value (or
  refuses the chain) instead of manufacturing ''.

### ARIA-LOW-1154

genesis_lifecycle.**all** omits the public reader eval_window_entered_at that genesis_superiority
imports by name, and genesis_lifecycle is not one of the modules whose **all** is pinned to its
public definitions

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-23.
- Raised by: the review notes of the F1.8 package with F1.8a, verified at origin/main a81bfa2d6;
  registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main a81bfa2d6.
- Evidence:
  - `aria-kernel/aria_kernel/genesis_lifecycle.py:187-210` (eval_window_entered_at is a public
    top-level function)
  - `aria-kernel/aria_kernel/genesis_lifecycle.py:581-596` (**all** lists every other public name
    and not eval_window_entered_at)
  - `aria-kernel/aria_kernel/genesis_superiority.py:44` (production code imports the reader by name)
  - `aria-kernel/tests/test_module_export_surfaces.py:19-23` (the registered modules are
    autonomy_ladder, calibrated_intelligence and own_pr_ci; genesis_lifecycle is not pinned)
- Rule: The ARIA-LOW-475 rule that a kernel module's **all** names exactly its public top-level
  definitions (tests/test_module_export_surfaces.py).
- Failure scenario: The module's declared interface and its real one disagree: a reader, an API
  audit or `from aria_kernel.genesis_lifecycle import *` takes the module to offer
  current_lifecycle_state, lifecycle_chains and production_block_reason but not the F1.8a anchor
  reader, which production code already depends on. Nothing fails today, and nothing would catch the
  next public function that is added without an **all** entry, because the module is outside the
  pinned list.
- Close condition: Add eval_window_entered_at to genesis_lifecycle.**all** and add
  aria_kernel.genesis_lifecycle to `_REGISTERED_MODULES` in test_module_export_surfaces.py, so
  ModuleExportSurfaces.test_all_names_exactly_the_public_definitions passes for it and fails when a
  public definition is left out.

### ARIA-LOW-1155

The SUPERIORITY_SCHEMA comment states window_days as the window each side of the paired test reads,
while the policy default's `_doc` and the code define it as the baseline look-back before the
EVAL_WINDOW entry with an open-ended candidate window, so one contract is stated twice with two
meanings and no pin

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-23.
- Raised by: the review notes of the F1.8 package with F1.8a, verified at origin/main a81bfa2d6;
  registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main a81bfa2d6.
- Evidence:
  - `aria-kernel/aria_kernel/genesis_policy.py:1062-1066` (comment: window_days is which eval runs
    each side of the paired test reads)
  - `aria-kernel/aria_kernel/data/genesis_policy_default.json:212` (the `_doc`: window_days is the
    length of the baseline look-back before the entry; the comparison starts at the entry and has no
    end)
  - `aria-kernel/aria_kernel/agent_eval.py:772-784` (current window is [window_start, open end),
    previous window is [window_start - window_days, window_start))
  - `aria-kernel/aria_kernel/agent_eval.py:1031-1035` (now = window_start + window_days is only the
    seam of the split)
- Rule: One owner per fact (CLAUDE.md single center, PLAN-v2 section 1.2): the meaning of
  window_days has two statements that differ and no test ties them.
- Failure scenario: A developer or operator who reads the schema comment concludes that window_days
  bounds the runs both sides read, so lengthening it widens the candidate's evidence. Under F1.8(a)
  the candidate side is open-ended from the entry and window_days only sets how far back the
  baseline reaches, so a wrong expectation about the pre-registered knob follows from the comment
  while the policy file says the opposite.
- Close condition: Rewrite the comment above SUPERIORITY_SCHEMA to the meaning in
  genesis_policy_default.json (or drop the key description and point at the `_doc`), and add an
  assertion in the genesis policy tests that the schema comment and the default `_doc` do not give
  window_days different meanings, or delete the comment so the `_doc` is the only statement.

## Source B3: PR #2184 (K2), PRPUSH

2 findings.

### ARIA-LOW-1156

push_prepared_branch re-reads the proposal's approval through require_operator_approval alone and
omits the status == approved_for_apply precondition that prepare_branch and commit_prepared_branch
both enforce, so a proposal whose latest row left approved_for_apply but kept approval_source
operator still pushes under strict

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-23.
- Raised by: the review notes of the PRPUSH package, verified at origin/main a81bfa2d6; registered
  by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main a81bfa2d6.
- Evidence:
  - `aria-kernel/aria_kernel/pr_manager.py:998-999` (prepare_branch refuses a proposal not in
    approved_for_apply)
  - `aria-kernel/aria_kernel/pr_manager.py:1047-1048` (commit_prepared_branch refuses a proposal not
    in approved_for_apply)
  - `aria-kernel/aria_kernel/pr_manager.py:1103-1116` (the push comment says the approval is re-read
    as the two siblings do, and the call checks approval_source only)
  - `aria-kernel/aria_kernel/proposal.py:103-112` (get_proposal returns the latest row for the id,
    whatever its status)
  - `aria-kernel/aria_kernel/proposal.py:223-243` (approval_source_of reads the declared
    approval_source and never looks at status)
  - `aria-kernel/tests/test_pr_manager_e2e.py:1536-1548` (the withdrawal fixture clears
    approval_source together with status, so a status-only change is unpinned)
  - `aria-kernel/tests/test_pr_manager_e2e.py:1591-1595` (the only withdrawal pin passes whether or
    not push checks status)
- Rule: ARIA-MEDIUM-1109 intent as written in the push comment: the push re-reads the approval 'as
  prepare_branch and commit_prepared_branch do'; the lane's other two steps both gate on status ==
  approved_for_apply.
- Failure scenario: Append a proposals row for the same proposal_id with status 'open' (or any value
  other than approved_for_apply) and approval_source still 'operator'. get_proposal returns that
  row, require_operator_approval sees source 'operator' and passes, enforce_profile_for_action
  passes under strict, and git push -u runs, putting the aria/\* branch on the remote for a proposal
  the lane no longer treats as approved. No production writer produces such a row today
  (record_proposal mints fresh ids and `_write_approval` only sets approved_for_apply), so it is
  reachable only through a hand-appended ledger row; it becomes reachable as soon as any writer
  changes status without clearing the approval fields.
- Close condition: push_prepared_branch refuses with a named GovernanceError when the proposal's
  status is not approved_for_apply, using the same check as commit_prepared_branch, and
  PushIsAGovernedActionTests gains a case that appends a row with status open and approval_source
  operator and asserts the refusal before any git call, intent row or push row.

### ARIA-LOW-1157

The 'autonomous permits' legend above ACTION_PERMISSIONS is a hand-kept third list of the table that
omits pr_create and pr_push, both of which the table grants to autonomous, and no test ties the
legend to the table it calls the single source of truth

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-23.
- Raised by: the review notes of the PRPUSH package, verified at origin/main a81bfa2d6; registered
  by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main a81bfa2d6.
- Evidence:
  - `aria-kernel/aria_kernel/runtime_profile.py:158-163` (the comment says the table is the SSoT and
    that the action_permissions test asserts it)
  - `aria-kernel/aria_kernel/runtime_profile.py:165-176` (the legend lists eight actions for
    autonomous and not pr_create or pr_push)
  - `aria-kernel/aria_kernel/runtime_profile.py:181-190` (the table grants pr_create and pr_push to
    strict and autonomous)
  - `aria-kernel/tests/test_runtime_profile.py:886-899` (the wiring-list pin covers the module
    docstring and enforce_profile_for_action only, not this legend)
- Rule: One owner per fact (CLAUDE.md single center, no second copy without an invariant): the
  authority table is the SSoT and the legend is an unpinned copy that is already wrong.
- Failure scenario: A reviewer auditing which actions the autonomous profile holds from the comment
  concludes it has no pr_create and no pr_push authority, the two GitHub-facing cells, while the
  table grants both. The copy already drifted before the push cell was added and the PRPUSH change
  extended the two lists a test pins but not this one.
- Close condition: Delete the legend (each table cell already names autonomous explicitly) or
  replace it with a pointer to ACTION_PERMISSIONS, and add a runtime_profile test that fails if a
  comment block above the table restates the autonomous set differently from the keys whose value
  contains 'autonomous'.

## Source B4: PR #2184 (K2), DOCROLES

5 findings.

### ARIA-MEDIUM-1158

The file-name token rule makes any document named plan, spec, audit and the like a record unless it
carries the ARIA-LIVE-AUTHORITY banner, so docs/plans/sensor-rust-migration/PLAN.md, which CLAUDE.md
and ADR-025 cite as the live plan, has 7 stale path references that the adapter no longer reports,
and nothing pins that cited-as-live documents stay scanned

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-12-09.
- Raised by: the review notes of the DOCROLES package, verified at origin/main a81bfa2d6; registered
  by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main a81bfa2d6.
- Evidence:
  - `tools/aria-adapters/doc-staleness-adapter.ts:350-361` (RECORD_NAME_TOKENS holds plan, spec,
    audit, report, review and four more words, matched against the base name only)
  - `tools/aria-adapters/doc-staleness-adapter.ts:384-388` (the only document-level escape is the
    ARIA-LIVE-AUTHORITY banner in the first 5 lines)
  - `tools/aria-adapters/doc-staleness-adapter.ts:397-401` (token branch of isPointInTimeRecord,
    skipped only when the banner is present; an explicit Status of Accepted or Normative is not
    consulted)
  - `CLAUDE.md:49` (the architecture map names docs/plans/sensor-rust-migration/PLAN.md as the plan
    of the sensor-ingestion sidecar)
  - `docs/adr/025-rust-sidecar-architecture.md:141` (ADR-025 lists the same PLAN.md as the full
    migration plan)
  - `docs/plans/sensor-rust-migration/PLAN.md:58-60` (invariant table rows name
    apps/sensor-service/src/ingestion/batch-processor.service.ts, which no longer exists, and
    apps/sensor-service/src/cache/sensor-topic-cache.service.ts, which now lives under ingestion/)
  - `docs/plans/sensor-rust-migration/PLAN.md:121` (names tools/scripts/check-codec-drift.sh; the
    repo file is tools/scripts/check-codec-drift.ts)
  - `docs/adr/037-plan-limit-ssot.md:1-3` (Status Accepted, and plan here means the subscription
    plan, yet the base name makes it a record)
- Rule: A missing path is stale only where a live document claims it exists
  (doc-staleness-adapter.ts header, ARIA-HIGH-212); a record classification must follow the
  document's own role, and the repo already has one mechanism for a document that stays live despite
  its name (the ARIA-LIVE-AUTHORITY banner) with no pin that the documents CLAUDE.md cites as
  current use it.
- Failure scenario: isPointInTimeRecord returns true for docs/plans/sensor-rust-migration/PLAN.md
  only because the base name holds the token plan (reproduced at a81bfa2d6 by running the adapter's
  exported functions over the revision's tree). The adapter counts it in recordDocs and never emits
  its 7 references (58, 60, 121, 122, 274, 364, 372; four are verifiable renames or moves (lines 60,
  121, 274, 364) and the rest name files that no longer exist) although CLAUDE.md:49 and ADR-025
  send readers to it as the live plan. The same rule makes docs/adr/037-plan-limit-ssot.md (Status
  Accepted), docs/aria/MISSION_SPEC.md (normative), docs/architecture/audit-tables.md
  (AUTHORITATIVE) and the runbooks edge-audit-forensics.md and product-audit-invocation.md records
  through a topic word; none has a missing reference today, so the loss there is silent future
  recall. Across the tree 29 documents are records by name alone and 68 stale references in 11 of
  them (a replay of the adapter functions over the revision) are not reported; the banner half of
  this problem was fixed for docs/aria/SPEC.md by 65204058b.
- Close condition: Read a document's own live header (the ARIA-LIVE-AUTHORITY banner, or a Status of
  Accepted, Normative or Authoritative) before the name token in isPointInTimeRecord, give PLAN.md
  such a header, and add a real-tree test that every docs path cited in CLAUDE.md is not read as a
  record; proof is the adapter test with a fixture for each header and the real-tree test green,
  with PLAN.md's 7 references repaired so the adapter reports no finding for it while it is scanned
  live.

### ARIA-MEDIUM-1159

The file-name token rule lists only singular words, so a plural base name such as
docs/db/19-improvement-specs.md is not a record and that one dated snapshot document emits 30 of the
adapter's 172 findings on the real tree

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-12-09.
- Raised by: the review notes of the DOCROLES package, verified at origin/main a81bfa2d6; registered
  by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main a81bfa2d6.
- Evidence:
  - `tools/aria-adapters/doc-staleness-adapter.ts:335` (RECORD_DIR_SEGMENTS spells the plurals
    reviews and audits)
  - `tools/aria-adapters/doc-staleness-adapter.ts:350-360` (RECORD_NAME_TOKENS spells only the
    singulars report, review, audit, verification, spec, plan, inventory, retro, plus findings)
  - `tools/aria-adapters/doc-staleness-adapter.ts:397-401` (the base name is split on separators and
    each token must equal a listed word, so specs never matches spec)
  - `docs/db/19-improvement-specs.md:1-5` (a generated document dated 2026-03-18 with Status Ready
    for implementation agents)
  - `docs/db/19-improvement-specs.md:162` (file table of the cron services as of 2026-03-18;
    feeding-cron.service.ts no longer exists)
  - `docs/db/19-improvement-specs.md:277-282` (six tenant-schema.middleware.ts paths that no longer
    exist)
  - `tools/aria-adapters/doc-staleness-adapter.test.ts:468-482` (the file-name pin enumerates only
    the nine singular tokens; no plural base name is pinned either way)
- Rule: DOCROLES SPEC ruling 2 (a base name holding spec, plan, report and the other tokens is a
  point-in-time record) and the single-owner rule: the review and audit vocabulary has two spellings
  (plural for directories, singular for names) with no pin that relates them.
- Failure scenario: Calling isPointInTimeRecord on docs/db/19-improvement-specs.md returns false,
  while docs/db/19-improvement-spec.md, docs/db/18-final-review-report.md and the other numbered
  documents of that series return true. The document is scanned as live, none of its roles apply to
  the file tables, and a replay of the adapter functions over a81bfa2d6 emits 30 findings for it (17
  percent of all 172), and by the package's own ruling that a spec is a record these are history,
  not staleness. They go to the judges as false claims and lower the precision that ARIA-HIGH-212
  measures. docs/guides/reviews.md is the same class (live although named for a review).
- Close condition: Match each record token and its plural from one list that RECORD_DIR_SEGMENTS
  also reads, and pin plural base names in the file-name scenario of doc-staleness-adapter.test.ts;
  proof is isPointInTimeRecord true for docs/db/19-improvement-specs.md and the real-tree replay
  dropping 172 to 142 findings with recordDocs up by one.

### ARIA-LOW-1160

isPointInTimeRecord reads the Status header from raw lines with no fence mask, so a Status: Proposed
or Draft line inside a code block in the first 40 lines turns a live document into a record and
silences all of its references

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-23.
- Raised by: the review notes of the DOCROLES package, verified at origin/main a81bfa2d6; registered
  by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main a81bfa2d6.
- Evidence:
  - `tools/aria-adapters/doc-staleness-adapter.ts:184-196` (fenceMask exists in the same file and is
    used by the reference roles)
  - `tools/aria-adapters/doc-staleness-adapter.ts:375-378` (STATUS_HEADER_RES match any line that
    spells a status, with no notion of a fence or a blockquote)
  - `tools/aria-adapters/doc-staleness-adapter.ts:405` (the status test slices the first 40 raw
    lines and never consults a fence mask)
  - `tools/aria-adapters/doc-staleness-adapter.test.ts:448-466` (the window scenario pins lines 40,
    41 and 80 but holds no case for a fenced Status line)
- Rule: DOCROLES SPEC ruling 1 (the document's own header states its status) and the adapter's own
  convention that fenced lines are code, not prose (referenceRole already masks them).
- Failure scenario: A guide that teaches how to write an ADR and shows the template in a code block
  with a Status: Proposed line within its first 40 lines is read as a record: calling
  isPointInTimeRecord on such a document returned true at a81bfa2d6 (probe with the template block
  and a later reference to a missing apps path). Every stale reference of that guide then goes
  unreported. Not reachable on the current tree: none of the 32 documents with a Status line in
  their first 40 lines has it inside a fence, and no fenced status line exists anywhere under the
  scan roots.
- Close condition: Apply fenceMask(lines) to the status check (and to the header marker test beside
  it) and add a case to semantic-status-header-records plus a unit scenario in which a fenced
  Status: Proposed keeps the document live and its missing path flagged.

### ARIA-LOW-1161

The ARIA-HISTORICAL, ARIA-SUPERSEDED and ARIA-LIVE-AUTHORITY header markers have two owners that
disagree on where a marker counts: the adapter reads them in the first 5 lines only, the invariant
spec counts them anywhere in the body, and no test relates the two lists

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-23.
- Raised by: the review notes of the DOCROLES package, verified at origin/main a81bfa2d6; registered
  by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main a81bfa2d6.
- Evidence:
  - `tools/aria-adapters/doc-staleness-adapter.ts:344-345` (RECORD_MARKERS lists two of the markers
    and MARKER_HEAD_LINES is 5)
  - `tools/aria-adapters/doc-staleness-adapter.ts:384-388` (the live-authority banner is a third
    spelling with its own regex and the same 5-line window)
  - `tools/aria-adapters/doc-staleness-adapter.ts:403-404` (the marker test slices the first 5
    lines)
  - `tests/invariants/aria-doc-runtime-ssot.spec.ts:74` (PLAN_MARKERS lists all three markers
    independently)
  - `tests/invariants/aria-doc-runtime-ssot.spec.ts:189-194` (planMarkerCount counts occurrences
    anywhere in the document body)
  - `tests/invariants/aria-doc-runtime-ssot.spec.ts:263-269` (every ARIA plan document must hold
    exactly one marker, at any position)
- Rule: CLAUDE.md single-owner principle (every concept has one owner; a second copy is deleted or
  pinned by an invariant).
- Failure scenario: A docs/aria/plans document that carries its single ARIA-HISTORICAL marker on
  line 7 satisfies the invariant (one marker, anywhere), yet isPointInTimeRecord returns false for
  it (probe at a81bfa2d6), so the adapter scans the plan as live and emits its missing references as
  stale claims. A new marker added to PLAN_MARKERS is likewise invisible to the adapter. Not
  reachable today: every marker-carrying document under docs/aria, docs/adr/033 and
  docs/runbooks/aria-gateway.md holds it on line 1.
- Close condition: Export the marker words and the head window from the adapter (or a shared module)
  and make the invariant spec import them for PLAN_MARKERS, with an assertion that every
  docs/aria/plans document carries its marker inside that window; proof is the invariant failing
  when a marker is moved to line 6.

### ARIA-LOW-1162

ADR-012 (messaging service) and ADR-013 (NestJS 11 upgrade) still declare Status: Proposed although
apps/messaging-service exists and package.json depends on @nestjs/core ^11, so the new status rule
reads both as records and no check compares an ADR status with the repository

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-23.
- Raised by: the review notes of the DOCROLES package, verified at origin/main a81bfa2d6; registered
  by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main a81bfa2d6.
- Evidence:
  - `docs/architecture/ADR-012-messaging-service.md:3` (Status Proposed, dated 2026-03-28)
  - `docs/architecture/ADR-013-nestjs-v11-upgrade.md:3` (Status Proposed (Reviewed), dated
    2026-03-29)
  - `package.json:207-209` (@nestjs/common and @nestjs/core at ^11.2.7, so the upgrade ADR-013
    proposes is done)
  - `CLAUDE.md:54` (the architecture map lists messaging-service as a running service)
  - `tools/aria-adapters/doc-staleness-adapter.ts:375-378` (STATUS_HEADER_RES accept Proposed
    followed by a parenthesis)
  - `tools/aria-adapters/doc-staleness-adapter.ts:405` (a header match makes the document a record;
    the header is never compared with the repository)
  - `docs/architecture/ADR-013-nestjs-v11-upgrade.md:333` (names platform/event-bus, a directory
    that is platform/libs/event-bus in the repo)
  - `CLAUDE.md:181` (known-drift note lists ADR-012 and ADR-013 as misfiled and tracks only their
    location)
- Rule: A document that answers confidently and wrongly is the defect doc-staleness exists to find
  (adapter header lines 4-6); an ADR whose status contradicts the shipped code is such a document,
  and DOCROLES ruling 1 makes it invisible to the only scanner.
- Failure scenario: Both ADRs spell a status the rule accepts, so a replay of the adapter functions
  at a81bfa2d6 counts them in recordDocs and reports none of their 11 missing paths (ADR-012 lines
  1783, 1842-1844, 1905; ADR-013 lines 161, 175, 176, 179, 333, 404). Whether each of those rows is
  a claim is the owner's call; the headers themselves are wrong, since the service and the upgrade
  are shipped, and a reader of these misfiled ADRs (CLAUDE.md:181 tracks only their location) is
  told the decision is still open. ADR-038 line 20 is hidden the same way.
- Close condition: Set the status of both ADRs to the state the repository shows (Accepted or
  Implemented with a date), then run the adapter over them as live documents and repair or role-mark
  whatever it reports; proof is the adapter reporting zero findings for both paths with recordDocs
  not counting them.

## Notes the clerk did not register

- Notes examined and not registered: 16 (style or process notes 11, duplicates of existing rows 3,
  already fixed 2). Each is recorded with its reason in the verifiers' result files.
- Duplicates of existing rows, whose root cause and close condition are the row's: ARIA-HIGH-758,
  ARIA-MEDIUM-1045, ARIA-MEDIUM-1115.
- Two review notes were already fixed after the reviewed head: a control that draws a malformed
  claim in the zoo scorer is a false alarm again (D9b, commit 97a44d364), and the live-authority
  banner outranks the file-name token rule of the doc-staleness adapter (DOCROLES, commit
  65204058b).
- ARIA-MEDIUM-1108 stays OPEN: the DOCROLES package advances it and does not close it. The two
  MEDIUM findings of the DOCROLES group below record where the file-name token rule still reads live
  documents as records; the false-alarm change on a held-out sample is measured by the peer session
  that proposed the rules.
