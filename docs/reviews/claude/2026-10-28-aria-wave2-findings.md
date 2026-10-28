# ARIA wave-2 findings (2026-10-28)

The program lead's wave-2 list named five findings whose evidence the lead had already verified. The
clerk re-read every cited line at origin/main db10640f6 (the merge of PR #2170), probed the
doc-staleness behaviour by calling the adapter's own functions, and registered the five through
`finding-registry add`, one event log each. Owner is Okan-wqm; deadlines are 2026-12-08 for MEDIUM
and 2026-12-22 for LOW.

All five were confirmed and none was dropped; four needed corrected line numbers or narrower
wording, and one was widened. The corrections are listed at the end.

## Findings

### ARIA-MEDIUM-1108

The doc-staleness adapter has no claimed role for an ADR Status header (Proposed, Draft,
Superseded), a dated or Historical heading at the top of a document, a plan-table Create row, or a
planned, pending or (R2) marker, so a reference under any of them is reported as a stale claim
although the document says the path is not live

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-12-08.
- Raised by: the program lead's wave-2 list (evidence verified again by the clerk at origin/main
  db10640f6); registered by the wave-2 findings clerk.
- Plan item(s): F2.2.
- Verified at origin/main db10640f6.
- Evidence:
  - `tools/aria-adapters/doc-staleness-adapter.ts:122-156` (UnclaimedRole is creation, proposal,
    absence or change_target; the pattern lists hold no planned, pending, release-marker or Status
    header pattern)
  - `tools/aria-adapters/doc-staleness-adapter.ts:131-135` (CREATION_RES matches (new), a dash then
    new, and a list-item Create: only; a table row whose cell reads Create is not matched)
  - `tools/aria-adapters/doc-staleness-adapter.ts:137-140` (PROPOSAL_RES reads the word proposed or
    proposal, and only inside the reference's own markdown unit)
  - `tools/aria-adapters/doc-staleness-adapter.ts:246-271` (referenceRole decides the role from the
    reference's own unit and nothing above it, so a document-level Status line is never seen)
  - `tools/aria-adapters/doc-staleness-adapter.ts:325-349` (isPointInTimeRecord keys on an archive
    path, a reviews or audits path segment, a dated path segment, or ARIA-HISTORICAL or
    ARIA-SUPERSEDED in the first 5 lines; a dated or Historical heading is not a key)
  - `tools/aria-adapters/fixtures/doc-staleness-adapter/cases/semantic-reference-roles.json` (the
    roles fixture holds no case for a Status header, a Create table row or a planned, pending or
    (R2) marker)
- Rule: The doc-staleness rule claims that a document answers confidently about a surface that is
  gone (the adapter's own header, `ARIA-HIGH-212`): a document that says the path is proposed,
  planned or historical makes no such claim, so a role the adapter cannot read is a false claim it
  judges
- Failure scenario: Probed at origin/main db10640f6 by calling the adapter's own referenceRole and
  isPointInTimeRecord: a reference in a document whose header reads Status: Proposed or Status:
  Superseded, a plan-table row | Create | `path` |, and list items marked (planned), pending
  migration or (R2) all return no role, while (new) returns creation and the word proposed returns
  proposal; isPointInTimeRecord returns false for a document headed Historical inventory with a date
  and for one whose first lines read Status: Superseded. Each such reference is therefore emitted as
  a stale claim and sent to the judges, which is the false-positive class `ARIA-HIGH-212` (open,
  owner of the 0.85 precision gate) tracks. A peer session measured it on origin/main 3a0cce89c and
  reported it (this finding states the figures as reported, the program did not re-run them): 273
  findings, 28 with a planned, pending or (R2)-like marker nearby; a 60-item systematic sample
  labelled by two blind LLM labellers agreed 57 of 60, 11 of 60 were worth fixing (Wilson 0.106 to
  0.299) and 4 of 60 were mechanically fixable (0.026 to 0.159).
- Close condition: These roles are claimed roles: referenceRole claims a planned, pending or (R2)
  marker and a Create table row, and isPointInTimeRecord (or a document-level role) claims an ADR
  Status header of Proposed, Draft or Superseded and a dated or Historical heading in the first
  lines; semantic-reference-roles.json and semantic-point-in-time-records.json each gain a positive
  fixture per role and a near-miss fixture (a live reference in a document that merely mentions the
  word) that still reports a finding.

### ARIA-MEDIUM-1109

pr_manager.push_prepared_branch (the pr push verb with --no-dry-run) pushes an `aria/*` branch to
the remote with no pr_create or pr_open profile gate and no approval check of its own, so the
standard profile, which may not open a pull request, can still put a branch on GitHub

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-12-08.
- Raised by: the program lead's wave-2 list (evidence verified again by the clerk at origin/main
  db10640f6); registered by the wave-2 findings clerk.
- Verified at origin/main db10640f6.
- Evidence:
  - `aria-kernel/aria_kernel/pr_manager.py:1088-1134` (push_prepared_branch reads the commit row,
    validates the branch name, runs git push when dry_run is false; the function holds no
    enforce_profile_for_action and no require_operator_approval call)
  - `aria-kernel/aria_kernel/pr_manager.py:353` (open_pr_for_action enforces pr_create)
  - `aria-kernel/aria_kernel/pr_manager.py:931` (open_revert_pr enforces pr_create)
  - `aria-kernel/aria_kernel/pr_manager.py:1003` (prepare_branch requires operator approval)
  - `aria-kernel/aria_kernel/pr_manager.py:1052` (commit_prepared_branch requires operator approval)
  - `aria-kernel/aria_kernel/runtime_profile.py:176-181` (pr_create and pr_open belong to strict and
    autonomous only; standard holds change_committed and change_validated)
  - `aria-kernel/aria_kernel/runtime_profile.py:204-205` (the table's own rule for standard: it
    mutates the store, not GitHub)
  - `aria-kernel/aria_kernel/recovery.py:81-89` (record_intent, the write before the push, goes
    through the profile-gated declared append of the external-effects ledger)
  - `aria-kernel/aria_kernel/runtime_profile.py:1111-1123` (the write gate: standard, strict and
    autonomous permit every known surface)
  - `aria-kernel/aria_kernel/cli.py:6294-6303` (pr push forwards --no-dry-run to
    push_prepared_branch)
  - `aria-kernel/tests/test_pr_manager_e2e.py:1371-1412` (the only push tests refuse the protected
    branches snowball and main; none pins a profile or approval refusal)
- Rule: CLAUDE.md make it impossible (tier 1) and the runtime-profile table (ACTION_PERMISSIONS): an
  action that changes GitHub is an action authority of strict and autonomous, and every step of the
  pipeline that reaches GitHub is enrolled in that table
- Failure scenario: Under the standard profile, pr_create is refused (it names strict and
  autonomous), yet `aria-kernel pr push --no-dry-run` on a proposal that has a commit row runs
  `git push -u origin` for its `aria/*` branch. The checks on that path are the existence of the
  commit row (whose own creation required operator approval) and the intent write to the
  external-effects ledger (recovery.py:81-89), a write the profile gate admits for standard
  (runtime_profile.py:1111-1123 permits every known surface to standard); approval is not re-read at
  push, so a proposal whose approval changed after the commit still pushes. The branch push is the
  GitHub-facing half of the same pipeline whose tail pr_create guards.
- Close condition: push_prepared_branch calls enforce_profile_for_action with the same action as
  pr_create (or a documented decision that a branch push is a standard authority, written in
  ACTION_PERMISSIONS as its own cell), and test_pr_manager_e2e.py gains a test that a real push
  (dry_run false) under the standard profile is refused with no git push executed, while strict
  still pushes.

### ARIA-MEDIUM-1110

self_revert.run_self_revert_producer has callers only inside two cycle phases and none in the CLI,
and the CLI has no verb for the post-merge CI scan or the change-outcome evaluation either, so a
deployment that runs ARIA step by step instead of through the cycle never scans for or reverts a bad
ARIA merge

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-12-08.
- Raised by: the program lead's wave-2 list (evidence verified again by the clerk at origin/main
  db10640f6); registered by the wave-2 findings clerk.
- Plan item(s): F3.4 and F3.3b.
- Verified at origin/main db10640f6.
- Evidence:
  - `aria-kernel/aria_kernel/self_revert.py:930-975` (run_self_revert_producer, the one producer of
    the revert and the self-merge freeze, with the two triggers named at :187-189)
  - `aria-kernel/aria_kernel/cycle.py:1295-1316` (the change-outcome phase calls it for
    TRIGGER_CHANGE_OUTCOME)
  - `aria-kernel/aria_kernel/cycle.py:1683-1690` (the pr_ci_scan phase calls it for
    TRIGGER_POST_MERGE_CI)
  - `aria-kernel/aria_kernel/cycle.py:1278` (the change-outcome phase function; the cycle is its
    only caller)
  - `aria-kernel/aria_kernel/cli.py:669` (the only mention of a revert in the CLI is a comment; the
    file holds no import of self_revert, evaluate_change_outcomes or scan_merged_own_prs)
- Rule: CLAUDE.md make it automatic (tier 2) applied to a safety brake: the producer that freezes
  self-merge and reverts a bad ARIA merge must be reachable from every entry point that can merge,
  not from one phase table
- Failure scenario: git grep at origin/main db10640f6 finds run_self_revert_producer called only at
  cycle.py:1306 and cycle.py:1685. A deployment that drives the kernel through CLI verbs one step at
  a time (pr create, merge, state publish) has no verb that reads post-merge CI, evaluates the
  change outcome or calls the producer, so a merged ARIA change that goes red is never frozen or
  reverted unless a full cycle also runs. Plan items F3.4 and F3.3b own the merge-outcome side of
  this chain.
- Close condition: A CLI verb (for example self-revert run with --trigger) calls
  run_self_revert_producer with the same issue-writer selection the cycle uses, or a written
  operator rule states that the cycle is the only entry and a test pins that statement; either way a
  test pins that the CLI reaches the producer (or that its absence is the documented rule).

### ARIA-MEDIUM-1111

No step outside the cycle creates a judgment request group: dispatch_judges_for_sample has one
production call site in cycle.py, the judge CLI verb has only replay, and agent-invocations request
mints a single request without the seat plan, the tier-0 gate, the method receipt or the consensus
link

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-12-08.
- Raised by: the program lead's wave-2 list (evidence verified again by the clerk at origin/main
  db10640f6); registered by the wave-2 findings clerk.
