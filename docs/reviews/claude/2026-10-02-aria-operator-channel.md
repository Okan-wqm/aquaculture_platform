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

Rule: FAILING_CI means a red workflow whose verdict is about `main` itself (proposed ADR-0019).

Fix (proposed, owner okan, decision by 2026-10-16): a role manifest under `.github/manifests/`
(`main_verdict` | `pr_verdict` | `observer`, undeclared counts as `main_verdict`), an invariant over
each workflow's `on:` triggers, and a per-cycle log of every red workflow the source excludes.
Nothing of it is implemented in the branch that registers this finding; until it is decided, the
signed operator request (ADR-0018) is how a one-time decision outranks failing CI.

## ARIA-HIGH-260

Context: raised by the architectural-arbiter in review round 2. The operator channel is an operator
act per request; the aging F_FINDING source (priority 3) is not. When no higher source converts, it
turns one of ARIA's own findings into a grounded plan unattended, and ADR-0003 named the guards such a
self-feed needs before it may exist.

Evidence:

- `aria-kernel/aria_kernel/plan_synthesizer.py:584` — `scan_f_findings` ranks every aging F finding.
- `aria-kernel/aria_kernel/plan_synthesizer.py:831` — `F_FINDING` holds slot 3.
- `aria-kernel/aria_kernel/finding_grounding.py:115` and
  `aria-kernel/aria_kernel/cycle_phases/plan_source.py:199` — admission and conversion judge grounding
  only.
- `docs/recommendations/architectural-arbiter/2026-05-20-adr-0003-aria-self-feed-deferred.md:49-51` —
  prerequisites 3 (originating-skill self-loop guard), 4 (per-24h cap) and 5 (cycle detection).

Rule: a source that plans ARIA's own findings carries ADR-0003's loop guards.

Fix: not in this branch. Owner okan, deadline 2026-10-16. Prerequisite 2 (12 adversarial fixtures)
is pinned here by `test_no_adversarial_payload_reaches_any_plan_field`.

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

Fix: not in this branch. Bounding revisions to the admitted surfaces would refuse the surfaces the
coverage gate makes a revision add (tests, dependents, migrations); the bound must be the admitted
surfaces united with their machine-computed impact closure, which needs an arbiter decision on that
closure. Owner okan, deadline 2026-10-23.

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
