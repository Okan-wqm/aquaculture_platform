# ARIA operator request channel — signed, grounded, consumed once (2026-10-02)

Context: the operator wants the next strict nightly cycle to plan one of ARIA's own F findings
(F-007) instead of a failing CI run. The operator-feedback source already ranks at priority 0
(`plan_synthesizer._SOURCE_PRIORITY`), so a signed operator request is the designed way to express
a one-time decision without editing the standing priority. Reading the channel end to end showed it
could not deliver a single request, and that the failing-CI source it has to outrank has no notion
of which red workflows are about `main`. The architectural-arbiter ruled on both on 2026-10-02
(ADR-0018, ADR-0019 proposed, ADR-0020 under `docs/recommendations/architectural-arbiter/`).

Owner: claude (implementation), okan (review, operator steps, ADR-0019 decision).

## ARIA-CRITICAL-255

Context: a request row reached the synthesizer through `ingest_operator_feedback`, which admitted
every row whose `status` was `unaddressed`. Five independent defects sat on the path from that row
to a merged plan, and any one of them was enough to stop delivery.

Evidence:

- `aria-kernel/aria_kernel/operator_feedback_ingestion.py:98` — every `unaddressed` row is a
  candidate on every scan and nothing ever changes the status, so one request holds priority 0
  forever.
- `aria-kernel/aria_kernel/plan_synthesizer.py:1095` — the operator plan's only evidence ref and
  only surface was `aria-tools/operator-feedback.jsonl`, ARIA's own output;
  `aria-kernel/aria_kernel/agent_invocations.py:1315` refuses such an envelope
  (`request_evidence_self_output_only`), so the challenger could never be minted.
- `aria-kernel/aria_kernel/operator_feedback_signature.py:46` — request rows were HMAC-signed under
  `secrets/operator-feedback-hmac.key`, minted on the runner: any runner-uid process could sign.
  `.github/workflows/aria-auto-cycle.yml:204` (and `aria-agent-executor.yml:183`) run
  `git clean -ffdx` at job start, and the store never publishes `secrets/`, so the key died with
  every self-hosted job.
- `aria-kernel/aria_kernel/operator_feedback_ingestion.py:282` — check 12 re-verified consumed rows
  against that key file; `.github/workflows/aria-merge-authority.yml:19` runs on `ubuntu-latest`,
  which never holds it, so an operator-sourced plan could never pass the pre-merge perimeter.
- `aria-kernel/aria_kernel/plan_convergence.py:577` — `_validate_submitted_plan` never compared a
  submitted body's `finding_id` with the started plan's; a challenger or revision could drop it.

Rule: an operator decision reaches the planner only through a channel the operator alone can sign,
that a runner uid cannot forge, that every lane verifies against the same committed anchor, that is
consumed once, whose plan is grounded in tracked repository evidence, and whose plan keeps its
finding from start to merge (ADR-0018, ADR-0020).

Fix:

- Request rows carry `finding_id` and an operator ed25519 signature (`ssh-keygen -Y sign -n
aria-operator-request`), verified against `.github/manifests/aria-operator-signers` read as a git
  object (cycle HEAD at ingestion, the PR's live base on `main` at merge)
  — `aria_kernel/operator_request_signature.py`. The HMAC stays for kernel-written verdict and
  calibration rows only, and the HMAC append path refuses a request-shaped row.
- One admission for F_FINDING and operator candidates (`aria_kernel/finding_grounding.py`): OPEN in
  the event fold, refs that are tracked files of the checkout, at least one writable surface;
  refused surfaces named in the conversion event. An operator plan's summary is fixed text plus the
  operator's sanitized words; no finding-body field reaches the plan.
- Consume-once at ingestion (`aria_kernel/operator_request_spend.py`): spent when a started plan's
  binding consumed it or a `request_refused` row names it; reused ids refused at record time and at
  ingestion.
- `_validate_submitted_plan` refuses a body whose `finding_id` differs from, adds to or drops the
  started plan's (`plan_origin_changed`); the planner bridge carries the started origin onto a body
  that names none.
- Check 12 verifies with the committed anchor only; no key file exists on any lane.

## ARIA-HIGH-256

Context: the failing-CI source ranks above every finding source and supplies a candidate for any
workflow red on `main`, whatever that workflow judges. With eight workflows red on 2026-10-02,
observers and post-deploy probes outranked every F finding ARIA holds.

Evidence:

- `aria-kernel/aria_kernel/plan_synthesizer.py:678` — `scan_failing_ci` keeps any workflow whose
  newest decisive run on `main` failed; no input says what the workflow is a verdict about.
- `aria-kernel/aria_kernel/plan_synthesizer.py:823` — `_SOURCE_PRIORITY` ranks `failing_ci` at 1,
  above ORPHAN (2) and F findings (3).
- `.github/workflows/e2e-tests.yml:12` — runs on `workflow_run` after deploy and judges `main`, so
  an exclusion keyed on `event == workflow_run` would drop a real verdict.

Rule: FAILING_CI means a red workflow whose verdict is about `main` itself (ADR-0019, accepted by
the operator 2026-10-02).

Fix (implemented 2026-10-02):

- `.github/manifests/workflow-roles.json` gives each of the 56 workflows one role with a one-line
  reason: 49 `main_verdict`, 5 `pr_verdict` (`aria-merge-authority`, `aria-readiness-claim`,
  `backup-manifest-invariant`, `closes-footer-check`, `dependency-review`), 2 `observer`
  (`scheduled-workflow-watchdog`, `aria-external-watchdog`, each with its `observes` list).
- `tests/invariants/workflow-roles.spec.ts` pins it to `.github/workflows/`: every file declared
  once, no stale entry, `name` equal to the workflow's `name:` and unique, the closed role set, a
  pull-request trigger for `pr_verdict` (directly or via `workflow_run`), and for `observer` an
  `observes` list of existing workflows that its source (or a manifest its source loads) names,
  plus a `workflow_run` trigger or a runs API call.
- `scan_failing_ci` reads the manifest at the checkout's commit once `main_anchor` proves it on
  `main`, else from the working tree. Only a `main_verdict` or undeclared red workflow is a
  candidate; each excluded one is disclosed once per cycle as `failing_ci_workflow_excluded`
  (workflow, role, run id). A missing or malformed manifest excludes nothing and is disclosed once
  per cycle as `failing_ci_workflow_roles_unavailable`. The run cache holds the reds before the
  role filter (cache schema 2), so a cached scan discloses its own cycle's exclusions too.
- Tests: `aria-kernel/tests/test_failing_ci_main_verdict.py`.

## ARIA-HIGH-260

Context: raised by the architectural-arbiter in review round 2. The operator channel is an operator
act per request; the aging F_FINDING source (priority 3) is not. When no higher source converts, it
turns one of ARIA's own findings into a grounded plan unattended, and ADR-0003 named the guards such
a self-feed needs before it may exist.

Evidence:

- `aria-kernel/aria_kernel/plan_synthesizer.py:584` — `scan_f_findings` ranks every aging F finding.
- `aria-kernel/aria_kernel/plan_synthesizer.py:831` — `F_FINDING` holds slot 3.
- `aria-kernel/aria_kernel/finding_grounding.py:115` and
  `aria-kernel/aria_kernel/cycle_phases/plan_source.py:199` — admission and conversion judge grounding
  only.
- `docs/recommendations/architectural-arbiter/2026-05-20-adr-0003-aria-self-feed-deferred.md:49-51` —
  prerequisites 3 (originating-skill self-loop guard), 4 (per-24h cap) and 5 (cycle detection).

Rule: a source that plans ARIA's own findings carries ADR-0003's loop guards.

Fix: `finding_grounding.admit_candidate` runs `judge_loop_guards` on every admitted F_FINDING
candidate and on nothing else; an operator request is the operator's act and is never judged by
them. The provider folds the history once per synthesis
(`load_grounding_context(workspace_root, tools_root=base_dir)`) from ledgers the kernel already
writes: plan events, `synthesis_bound` rows, self-reverts and finding events. A refusal is the
candidate's one `plan_candidate_conversion_skipped` event of the cycle, with a stable reason and a
`loop_guard` detail. A context without that history refuses (`f_finding_loop_history_unavailable`).

- Prerequisite 3: `f_finding_self_loop_origin_surface` (an ARIA-originated finding whose plan would
  modify a path in `self_improvement.SELF_CHANGE_ALLOWED_PREFIXES`),
  `f_finding_self_loop_own_change` (a finding emitted after an ARIA plan merged a change to its
  evidence) and ADR-0003's own watchdog predicate, `f_finding_self_loop_watchdog_recent`.
- Prerequisite 4: `f_finding_global_cap_exceeded`. At most `max_plans_per_24h` F-sourced plans
  start in any rolling 24h, counted from `plan_started` stamps. The value lives in the
  `f_finding_loop_guards` policy block (default 1); a plan an operator request bound never counts.
- Prerequisite 5: `f_finding_subject_quarantined` (a merge the self-revert producer attributed,
  until an operator-sourced plan for the finding starts), `f_finding_subject_cool_off`
  (`cool_off_days`, default 7, after a failed plan or a new finding on what it changed) and
  ADR-0003's own `f_finding_watchdog_resolution_streak`.

Pinned by `aria-kernel/tests/test_f_finding_loop_guards.py`. Prerequisite 2 (12 adversarial
fixtures) is pinned by `test_no_adversarial_payload_reaches_any_plan_field`.

## ARIA-MEDIUM-261

Context: the reviewers asked whether a converged plan's revisions can widen `affected_surfaces`
beyond the grounding the request or finding was admitted on. Verified 2026-10-02: they can.

Evidence:

- `aria-kernel/aria_kernel/cross_review_bridge.py:807` — the implementation's `allowed_scope` is the
  CONVERGED body's surfaces minus `READONLY_PATHS`.
- `aria-kernel/aria_kernel/plan_convergence.py:603` — a submitted body is held to its origin
  `finding_id`, not to its surfaces.
- `aria-kernel/aria_kernel/plan_coverage.py:10` — the coverage gate makes a revision claim the impact
  closure of its surfaces, so widening is required, not incidental.

Rule: the write scope of an operator- or finding-sourced plan is bounded by what admission grounded
plus a closure the kernel computes, never by planner prose alone.

Fix: `plan_convergence.start_plan` records the bound on `plan_started` as `admission_scope`
(`plan_origin.compute_admission_scope`): the admitted surfaces plus the roots of their
`impact_graph.plan_downstream_impact` project closure, computed by the kernel in the plan's
workspace with no parameter to pass one in, united with the subject pins of
`plan_origin.SUBJECT_PIN_POLICY` (empty; the CB-5 hook). `_validate_submitted_plan` refuses a
challenger draft or revision naming a path outside it (`revision_scope_exceeds_admission_closure`,
paths listed, one governance row); `implementation_allowed_scope` takes the bound as a required
argument and refuses a scope that exceeds it, so the implementation mint refuses with the plan
still CONVERGED. A finding-origin plan with no record is refused (`admission_scope_missing`).
Recorded as ADR-0021 (`2026-10-02-adr-0021-revision-scope-bound.md`). Tests:
`aria-kernel/tests/test_revision_scope_bound.py`.

Arbiter ruling (2026-10-02, program review of the ARIA memory and repository-knowledge plan): the
closure is the `impact_graph.plan_downstream_impact` project closure of the admitted surfaces, and
the fix lands as its own kernel change before the executor is enabled (CP-3), under the freeze's
security exemption. The ruling is recorded as a new ADR in that change; ADR-0018 stays as accepted.

## ARIA-LOW-262

Context: security-reviewer GSEC-LOW-009. Every scan emitted one `unsigned_operator_feedback` event
per bad row, so one unsigned line flooded governance every cycle it stayed in the ledger.

Evidence: `aria-kernel/aria_kernel/operator_feedback_ingestion.py:155` — the drop event had no memory
of rows already reported.

Rule: a defect is reported once with a stable key; later observations are recorded without a new
announcement.

Fix: each drop carries a `row_key` (the row's ledger hash, or the hash of the raw line); a drop whose
`(row_key, reason)` the ingestion history already holds is recorded with `reported_before: true` and
no new event. Test: `test_a_drop_is_reported_once_not_every_cycle`.

## ARIA-HIGH-263

ARIA forgets what it learned every week: state compaction keeps memory/learning-events only inside
--retain-days (7) and collapses memory/beliefs, archiving the rest where no memory reader looks, so
the live memory held 8 beliefs and 33 learning events on 2026-10-02 against 8 MB of archived history
each.

Evidence:

- `aria-kernel/aria_kernel/state_compact.py:20` (beliefs collapse to the latest row per id;
  learning-events keep only rows newer than --retain-days)
- `aria-kernel/aria_kernel/state_compact.py:874` (\_archive_stripped writes the removed rows to
  tools/archives; only state_compact and state_manifest reference archives)
- Measured on aria/state 05c5d3160: memory/beliefs 8, learning-events 33, observations 16,
  uncertainties 105, contradictions 0, calibration 0; tools/archives beliefs-collapsed.jsonl.gz 8.3
  MB, learning-events-stripped.jsonl.gz 8.2 MB. Operator goal 2026-10-02: ARIA solves, records,
  learns and knows the repository.

Rule: What ARIA has learned stays readable by ARIA: compaction may reduce volume only by folding
history into durable knowledge the memory readers consume, never by moving it out of their reach.

Owner okan, deadline 2026-10-16.

## ARIA-MEDIUM-264

A rolled-back aria/state can re-admit a spent operator request inside its signed window (up to
168h): the merge lane's merged-once proof reads the same ledgers a rollback erases.

Evidence:

- `aria-kernel/aria_kernel/operator_feedback_observation.py:51` (\_merged_elsewhere reads the
  captured plan and ingestion ledgers)
- `aria-kernel/tests/test_operator_feedback_ingestion.py:357` (pins the re-admission window up to
  expiry)
- AISAFETY residual of round 2 (HIGH-001) and GSEC-MEDIUM-001 residual. Fix direction: the
  GitHub-hosted merge lane refuses when a merged commit or PR on main already carries the request
  id.

Rule: A signed operator request authorizes one merged change; the single-use proof comes from a
record a rollback of aria/state cannot erase (main's merged history).

Owner okan, deadline 2026-10-23.

## ARIA-LOW-265

Check 12 confirms an operator request's signed terms and that a grounding digest is present, but
never compares the signed finding_id and grounding_digest with the plan_started content of the plan
it merges.

Evidence:

- `aria-kernel/aria_kernel/operator_feedback_observation.py:146` (terms and digest presence checked;
  no comparison with plan_started.plan_content)
- GSEC-MEDIUM-002 residual (round 2).

Rule: The merge proves the plan it merges is the plan the operator signed for: same finding, same
grounding.

Owner okan, deadline 2026-10-23.

## ARIA-LOW-266

The operator signs an opaque digest: the recorder prints the canonical subject, whose grounding is a
sha256, not the refs and writable surfaces the request will authorize, and nothing refuses to sign
as root from a checkout or cwd another user can write.

Evidence:

- `aria-kernel/aria_kernel/operator_request_signature.py:211` (stderr subject shows grounding_digest
  only)
- `docs/recommendations/architectural-arbiter/2026-10-02-adr-0018-operator-channel-contract.md`
  (root-owned checkout procedure is documentation only)
- AISAFETY LOW and GSEC-MEDIUM-005 residual (round 2).

Rule: The operator sees exactly what a signature authorizes, and the signing path refuses an
environment the runner uid could have prepared.

Owner okan, deadline 2026-10-23.

## ARIA-LOW-267

Docs/aria/policy/ is not in implementation_safety.READONLY_PATHS, yet operators.json there sets the
operator request lifetime and audience that ingestion reads from the working tree.

Evidence:

- `aria-kernel/aria_kernel/operator_approval.py:56` (OPERATORS_POLICY_PATH under docs/aria/policy)
- `aria-kernel/aria_kernel/implementation_safety.py:73` (READONLY_PATHS lists docs/adr/ but not
  docs/aria/policy/)
- AISAFETY LOW and GSEC-MEDIUM-001 residual (round 2). Adding a READONLY path needs ADR + arbiter
  approval + invariant amendment (implementation_safety.py header).

Rule: Files that set ARIA's authority bounds are read-only to ARIA's implementer, and ingestion
reads them from a commit proven on main.

Owner okan, deadline 2026-10-23.

## ARIA-LOW-268

Operator request ingestion verifies every historical request row with ssh-keygen before the spent
check and re-lists every spent request in each scan row, so plan-source time and the ingestion
ledger grow with history.

Evidence:

- `aria-kernel/aria_kernel/operator_feedback_ingestion.py:229` (verification precedes the spent
  check at :237)
- `aria-kernel/aria_kernel/operator_feedback_ingestion.py:292` (scan row lists all spent requests)
- GSEC-LOW-009 residual (round 2).

Rule: A cycle's ingestion cost is bounded by the requests still live, not by every request ever
filed.

Owner okan, deadline 2026-10-31.

## ARIA-LOW-269

The ingestion trust anchor rests on the runner-writable local refs/remotes/origin/main and re-hashes
only the allowed-signers blob, not the commit or tree that names it.

Evidence:

- `aria-kernel/aria_kernel/main_anchor.py:136` (ancestor check against the local origin/main ref)
- `aria-kernel/aria_kernel/main_anchor.py:166` (blob re-hash; commit and tree not re-derived)
- GSEC-MEDIUM-003 residual (round 2); the fresh-clone merge lane re-check is the backstop.

Rule: Ingestion's anchor is proven against main as GitHub serves it, not against refs a runner
process can rewrite.

Owner okan, deadline 2026-10-31.

## Review round 2

Three mandatory reviews (architectural-arbiter, ai-safety-auditor, security-reviewer) returned
merge-blocking items. All of them land in the round-2 fix commit on this branch, except the two
findings recorded above as not fixed (ARIA-HIGH-260, ARIA-MEDIUM-261). Test files are under
`aria-kernel/tests/`.

| Review id                          | What it found                                                                                                | Closed by (test)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AISAFETY-HIGH-001, GSEC-MEDIUM-001 | spend keyed on unsigned `(id, ledger_hash)`; reuse depended on rows still in the file; no expiry or audience | id-keyed spend from the ingestion history, signed `expires_at` (168h max) and `audience`, merged-once proof at check 12 — `test_operator_feedback_ingestion.py`: `test_a_copy_at_a_new_position_with_a_new_ledger_hash_is_still_spent`, `CopyAndRollbackTests`, `test_a_signed_row_with_bad_terms_is_refused_and_spent`, `test_an_expired_request_cannot_merge`, `test_a_request_merged_through_another_plan_cannot_merge_again`; `test_operator_request_signature.py`: `test_an_id_the_ingestion_history_holds_is_refused_at_record_time` |
| AISAFETY-HIGH-002, GSEC-MEDIUM-002 | refs read from the frozen JSON, one shape filtered, index as "tracked", nothing of the grounding signed      | fold record (folded once per synthesis), one filter for both shapes, `git ls-tree` at the anchor, signed `grounding_digest` — `test_operator_request_grounding.py`: `test_the_fold_record_not_the_frozen_json_supplies_the_refs`, `test_the_finding_fold_is_read_once_per_synthesis`, `test_refs_changed_after_signing_refuse_the_request`, `test_a_tracked_check_comes_from_the_commit_tree_not_the_index`; `test_finding_driven_evidence.py`: `test_evidence_chain_becomes_code_refs`                                                    |
| AISAFETY-MEDIUM-003                | the control-character assertion could not fail (`json.dumps` escapes)                                        | 12 ADR-0003 fixtures, raw field-by-field assertions, both finding-named branches, payloads in body fields and refs — `test_no_adversarial_payload_reaches_any_plan_field`                                                                                                                                                                                                                                                                                                                                                                  |
| GSEC-MEDIUM-003                    | ingestion anchor at `HEAD`, steerable git                                                                    | anchor = commit proven on `origin/main`, scrubbed env, `GIT_NO_REPLACE_OBJECTS=1`, alternates refused, blob re-hashed, anchor recorded per ingestion — `TrustAnchorTests` (5 tests), `test_an_anchor_off_main_is_a_runner_fault_that_spends_nothing`                                                                                                                                                                                                                                                                                       |
| GSEC-MEDIUM-004                    | tolerant reader admitted rows after a chain break                                                            | the merge owner's verified-prefix reader — `test_rows_after_a_chain_break_are_never_admitted`                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| GSEC-MEDIUM-005                    | the operator could not see what was signed                                                                   | subject printed to stderr before ssh-keygen; ADR-0018 operator procedure (root-owned checkout) — `test_the_recorder_signs_the_request_and_its_replay_bounding_terms`, `test_the_cli_verb_records_a_signed_request_and_requires_its_finding`                                                                                                                                                                                                                                                                                                |
| GSEC-LOW-006                       | `ssh-keygen` resolved by name at exec                                                                        | absolute path resolved per call and executed — `test_the_verifier_runs_the_binary_it_resolved`                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| GSEC-LOW-007                       | a transient fault spent a request                                                                            | runner faults out of the refusal list — `test_a_runner_fault_never_spends_the_request`, `test_a_refused_request_is_spent_and_a_fault_cannot_spend`                                                                                                                                                                                                                                                                                                                                                                                         |
| GSEC-LOW-008                       | one malformed ref failed the whole admission                                                                 | closed safe charset, per-ref refusal named by hash — `test_unsafe_reference_is_refused_per_ref`, `test_each_ungrounded_target_is_refused_by_name`                                                                                                                                                                                                                                                                                                                                                                                          |
| GSEC-LOW-009 (ARIA-LOW-262)        | drop events re-emitted every cycle                                                                           | `test_a_drop_is_reported_once_not_every_cycle`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| arbiter i                          | ADR corrections                                                                                              | ADR-0018 (ADR-0003 cited and upheld, rejected options A–D, operator procedure, alias), ADR-0019 (role definitions, consequences), ADR-0020 (rejected alternatives, hardened anchor, signed terms), policy §12 note                                                                                                                                                                                                                                                                                                                         |
| arbiter ii–iv                      | anchor on main; transient faults never spend; fold once per synthesis                                        | as GSEC-MEDIUM-003, GSEC-LOW-007, AISAFETY-HIGH-002 above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| arbiter (B8)                       | F_FINDING self-feed guards; revision scope widening                                                          | ARIA-HIGH-260 and ARIA-MEDIUM-261, recorded, not fixed here                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