- Verified at origin/main db10640f6.
- Evidence:
  - `aria-kernel/aria_kernel/judge_fanout.py:401` (dispatch_judges_for_sample, the function that
    mints the seats of a sample)
  - `aria-kernel/aria_kernel/cycle.py:2123-2133` (route_judgment_sample and then
    dispatch_judges_for_sample per leg: the only production call site)
  - `aria-kernel/aria_kernel/cli.py:1527-1533` (the judge subcommand defines replay and nothing
    else)
  - `aria-kernel/aria_kernel/cli.py:2344-2347` (agent-invocations request takes one target agent,
    one role and one prompt file)
  - `aria-kernel/aria_kernel/cli.py:5656-5671` (the verb calls create_agent_invocation_request once,
    as an operator mint, with no seat plan)
  - `aria-kernel/aria_kernel/agent_invocations.py:1367-1388` (the dispatch records a context hash
    and a prompt hash and verifies them together)
  - `aria-kernel/aria_kernel/agent_invocations.py:6227-6235` (submit-result refuses an answer whose
    context_hash or prompt_hash differs from the request's recorded binding)
- Rule: CLAUDE.md one owner per concept and make it automatic (tier 2): the judgment lane has one
  dispatcher, and every entry point that needs a judgment group must reach it instead of rebuilding
  its parts
- Failure scenario: A step-by-step run has no way to turn a sampled finding into the judge seats the
  consensus and promotion path reads: judge replay only replays a gold corpus, and agent-invocations
  request creates one request from an operator prompt file with none of the seat plan, tier-0 gate,
  method receipt or anchor and consensus link that dispatch_judges_for_sample adds, while
  submit-result accepts an answer only if it carries the context_hash and prompt_hash of the request
  the kernel rendered. The judgment lane is therefore reachable only through the cycle's judge
  phase.
- Close condition: One CLI wrapper over dispatch_judges_for_sample (no second dispatcher) mints the
  judgment group for a given sample or finding, or a documented rule states that the cycle's judge
  phase is the only entry; a test pins whichever is chosen (the wrapper mints the same seats and
  receipt fields as the cycle for one fixture sample, or the rule text is pinned by a test).

### ARIA-LOW-1112

The system_one.py module docstring calls enabled: false the seed, but the shipped
aria-config/system-one-questions.json has carried enabled: true since 2026-10-03, so a reader is
told that no call is made while every shadow decision point asks the external Jev service, and the
docstring never names the decision (ADR-0027) that turned it on

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-22.
- Raised by: the program lead's wave-2 list (evidence verified again by the clerk at origin/main
  db10640f6); registered by the wave-2 findings clerk.
