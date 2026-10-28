# ARIA wave-3 findings: the K1 and JFT review points and the 53-finding review (2026-10-28)

The K1 integration pull request (#2174, merge a07638350) and the JFT pull request (#2176, merge
ae2958653) landed with their non-blocking review points and tracked gaps listed as "to be registered
after the landing". This file registers those points, and the findings the lead session and a second
session's review of 53 security findings added, each through `finding-registry add`.

Method. Three read-only verifiers re-read every note at origin/main ae2958653d (the code of both
merges), reproduced each claim where they could, merged notes that share one root cause, and
compared every candidate with the registry snapshot of that revision. A finding below is a real,
evidence-backed defect with one root cause, an owner, a deadline and a close condition a test or
invariant can check. Owner is Okan-wqm for every row; deadlines are 2026-11-18 for HIGH, 2026-12-09
for MEDIUM and 2026-12-23 for LOW.

## Source A1: PR #2174 (K1), F4.0b, SE-5 and F1.3

12 findings.

### ARIA-MEDIUM-1113

`_predecessor_rejection` still entity-encodes < and > into the sealed refusal row at mint, and from
prompt v8 untrusted_block encodes the result again, so a refused answer's quoted '<' reaches the
successor agent as '&amp;lt;' and cannot be told apart from an original literal '&lt;'

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-12-09.
- Raised by: the review notes of the K1 packages F4.0b, SE-5 and F1.3, verified at origin/main
  ae2958653d; registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `aria-kernel/aria_kernel/agent_invocations.py:1115-1121` (the mint-time second escaper:
    replace('<', '&lt;') and replace('>', '&gt;') on every rejection reason)
  - `aria-kernel/aria_kernel/agent_invocations.py:1125-1128` (each reason is cut to 400 characters
    AFTER the encoding, so the cut can land inside an entity)
  - `aria-kernel/aria_kernel/agent_invocations.py:1268-1272` (v8 renders the predecessor block
    through `_untrusted_section`, the owner's escape)
  - `aria-kernel/aria_kernel/text_safety.py:79` (the owner encodes '&' first, then '<' and '>')
  - `aria-kernel/aria_kernel/agent_invocations.py:1962-1971` (every fresh mint stamps the current
    version v8 and attaches the pre-escaped row, so the mint-time escape serves no version any more)
  - `aria-kernel/tests/test_trust_boundary_f40b.py:367-373` (the predecessor test checks only that
    the injected text stays inside the block; no test pins a single encoding layer for a plain '<')
- Rule: Single owner per fact (text_safety.untrusted_block is the one escaper of untrusted prompt
  data, PLAN-v2 F4.0b; an escape stored in a sealed row is a second owner with no pin).
- Failure scenario: A refused answer whose rejection reason quotes a ref such as Map<string, Foo> is
  sealed as Map&lt;string, Foo&gt; when the successor is minted. The v8 prompt renders that body
  through untrusted_block, which encodes the '&' again, so the successor reads Map&amp;lt;string,
  Foo&amp;gt;. The v8 data notice says one decode turns &lt; into '<', so the agent decodes to the
  text '&lt;' and not to the generic it was refused for, and the original '<' and an original
  literal '&lt;' render identically. The 400-character cut after encoding can also split an entity
  and the owner then encodes its '&'. No boundary is breached; the fidelity of the refusal the
  successor is told to avoid repeating is lost.
- Close condition: Store the raw reason in `_predecessor_rejection` (slice the raw text, no replace)
  and let untrusted_block be the only escaper; rows already sealed keep their bytes and render under
  their own version. Add a mint-then-render test in test_trust_boundary_f40b.py: a reason with a
  plain '<' renders as &lt; exactly once and a reason holding a literal '&lt;' renders as &amp;lt;.

### ARIA-MEDIUM-1114

dispatch_change_intelligence writes a held service seat's change_review_budget_held row only after
the seat loop, so a dispatch interrupted after the last seat is minted leaves the row unwritten
forever: the next dispatch sees no missing seat and skips the change as already_dispatched before
the hold code is reachable

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-12-09.
- Raised by: the review notes of the K1 packages F4.0b, SE-5 and F1.3, verified at origin/main
  ae2958653d; registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `aria-kernel/aria_kernel/pr_tracking.py:522-572` (the seat loop mints every missing seat)
  - `aria-kernel/aria_kernel/pr_tracking.py:573-577` (the hold rows for plan.held are written only
    after that loop)
  - `aria-kernel/aria_kernel/pr_tracking.py:480-483` (a re-dispatch with no missing seat is skipped
    as already_dispatched and continues past the hold code)
  - `aria-kernel/aria_kernel/judgment_funnel.py:801-815` (hold_change_seat: the seat is 'held, not
    dropped' through one once-keyed governance row)
- Rule: WP-D4 'a cap is a hold for its reader, never a silent drop': every touched service past
  service_seats_per_change is named by one change_review_budget_held row
  (judgment_funnel.hold_change_seat docstring, genesis_policy_default.json change_review.seats).
- Failure scenario: A change touches four services with a service cap of three. The dispatch mints
  the three service seats and the lens seat, then fails before the hold row of the fourth service is
  appended (a ledger_lock_timeout on the governance append, or the process ending). On the next
  dispatch all planned seats are already asked, so missing is empty and the change is skipped as
  already_dispatched; hold_change_seat is never called for it. The fourth service is then neither
  reviewed nor named anywhere. The reviewer's probe reproduced this with hold_change_seat raising
  once: four seats minted, zero hold rows, and the second dispatch minted nothing and wrote nothing.
- Close condition: Write the idempotent once-keyed hold rows for plan.held on the 'no missing seat'
  path as well (the change was admitted when any seat exists), or write them in the same step as the
  last seat mint. Add a test in test_se5_seat_routing.py that patches hold_change_seat to raise once
  on the four-service change and asserts the second dispatch ends with exactly one hold row per held
  service.

### ARIA-MEDIUM-1115

genesis_lifecycle.`_replay` is documented to return an InvalidLifecycleChain value and never raise,
but validate_transition raises on a malformed row (int() of a non-numeric valid_cycles, .get on a
non-dict evidence), and lifecycle_chains replays every entity, so one entity's bad row makes every
change_intelligence mint and request validation fail

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-12-09.
- Raised by: the review notes of the K1 packages F4.0b, SE-5 and F1.3, verified at origin/main
  ae2958653d; registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `aria-kernel/aria_kernel/genesis_lifecycle.py:71-84` (InvalidLifecycleChain: 'a value, not a
    raise'; the ledger may hold any row an appender writes)
  - `aria-kernel/aria_kernel/genesis_lifecycle.py:103-128` (`_replay` calls validate_transition for
    every row with no containment)
  - `aria-kernel/aria_kernel/genesis_lifecycle.py:185-188` (int(evidence.get('valid_cycles') ...)
    raises ValueError on a non-numeric value)
  - `aria-kernel/aria_kernel/genesis_lifecycle.py:138-141` (lifecycle_chains replays every entity of
    the ledger in one pass)
  - `aria-kernel/aria_kernel/agent_surface.py:425-433` (`_seat_claims` walks every chain, so another
    entity's bad row is read on each seat resolution)
  - `aria-kernel/aria_kernel/agent_invocations.py:1669` (the mint asks allowed_targets_for_role,
    which reaches that walk)
  - `aria-kernel/aria_kernel/agent_contract.py:224` (validate_request asks service_seat_agents for
    the role)
- Rule: SE-5 lifecycle owner contract: one reader replays the ledger and an invalid chain is a value
  that makes the entity not ACTIVE, never a crash (genesis_lifecycle.InvalidLifecycleChain
  docstring); a reader that fails closed must fail per entity.
- Failure scenario: A row for an unrelated entity is appended through the declared-ledger API with
  to_state CANDIDATE_PROPOSED and evidence {valid_cycles: 'many'}. record_transition would have
  refused to write it, but the ledger accepts any appended row, which is the threat the replay
  docstring names. Replaying that entity raises ValueError instead of returning
  InvalidLifecycleChain; because `_seat_claims` replays every entity,
  allowed_targets_for_role('change_intelligence') and service_seat_agents raise the same error, so
  every change_intelligence mint (agent_invocations.py:1669) and request validation
  (agent_contract.py:224) fails until the row is removed. The reviewer's probe reproduced the
  ValueError through both entry points.
- Close condition: Make the row reads in validate_transition and `_replay` total: coerce or refuse a
  non-numeric count and a non-dict evidence into reasons on the chain (InvalidLifecycleChain)
  instead of raising. Add a test in test_se5_lifecycle_replay.py that appends such a row for entity
  other-a and asserts current_lifecycle_state('other-a') is an InvalidLifecycleChain and
  allowed_targets_for_role('change_intelligence') still answers for the other entities.

### ARIA-MEDIUM-1116

dispatch_change_intelligence decides what is already asked by re-planning the change's seats from
today's workspace on every dispatch, so each fully seated merge ever recorded costs one closure
computation per run (plus one service-facts computation per dispatch) and a later project rename or
closure-order change re-asks an already reviewed change under a new seat name

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-12-09.
- Raised by: the review notes of the K1 packages F4.0b, SE-5 and F1.3, verified at origin/main
  ae2958653d; registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `aria-kernel/aria_kernel/pr_tracking.py:436-439` (the comment states the merge list only grows
    and per-merge cost must not scale per cycle)
  - `aria-kernel/aria_kernel/pr_tracking.py:459-467` (an already-seated change skips the mint-budget
    exit, so it proceeds to planning)
  - `aria-kernel/aria_kernel/pr_tracking.py:468-483` (service facts and `_change_impact` are
    computed from the live tree for every change with asked seats; missing is derived from today's
    plan)
  - `aria-kernel/aria_kernel/pr_tracking.py:304-321` (plan_change_seats names seats from the live
    closure order and project names)
  - `aria-kernel/aria_kernel/agent_invocations.py:2442-2445` (the ledger scan's own docstring says a
    per-subject cost must not grow with every merge ever recorded)
- Rule: SE-5 D-2 dedup contract: the ledger is the record of what was asked; a change asked about
  must not be asked again because the tree changed, and per-merge cost of the nightly dispatch must
  not grow with the merge history.
- Failure scenario: At the base an already-asked merge was a set lookup (pr_tracking.py at 91365f31a
  lines 330-334). Now every merge with a seated row runs cycle_service_examination, and the
  workspace's service facts are computed once per dispatch, on each nightly cycle, for as many
  merges as the ledger holds. Separately, after a change was asked with seats service:zz-core and
  lens, a commit that only renames the nx project owning libs/zz-core makes the next dispatch
  compute service:zz-core-renamed as missing and mint it for the same reviewed change (the same
  happens when closure order changes with more than three touched services). Both package reviewers
  reproduced the second effect with a rename probe; the architecture reviewer measured the first on
  this repository at about 1 s per change plus 14-19 s of service facts per dispatch.
- Close condition: Record the planned seat set (or a completion marker) on the change's first mint
  and read it back in dispatch, so a change whose recorded plan is fully asked is skipped from the
  ledger alone with no closure and no facts computation. Add tests: a rename after seating mints
  nothing, and a dispatch over N fully seated merges makes zero `_change_impact` calls.

### ARIA-MEDIUM-1117

The baseline exam reads the run vocabulary through two private literals, so crashed_tools lists only
status 'crash' while tool_health.RUN_STATUSES has seven other non-ok outcomes (budget_exceeded,
tool_unhealthy, integrity_failed and more); a run that ended that way is tallied as a finished tool
with its findings, and the stamped tally carries no completeness field

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-12-09.
- Raised by: the review notes of the K1 packages F4.0b, SE-5 and F1.3, verified at origin/main
  ae2958653d; registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `tools/aria-acceptance/harness.py:730-731` (the runner check spells 'subprocess')
  - `tools/aria-acceptance/harness.py:737` (every run's status is stored, but only the count of
    findings reaches the tally)
  - `tools/aria-acceptance/harness.py:846-849` (crashed_tools is status == 'crash' only; no other
    incompleteness is reported)
  - `aria-kernel/aria_kernel/tool_health.py:38-52` (RUN_STATUSES: nine statuses, eight of them not
    ok)
  - `aria-kernel/aria_kernel/tool_registry.py:73-75` (SUBPROCESS_RUNNER_TYPE and RUNNER_TYPES exist)
- Rule: Every number carries what it was measured over (F1.3 stamping): a stamped tally must say
  which tools did not finish, using the kernel's one status vocabulary rather than a private
  literal.
- Failure scenario: A cycle in which one adapter timed out (budget_exceeded) or was refused as
  tool_unhealthy is read by the exam as a tool with zero or partial findings. crashed_tools stays
  empty, the console prints 'crashed: []', and the measurements.tally block, which is what --against
  compares and what the program stamps as the baseline, carries no marker that the number is a lower
  bound. Only the per-tool status in store.tools shows it. The kept store holds only ok and crash,
  so the exit run did not meet this; a re-baseline over a cycle with a timeout will. The evidence
  reviewer reproduced it on a store copy with one status edited to budget_exceeded.
- Close condition: Derive incomplete_tools from tool_health.RUN_STATUSES (every status other than
  ok) and compare the runner type with tool_registry.SUBPROCESS_RUNNER_TYPE; put incomplete_tools in
  the tally block, or refuse by name when any run is not ok. Add a test per non-ok status asserting
  the report names the tool and the tally flags itself as a lower bound.

### ARIA-MEDIUM-1118

The baseline exam derives scanned_sha only from the evidence_envelopes of the runs that kept them (7
of 17 in the kept store) and never reads each row's repo_snapshot, so a working-tree scan with
uncommitted changes is stamped as a clean scan of the commit and the report does not say which runs
back the tree it names

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-12-09.
- Raised by: the review notes of the K1 packages F4.0b, SE-5 and F1.3, verified at origin/main
  ae2958653d; registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `tools/aria-acceptance/harness.py:739-745` (scanned is the set of envelope target_sha values; a
    row with no envelopes contributes nothing and is not named)
  - `tools/aria-acceptance/harness.py:748-759` (the single scanned sha must equal the corpus head
    and --aria-sha; dirty_snapshot and repo_state_id are not consulted)
  - `aria-kernel/aria_kernel/tool_health.py:457` (every run row carries repo_snapshot)
  - `aria-kernel/aria_kernel/tool_runner.py:365-377` (the compact snapshot holds dirty_snapshot and
    repo_state_id)
  - `aria-kernel/aria_kernel/snapshot.py:104-111` (in working_tree mode base_commit_sha is HEAD
    while dirty_snapshot is true when files are modified)
  - `aria-kernel/aria_kernel/evidence_validator.py:1167-1171` (an envelope's target_sha is taken
    from the snapshot's base_commit_sha)
  - `aria-kernel/aria_kernel/ledger_inline.py:33-40` (a spilled evidence_validation keeps no
    envelopes, which is why most rows carry none)
- Rule: F1.3: every number is stamped with the ARIA SHA it was measured at; the stamp must be
  refused when the run did not scan that commit's clean tree.
- Failure scenario: A cycle scanned in working_tree mode (not the committed mode) over a checkout
  with uncommitted edits records, for each run that kept envelopes, target_sha = HEAD and
  dirty_snapshot = true. The exam sees one scanned sha equal to the corpus head and --aria-sha and
  accepts it, so a tally measured on modified code is stamped as the measurement of that commit. The
  evidence reviewer set dirty_snapshot true on all 17 rows of a store copy and the exam exited 0
  with the same stamp. The evidence reviewer found that in the kept store ten of the 17 runs
  (including the 250-finding doc-staleness run and the kernel-dead-wire run behind 7 of the 29 named
  noise) have no envelope, so the tree claim is backed by 7 runs while the report states one
  store.scanned_sha for the cycle.
- Close condition: Require, over every run of the cycle, repo_snapshot.dirty_snapshot is False and a
  single repo_state_id (refuse by name otherwise), and record in the report which tools evidence the
  scanned tree and which do not. Add tests: all rows dirty_snapshot true is refused; two
  repo_state_id values is refused; a spilled row is listed as not evidencing the tree.

### ARIA-MEDIUM-1119

The baseline exam reads runs.jsonl through read_runs_rows, which only parses JSON lines, and never
verifies the ledger's hash chain, so a hand-edited ledger (status, snapshot flags, findings pointers
changed) is accepted and stamped as a measurement of the kept store

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-12-09.
- Raised by: the review notes of the K1 packages F4.0b, SE-5 and F1.3, verified at origin/main
  ae2958653d; registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `tools/aria-acceptance/harness.py:722` (the exam reads runs.jsonl with read_runs_rows)
  - `aria-kernel/aria_kernel/runs_reader.py:38-57` (read_runs_rows: strict JSON parse and upcast, no
    chain check)
  - `aria-kernel/aria_kernel/ledger.py:2148-2167` (load_jsonl_verified: the verified loader; its
    docstring names the runs-loader among the hot-path consumers that must use it)
  - `tools/aria-acceptance/harness.py:383` (the same harness verifies cycles.jsonl with
    load_jsonl_verified)
- Rule: Append-only integrity (Plan 026R A.2): a reader whose output is stamped as evidence must
  load the ledger through load_jsonl_verified so a tamper surfaces as a failure.
- Failure scenario: An operator or a process edits a row of a kept store's runs.jsonl (flips a
  status, sets dirty_snapshot, changes an artifact pointer) without recomputing the chain.
  load_jsonl_verified raises ledger_hash_mismatch on that file, but the exam parses each line as
  JSON and carries on, so the report is stamped with the real ARIA SHA and corpus hash and --against
  calls it reproduced. The stamp then vouches for numbers the store's own integrity check rejects.
  The trigger needs a hand-edited ledger, which is exactly the case the chain exists for; the
  kernel's own read_runs_for_cycle shares the strict-JSON-only read, so the close here is local to
  the exam.
- Close condition: Verify the plain runs.jsonl with ledger.load_jsonl_verified (read only, no
  diagnostics) before reading it and refuse by name on a mismatch. Add a test that flips one byte of
  a row in a store copy and asserts a named refusal, exit 2, and no --out.

### ARIA-MEDIUM-1120

The baseline-exam is documented as read-only ('nothing is written', 'writes nothing else', 'nothing
written but --out'), but a corrupt runs.jsonl row makes the strict reader append a diagnostic to
`<store>/diagnostics/ledger-corruption.jsonl`, so the exam changes the kept store it is meant to
leave identical

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-12-09.
- Raised by: the review notes of the K1 packages F4.0b, SE-5 and F1.3, verified at origin/main
  ae2958653d; registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `tools/aria-acceptance/harness.py:722` (read_runs_rows is called with base_dir=root, the kept
    store)
  - `aria-kernel/aria_kernel/strict_jsonl_reader.py:85-106` (a corrupt line emits ledger_row_corrupt
    before the strict raise)
  - `aria-kernel/aria_kernel/diagnostics.py:66-77` (the sink is
    `<base_dir>/diagnostics/ledger-corruption.jsonl`; mkdir and append)
  - `tools/aria-acceptance/harness.py:815-820` (baseline_exam docstring: offline and read-only,
    nothing is written)
  - `tools/aria-acceptance/harness.py:864-867` (the command docstring: writes nothing else)
  - `tools/aria-acceptance/harness.py:1043-1044` (the CLI help: nothing written but --out)
- Rule: F1.3 contract: the exam reads a kept store and leaves it byte-identical; a documented
  read-only command must not write into the store it reads.
- Failure scenario: A torn last line in runs.jsonl (a crash while the store was being written) is
  enough: the exam exits 2 with strict_jsonl_row_corrupt, but before raising the reader creates
  diagnostics/ledger-corruption.jsonl inside the kept store. The store's fingerprint then differs
  before and after the exam, a later run of the same exam sees a different store, and the three
  statements that the command writes nothing are false for exactly the input where an operator is
  most likely to be checking the store. The evidence reviewer reproduced the new file on a store
  copy; the store hash was identical for every success and named refusal that does not read a
  corrupt row.
- Close condition: Give the strict reader a no-emit mode (or route the diagnostic to stderr when the
  caller declares a read-only store) and use it from the exam, or verify the ledger with a loader
  that does not write. Add a test: append a torn line to a store copy, assert exit 2 and that the
  store's file listing and hashes are unchanged.

### ARIA-LOW-1121

untrusted_context_fields bounds the planner's untrusted-context block only by the 24,000-character
whole-body cap, so one long reason or a long ref list cuts the JSON body mid-string, drops
provenance_refs and refused_evidence_refs, and leaves a body that is not valid JSON

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-23.
- Raised by: the review notes of the K1 packages F4.0b, SE-5 and F1.3, verified at origin/main
  ae2958653d; registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `aria-kernel/aria_kernel/pressure_evidence.py:109-121` (the one producer: json.dumps(payload,
    sort_keys=True) passed whole to untrusted_block; no per-value bound)
  - `aria-kernel/aria_kernel/pressure_evidence.py:143-152` (reason, provenance_refs and
    refused_evidence_refs enter the payload unbounded; sort_keys puts refused_evidence_refs last)
  - `aria-kernel/aria_kernel/text_safety.py:79-83` (the cap truncates the already serialised and
    escaped body at a character count)
  - `aria-kernel/aria_kernel/pressure.py:1063-1065` (a pressure record stores reason and
    provenance_refs with no length bound)
  - `aria-kernel/aria_kernel/mission.py:507-514` (a mission's evidence_refs only grow:
    sorted(set(old + new)) on every opened/evidence event; pr:`<n>` and branch:`<name>` refs all
    land in refused_evidence_refs)
  - `aria-kernel/aria_kernel/autonomy_orchestrator.py:416-422` (the mission path feeds the
    accumulated refs into prompt_fields)
  - `aria-kernel/tests/test_trust_boundary_f40b.py:326-340` (the oversize test covers
    decision_memory only; no test checks the planner block for structure after a cut)
- Rule: PLAN-v2 F4.0b: the planner block has one producer; the per-field bounds it replaced (reason
  1024, each ref 512) guaranteed every key survived, and the cap should be applied per value at the
  producer, not to the serialised text.
- Failure scenario: A mission whose accumulated refs serialise past about 24,000 characters (a few
  hundred refused pr:/branch: entries), or a pressure reason longer than that, makes untrusted_block
  cut the escaped JSON text at the cap. The tail of the body is the sorted-last key
  refused_evidence_refs, so it is dropped first, and when the cut lands inside a string the block's
  body is not parseable JSON; only the trailing '...[truncated]' marker tells the planner that
  anything is missing. At the base each field was bounded, so all three keys were always present and
  the body always parsed. The affected data is the planner's read-and-never-cite context, so the
  harm is lost provenance, not a boundary breach; the trigger is a long mission or reason, not an
  attacker.
- Close condition: In untrusted_context_fields bound each value before serialising (a per-value
  character cap and a list-length cap with an explicit omitted-count entry) so the serialised body
  stays under the block cap and parses. Add a test: a 30,000-character reason and a 3,000-ref list
  each give a block whose body parses as JSON and still names all three keys.

### ARIA-LOW-1122

The F4.0b minter census (I4) classes autonomy_orchestrator as escaped, but its generic queue prompt
still places recommended_action and candidate_tools as raw JSON values outside any untrusted block,
so the pending list that F4.0c drives to zero does not contain that minter

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-23.
- Raised by: the review notes of the K1 packages F4.0b, SE-5 and F1.3, verified at origin/main
  ae2958653d; registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `aria-kernel/aria_kernel/autonomy_orchestrator.py:358-365` (the generic prompt carries
    item.get('recommended_action') and item.get('candidate_tools') verbatim)
  - `aria-kernel/aria_kernel/autonomy_orchestrator.py:559` (the prompt is json.dumps'd straight into
    suggested_prompt, with no untrusted_block around those fields)
  - `aria-kernel/aria_kernel/task.py:300-304` (a finding mission's next_action embeds the finding's
    cited repository path)
  - `aria-kernel/aria_kernel/cycle.py:3013-3019` (the mission's next_action is queued as the item's
    recommended_action)
  - `aria-kernel/tests/invariants/test_prompt_labels_one_owner.py:253-255` (MINTERS classes
    autonomy_orchestrator as 'escaped' through pressure_evidence)
  - `aria-kernel/tests/invariants/test_prompt_labels_one_owner.py:316-326` (the escaped-class check
    asserts only that the module imports a declared renderer, not that every field it mints goes
    through it)
- Rule: PLAN-v2 F4.0b I4: every minter is classified by where its prompt text comes from; a class
  that over-claims makes the 'pending may only shrink' pin end at zero while a raw path remains.
- Failure scenario: The census says the autonomy minter is escaped because its pressure and mission
  context goes through pressure_evidence.untrusted_context_fields. The same minter also puts the
  queue item's recommended_action and candidate_tools into the prompt unescaped; for a
  finding-sourced mission recommended_action holds a repository path chosen by whoever named the
  file. Because the module is not in the pending set, closing F4.0c by driving the pending minters
  to zero leaves this field family labelled nowhere, and no invariant fails.
- Close condition: Either route recommended_action and candidate_tools through
  untrusted_context_fields (or an untrusted_block) in autonomy_orchestrator, or class the minter
  'pending' in MINTERS and raise the pinned pending count with the finding id in the same commit;
  add a test that renders the generic queue prompt with a hostile recommended_action and asserts it
  appears only inside an untrusted block.

### ARIA-LOW-1123

tools/aria-acceptance/harness.py `_read_cycle` re-implements the 'runs of one cycle' read beside
runtime_artifacts.read_runs_for_cycle because the owner has no read-only mode (its path helpers call
ensure_tools_dir, which creates directories and rewrites integrity_index.json), leaving two readers
of one fact

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-23.
- Raised by: the review notes of the K1 packages F4.0b, SE-5 and F1.3, verified at origin/main
  ae2958653d; registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `tools/aria-acceptance/harness.py:704-722` (`_read_cycle`: ensure_tools_dir_readonly plus
    read_runs_rows filtered by cycle_id)
  - `aria-kernel/aria_kernel/runtime_artifacts.py:289-303` (the owner: by-cycle file when present,
    else runs.jsonl filtered by cycle_id, both through ensure_tools_dir)
  - `aria-kernel/aria_kernel/tool_registry.py:328-354` (ensure_tools_dir mkdirs, prepares
    directories and calls update_tools_index)
  - `aria-kernel/aria_kernel/tool_registry.py:357-378` (ensure_tools_dir_readonly exists, but the
    owner does not use it)
- Rule: Single center, no duplicates: every concept has one owner and a second copy is deleted or
  pinned (user rule; CLAUDE.md Architectural Approach).
- Failure scenario: The harness's reader and the owner can disagree: the owner prefers the by-cycle
  summary file when it exists, the harness always reads runs.jsonl, and the owner cannot be called
  on a kept store without mutating it. A change to how a cycle's runs are selected (a new by-cycle
  layout, a status filter) lands in the owner and not in the exam, so the stamped baseline reads a
  different run set than the cycle phase reports, with no test tying the two.
- Close condition: Give read_runs_for_cycle a read-only mode (resolve paths through
  ensure_tools_dir_readonly, no index rewrite) and have `_read_cycle` call it; delete the private
  filter. Add a test that the exam and read_runs_for_cycle return the same rows for a store holding
  a by-cycle file and for one without.

### ARIA-LOW-1124

harness.`_corpus_git` is a private git runner that omits the safe.directory rule of
main_anchor.`_git` and treats every nonzero return as 'not a commit' or 'not an ancestor', so a
corpus repository owned by another uid read as root (git exit 128, dubious ownership) is refused as
a missing corpus commit

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-23.
- Raised by: the review notes of the K1 packages F4.0b, SE-5 and F1.3, verified at origin/main
  ae2958653d; registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `tools/aria-acceptance/harness.py:679-687` (`_corpus_git`: scrubbed env, no safe.directory,
    subprocess.run with a timeout that is not caught)
  - `tools/aria-acceptance/harness.py:695-701` (any returncode other than 0 from rev-parse --verify
    or merge-base --is-ancestor becomes baseline_exam_corpus_commit_missing)
  - `aria-kernel/aria_kernel/main_anchor.py:243-267` (the kernel's scrubbed runner names the
    checkout in a command-line safe.directory when root reads a root-owned repo)
  - `aria-kernel/aria_kernel/main_anchor.py:97-104` (scrubbed_git_env, the part the harness does
    share)
- Rule: Single center for hermetic git: a second scrubbed-env runner without the owner's trust rule
  or exit-code discipline (rev-parse --verify --quiet and merge-base --is-ancestor return 1 for
  'no', 128 for a fault).
- Failure scenario: Sessions here run as root while the CI runner's checkouts belong to uid 1001
  (root's global git config carries safe.directory entries for the runner's paths). git refuses such
  a repo with 'fatal: detected dubious ownership' and exit 128 (reproduced here on a repo owned by
  uid 1001: rev-parse --verify --quiet HEAD^{commit} returns 128 under root's home config and 0 only
  with -c safe.directory). `_corpus_git` has no such scope and the harness reads 128 as 'not a
  commit of `<repo>`', so a valid corpus is reported missing with a misleading name and the real
  cause is dropped; the same conflation applies to --is-ancestor. The refusal direction is safe; the
  diagnosis is wrong, and a timeout raises an unnamed TimeoutExpired.
- Close condition: Run the corpus checks through one shared hermetic git runner that carries the
  safe.directory rule, and map only exit 1 to the 'missing' and 'not an ancestor' refusals, naming
  any other exit (128, timeout) as its own refusal. Add a test with a repo owned by another uid that
  expects the named fault, not corpus_commit_missing.

## Source A2: PR #2174 (K1), F0.9p, F3.5a, F3.3a with F3.4, and F1.2

15 findings.

### ARIA-MEDIUM-1125

The no-orphan-memory invariant covers 3 of the 58 memory=True surfaces by opt-in, and no test
requires a new memory surface to declare a LEARNED_KINDS entry or a named exemption, so a new
learned kind lands ungated while the doctor provenance organ still reads ok

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-12-09.
- Raised by: the review notes of the K1 packages F0.9p, F3.5a, F3.3a/F3.4 and F1.2, verified at
  origin/main ae2958653d; registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `aria-kernel/aria_kernel/row_provenance.py:11-13` (the module names the memory flag as the one
    declaration of what ARIA learned)
  - `aria-kernel/aria_kernel/row_provenance.py:62-66` (LEARNED_KINDS declares three kinds: belief,
    convention, episode)
  - `aria-kernel/aria_kernel/state_manifest.py:939-952` (memory_surfaces() is the whole
    self-learning record; 58 surfaces carry memory=True)
  - `aria-kernel/tests/test_row_provenance.py:150-164` (tests pin the exact three kinds and that
    each is a memory surface; nothing requires the other direction)
  - `aria-kernel/aria_kernel/ownership_atlas.py:262-267` (provenance_offenders iterates
    LEARNED_KINDS only, so an undeclared memory surface is never an offender)
  - `aria-kernel/aria_kernel/doctor.py:732-734` (the provenance organ reads ok whenever the declared
    kinds hold no orphan)
- Rule: F0.9p / PLAN-v2 no-orphan invariant (row_provenance.py module docstring: every memory kind a
  later package adds needs a gate that says its row names a source); CLAUDE.md tier 3, the wrong
  behaviour must be detectable at build time.
- Failure scenario: F4.1 (lessons), F4.4 or F4.5 (uncertainties) adds a memory=True surface whose
  rows cite nothing. provenance_offenders and every test stay green, because only the surfaces named
  in LEARNED_KINDS are read, and the doctor provenance organ reports ok from a census of three
  kinds. The module's statement that the memory flag is the one declaration of what ARIA learned is
  then false for the new kind, and nothing detects it.
- Close condition: Add a test over state_manifest.memory_surfaces() minus the LEARNED_KINDS surfaces
  that is green only when every remaining surface is in a closed exemption table with a one-line
  reason; adding a memory=True surface without a Learned entry or an exemption then fails the build.

### ARIA-MEDIUM-1126

validation.`_pinned_worktree` runs git worktree add, remove and prune without the kernel's hooks-off
arguments on the commit under proof, so where the repository config sets core.hooksPath=.husky the
agent tip's own .husky/post-checkout runs as the executor, outside the sandbox, on the PR-open
authority path

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-12-09.
- Raised by: the review notes of the K1 packages F0.9p, F3.5a, F3.3a/F3.4 and F1.2, verified at
  origin/main ae2958653d; registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `aria-kernel/aria_kernel/validation.py:755-780` (git worktree add, remove and prune through
    plain git, no hooks-off arguments, on the agent's tip)
  - `aria-kernel/aria_kernel/validation.py:503-504` (prove_red_first checks each side out through
    it)
  - `aria-kernel/aria_kernel/apply_engine.py:1059-1062` (the apply gate's finding-origin proof
    reaches it)
  - `aria-kernel/aria_kernel/git_containment.py:261` (KERNEL_GIT_NO_HOOKS_ARGS)
  - `aria-kernel/aria_kernel/implementation_delivery.py:179-185` (the delivery's contract: every
    executor git subprocess touching the agent's tree runs hooks off, because a runner
    core.hooksPath would run the agent's .husky hook)
  - `aria-kernel/aria_kernel/apply_engine.py:989-992` (the lift in the same slice does pass the
    hooks-off arguments)
- Rule: implementation_delivery module contract (lines 179-185): every executor git subprocess that
  touches a tree the agent wrote runs with hooks off; CLAUDE.md Security, untrusted code does not
  run outside the sandbox.
- Failure scenario: Reproduced by the verifier in a scratch repository: with core.hooksPath=.husky
  and a commit that adds an executable .husky/post-checkout, git worktree add --detach `<dir>`
  `<that commit>` ran the hook and wrote a marker file. In the gate the green side is the agent's
  branch tip, so an agent that commits such a hook gets code execution as the executor uid during
  the red-first proof, outside bwrap, whenever the runner's repository config carries a hooksPath
  (the delivery docstring names npm run hooks:install and npm ci without --ignore-scripts as ways it
  gets set). Not shown here: that the production runner checkout sets core.hooksPath. Implementation
  authority is off today, so no break is proven reachable.
- Close condition: Run every git call of `_pinned_worktree` with KERNEL_GIT_NO_HOOKS_ARGS and a
  scrubbed environment, preferably through one hardened worktree runner shared with
  request_worktree.run_worktree_git; a test commits a .husky/post-checkout under a repository with
  core.hooksPath=.husky and asserts prove_red_first does not run it.

### ARIA-MEDIUM-1127

The red-first gate turns only GovernanceError into a named refusal, so an OSError or ValueError
raised by the proof (a declared command with a NUL byte or an over-long argv, or a test path whose
ancestor is a regular file at the base) escapes run_apply_gate and deliver_implementation and
crashes the executor job with no named refusal

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-12-09.
- Raised by: the review notes of the K1 packages F0.9p, F3.5a, F3.3a/F3.4 and F1.2, verified at
  origin/main ae2958653d; registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `aria-kernel/aria_kernel/apply_engine.py:1055-1064` (the decision catches GovernanceError only)
  - `aria-kernel/aria_kernel/validation.py:766-773` (pin files are written with mkdir and os.open,
    which raise FileExistsError or OSError)
  - `aria-kernel/aria_kernel/validation.py:1376-1393` (parse_allowed_command admits any
    shlex-parsable text after python3 -m unittest, NUL and length included)
  - `aria-kernel/aria_kernel/validation.py:998-1008` (`_run_one` catches only TimeoutExpired around
    the spawn)
  - `aria-kernel/aria_kernel/implementation_delivery.py:1041-1050` (run_apply_gate is wrapped for
    SandboxUnavailable and GovernanceError only)
  - `tools/aria-poc/ci_executor.py:6037-6077` (the executor catches ImplementationDeliveryRefusal
    only)
- Rule: Every refusal of untrusted agent input is a named refusal (implementation_delivery stages
  and settlement); a fail-closed path must also fail by name (CLAUDE.md root-cause rule).
- Failure scenario: An agent declares red_first.command as a python3 -m unittest line with an
  embedded NUL (JSON can carry it) or a very long argument. parse_allowed_command admits it, the
  sandbox wrap builds a bwrap argv, and the spawn raises ValueError (embedded null byte) or OSError
  E2BIG (confirmed with a stdlib one-liner: shlex.split keeps the NUL, subprocess.run raises
  ValueError, a 300 KB argument raises OSError 7); none of `_run_one`, `_red_first_decision` or
  deliver_implementation catches it, so it reaches ci_executor with the request unsettled. The same
  escape occurs for an honest refactor that turns module calc.py into a package and adds
  calc/test_x.py: mkdir of calc/ under a regular file calc (validation.py:770) raises
  FileExistsError, also confirmed. Nothing is promoted (fail-closed); the cost is an unnamed job
  crash. Executor behaviour after the crash was not verified.
- Close condition: Make the prover's spawn and pin-write paths raise GovernanceError with a fixed
  code for OSError and ValueError, or have `_red_first_decision` map them to
  red_first_proof_refused; tests for a NUL command, an over-long command and a file-over-directory
  pin path assert the gate returns a blocked row named red_first_proof_refused.

### ARIA-MEDIUM-1128

The merge_intent row is still published before every lane merge but nothing reads it since
`_aria_merged_prs` was deleted, so a lane merge whose merged rows never reached the store is
invisible to self-revert unless its PR has a plan in IMPLEMENTATION_RECORDED, and two docstrings
still state the retired rule

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-12-09.
- Raised by: the review notes of the K1 packages F0.9p, F3.5a, F3.3a/F3.4 and F1.2, verified at
  origin/main ae2958653d; registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `aria-kernel/aria_kernel/merge_authority.py:609-632` (the intent docstring: an intent whose PR
    later merged at that head is an ARIA merge (self_revert))
  - `aria-kernel/aria_kernel/merge_authority.py:353-364` (the intent publish is still a gate before
    every merge call)
  - `aria-kernel/aria_kernel/own_pr_ci.py:50-59` (is_own_pr_head docstring: a merge_intent could
    never be tied to its merge)
  - `aria-kernel/aria_kernel/merge_record.py:396-405` (arias_merges reads the merged rows only,
    never an intent)
  - `aria-kernel/aria_kernel/self_revert.py:674-677` (a PR absent from arias_merges is skipped as
    not_an_aria_merge)
  - `aria-kernel/aria_kernel/self_revert.py:1513-1519` (revert_landed needs the revert PR in
    arias_merges)
  - `aria-kernel/aria_kernel/implementation_reconciler.py:163-182` (the one recovery left:
    `_observe_merge`, only for plans in IMPLEMENTATION_RECORDED)
- Rule: ARIA-HIGH-222: a merge can never be invisible to self-revert; F3.3a one-owner rule
  (merge_record.py 358-364): merge_record is the one reader of which merges are ARIA's, so its
  record must be complete for every merge the lane makes.
- Failure scenario: The lane publishes a merge_intent at head H, merges, and loses its final publish
  (runner death or a lost fast-forward race), so no merged row exists. A self-revert PR, or any
  lane-merged ARIA PR with no plan in IMPLEMENTATION_RECORDED, is then absent from arias_merges: a
  red outcome on it is skipped as not_an_aria_merge, and its revert_landed row and rollback_success
  event are never written, where the pre-F3.4 reader recovered it from the intent. The review's
  probe gave no decision on the branch and revert_opened at the merge-base. The intent publish stays
  a gate before every merge call and costs a publish round trip for no reader.
- Close condition: Either restore the recovery in the one owner (merge_record reconciles an
  unsettled merge_intent whose PR GitHub reports merged at that head into a merged row, as
  reconcile_enqueued_merges does for the queue) with a test that a lost merged row is recovered for
  a non-plan PR, or retire the intent publish and correct both docstrings in the same change.

### ARIA-MEDIUM-1129

The post-merge scan lists only the last 20 merged PRs repo-wide and, since F3.4, credits a PR only
when merge_record already holds its merged row, so an ARIA merge classified late or reached after 20
other merges never gets a merge outcome and nothing rescans older merges, which blinds the
post-merge red trigger and the landed-revert check

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-12-09.
- Raised by: the review notes of the K1 packages F0.9p, F3.5a, F3.3a/F3.4 and F1.2, verified at
  origin/main ae2958653d; registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `aria-kernel/aria_kernel/own_pr_ci.py:161-167` (scan_merged_own_prs: limit=20)
  - `aria-kernel/aria_kernel/own_pr_ci.py:206-211` (a PR outside arias_merges is skipped before any
    outcome row)
  - `aria-kernel/aria_kernel/github_adapters.py:550-566` (list_merged_own_prs: gh pr list --state
    merged --limit N, not filtered to ARIA)
  - `aria-kernel/aria_kernel/cycle.py:1672-1676` (the cycle calls the scan with the default limit)
  - `aria-kernel/aria_kernel/merge_record.py:105` (MAX_LINEAGE_CHECKS = 6 cycles of lineage retries)
  - `aria-kernel/aria_kernel/implementation_reconciler.py:120-130` (an unreadable merged head is
    retried, so the merged row can arrive cycles after the merge)
  - `aria-kernel/aria_kernel/self_revert.py:644-657` (post-merge candidates come only from the
    merge-outcome rows)
- Rule: ARIA-HIGH-199 / ORPHAN-718 intent: every ARIA merge is watched for a red on main and
  reverted when attributable; a safety net must not depend on how many unrelated PRs merged in
  between.
- Failure scenario: A person merges an ARIA PR; merge_record cannot read the merged head and retries
  for up to six cycles, or ARIA is paused for days while other sessions merge more than 20 PRs. By
  the time the lineage is classified the PR is no longer among the 20 newest merged PRs, so
  scan_merged_own_prs never lists it, no merge-outcome row is written, the post-merge candidate list
  never contains it, and a red that main shows after it is never attributed or reverted by the
  post-merge CI trigger (the change-outcome regression trigger reads the merged rows directly and is
  not affected). The 20-PR window existed before F3.4; F3.4 added a second condition that is
  satisfied after the merge.
- Close condition: Drive the scan from the merged rows merge_record holds (arias_merges) and ask
  GitHub for each PR's merge commit by number (the per-PR read the reconciler already uses,
  reader.pr_merge_state), instead of listing the repository's last N merges; a test with a merged
  row whose PR is outside the newest 20 asserts a merge-outcome row is still written.

### ARIA-MEDIUM-1130

The five pre-registered G1 field names bind to nothing: they are second names for numbers recorded
under other keys (role_fitness mutation_canary rates, performance_kpis implementer rate, scorecard
learning_log.live), and no function maps a name to its recorded key path or builds the flat report
g1_gap_free_run reads, so fed the real fitness row it reports every field none

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-12-09.
- Raised by: the review notes of the K1 packages F0.9p, F3.5a, F3.3a/F3.4 and F1.2, verified at
  origin/main ae2958653d; registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `aria-kernel/aria_kernel/autonomy_evidence.py:1456-1459` (finding-quality field names
    canary_mutant_detection_rate and canary_false_claim_refutation_rate)
  - `aria-kernel/aria_kernel/role_fitness.py:225-226` (the number is recorded as
    mutant_detection_rate and false_claim_refutation_rate)
  - `aria-kernel/aria_kernel/role_fitness.py:272` (nested under role_fitness.mutation_canary in the
    fitness row)
  - `aria-kernel/aria_kernel/autonomy_evidence.py:1465-1466` (implementer_repeat_failure_rate)
  - `aria-kernel/aria_kernel/agent_eval.py:1365` (recorded as live.repeat_failure_rate.implementer,
    nested in implementation_quality at fitness.py:88)
  - `aria-kernel/aria_kernel/autonomy_evidence.py:4743-4750` (g1_gap_free_run reads report.get(name)
    on a flat {name: value} report nothing builds)
  - `aria-kernel/aria_kernel/data/genesis_policy_default.json:92-100` (the pre-registered list of
    five names)
  - `docs/aria/generated/OWNERSHIP-ATLAS.md:31` (mechanism_contribution and its scorecard caller
    read liveness dead)
- Rule: F1.2 spec item 1: each lens field names the ledger and the owner of its number, one owner
  per number; a name that no code binds to its recorded location is a second, unpinned name
  (CLAUDE.md single-center rule).
- Failure scenario: The review's probe, reproduced by reading: a fitness row generated on a bound
  store, fed to g1_gap_free_run with `gates_policy()['g1']['fields']`, finds none of the five keys
  at the top level (canary rates live under role_fitness.mutation_canary, the implementer rate under
  implementation_quality.live.repeat_failure_rate.implementer, learning_log_live under
  `mechanism_scorecard()['learning_log']`), so every field reads none, run 0, no first gap (a
  never-measured field is deliberately not a gap). No production code calls mechanism_scorecard,
  g1_gap_free_run or gates_policy, so G1 cannot be evaluated from recorded state until some owner
  writes the name-to-path map; whoever does must invent it.
- Close condition: Give MeasuredField the key path of its number in the ledger it names, add one
  function that builds a cycle's flat G1 report from the fitness row and mechanism_scorecard through
  those paths, and call it from the fitness phase or doctor; a test feeds a real
  generate_fitness_report row to g1_gap_free_run and asserts the canary and implementer fields read
  measured when their numbers exist.

### ARIA-MEDIUM-1131

g1_gap_free_run returns only the longest gap-free run of the whole history, never the current
trailing run, so a gate written as run >= consecutive_cycles stays satisfied forever after 14 good
cycles followed by any number of cycles with no report

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-12-09.
- Raised by: the review notes of the K1 packages F0.9p, F3.5a, F3.3a/F3.4 and F1.2, verified at
  origin/main ae2958653d; registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `aria-kernel/aria_kernel/autonomy_evidence.py:4722-4736` (docstring: the longest gap-free run;
    the result carries a run and a gap, never a verdict)
  - `aria-kernel/aria_kernel/autonomy_evidence.py:4741-4761` (run resets to 0 on a gap cycle;
    longest keeps the maximum)
  - `aria-kernel/aria_kernel/autonomy_evidence.py:4763-4770` (the result returns longest as run; the
    trailing run is dropped)
  - `aria-kernel/aria_kernel/data/genesis_policy_default.json:93` (the pre-registered gate asks for
    14 consecutive cycles)
  - `aria-kernel/aria_kernel/genesis_policy.py:1103-1107` (PLAN-v2 G1: 14 consecutive cycles with
    every field measured)
- Rule: PLAN-v2 section 4, G1: '14 consecutive cycles, every field measured' is about the cycles up
  to now; a reader of a pre-registered gate must expose what the gate decides on.
- Failure scenario: History: 14 gap-free cycles, then 30 cycles with no report. The loop sets run to
  0 on each missing report but longest stays 14, so the reader returns run 14 and names first_gap at
  the 15th cycle (read from the loop; the review's probe_b reports the same). Any consumer that
  compares run with the pre-registered consecutive_cycles (14) passes the gate on a stale run,
  although no cycle of the last 30 was measured. The spec says 'longest run', but the gate it feeds
  needs the trailing one, which the same loop already computes.
- Close condition: Return the trailing run beside the longest (a current_run key) and document which
  one a gate must read; a test with 14 good cycles followed by one missing report asserts
  current_run is 0 while the longest stays 14.

### ARIA-LOW-1132

The red*first*\* gate blockers are never classified by the delivery settlement:
implementation_rejections names only validation_regression, suppression_pattern and
candidate_validation_not_green, so every red_first outcome settles unclassified and a proven suite
regression that arrives with a red_first blocker loses its request-fault attribution

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-23.
- Raised by: the review notes of the K1 packages F0.9p, F3.5a, F3.3a/F3.4 and F1.2, verified at
  origin/main ae2958653d; registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `aria-kernel/aria_kernel/apply_engine.py:280-289` (the red_first blockers are appended to the
    gate's own blocked_by)
  - `aria-kernel/aria_kernel/apply_engine.py:931-937` (RED_FIRST_BLOCKERS is declared and referenced
    by no production code)
  - `aria-kernel/aria_kernel/implementation_rejections.py:145-146` (the agent-fault blocker sets
    name three blockers and no red*first*\*)
  - `aria-kernel/aria_kernel/implementation_rejections.py:175-177` (a gate_blocked reason is the
    agent's only when every item is in AGENT_GATE_BLOCKERS)
  - `aria-kernel/aria_kernel/implementation_rejections.py:195` (the one gate_blocked settlement
    rule)
  - `aria-kernel/aria_kernel/finding_grounding.py:136-151` (an unclassified ending counts toward a
    streak of two before the subject cools off)
- Rule: One owner per concept (CLAUDE.md single-center rule, F3.5a spec item 3): the gate's blocker
  vocabulary and the settlement's fault vocabulary must agree by construction, or a test must pin
  each name's class (tier 3).
- Failure scenario: A finding-origin delivery whose suite regresses and whose agent declared no
  red-first test is blocked with blocked_by validation_regression,red_first_declaration_missing.
  `_gate_blockers_are_the_agents` needs every item inside AGENT_GATE_BLOCKERS, so the settlement is
  unclassified instead of request, and finding_grounding counts it as an unverified ending (a streak
  of two before cool-off) rather than a failure. Every red_first verdict, including a refuted pin
  that is provably the agent's, settles the same way, and no test names the intended class for any
  of them.
- Close condition: Decide each RED_FIRST_BLOCKERS name in implementation_rejections (agent-proving
  or not), taking the names from the apply_engine tuple instead of retyping them, make the verifier
  treat a proving blocker as proving when a decided non-agent blocker accompanies it, and add a test
  over every RED_FIRST_BLOCKERS name asserting its settlement class.

### ARIA-LOW-1133

Delivery pricing is no longer total: `_staged_proof_runs` calls classify_red_first, which raises
red_first_change_chain_missing for a staged action whose change has no planned row, and neither the
drain's per-request pricing nor delivery_admission_refusal (documented to return a string or None)
handles it

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-23.
- Raised by: the review notes of the K1 packages F0.9p, F3.5a, F3.3a/F3.4 and F1.2, verified at
  origin/main ae2958653d; registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `aria-kernel/aria_kernel/apply_engine.py:959-976` (classify_red_first raises GovernanceError for
    a staged change with no planned row)
  - `aria-kernel/aria_kernel/implementation_delivery.py:680-691` (`_staged_proof_runs` calls it with
    no handler)
  - `aria-kernel/aria_kernel/implementation_delivery.py:755-772` (the admission's try covers the
    sandbox only; the pricing call at 769 is outside it)
  - `tools/aria-poc/ci_executor_drain.py:1322-1327` (the drain prices each request with no handler)
  - `tools/aria-poc/ci_executor.py:1599-1618` (`_request_delivery_seconds`, uncaught)
  - `tools/aria-poc/ci_executor.py:5537-5545` (the pre-spawn pricing and admission run while the
    claim is held)
- Rule: Refuse by name, never by an unhandled exception (delivery_admission_refusal's own contract
  returns a refusal string or None; CLAUDE.md root-cause rule): a pricing function that gained a
  raise path must stay total or be handled at every caller.
- Failure scenario: A restored or partially published store holds an apply action whose change_id
  has no change_planned row (the stager writes the planned row first, so only an inconsistent store
  reaches this). The drain's per-request pricing at ci_executor_drain.py:1324 then raises out of
  drain_pending, so the request is neither skipped by name nor claimed and every later drain trips
  on it again; the executor's pre-spawn call raises while the claim is held instead of releasing it
  with a named refusal.
- Close condition: Make pricing and admission total: price an unclassifiable action at the
  conservative proof count, or catch the GovernanceError at the callers and return a named refusal
  (a drain skip by name, an admission string); a test with a staged action whose change has no
  planned row asserts staged_delivery_worst_case_seconds and delivery_admission_refusal do not
  raise.

### ARIA-LOW-1134

The observability dashboard's validation failed_count counts every validation_runs row with a non-ok
status, so each red-first proof's deliberate red run at the base commit is recorded as a failed
validation run

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-23.
- Raised by: the review notes of the K1 packages F0.9p, F3.5a, F3.3a/F3.4 and F1.2, verified at
  origin/main ae2958653d; registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `aria-kernel/aria_kernel/observability.py:99-110` (failed_count counts every non-ok row of the
    ledger)
  - `aria-kernel/aria_kernel/observability.py:66` (the dashboard reads the whole validation_runs
    ledger)
  - `aria-kernel/aria_kernel/validation.py:503-510` (each proof runs the pin at the base and at the
    tip through `_run_one`, one ledger row each)
  - `aria-kernel/aria_kernel/validation_runs_ledger.py:160-172` (any non-zero exit is failed)
  - `aria-kernel/aria_kernel/validation.py:797-800` (a red base run is the expected outcome of a
    proof)
- Rule: A measurement counts what it names (observability.py:82-88, E21-a: readers must not miscount
  the unified validation surface); a run whose failure is the evidence is not a failed validation.
- Failure scenario: Every finding-origin delivery with a proof, and every D6 seat-pin proof, appends
  a red row at red_at to validation/validation-runs.jsonl on purpose. The nightly dashboard row then
  reports failed_count and status_counts that include those rows, so a cycle with only successful
  proofs shows validation failures. No decision reads that block today (reflection renders
  rolling_slo and alerts), so the wrong number is recorded, not acted on.
- Close condition: Exclude proof and bench runs (their change_id and validation_plan_id family, or
  an explicit run purpose field) from `_validation_summary`, or report them under a separate key; a
  test where a proven red-first pair leaves failed_count unchanged.

### ARIA-LOW-1135

delivery_closure still decides that a request's PR merged from ci/merge-outcomes.jsonl, own_pr_ci's
post-merge ledger, instead of merge_record, and F3.4 narrowed that ledger to PRs merge_record holds
as ARIA's inside a 20-PR window, so a merged PR can stay in its last pre-merge state in the delivery
closure

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-23.
- Raised by: the review notes of the K1 packages F0.9p, F3.5a, F3.3a/F3.4 and F1.2, verified at
  origin/main ae2958653d; registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `aria-kernel/aria_kernel/delivery_closure.py:123-137` (a PR is merged only when a merge outcome
    row exists, else the last CI check state decides)
  - `aria-kernel/aria_kernel/delivery_closure.py:252-256` (latest_merge is read from the
    merge-outcomes ledger)
  - `aria-kernel/aria_kernel/delivery_closure.py:268-270` (merge_status is set only from a
    merge-outcome row with a merge_sha)
  - `aria-kernel/aria_kernel/own_pr_ci.py:206-211` (merge-outcome rows now exist only for PRs in
    arias_merges)
  - `aria-kernel/aria_kernel/merge_record.py:358-364` (the stated rule: which merges happened is
    read in merge_record and nowhere else)
  - `aria-kernel/tests/invariants/test_merge_index_single_owner.py:152-181` (the pin does not look
    at this reader)
- Rule: F3.3a one-owner rule (merge_record.py:358-364): 'which merges happened, and which are
  ARIA's' is read in merge_record and nowhere else.
- Failure scenario: A request's PR is merged by a person and merge_record has not classified its
  head as ARIA's, or the PR left the 20-PR scan window, so no merge-outcome row exists.
  delivery_closure keeps the state of the last own-PR check (ci_pending or ci_red) and rec.delivered
  stays false for a change that is on main, which feeds the verified_prs gap of the delivery SLO.
  The narrowing came from F3.4's arias_merges gate; the invariant that should have caught the second
  reader does not scan this shape.
- Close condition: Derive a request PR's merged state from merge_record (fold_merged_rows or
  arias_merges by pr_number) and keep own_pr_ci's ledger for the post-merge CI verdict only; extend
  the single-owner invariant with this reader's shape and add a closure test with a merged row and
  no merge-outcome row expecting 'merged'.

### ARIA-LOW-1136

test_merge_index_single_owner recognises a fold of the merged rows only as a comparison with the
literal 'merged', so a fold through a named constant (EVENT_MERGED) or a constant set such as
auto_merge's `_OWNED_LIFECYCLE_EVENTS` passes the single-owner pin

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-23.
- Raised by: the review notes of the K1 packages F0.9p, F3.5a, F3.3a/F3.4 and F1.2, verified at
  origin/main ae2958653d; registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `aria-kernel/tests/invariants/test_merge_index_single_owner.py:84-90` (`_names_merged` accepts a
    Constant or a literal tuple, list or set, never a Name)
  - `aria-kernel/tests/invariants/test_merge_index_single_owner.py:93-97`
    (`_compares_field_with_merged` builds on it)
  - `aria-kernel/tests/invariants/test_merge_index_single_owner.py:113-118`
    (merged_row_fold_offenders)
  - `aria-kernel/tests/invariants/test_merge_index_single_owner.py:183-200` (every planted shape is
    a literal)
  - `aria-kernel/aria_kernel/auto_merge.py:553-559` (a constant frozenset that holds 'merged'
    already exists in production code)
- Rule: F3.3a one-owner rule: a second fold of the merged rows must be red the commit it appears
  (the digest.py pattern); CLAUDE.md tier 3, detectable at build time.
- Failure scenario: A new module folds merged rows with row['event'] in LIFECYCLE_EVENTS or
  row['event'] == EVENT_MERGED. `_names_merged` sees a Name, not a Constant, so
  merged_row_fold_offenders returns nothing and the invariant stays green while a second merge index
  exists. The decision comparison at line 139 has the same literal-only blind spot.
- Close condition: Resolve module-level string constants and constant sets in the scan (a Name bound
  to a value that holds 'merged'), and add planted shapes for == EVENT_MERGED and in CONSTANT_SET to
  test_every_shape_the_atlas_named_is_caught that must be red.

### ARIA-LOW-1137

own_pr_ci.is_own_pr_head still decides that an open PR is ARIA's from its head-branch name (aria/,
automation/, `aria-impl-<hex>`) in scan_own_prs and in the repo PR health own_pr flag, a second
authorship rule beside merge_record's, so an ARIA change on a person-named branch gets no open-PR CI
scan

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-23.
- Raised by: the review notes of the K1 packages F0.9p, F3.5a, F3.3a/F3.4 and F1.2, verified at
  origin/main ae2958653d; registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `aria-kernel/aria_kernel/own_pr_ci.py:36-37` (OWN_PR_HEAD_PREFIXES and the excluded heads)
  - `aria-kernel/aria_kernel/own_pr_ci.py:50-67` (is_own_pr_head)
  - `aria-kernel/aria_kernel/own_pr_ci.py:109-113` (scan_own_prs skips every open PR whose head name
    does not match)
  - `aria-kernel/aria_kernel/own_pr_ci.py:339` (the repo PR health row's own_pr flag)
  - `aria-kernel/aria_kernel/own_pr_ci.py:183-186` (the scan's own docstring: PR #1906 was ARIA's
    change on a person-named branch)
  - `aria-kernel/aria_kernel/merge_record.py:396-405` (the owner's rule: authorship by lineage, not
    by branch name)
  - `aria-kernel/tests/invariants/test_merge_index_single_owner.py:121-130` (the pin flags the
    head-prefix rule only inside a function that lists merged PRs)
- Rule: F3.3a one-owner rule (merge_record.py:396-405): ARIA authorship is decided by merge_record,
  not by a head branch's name; the merged-PR half was fixed and the open-PR half was left.
- Failure scenario: ARIA opens a PR and its change reaches GitHub under a branch name the three
  patterns do not match (the PR #1906 shape the code itself documents). scan_own_prs never snapshots
  it, so no own-pr-checks row, no CI feedback and no pressure from its red exist while it is open,
  although the lifecycle's opened row says ARIA opened it; repo PR health records own_pr false for
  it.
- Close condition: Decide ownership of an open PR from the lifecycle opened row (merge_record's
  opened_row and pr_change_binding) instead of its branch name, remove OWN_PR_HEAD_PREFIXES from
  own_pr_ci, and extend the single-owner invariant to forbid is_own_pr_head outside merge_record; a
  test that an ARIA-opened PR on a person-named branch is scanned.

### ARIA-LOW-1138

Two of the five G1 fields, learning_log_live (a bool) and mechanisms_contributing (an int), can
never be None, and mechanism_scorecard reads a missing or unbound learning journal as an empty one,
so a store with no learning instrument counts as 'measured' in every cycle of the G1 run

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-23.
- Raised by: the review notes of the K1 packages F0.9p, F3.5a, F3.3a/F3.4 and F1.2, verified at
  origin/main ae2958653d; registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `aria-kernel/aria_kernel/autonomy_evidence.py:4692-4698` (an unbound store or an absent journal
    file becomes an empty row list)
  - `aria-kernel/aria_kernel/autonomy_evidence.py:4703-4710` (live is a bool and
    mechanisms_contributing an int)
  - `aria-kernel/aria_kernel/autonomy_evidence.py:4750` (a field is measured when its value is not
    None)
  - `aria-kernel/aria_kernel/data/genesis_policy_default.json:98-99` (both names are in the
    pre-registered G1 list)
  - `aria-kernel/tests/test_scorecard_mechanisms.py:114-118` (the test pins 'no journal = dormant'
    as the reading)
- Rule: ARIA-MEDIUM-733 / ARIA-LOW-732 intent: a dormant learner must read differently from a
  working one and a field with no producer reads unmeasured with a named reason, never a silent
  zero.
- Failure scenario: On an empty store, or one whose journal path cannot be resolved,
  mechanism_scorecard returns live False, mechanisms_contributing 0 and all five mechanisms as
  quarantine candidates once 30 cycles are supplied. g1_gap_free_run treats False and 0 as measured,
  so 14 cycles of a dead learning loop satisfy the learning half of G1; an absent instrument and a
  dormant one are the same reading.
- Close condition: Return None for both fields when the journal surface cannot be read (unbound
  store, absent file) and keep 0 and False only for a readable empty journal, then update the test
  that pins missing = dormant; a test asserts g1_gap_free_run reports learning_log_live as none for
  an unbound store.

### ARIA-LOW-1139

The learning lens's mechanisms tuple is a hand copy of memory.LEARNING_EVENT_KINDS, pinned in the
test by a second hand-typed set, so a kind added to the closed vocabulary appears in rows_by_kind
but is never scored or evaluated for quarantine

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-23.
- Raised by: the review notes of the K1 packages F0.9p, F3.5a, F3.3a/F3.4 and F1.2, verified at
  origin/main ae2958653d; registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `aria-kernel/aria_kernel/autonomy_evidence.py:1478-1484` (the five mechanisms typed in the lens
    spec)
  - `aria-kernel/aria_kernel/memory.py:27` (LEARNING_EVENT_KINDS, the closed vocabulary F1.1 landed)
  - `aria-kernel/aria_kernel/autonomy_evidence.py:4702-4705` (the scorecard scores only the listed
    mechanisms)
  - `aria-kernel/tests/test_scorecard_lens_specs.py:49-50` (`_JOURNAL_KINDS`, a third typed copy,
    not memory.LEARNING_EVENT_KINDS)
- Rule: One owner per concept (CLAUDE.md single-center rule): the closed learning-event vocabulary
  has one owner in memory.py; the scorecard must read it, not restate it.
- Failure scenario: A sixth kind is added to LEARNING_EVENT_KINDS (and its writer). memory.py
  accepts it, but the scorecard never lists it in mechanisms, so its contribution is not computed
  and it can never be a quarantine candidate; the test still passes because it compares the lens to
  its own typed set.
- Close condition: Build the lens's mechanisms from memory.LEARNING_EVENT_KINDS (or assert equality
  in a test) and replace the test's typed set with the owner's tuple; a test that adds a kind to the
  owner's tuple and expects it in `mechanism_scorecard()['mechanisms']`.

## Source A3: PR #2176 (JFT), the judge-fanout truth package

8 findings.

### ARIA-MEDIUM-1140

judge_replay and mutation_canary build their own path-and-message item and mint without evidence
refs or a repo root, so since the cited-line change the live judges are handed the cited line and
its excerpt while replay recall and the canary self-exam still measure the old question, and the
docstring that says replay measures the same question stays true only because a test pins the
difference.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-12-09.
- Raised by: the review notes of the JFT package, verified at origin/main ae2958653d; registered by
  the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `aria-kernel/aria_kernel/judge_replay.py:75-81` (comment: a replayed judge is asked the live
    question, recall on a different question is not recall; the full adapter finding is resolved
    here)
  - `aria-kernel/aria_kernel/judge_replay.py:149-153` (the replay item keeps rule, severity, path
    and message and drops the finding's evidence)
  - `aria-kernel/aria_kernel/judge_replay.py:161-166` (the replay mint passes no evidence_refs and
    no context_repo_root)
  - `aria-kernel/aria_kernel/mutation_canary.py:385-390` (the canary envelope item is likewise path
    and message only, its path a file:line string)
  - `aria-kernel/aria_kernel/judge_fanout.py:173-176` (judge_request_fields claims the live fan-out
    and the replay mint through it so replay recall measures the same question live judges answer)
  - `aria-kernel/aria_kernel/judge_fanout.py:552-571` (the live mint hands the refs and the repo
    root, so the packer quotes the window around the cited line)
  - `aria-kernel/tests/test_judge_input_cites_the_line.py:197-207` (a test pins that the
    replay-shaped item has no line row, so the divergence stays green)
- Rule: ARIA-HIGH-324 contract stated at judge_replay.py:75-78 and judge_fanout.py:173-176: one
  question for live judges and replayed judges; one owner of the sample item
  (feedback_store.`_sample_item_from_finding`) instead of private item builders.
- Failure scenario: For a gold item whose adapter finding is {path P, evidence [{P, line 120}]} the
  live fan-out now mints with refs [P, P:120], an excerpt covering line 120 and a prompt row 'line:
  120'; the replay mint for the same finding resolves the full finding, copies only rule, path and
  message, and mints with no refs, no excerpt and no line row. Judge recall, ECE and accuracy
  computed from the replay: groups (compute_replay_recall, the canary self-exam) describe a regime
  live judges no longer run in, and the shipped docstrings say the opposite. The effect is latent
  while both lanes are held (ARIA-MEDIUM-713, ARIA-MEDIUM-1089) and appears with the first replay
  run.
- Close condition: Build the replay item and the canary envelope item through
  feedback_store.`_sample_item_from_finding` from the resolved adapter finding and mint with the
  same evidence_refs and repo root as dispatch_judges_for_sample; replace the pin at
  test_judge_input_cites_the_line.py:197 with a test that judge_request_fields output (prompt, refs)
  for a replay item equals the live item's for the same finding.

### ARIA-MEDIUM-1141

A judge group's second or re-minted seat is minted at the later call's HEAD while the first seat
keeps its own tree, and since the arbiter hold such a mixed-seat group has no producer rule and no
exit: neither arm mints, nothing re-asks a seat at a common tree, and both paid judge calls end in a
group that never settles.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-12-09.
- Raised by: the review notes of the JFT package, verified at origin/main ae2958653d; registered by
  the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `aria-kernel/aria_kernel/judge_fanout.py:90-100` (the group id is run-free, so a missing seat is
    minted by a later night's call)
  - `aria-kernel/aria_kernel/judge_fanout.py:508-520` (a seat already minted is skipped by (group,
    agent); a seat skipped for backlog on one role is left for a later call)
  - `aria-kernel/aria_kernel/judge_fanout.py:552-567` (the later mint stamps that call's target_sha)
  - `aria-kernel/aria_kernel/anchor_stale_effects.py:115-124` (the anchor-stale lane re-mints a dead
    judge at gate.head())
  - `aria-kernel/aria_kernel/judge_remint.py:100-107` (the other re-mint entry resolves the
    workspace HEAD)
  - `aria-kernel/aria_kernel/judge_fanout.py:1004-1009` (the split arm holds the mixed group and
    mints nothing)
  - `aria-kernel/aria_kernel/judge_fanout.py:1277-1282` (the anchor arm holds it too)
  - `aria-kernel/aria_kernel/genesis_policy.py:125-128` (measured: 296 of 462 minted judge envelopes
    died of anchor staleness, each one a candidate for a re-mint at a later HEAD)
- Rule: A closing set is judged at one tree (ARIA-HIGH-004 and J5: feedback_store.tree_is_mixed,
  generate_ai_consensus target_sha_mixed); a producer that creates mixed-tree groups and a consumer
  that refuses them, with no rule between, is a pipeline stage with no output.
- Failure scenario: Night 1 mints seat A at tree T1 (the other role is skipped by the backlog cap or
  its envelope dies of staleness); a later night re-mints or self-heals seat B at HEAD T2. The group
  now holds {A at T1, B at T2}: `_group_tree` reports the hold, both arbiter arms skip it, the
  governance row counts it, and no lane re-asks A at T2 or B at T1, so the two paid judge calls
  never become consensus or an anchor. With main moving nightly and most envelopes dying of
  staleness, this is the common path for any re-minted seat, not a corner.
- Close condition: Decide and implement the producer rule (a missing or re-minted seat is minted at
  the tree its surviving seat judged, or the group is re-minted whole at one tree) in the seat
  producers, pinned by a test that runs dispatch_judges_for_sample (or the anchor-stale re-mint)
  over two cycles at two target_shas and asserts `_group_tree` returns a tree, not
  ARBITER_HOLD_SEATS_MIXED_TREE.

### ARIA-MEDIUM-1142

Each arbiter arm recognises a held group inside its mint loop, which a discretionary admission
refusal ends with a break, so the held groups behind the refusal are neither named in skipped nor
counted in the once-per-claim governance disclosure, and the disclosed held_count and id list depend
on where the break fell.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-12-09.
- Raised by: the review notes of the JFT package, verified at origin/main ae2958653d; registered by
  the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `aria-kernel/aria_kernel/judge_fanout.py:1001-1022` (split arm: held is filled inside the loop,
    an admission refusal at 1018-1022 breaks out)
  - `aria-kernel/aria_kernel/judge_fanout.py:1053` (the disclosure runs after the loop over whatever
    was visited)
  - `aria-kernel/aria_kernel/judge_fanout.py:1272-1295` (anchor arm: the same inline hold branch and
    the same break)
  - `aria-kernel/aria_kernel/judge_fanout.py:1311` (anchor arm discloses what it visited)
  - `aria-kernel/aria_kernel/judge_fanout.py:730-747` (`_disclose_tree_holds`: the claim is tool,
    reason, held_count and the first 20 ids of the visited held groups)
  - `aria-kernel/aria_kernel/tool_registry.py:786-792` (append_tools_governance_once dedups by
    claim, so each distinct held_count writes its own row)
  - `aria-kernel/aria_kernel/judge_fanout.py:1057-1064` (`_arbiter_admission`: the door is
    discretionary: a refusal is a normal outcome that holds for the rest of the cycle, so the arm
    stops asking)
- Rule: A standing fact is disclosed whole or not at all (the reason the hold is disclosed once per
  claim on governance, ARIA-MEDIUM-644); a count that depends on the iteration order and on the
  admission door is a measurement that is wrong.
- Failure scenario: 40 groups are held; sorted by key, the third group needs an arbiter and the door
  refuses it: the arm breaks, so held_count is 2 and only those two ids are disclosed, and the 38
  held groups behind the refusal appear nowhere. The next night the door is open, the claim changes
  to held_count 40 and writes another row, and a night of refusal at a different group writes a
  third. The held share read from these rows (M5, M6) undercounts exactly when the pipeline is under
  pressure, and the two copies of the branch must be kept in step by hand.
- Close condition: Classify held groups before the mint loop with one shared helper used by both
  arms (hold detection no longer inside the loop), disclose all of them, and pin with a test that an
  admission refusal on the first non-held group still names every held group in skipped and in one
  disclosure with the full held_count.

### ARIA-LOW-1143

feedback_store.`_evidence_refs_from_item` still reads what a sample item cites in its own way (dict
paths without lines, string evidence ignored) beside the new owner item_citations.item_cited_refs,
and the item_citations atlas family does not name it, so the operator batch label's evidence_refs
disagree with the refs the judges were handed.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-23.
- Raised by: the review notes of the JFT package, verified at origin/main ae2958653d; registered by
  the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `aria-kernel/aria_kernel/feedback_store.py:2143-2150` (reads item path and dict evidence paths
    only: no line, string refs dropped)
  - `aria-kernel/aria_kernel/feedback_store.py:1138` (its one caller: the evidence_refs of an
    operator batch label whose verdict names none)
  - `aria-kernel/aria_kernel/item_citations.py:53-64` (the owner: item_cited_refs returns path:line
    refs and string refs, in order)
  - `aria-kernel/aria_kernel/ownership_atlas.py:112-114` (the item_citations family forbids other
    names but not `_evidence_refs_from_item`)
  - `aria-kernel/tests/test_item_citations.py:8-11` (the owner's own test names this reader among
    the four that disagreed)
- Rule: PLAN-v2 section 1.2 one owner per fact; the item_citations family exists so a fifth reader
  of an item's citations cannot drift from the owner (the same defect as the retired
  system_one_points.`_cited_line`).
- Failure scenario: For an item {path P, evidence ["P:120", {path Q, line 7}]} the owner returns [P,
  P:120, Q:7] while `_evidence_refs_from_item` returns [P, Q]: the string ref is dropped and no line
  survives. An operator label recorded through record_batch with no explicit evidence_refs therefore
  carries refs that name no line and miss a ref the judges cited, and the atlas invariant stays
  green because the family lists names, not this one.
- Close condition: Make `_evidence_refs_from_item` a caller of item_citations.item_cited_refs (or
  delete it and call the owner at feedback_store.py:1138), add the name to the item_citations
  family's forbidden names, and pin that a label for an item with dict evidence carries [P, P:120].

### ARIA-LOW-1144

The split arm holds a group whenever any two of its seats judged different trees, but the consumer
refuses a mixed tree only for an anchor-grade closing set with no dissenter, so the stated reason
for the hold (the producer follows the law that will refuse its arbiter's answer) does not hold for
a split group, which always has a dissenter.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-23.
- Raised by: the review notes of the JFT package, verified at origin/main ae2958653d; registered by
  the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `aria-kernel/aria_kernel/feedback_store.py:1377-1380` (closing is built from the rows that agree
    with the settled verdict)
  - `aria-kernel/aria_kernel/feedback_store.py:1448` (dissenting = rows minus agreeing)
  - `aria-kernel/aria_kernel/feedback_store.py:1521-1525` (the consumer refuses a mixed tree only
    when len(closing) >= ANCHOR_MIN_JUDGE_COUNT and dissenting == 0)
  - `aria-kernel/aria_kernel/judge_fanout.py:715-727` (`_group_tree` asks tree_is_mixed of ALL
    non-arbiter seats; the docstring says it cannot drift from the law that will refuse the answer)
  - `aria-kernel/aria_kernel/judge_fanout.py:808-813` (arbitration_groups sets split and hold from
    the same seats)
  - `aria-kernel/aria_kernel/judge_fanout.py:1002-1009` (the split arm holds and mints nothing)
  - `aria-kernel/tests/test_arbiter_minted_at_the_pairs_tree.py:365-369` (a test pins the split
    hold, so the broader predicate is green by construction)
- Rule: One mixed-tree law (feedback_store.tree_is_mixed): the producer is meant to be asked the
  consumer's own refusal condition, not a wider set of rows than the consumer inspects.
- Failure scenario: Group {seat 1 true_positive at A, seat 2 false_positive at C}: when the weighted
  vote is active (non-empty judge weights) an arbiter answering true_positive leaves closing = 2
  agreeing rows and dissenting = 1, so the consumer's tree check is skipped and the group settles at
  sub-anchor grade with no target_sha. The split arm instead holds it, so it stays unsettled with no
  repair, and the held share the lead reads at M5 and M6 counts split groups the consumer would have
  settled. Under the legacy unanimity path the consumer never settles a 2-1 split either, so the
  hold changes nothing there.
- Close condition: Derive the split arm's hold from the consumer's refusal condition (an
  anchor-grade closing set) instead of from every seat, or record in a test and the registry that
  mixed-tree split groups are held on purpose with their repair item; the test settles a TP-at-A /
  FP-at-C split through the arbiter and asserts no target_sha_mixed refusal.

### ARIA-LOW-1145

judge_fanout spells 'the seats of a group' (every row but the arbiter's) inline in three functions
and re-spells the target_sha normalisation that feedback_store.target_shas owns inside the
arbiter-inputs digest, so a change to either fact moves the group tree, the hold and the digest at
different times.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-23.
- Raised by: the review notes of the JFT package, verified at origin/main ae2958653d; registered by
  the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `aria-kernel/aria_kernel/judge_fanout.py:693-702` (`_seat_inputs`: its own filter of the arbiter
    row and its own str(row.get("target_sha") or ""))
  - `aria-kernel/aria_kernel/judge_fanout.py:724-727` (`_group_tree`: a second inline filter of the
    arbiter row)
  - `aria-kernel/aria_kernel/judge_fanout.py:808-813` (arbitration_groups: a third filter, and it
    then hands the unfiltered by_judge to `_group_tree`, which filters again)
  - `aria-kernel/aria_kernel/feedback_store.py:1714-1717` (target_shas: the owner of how a row's
    tree is read, with the empty string for none)
  - `aria-kernel/aria_kernel/feedback_store.py:1720-1730` (tree_is_mixed documents that a change of
    the law is a change of this function)
- Rule: PLAN-v2 section 1.2 one owner per fact; the closing_tree family's own stated contract that a
  change of the unnamed-tree law is a change of one function (feedback_store.tree_is_mixed).
- Failure scenario: The digest that binds an arbiter to its seats reads each seat's tree with its
  own normalisation, and the hold reads it through target_shas. If ARIA-MEDIUM-881 or a later change
  alters how an unnamed or abbreviated tree is read in the owner, the hold and mint tree move while
  the digest keeps its old reading (or the reverse), so a re-offer or a stale refusal fires on the
  wrong event; a new non-seat row kind (a rebuttal or method row) added to one filter and not the
  others gives three different answers to which rows are seats.
- Close condition: Add one helper in judge_fanout that returns a group's seat rows and use it in
  `_seat_inputs`, `_group_tree` and arbitration_groups, and have `_seat_inputs` read each seat's
  tree through feedback_store.target_shas; pin with a patch test that changing target_shas moves the
  digest and the hold together.

### ARIA-LOW-1146

anchor_candidate_groups returns a held mixed-tree true_positive pair outside the demand bound, and
stability_reask.stability_candidates passes that selector's output straight to the re-ask budget, so
a pair that no arbiter will ever be minted for can take stability budget ahead of unanimous pairs
while the lane's docstring still says only false_positive pairs come back without demand.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-23.
- Raised by: the review notes of the JFT package, verified at origin/main ae2958653d; registered by
  the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `aria-kernel/aria_kernel/judge_fanout.py:1183-1188` (the selector's docstring: a held group is
    returned and spends no demand)
  - `aria-kernel/aria_kernel/judge_fanout.py:1213-1225` (a true_positive pair with a hold skips the
    new_pairs check and is appended)
  - `aria-kernel/aria_kernel/stability_reask.py:144-152` (stability_candidates docstring: without
    demand only false-positive pairs are returned)
  - `aria-kernel/aria_kernel/stability_reask.py:155-165` (every returned group becomes a stability
    candidate with its seats)
  - `aria-kernel/aria_kernel/stability_reask.py:224-236` (the budget counts minted re-asks, not
    candidates, so earlier candidates spend it first)
- Rule: The stability lane's own contract (stability_reask.py:147-152): true_positive pairs are
  examined only up to the demand it passes; a candidate the arbiter arms refuse as held is not a
  pair the lane is meant to spend a re-ask on.
- Failure scenario: A true_positive pair whose seats judged different trees is held, so it can never
  reach an arbiter or an anchor, yet with demand 0 (or after the demand is used up) it is still
  returned to the stability lane, which re-mints both of its seats under stability groups and
  decrements the budget. In group-key order such pairs come ahead of later unanimous pairs, so
  stability_budget is spent on pairs that cannot anchor and the docstring that documents the
  selector's behaviour is false.
- Close condition: Exclude pairs whose group carries a hold from stability_candidates (or give
  anchor_candidate_groups an include_held argument only the dispatcher sets), correct the docstring,
  and pin with a test that stability_candidates(demand=0) over a held true_positive pair returns no
  true_positive pair.

### ARIA-LOW-1147

The new policy key anchor_tp_pairs_per_tool_per_cycle is converted with int() in the cycle under an
except GovernanceError, and judgment_pipeline_policy merges operator override values with no type
check, so a null or non-numeric override raises TypeError or ValueError out of the judgment pipeline
phase instead of a named blocked step.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-23.
- Raised by: the review notes of the JFT package, verified at origin/main ae2958653d; registered by
  the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `aria-kernel/aria_kernel/cycle.py:2216-2224` (int(pipeline_policy[...]) inside a try that
    catches GovernanceError only)
  - `aria-kernel/aria_kernel/judge_fanout.py:1267-1268` (the dispatcher's own default read converts
    the same value with int())
  - `aria-kernel/aria_kernel/genesis_policy.py:233-251` (judgment_pipeline_policy copies override
    sub-keys with no validation)
  - `aria-kernel/aria_kernel/cycle.py:2027-2029` (neighbouring keys are read with 'or `<default>`')
  - `aria-kernel/aria_kernel/genesis_policy.py:363-385` (executor_policy validates and raises
    GovernanceError naming the field)
- Rule: Policy accessors are parsed strictly and refuse a bad value by name (executor_policy,
  circuit_breaker_policy); a value the accessor lets through must not be able to crash the phase
  that reads it.
- Failure scenario: A repo override {"judgment_pipeline": {"anchor_tp_pairs_per_tool_per_cycle":
  null}} (or "five") reaches int(None) at cycle.py:2220: a TypeError, not a GovernanceError, so the
  per-tool containment does not catch it and the judgment pipeline phase raises for every tool of
  the cycle instead of recording a blocked 'anchoring' step. The override file is operator-owned, so
  the trigger is an operator typo, but it fails the whole phase every cycle until fixed.
- Close condition: Validate anchor_tp_pairs_per_tool_per_cycle (and the other judgment_pipeline
  keys) in judgment_pipeline_policy as a non-negative int and raise GovernanceError naming the key;
  test that null, a string and -1 overrides each raise GovernanceError and that the cycle records a
  blocked anchoring step.

## Source A4: session items from the 53-finding review (sampler, adapters, HR, sensor)

4 findings.

### ARIA-MEDIUM-1148

The judgment sample item drops the adapter finding's confidence, actionability and review_reason, so
the stratified_by_uncertainty ranking the cycle uses reads the default confidence 1.0 for every item
and a finding that declares itself review_required at 0.55 ranks and costs a judge slot exactly like
an actionable 0.9 one.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-12-09.
- Raised by: the lead session and the second-session review of 53 security findings, verified at
  origin/main ae2958653d; registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `aria-kernel/aria_kernel/feedback_store.py:1940-1951` (`_sample_item_from_finding` keeps
    tool_id, run_id, rule, severity, path, message, evidence and the fingerprint; the adapter's
    confidence, actionability and review_reason are not copied)
  - `aria-kernel/aria_kernel/feedback_store.py:1896` (the candidates the sampler ranks are these
    items, not the adapter findings)
  - `aria-kernel/aria_kernel/feedback_store.py:2066-2075` (`_finding_uncertainty` reads
    finding.get("confidence", 1.0), which is always the default for a sampler item, so the term can
    never move a rank)
  - `aria-kernel/aria_kernel/cycle.py:2107-2113` (production samples with strategy
    stratified_by_uncertainty)
  - `tools/aria-adapters/tenant-scoping-adapter.ts:327-333` (declares confidence 0.55, actionability
    review_required and review_reason seed_or_bootstrap_context, or 0.9 and actionable)
  - `tools/aria-adapters/tenant-scoping-adapter.ts:358-359` (the unscoped-read rule declares 0.82
    and actionable)
  - `tools/aria-adapters/security-boundary-adapter.ts:50-58` (AdapterFinding declares neither field,
    so no security-boundary row can ever carry the signal)
- Rule: Single owner of what a sampled finding is: the sample item is the one shape every downstream
  reader (ranking, tier-0, judge fan-out) sees, so a fact the producer declares and the ranking
  function reads must survive the item builder; a read that can only see its default is a dead term
  (PLAN-v2 section 1.2, one owner per fact).
- Failure scenario: Probe at ae2958653d: for the adapter finding {severity high, confidence 0.55,
  actionability review_required} `_finding_uncertainty` scores 0.57, but for the sampler item built
  from it from `_sample_item_from_finding` it scores 0.12, identical to the item built from the same
  finding at confidence 0.9. The ranking therefore cannot prefer or demote findings by the adapter's
  own confidence, and actionability and review_reason are read by no module of the funnel (tier0,
  judgment_funnel, finding_promotion, feedback_store, judge_fanout), so a self-declared
  review_required finding spends one of sample_size_per_tool slots like an actionable one.
  security-boundary rows can never carry the signal at all because its finding type has no such
  fields.
- Close condition: Carry confidence, actionability and review_reason through
  `_sample_item_from_finding` and decide in the one ranking function what a review_required or
  low-confidence finding costs, with a test that two items differing only in confidence or
  actionability rank differently; declare the two fields once for every adapter finding type (or
  state per rule that none exists).

### HR-MEDIUM-074

LeaveResolver.createLeaveRequest carries only @AuditLog while its self-service peers submit, cancel
and update carry @UseGuards(RolesGuard, MobileFeatureGuard), @ModuleUserOrHigher() and
@RequiresMobileFeature('leave'), so the per-user 'leave' mobile entitlement (SEC-HIGH-052) is not
enforced server-side on creation and the explicit role contract is missing.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-12-09.
- Raised by: the lead session and the second-session review of 53 security findings, verified at
  origin/main ae2958653d; registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `apps/hr-service/src/leave/leave.resolver.ts:485-491` (createLeaveRequest: @Mutation and
    @AuditLog only)
  - `apps/hr-service/src/leave/leave.resolver.ts:531-537` (submitLeaveRequest: RolesGuard,
    MobileFeatureGuard, ModuleUserOrHigher, RequiresMobileFeature('leave'))
  - `apps/hr-service/src/leave/leave.resolver.ts:600-604` (cancelLeaveRequest carries the same set)
  - `apps/hr-service/src/leave/leave.resolver.ts:626-629` (updateLeaveRequest carries the same set)
  - `apps/hr-service/src/leave/leave.resolver.ts:100-102` (the class carries GqlAuthGuard only)
  - `apps/hr-service/src/leave/leave.resolver.ts:526-530` (the submit comment says the contract
    matches createLeaveRequest, which it does not)
  - `libs/backend-common/src/guards/mobile-feature.guard.ts:64-67` (a route with no
    @RequiresMobileFeature metadata makes the guard a no-op)
  - `libs/backend-common/src/guards/roles.guard.ts:122-127` (a handler with no required roles admits
    any authenticated user)
- Rule: SEC-HIGH-052 (RESOLVED): the 'leave' mobile entitlement must be enforced server-side on
  every leave mutation, not only in the client; and the peer-boundary rule
  authz_boundary_missing_among_peers of the security-boundary adapter.
- Failure scenario: A tenant member whose auth.mobile_user_settings.allowedFeatures does not include
  'leave' (an admin switched the feature off) calls createLeaveRequest with a crafted GraphQL
  request: no MobileFeatureGuard runs and the global RolesGuard admits any authenticated user, so
  the request is created, while submit, cancel and update refuse the same user. The body check
  limits it to the caller's own employee record, so the reach is narrower than the cross-employee
  case, but it is exactly the client-only-flag bypass SEC-HIGH-052 closed for the other three
  mutations.
- Close condition: Add @UseGuards(RolesGuard, MobileFeatureGuard), @ModuleUserOrHigher() and
  @RequiresMobileFeature('leave') to createLeaveRequest and add a resolver spec that reads ROLES_KEY
  and MOBILE_FEATURE_KEY metadata for all four self-service mutations; the security-boundary adapter
  hit on createLeaveRequest then disappears.

### SENSOR-LOW-205

removeLoRaDevice and sendLoRaDownlink take edgeDeviceId from the caller and use it as the MQTT
target without comparing it with the LoRa device's stored edgeDeviceId, so within one tenant the
update_lora_devices push or the lora_downlink command goes to a gateway that does not own the device
and the real parent is never told.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-23.
- Raised by: the lead session and the second-session review of 53 security findings, verified at
  origin/main ae2958653d; registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `apps/sensor-service/src/edge-device/edge-device.service.ts:2367-2385` (removeLoRaDevice finds
    the device by {id, tenantId}, deletes it, then pushes to deviceRepository.findOne({where: {id:
    edgeDeviceId}}) with the caller's id)
  - `apps/sensor-service/src/edge-device/edge-device.service.ts:2444-2475` (sendLoRaDownlink finds
    the LoRa device by {id, tenantId} and the gateway by the caller's edgeDeviceId, with no parent
    comparison)
  - `apps/sensor-service/src/edge-device/edge-device.service.ts:2491-2501` (lora_downlink is
    published to the caller-chosen gateway's command topic)
  - `apps/sensor-service/src/edge-device/edge-device.service.ts:2322-2323` (addLoRaDevice validates
    the edge device with findByIdOrFail and stores it as the parent, so its push at 2355 targets the
    real parent and is not affected)
  - `apps/sensor-service/src/edge-device/edge-device.resolver.ts:518-527` (removeLoRaDevice exposes
    both ids as arguments)
  - `apps/sensor-service/src/edge-device/edge-device.resolver.ts:535-553` (sendLoRaDownlink exposes
    both ids as arguments)
- Rule: A relation must be derived from the stored parent, not trusted from a caller-supplied
  duplicate of it (the LoRa device row already carries edgeDeviceId).
- Failure scenario: In one tenant with gateways E1 and E2 and LoRa device L1 on E1, a TENANT_ADMIN
  or MODULE_MANAGER request removeLoRaDevice(edgeDeviceId: E2, loraDeviceId: L1) deletes L1,
  rebuilds and pushes E2's own LoRa list to E2, and never pushes to E1, whose agent keeps L1
  provisioned until some later push; sendLoRaDownlink(E2, L1) publishes the downlink with L1's
  devAddr to E2's command topic. It is not cross-tenant (both tables are per-tenant and routed by
  search_path) and the UI sends the right pair, so it needs a crafted or stale request.
- Close condition: Take the push and publish target from device.edgeDeviceId (the stored parent) in
  removeLoRaDevice and sendLoRaDownlink and refuse a supplied edgeDeviceId that differs; tests:
  removing L1 with E2 throws and publishes nothing, removing it with E1 pushes to E1, and
  sendLoRaDownlink(E2, L1) returns an error without a publish.

### ARIA-LOW-1149

Both adapters scan non-spec helper and fixture files under **tests** as product code, and only one
emit site (the tenant-scoping raw-query rule) demotes a seed, bootstrap or fixture context, so a
deliberately bare route in a test fixture is reported at full severity every night and the
includeExcludedDir hook that is meant to express the choice has no effect.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-23.
- Raised by: the lead session and the second-session review of 53 security findings, verified at
  origin/main ae2958653d; registered by the REG-WAVE findings clerk; non-blocking at merge.
- Verified at origin/main ae2958653d.
- Evidence:
  - `tools/aria-adapters/tenant-scoping-adapter.ts:729-739` (collectTypeScriptFiles passes
    includeExcludedDir for **tests** and excludes only .spec.ts, .test.ts and .d.ts files)
  - `tools/aria-adapters/security-boundary-adapter.ts:713-723` (a second copy of the same options
    and the same isTestFile)
  - `tools/aria-adapters/adapter-fs.ts:24-35` (**tests** is not in ADAPTER_EXCLUDED_DIRS)
  - `tools/aria-adapters/adapter-fs.ts:250-253` (includeExcludedDir is consulted only for a
    directory that is in the excluded set, so the **tests** option never does anything)
  - `tools/aria-adapters/tenant-scoping-adapter.ts:378-383` (isSeedOrBootstrapContext: the only
    demotion, matching seed, bootstrap or fixture in the path or the first 4000 characters)
  - `tools/aria-adapters/tenant-scoping-adapter.ts:327-333` (the demotion is applied to the
    raw-query rule only; the unscoped-read rule at 343-366 always emits actionable)
  - `tools/aria-adapters/security-boundary-adapter.ts:284-311` (mutation_missing_role_boundary and
    controller_missing_guard_boundary have no test or fixture context at all)
  - `libs/backend-common/src/guards/__tests__/access-context.fixture.ts:97-107` (a fixture route
    with @Mutation and an @Access decorator only, the shape the rules flag)
- Rule: One predicate for 'this is test, seed or fixture code' shared by the adapters, so a finding
  about it is demoted or excluded in one place (PLAN-v2 section 1.2 one owner); a detector must not
  report a fixture's intentionally bare route as an actionable product defect.
- Failure scenario: access-context.fixture.ts declares routes with a single @Access decorator on
  purpose to test the guard. The security-boundary adapter walks it (it is under **tests** and does
  not end in .spec.ts) and emits mutation_missing_role_boundary and
  controller_missing_guard_boundary rows for it on every run; those rows carry no confidence or
  actionability, so they cannot be told from product findings. In the 53-row sample read by the lead
  7 rows came from this one file, while the 3 rows from a seed service were already demoted by the
  raw-query rule's own review_reason: the cost is sampler slots and judge calls spent on rows the
  adapter could have marked or skipped.
- Close condition: Move the test, seed and fixture-path predicate into adapter-fs.ts as one function
  used by every adapter, apply it to all emit sites (exclude, or emit review_required with a
  review_reason), and delete the no-op includeExcludedDir options; adapter tests that a fixture file
  under **tests** yields no actionable finding for any rule.

## Notes the clerk did not register

- Notes examined and not registered: 57 (style or process notes 30, duplicates of existing rows 18,
  notes the code does not support 7, already fixed 2). Each is recorded with its reason in the
  verifiers' result files.
- Duplicates of existing rows, whose root cause and close condition are the row's: ARIA-HIGH-963,
  ARIA-HIGH-964, ARIA-LOW-646, ARIA-LOW-950, ARIA-LOW-967, ARIA-LOW-968, ARIA-LOW-969, ARIA-LOW-970,
  ARIA-LOW-971, ARIA-LOW-972, ARIA-LOW-973, ARIA-MEDIUM-1046, ARIA-MEDIUM-1047, ARIA-MEDIUM-751,
  ARIA-MEDIUM-881, ARIA-MEDIUM-965, ARIA-MEDIUM-966, ARIA-MEDIUM-993. The D6 review points were
  already registered as ARIA-HIGH-963 and ARIA-HIGH-964, ARIA-MEDIUM-965 and ARIA-MEDIUM-966,
  ARIA-LOW-967 to ARIA-LOW-973 and the D6 security rows 993 to 999.
- The stale suite shard weights (a 30-minute shard cap overrun in CI run 40630521860, and a pass at
  1782 s of 1800 s in run 40641014171) are already owned by ARIA-LOW-646, whose rule names the
  automatic refresh and the fail-loudly option; the K1 commits 987515920 and 08fd5358c refresh the
  weights file from the slowest of three runs but add neither. The CI evidence is recorded here for
  that row.
- ARIA-MEDIUM-1046 plans to allowlist the hit on apps/hr-service/src/leave/leave.resolver.ts as
  intentional; the HR finding registered in this file shows the mutation lacks the entitlement guard
  its peers carry, so that hit is a true positive and must stay out of the allowlist.