- Verified at origin/main db10640f6.
- Evidence:
  - `aria-kernel/aria_kernel/system_one.py:5-8` (enabled: false, the seed, means no call and no row)
  - `aria-config/system-one-questions.json:3` (the shipped registry reads "enabled": true)
  - `aria-kernel/aria_kernel/system_one.py:536-537` (ask returns system_one_disabled only when the
    registry is not enabled; with the shipped value it proceeds to the call)
  - `aria-kernel/aria_kernel/system_one.py:12-32` (the egress rule is stated here, but the docstring
    does not say the shipped state is on and holds no reference to ADR-0027)
  - `docs/recommendations/architectural-arbiter/2026-10-03-adr-0027-system-one-jev-egress.md` (the
    egress policy under which commit 1818d28af turned System One on in shadow)
- Rule: CLAUDE.md document it (tier 4) where the first reader looks: a docstring that states a
  default the shipped file contradicts is a false statement of the module's own behaviour
- Failure scenario: Commit 1818d28af (2026-10-03, turn System One on in shadow, under ADR-0027's
  egress policy) flipped the shipped value on purpose and left the docstring written for the seed. A
  reader changing a decision point, or checking what leaves the host, reads that false means no call
  and concludes the shipped state is quiet; in fact a cycle sends typed questions built from public
  references to Jev, an external service, in shadow. The egress rules that bound it are in the
  docstring body, but the one sentence that states the shipped value is wrong and the deciding ADR
  is not cited.
- Close condition: The docstring states that the shipped registry is enabled: true and cites
  ADR-0027, and a test reads aria-config/system-one-questions.json and asserts that the module
  docstring names the same enabled value, so the two cannot drift again.

## Verification notes

- `ARIA-MEDIUM-1108`: the cited ranges 118-175 and 318-350 no longer match the file; the role
  families sit at 122-156, `referenceRole` at 246-271 and `isPointInTimeRecord` at 325-349.
  Confirmed by running the adapter's own functions: a Status header (Proposed, Superseded), a
  `| Create |` table row and (planned), pending and (R2) markers all return no role, and a dated
  Historical heading is not a record. The measurement by the peer session (273 findings on
  origin/main 3a0cce89c, 28 with a marker nearby, 57 of 60 labeller agreement, 11 of 60 worth
  fixing, 4 of 60 mechanically fixable) is stated as reported and was not re-run.
- `ARIA-MEDIUM-1109`: the claim of no runtime-profile gate is narrowed to no action-level gate.
  `push_prepared_branch` writes an intent to the external-effects ledger before the push, and that
  declared append is write-gated, but the write gate admits the standard profile, so a standard run
  still pushes while `pr_create` is refused. The approval is not re-read at push.
- `ARIA-MEDIUM-1110`: confirmed, and widened by one fact: the CLI also has no verb for the
  post-merge CI scan or the change-outcome evaluation, so the step-by-step path lacks the detection
  as well as the revert.
- `ARIA-MEDIUM-1111`: the cited `agent_invocations.py` lines 1314-1318 and 1344 are the
  dispatch-side records (a context hash check at persist and the prompt-hash row), not the
  submit-result binding. The binding the answer must satisfy is at 1367-1388 and 6227-6235, and the
  finding cites those.
- `ARIA-LOW-1112`: the claim that the consequence is not stated where a reader looks is narrowed.
  The egress rules are in the docstring body (lines 12-32); what is stale is the sentence that calls
  `enabled: false` the seed, and the docstring never cites ADR-0027 or says the shipped value is on.
