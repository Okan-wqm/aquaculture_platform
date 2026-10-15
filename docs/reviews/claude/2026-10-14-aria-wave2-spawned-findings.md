# 2026-10-14 — ARIA wave 2: findings spawned by the Z.ai takeover adjudication

**Owner agent:** claude · **Cycle:** 2026-10-14-aria-wave2-spawned-findings · **Branch:**
`fix/aria-zai-quality-port`

## Why this document exists

On 2026-10-13 the operator handed Z.ai's ARIA quality audit to Claude. Wave 1 re-validated its 219
findings on origin/main 99689e46b, fixed the valid ones on this branch and registered them as
ARIA-LOW-449 to ARIA-HIGH-501
([2026-10-13-aria-quality-audit-port.md](../zcode/2026-10-13-aria-quality-audit-port.md)). Wave 2
adjudicated what wave 1 left open: the recorded stubs, the registry rows they touch, and the
defects its own critics and blind-spot audits found. Its plan groups the fixes into buckets that
land through a sequence of landing PRs (L1, L2, and so on).

A fix commit can close only a registered finding, and its `Closes:` trailer must cite the review
file of that finding's own registry row. Every row the wave-3 registry steps mint therefore uses
this file as its `review_file`. Each minted ID has a section below with the problem and the planned
fix; the landing commit appends what landed. Amendments to existing rows that no governed registry
verb can record are listed at the end.

## Findings

### ARIA-HIGH-502 — `require_lifecycle_state` waiver lapses before its control is wired

- **Wave-2 key:** ORPHAN-HIGH-573-waivers (a deadline item; ORPHAN-HIGH-573 itself is RESOLVED).
- **Problem:** origin/main carries four control-reachability dormancy waivers that expire on
  2026-10-20, so every kernel lane on main goes red from 2026-10-21 UTC. The repair stack removes
  three. `require_lifecycle_state` (`genesis_lifecycle.py:417`) still has no production caller,
  and `shadow_eval_bridge.py` appends the eval and governance rows (`:244`) before the lifecycle
  precondition it promises to check first (`:137-138`; checked only at `:298`).
- **Planned fix:** bucket `G013-573-waivers` (landing L1) calls `require_lifecycle_state` in the
  bridge after the target agent is resolved and before `run_agent_eval`, with the entry states
  derived from `ALLOWED_TRANSITIONS`, and deletes the waiver. Deadline: 2026-10-20.
- **Landed (L1):** the bridge calls `require_lifecycle_state` with `_BRIDGE_ENTRY_STATES` (derived
  from `ALLOWED_TRANSITIONS`, today `{DRAFT}`) before `run_agent_eval`, and
  `control-reachability.dormant.json` is `{}`. `test_shadow_eval_bridge.py` proves a refused
  bridge (target at SHADOW, or with no genesis chain) leaves every `*.jsonl` byte-identical (red
  before the fix); `test_control_reachability` holds the call as the production caller, and the
  `test_deadlines.py` waiver pin now runs over the live manifest plus a synthetic two-entry one.
  The pre-write guarantee holds for one bridge run per agent at a time (no lock spans the check,
  the eval and the transitions; `record_transition` still re-validates).

### PROC-LOW-049 — committed conflict markers in a gated document, and no gate refuses them

- **Wave-2 key:** SYN-conflict-markers (wave-2 critic).
- **Problem:** the debt-closure plan's `finding-truth-table.md:251-253` on origin/main holds
  `<<<<<<< HEAD`, `=======` and `>>>>>>> 291d2adb8` with both sides empty, in a document that
  `debt-plan-truth` parses. Nothing in the repository refuses a committed conflict marker.
- **Planned fix:** bucket `SYN-conflict-marker-gate` (landing L1) deletes the three lines and adds
  `tests/invariants/no-committed-conflict-markers.spec.ts`, which fails on any tracked text line
  that starts with seven `<` or seven `>` characters and a space.
- **Landed (L1):** the three marker lines are deleted (both sides were empty; the theirs-side rows
  had already been retired as RESOLVED). `no-committed-conflict-markers.spec.ts` (layer 1, run by
  `invariants:fast` on every PR) `git grep`s tracked text for `^(<{7,}|>{7,})( |$)`, which also
  covers a widened `conflict-marker-size` and unlabelled markers. It was red on the old tree, and
  its detector tests use markers written by `git merge-file` itself.

### PROC-LOW-050 — the hermetic fixture-git environment has no shared owner

- **Raised by:** the `SYN-conflict-marker-gate` implementer and its reviewer (landing L1).
- **Problem:** specs that build a throwaway git repository each keep a private copy of the
  hermetic environment (drop inherited `GIT_*`, `GIT_CONFIG_GLOBAL=/dev/null`,
  `GIT_CONFIG_NOSYSTEM=1`): `no-committed-conflict-markers.spec.ts`,
  `aria-doc-runtime-ssot.spec.ts`, `backup-restore-verification-contract.spec.ts`,
  `derived-merge-pins.spec.ts`, `aria-authority-hash.spec.ts`, `banned-phrase.spec.ts`,
  `format-scope-derived.spec.ts`, and `finding-registry.ts` (`HERMETIC_GIT_ENV`, not exported).
  The copies differ: `aria-doc-runtime-ssot.spec.ts:816-819` keeps inherited `GIT_DIR` and
  `GIT_INDEX_FILE`, so a run from a git hook can point its fixture git at the real repository.
- **Planned fix:** one exported owner under `tools/gates` that every spec and `finding-registry.ts`
  import, and a tier-3 check that no spec builds its own copy. Deadline: 2027-04-12.

### ORPHAN-MEDIUM-840 — observability-service never runs its security-events consumer

- **Wave-2 key:** R7-011 (design G020 N3; minted at the registry step before wave 1).
- **Problem:** `SecurityEventsModule` subscribes `events.security.events.>`
  (`security-events-consumer.service.ts:30`), but no module imports it (`app.module.ts:38`), so the
  observability security counters and structured logs are never produced. admin-api-service still
  stores the events.
- **Planned fix:** a product-lane PR (wave-2 operator question Q26 decides the branch) imports the
  module in `AppModule` and adds a tier-3 invariant that every `apps/<svc>/src/**/*.module.ts` is
  reachable from its service's `AppModule`.

### PROC-MEDIUM-051 — a closure rejection holds against one SHA, not a squash or rebase

- **Raised by:** the security review of landing L1's closure commits, on the rejection of `3ff275a5f`.
- **Problem:** `rejected_closing_commits` holds SHAs, and `shaMatches`
  (`finding-traceability.ts:51-55`) compares nothing else. A squash or rebase of a rejected change
  makes a new commit whose message still carries the rejected `Closes:` trailer, and `close` and
  `reconcile` accept it. Reproduced on a scratch copy of the L1 tip: a merge of `3ff275a5f` leaves
  ARIA-CRITICAL-215 OPEN; the same message under a new SHA resolves it.
- **Planned fix:** bind a rejection to what a squash or rebase preserves (the finding plus the
  change's patch-id or pull request), with a test that re-commits a rejected message under a new
  SHA. Until then PR #1743 is closed at L1's push gate, not drafted. Deadline: 2027-01-13.

### PROC-MEDIUM-052 — the commit-msg gate admits an ORPHAN trailer that cannot close its row

- **Raised by:** the implementer of landing L1's closure commits.
- **Problem:** for an `ORPHAN-` id the gate checks only that the id exists
  (`commit-msg-validator.ts:704-712`); the anchor-to-`review_file` binding at `:720` runs only for
  other ids. A trailer citing the wrong review file therefore passes the gate and never closes the
  row: 8a86ee392 and 57067433c merged such trailers for ORPHAN-HIGH-556 and ORPHAN-MEDIUM-562.
- **Planned fix:** every `ORPHAN-` id with a registry row goes through
  `commitMessageClosesFindingExactly`, with a negative test. Deadline: 2027-01-13.

### ARIA-LOW-503 — the pre-intent credential refusal of `pr create` is unpinned

- **Raised by:** the implementer of landing L1's closure commits.
- **Problem:** `pr_manager.py:812` refuses a create without an installation token before
  `record_intent` writes the `pr_create` intent, and nothing pins that order: with the line removed
  every test stays green, and a refused create leaves an unresolved intent (the write itself is
  still refused by `run_gh_write`).
- **Planned fix:** the refused-create test also asserts that no `pr_create` intent row exists.
  Deadline: 2027-04-13.

### ARIA-LOW-504 — `circuit_breaker.__all__` exports a deleted function

- **Raised by:** the implementer of landing L1's closure commits.
- **Problem:** `circuit_breaker.__all__` (`:697`) still lists `assert_within_breaker`, deleted on
  2026-09-09 (`:673-684`), so `from aria_kernel.circuit_breaker import *` raises
  `AttributeError`.
- **Planned fix:** drop the name, and a kernel-wide test that every module's `__all__` resolves.
  Deadline: 2027-04-13.

### ARIA-HIGH-505 — the Bash gate verifies an argv bash never runs

- **Wave-2 key:** NEW-bashexp-1 (minted at the L1 registry step: the L1 truth table names it as
  the class ARIA-CRITICAL-446 does not cover).
- **Problem:** `argv_of` (`command_policy.py:189-201`) lexes with `shlex.split`, which expands
  nothing, and the one scanner (`:141-186`) treats braces, `$name`, globs and `~` as word
  characters. So `git commit -m {x,--amend}` and `git commit -m x$IFS-n` pass the gate, and bash
  runs `git commit -m x --amend` and `-m x -n`, options the gate refuses when spelled out.
- **Planned fix:** the one scanner admits only lines whose shlex argv is bash's, proven by a
  bash-truth differential test; it lands with ARIA-HIGH-443's fix. Deadline: 2026-10-21.

### ARIA-LOW-506 — each watchdog freeze layer is pinned only together with the other

- **Raised by:** the test review of landing L1's closure commits, on ORPHAN-MEDIUM-562's closure.
- **Problem:** the freeze has two layers, the merge runner's in-loop check
  (`auto_merge_runners.py:227-245`) and `merge_pr_if_ready`'s own refusal (`merge_authority.py:91`).
  Removing either alone leaves `test_watchdog_freeze.py` green; only removing both turns it red. The
  direct-call refusal is pinned by a source-text check (`:209-215`).
- **Planned fix:** a test that calls `merge_pr_if_ready` with an open incident and expects
  `merge_frozen_watchdog_incident_open` and no merge, and a runner test whose merge authority does
  not refuse. Deadline: 2027-04-13.

### ARIA-MEDIUM-507 — skill genesis has no working path

- **Raised by:** landing L1's completeness critic, as a lost residual. Wave-2 r10 mapped B04-R01,
  B04-D10 and B09-D10 (the 2026-09-25 full-read review) onto ARIA-HIGH-470. L1's merge resolves
  470 from wave-1 `994091b2f`, which fixes only the evidence-grounded gate, corpus sanity and the
  drainer flag. No design, bucket or open row owned the rest.
- **Problem:** `select_drafter` and `select_judge` (`dispatcher_factory.py:165-177, 232-243`) take
  the store from `evidence_pack.get("_base_dir")`. `EvidencePack` (`evidence_collector.py:82-98`)
  has no such key, and nothing writes one. `accepted_response` (`:363`) returns `None` when
  `base_dir` is `None`, so every drafter and judge call polls its full 600 s inside the cycle and
  returns the `dispatchers_unavailable` fallback. A delivered draft is never read. Reproduced on the
  L1 tree: without the key, the store reader ran 0 times in a 0.4 s poll; with it, 4 times. Also,
  `skill_genesis_drainer.py:199-201` skips every non-convergent row. `learning.py:439` emits only
  non-convergent rows, and `existing_genesis_request_keys` (`agent_genesis.py:1093`) blocks a
  second request for the same gap, so a skill gap never closes. All 20 live rows are
  non-convergent, so no poll runs in production yet. Once one convergent request is queued, each
  authoring blocks the cycle; from then on, treat this finding as HIGH.
- **Planned fix:** the dispatchers take the drainer's `base_dir` as a required argument
  (`autonomy_orchestrator.py:1988-1991` passes `root`), and the evidence-pack key goes. A test
  submits an accepted result for the minted request and reads it back as the draft. Then either
  drain non-convergent requests, or route `skill_gap`/`unobserved_surface` to a seeded convergent
  request, or stop emitting them. A test shows that a request the router emits reaches a consumer.
  Deadline: 2027-01-13.

### ARIA-MEDIUM-508 — a missing repo-local ts-node is priced as a banned-phrase-adapter crash

- **Raised by:** landing L1's completeness critic (ARIA-works check 3c). The defect is already on
  origin/main 99689e46b. No bucket or registry row covered it.
- **Problem:** `banned-phrase-adapter` runs as `python3 banned_phrase_adapter.py` and spawns
  `./node_modules/.bin/ts-node` (`banned_phrase_adapter.py:38`). When that file is absent, the
  adapter writes status `unavailable` and exits 127 (`:64-65, 185-202`). The runner's
  missing-dependency guard, `_runner_missing_node_deps` (`tool_runner.py:741-744`), matches only
  the argv `node ./node_modules/ts-node/dist/bin.js`, which the registry builds from `npx ts-node`
  (`tool_registry.py:963-964`). Any other non-zero exit becomes status `crash` (`:181-182`), and
  the runner does not parse stdout, so the adapter's own `unavailable` is lost. A crash rate above
  0.2 over 10 runs moves the tool to CALIBRATE (`tool_health.py:268-299, 395-396`). The tool
  returns to SHADOW only after a fixture suite passes (`promotion.py:35`). The fixture-contract skip
  (`test_adapter_fixture_evidence_contract.py:66-78`) uses the same predicate. This is the class
  of fault that quarantined six adapters on 2026-08-10, and it is still open for this runner.
  Reproduced on the L1 tree: in a workspace without `node_modules`, ten bwrap runs of the shipped
  manifest each ended `crash` with exit 127 and empty stderr, and the tenth health decision was
  `calibrate` (crash rate 1.0). The nightly lane provisions `node_modules`, so the fault does not
  fire there. It fires wherever `run_tool` reaches a workspace without repo-local ts-node.
- **Planned fix:** the manifest's runner declares its repo-local node dependency. `tool_registry`
  validates that field and derives it for normalised `npx ts-node` runners. `tool_runner` and the
  fixture-contract skip read that one field, and the argv match is deleted. A test runs this
  adapter in a workspace without `node_modules` and expects `environment_unavailable` and no
  `calibrate` decision; today it fails. Deadline: 2027-01-13.

### ARIA-LOW-509 — the smoke runbook's mock switch is a name no code reads

- **Raised by:** landing L1's completeness critic (ARIA-works check 4c). The defect is already on
  origin/main 99689e46b. The wave-2 adjudication B01-R12 judged only the workflow copy and left
  the runbook copy without an owner.
- **Problem:** the v3.1 smoke runbook says `CLAUDE_CODE_MOCK=true` sends the LLM calls of its
  dry-run `autonomy run` through the mock path (`aria-v3-1-smoke.md:84-89`). No code reads that
  name. The mock switch is `CLAUDE_CLI_MOCK`, and it defaults to `'0'`
  (`claude_runtime.py:42, 293-294`), so an unset switch means live mode. `autonomy run` drains
  planner requests through `ci_executor.py` as a subprocess that inherits the environment
  (`autonomy_orchestrator.py:1110-1113`, `planner_dispatch_hook.py:554-594`). The executor takes
  its mock decision only from `is_mock_mode` (`ci_executor.py:1420-1421`). `ARIA_DRY_RUN` gates the
  GitHub adapter and token minting, not a Claude spawn. So the documented smoke sends every claimed
  planner request to the live `claude` binary. Only `unshare --net` keeps it offline. If that is
  dropped, the smoke spends real quota, and the F-5 acceptance still reads the results as mocked
  (`:129-130`). The wrong name also appears in two docstrings (`planner_dispatch_hook.py:374`,
  `cost_budget.py:3`), in `aria-operational-proof.yml:100` (harmless there, because observe
  burn-in makes no LLM calls; B01-R12 INVALID) and in a comment at `aria-auto-cycle.yml:999`.
- **Planned fix:** the runbook, the operational-proof workflow (or the line is deleted), both
  docstrings and the auto-cycle comment use `CLAUDE_CLI_MOCK`, so there is one spelling. An
  invariant test collects every `*_MOCK` name assigned in a workflow `env:` block or a runbook
  command line and fails unless code reads it or it is a shell local of the same step. The test is
  red on `CLAUDE_CODE_MOCK` today. Deadline: 2027-04-13.

### ARIA-LOW-510 — the kernel workflow reads a dispatch input it never declares

- **Raised by:** landing L1's completeness critic (ARIA-works check 4d). The defect is already on
  origin/main 99689e46b (`aria-kernel.yml` lines 16 and 406 are identical there).
- **Problem:** the state-compaction gate in `aria-kernel.yml` sets
  `RETAIN_DAYS: ${{ github.event.inputs.retain_days || '7' }}` and passes it to
  `state compact --retain-days` (`:403-414`). The workflow's `workflow_dispatch` (`:16`) declares
  no inputs, and `pull_request` and `push` carry none. The expression therefore always yields
  `'7'`. The step looks as if it offers a retention window, but none exists. GitHub's dispatch API
  also refuses a run that passes `retain_days`, because the input is unexpected. The gate copies
  the step from `aria-state-maintenance.yml` (`:152`), which does declare `retain_days` with
  default `'7'` (`:63-67`). The gate's verdict is not wrong today: it compacts at the maintenance
  lane's default window. No test checks that a workflow declares the inputs it reads.
  `aria-workflow-input-injection.spec.ts` checks only that inputs are not spliced into `run:`. A
  scan of every workflow on the L1 tree finds no other undeclared read; the other matches are
  comments.
- **Planned fix:** `test_state_compaction_gate.py` pins the gate's steps to the maintenance
  lane's, `env` included, byte for byte (`:15, 41, 68`). So the read stays, and `aria-kernel.yml`
  declares `retain_days` under `workflow_dispatch` with the maintenance lane's description and
  default. A tier-3 invariant next to the injection spec, using its expression matcher (not a
  second copy), parses every workflow. It fails when an `inputs.X`, `inputs['X']` or
  `github.event.inputs.X` read outside a comment names an input that the workflow's
  `workflow_dispatch` or `workflow_call` does not declare. The invariant is red on `retain_days`
  today. Later-stage buckets edit `aria-kernel.yml` and the injection spec, so the fix lands with
  one of those stages or after them. Deadline: 2027-04-13.

### ARIA-HIGH-511 — the enrolment walk judges history by today's namespace tuple

- **Wave-2 key:** R7-015 (register row; design R-G023-enrolment-walk).
- **Problem:** `parse_namespace_registry` (`operator_request_signature.py:228-250`) refuses any
  registry that lacks one of today's `OPERATOR_NAMESPACES`, and `_child` (`:305-313`) applies it to
  every historical row, the pinned genesis included. Once a namespace is added, the genesis no
  longer parses and every operator act fails closed for good.
- **Planned fix:** bucket `G023-254-sliceA` (landing L2): history parses require only
  `ENROL_NAMESPACE`; the tip check keeps the full tuple. Failing first: a namespace added by
  enrolment walks from the pinned genesis. Deadline: 2026-12-14.
- **Landed (L2):** `operator_request_signature.py` has one parser body behind two questions:
  `parse_namespace_registry` (the tip: every `OPERATOR_NAMESPACES` name, used by the anchor read and
  by `record_enrolment` for the child that becomes the tip) and `_walked_registry` (history: the
  enrol entry only, used by `_child` and the walk's parent parse).
  `test_a_namespace_added_by_enrolment_walks_from_the_pinned_genesis` was red before
  (`enrol_genesis_mismatch`) and is green after; the tip and new-child pins hold on both sides. The
  public `verify_enrolment_chain` no longer applies the tip rule by itself (its one production
  caller, `_anchor_at`, parses the tip first); that note goes to the slice-B owner.

### ARIA-MEDIUM-512 — operator authorizations are not bound to their subject

- **Wave-2 key:** NEW-ACKBIND-1 (remediation remed-10).
- **Problem:** `consume_token` (`ack_ledger.py:404-474`) never compares the minted draft, intent or
  target with the materialization, `agent_genesis` consumes the token before its escape and
  model-tier refusals (`:762-784`), and a C4-a approval without `target_agent` matches any agent
  (`shadow_eval_bridge.py:254-255`).
- **Planned fix:** `G023-254-sliceA` (L2) binds the ack scope (Part of); `R10-ack-subject` (wave 17)
  makes `consume_token` take the subject, runs every refusal before consumption and requires
  `target_agent`, and closes it. Deadline: 2027-01-13.
- **Part landed (L2, `G023-254-sliceA`):** an ack row carries `AckScope` (draft id, intent, target,
  kind, `body_sha256` of the draft body, HMAC-signed), derived by the kernel from the draft
  (`ack_scope_for_draft`), never from the caller. `consume_token` takes the materialization's scope
  and refuses `ack_token_not_operator_signed`, `ack_token_scope_unbound` (a row minted before this
  change) and `ack_token_scope_mismatch:<field>` before it spends anything; an autonomous ack is minted
  and consumed in one transaction (`record_autonomous_ack`). `test_operator_ack_signature.py`: an ack
  for draft A no longer materializes draft B (agent and skill), nor a body re-drafted after the
  mint (red before, green after). Still open, for `R10-ack-subject`: consumption before the escape and
  model-tier refusals, the unscoped C4-a approval, and the window between the operator's review and
  `ack mint`, which binds the draft's latest body rather than the one the operator read.

### ARIA-LOW-513 — Plan 020 dispatch-rationale telemetry has no writer

- **Wave-2 key:** A12-4 (Z.ai ID; a wave-2 stub of the wave-1 review).
- **Problem:** `compose_dispatch_rationale` and `record_dispatch_rationale` (`cost_telemetry.py:62`,
  `:99`) are called only by tests, so `aria_dispatch_rationale_total` (`plan_016_metrics.py:197`) is
  always 0 and the `cost_telemetry` surface is never written. The native admission row already
  records why a route was taken.
- **Planned fix:** bucket `G026-443-A12-4` (landing L2) retires the module, the metric and the
  surface row and points Plan 020 Phase 13 at the admission row. Deadline: 2027-04-13.

### ARIA-LOW-514 — the Plan 016 reflection section swallows every exception

- **Wave-2 key:** R7-061 (register row; named by design G026 as not covered).
- **Problem:** `_render_plan016_section` (`reflection.py:1118-1123`) returns an empty section on any
  `Exception` from `compute_plan_016_metrics`, so a broken metric reads as no metric.
- **Planned fix:** tracked deferral (no wave-2 bucket): catch only the documented unreadable-store
  error and report it by name. Deadline: 2027-04-13.

### ARIA-HIGH-515 — a refused credential stays on the published outputs surface

- **Wave-2 key:** R7-005, the register key of NEW-SECRETPUB-1 (remediation remed-6).
- **Problem:** When the kernel refuses an envelope as `secret_in_envelope`
  (`agent_invocations.py:5566-5573`), it has already sealed the response (`:5014-5024`), and the
  executor's raw file stays at `expected_output_path` (`ci_executor.py:4408-4445`). Unreadable
  envelopes are never scanned (`:5661-5671`).
- **Planned fix:** bucket `R6-refused-output` (landing L2) withholds refused and unscannable output
  from every published surface. Deadline: 2026-10-31.

### ARIA-MEDIUM-516 — spine refresh runs adapters without their declared input

- **Wave-2 key:** R7-041 (register row; ARIA-HIGH-045 design, N2).
- **Problem:** `spine_orchestrator._run_one` (`:221-230`), the gateway scheduler and `tool run` omit
  the manifest `default_input` that only the cycle merges (`cycle.py:1368`), so tenant-scoping and
  security-boundary exit 1 in `requireScanRoots`. The refresh also trusts a pre-record status and
  names `schema-drift-adapter`, which has no manifest.
- **Planned fix:** bucket `G002-045-runs` (landing L3): one `default_input` merge in `run_tool`, the
  refresh judged by the recorded status, the adapter list derived from manifests. Deadline:
  2027-01-13.

### ARIA-LOW-517 — the prefixed sha256 digest has no single owner

- **Wave-2 key:** E11-4 (Z.ai ID; a wave-2 stub of the wave-1 review).
- **Problem:** 163 sites in 90 kernel modules compose `"sha256:" + ...` inline, about 15 private
  helpers re-implement it (four identical lease-token hashers, e.g. `agent_invocations.py:2497`,
  `worker_dispatch.py:500`), and 13 sites restate the validator `ledger.is_sha256_digest`
  (`ledger.py:248`) owns.
- **Planned fix:** `G006-digest-owner` (L3) adds `digest.py` as the one owner (Part of);
  `G006-digest-sites` and `G006-digest-codemod` (late chain) move every site and close it. Deadline:
  2027-04-13.

### ARIA-LOW-518 — the git object-id validator has 15 copies

- **Wave-2 key:** R7-002 (register row; named by design G006).
- **Problem:** 15 modules define their own git object-id pattern with different policies (40 hex
  only, 40 or 64, 40 plus an optional 24), e.g. `system_one.py:75`, `main_anchor.py:42`,
  `git_containment.py:255`. Under a SHA-256 object format a writer and a reader can disagree about
  the same id.
- **Planned fix:** tracked deferral to the first wave after the late codemods: one leaf module
  `git_object_id.py` with one format policy, called by every site. Deadline: 2027-04-13.

### ORPHAN-LOW-841 — two standalone Rust packages fail every cargo command

- **Wave-2 key:** R7-059 (register row; named by design G018 as not covered).
- **Problem:** `crates/protocol-codec/fuzz` and `sensorprotocols/wasm-decoder-template` carry no
  `[workspace]` table, so cargo attaches them to the root workspace, which does not list them, and
  refuses to load either. Reproduced with cargo 1.88 on HEAD.
- **Planned fix:** tracked deferral (product lane): an empty `[workspace]` table in each manifest.
  Deadline: 2027-04-13.

### ARIA-HIGH-519 — credential shapes have five owners and the boundary misses five families

- **Wave-2 key:** NEW-SECRETPUB-4 (remediation remed-6).
- **Problem:** The executor's publication boundary uses `secret_scrub._SECRET_PATTERNS` (`:36-52`)
  only, which misses five families the kernel's refusal set (`implementation_safety.py:273-290`)
  refuses; that set's header-only rows cannot redact. Three more tables restate credential shapes.
- **Planned fix:** bucket `R6-credential-shapes` (landing L3): one `CREDENTIAL_SHAPES` table with a
  detect and a redact pattern per family; every consumer derives its view. Deadline: 2026-10-31.

### ARIA-HIGH-520 — the closure policy's missing refs hide the Mode-A blocker

- **Wave-2 key:** A19-1 (Z.ai ID; a wave-2 stub of the wave-1 review).
- **Problem:** `_valid_operator_policy_shape` returns False for any absent regression ref
  (`autonomy_evidence.py:4111-4112`), and `_apply_operator_prerequisites` then returns early
  (`:4203-4212`) before the Mode-A check (`:4272-4277`). 17 refs are absent, so the operator is
  always shown `operator_prerequisite_policy_invalid`.
- **Planned fix:** `G003-A19-1-AB` (L4, Part of) reports unresolved refs as an engineering blocker
  and composes every blocker; `G003-A19-1-CD` (late) remaps the deleted ref and closes it. Deadline:
  2026-12-14.

### ARIA-HIGH-521 — the merge lane's own observed row blocks every perimeter

- **Wave-2 key:** merge-delivery-1 (blind-spot audit).
- **Problem:** `merge_pr_if_ready` appends an `observed` pr-lifecycle row with `change_id` None
  (`auto_merge.py:775`, `:579`), and the perimeter capture then reads that last row and refuses
  `pr_change_join_unavailable` (`merge_authority.py:1002-1005`). Every ARIA PR stops at
  `pre_merge_perimeter`.
- **Planned fix:** bucket `G003-md1-binding` (landing L4) binds the change from the row that carries
  it, with a test through the real capture after an observed row. Deadline: 2026-12-14.

### ARIA-MEDIUM-522 — pr_for_assignment reads pr-lifecycle unverified

- **Wave-2 key:** R7-043 (register row; named by design G003 as not covered).
- **Problem:** `worker_dispatch.pr_for_assignment` reads `pr-lifecycle.jsonl` with the unverified
  `load_jsonl` (`worker_dispatch.py:832`); its only caller is `worker_dispatch_hook.py:499`.
- **Planned fix:** tracked deferral: read through the verified ledger reader, or delete the reader
  if `G039-A10-1` removes its merge-path caller. Deadline: 2027-01-13.

### ARIA-HIGH-523 — runs.jsonl outgrows the publish cap and cycle publishes are refused

- **Wave-2 key:** NEW-remed3-runs-1 (remediation remed-3).
- **Problem:** Each run row inlines its full `read_paths` (`tool_runner.py:246`), which the run
  artifact already holds. Compaction strips it only after 7 days (`state_compact.py:110`,
  `:735-759`), and 7 days of rows exceed the 64 MiB cap, so `_bound_publish_surfaces` refuses the
  publish (live since 2026-10-13 20:34Z).
- **Planned fix:** bucket `R-NEW-runs-bound` (landing L4, or a standalone PR off main per operator
  Q1): rows keep a count, digest and sample; a lossless backfill slims old rows. Deadline:
  2026-12-14.

### ARIA-HIGH-524 — agent transcripts are published unscanned

- **Wave-2 key:** NEW-SECRETPUB-3 (remediation remed-6).
- **Problem:** The executor writes every transcript raw (`ci_executor.py:2402`, `:3294`, `:3441`,
  `ci_executor_judge_batch.py:505`), and the kernel checks only its hash before sealing it onto the
  published outputs surface (`agent_invocations.py:5352`, `:5112`). Tool output, file contents
  included, is published verbatim.
- **Planned fix:** bucket `R6-transcripts` (landing L4): `write_sanitized_text` at the executor
  boundary and the kernel's credential scan at submission. Deadline: 2026-10-31.

### ARIA-HIGH-525 — the spine's adapter invariants never measure production

- **Wave-2 key:** R7-040 (register row; ARIA-HIGH-045 design, N1).
- **Problem:** `_check_auth_security` and `_check_harness_security` read
  `workspace_root/aria-tools/runs.jsonl` (`architecture_spine_gate.py:269`, `:322`), a gitignored
  file production never writes, take the latest row of any status and ignore the run the refresh
  just produced (`:474-481`).
- **Planned fix:** bucket `G002-045-gate` (landing L5): the invariants read the refreshed run
  through the tools dir and compare location-free identities. Deadline: 2026-12-14.

### ARIA-MEDIUM-526 — the spine's event-contract producer reports every event missing

- **Wave-2 key:** R7-042 (register row; ARIA-HIGH-045 design, N3).
- **Problem:** `_check_event_contracts` (`architecture_spine_gate.py:167-206`) looks for
  `schemas/**/*.json` stems where the catalogs are `.schema.ts`, so 243 of 243 events are missing,
  and `detect_drift` (`:592-669`) treats totals as violations.
- **Planned fix:** bucket `G002-045-gate` (landing L5) deletes the wrong-set producers and compares
  identities only. Deadline: 2027-01-13.

### ARIA-HIGH-527 — quarantine publication follows agent-planted symlinks

- **Wave-2 key:** security-1 (blind-spot audit).
- **Problem:** After a managed spawn, `publish_quarantine` walks the agent-writable replica with
  link-following calls (`git_containment.py:758-764`, `:840`) and unlinks what it finds (`:729-731`,
  `:786-787`, `:871`). A link planted in the replica turns that into deleting the shared
  repository's objects, packs and branch refs.
- **Planned fix:** bucket `G008-security-1-2` (landing L5): a no-follow walk confined to the
  replica, objects imported through git, and a containment-probe case with a planted link. Deadline:
  2026-12-14.

### ARIA-HIGH-528 — the Codex sandbox shares the host network namespace

- **Wave-2 key:** R7-003 (register row; design G008, step 6).
- **Problem:** `_wrap_runtime_state_in_sandbox` (`implementation_safety.py:1413`) runs the Codex CLI
  with the host network files bound and no `--unshare-net` (`:1375-1385`). Both provider ladders end
  in `openai`, so any read-only role whose first rungs are cooled runs it.
- **Planned fix:** bucket `R7-codex-netns` (landing L6): the Codex spawn joins the managed
  egress-proxy netns and `"host"` leaves `SandboxNetwork`. Deadline: 2026-10-28.

### ARIA-HIGH-529 — unbound plans fail only at merge

- **Wave-2 key:** R7-007 (register row; design R-G015-unbound-start).
- **Problem:** Plans started by `plan start`, skill authoring or the V7 fallback carry no
  `synthesis_bound` row, and only the merge gate (`implementation_safety.py:2402-2428`) asks for it.
  The implementation mint (`cross_review_bridge.py:1004`) does not, so planning, implementation and
  the panel are spent on a plan that cannot merge.
- **Planned fix:** bucket `R7-unbound-start` (wave 15): the merge-class implementation mint refuses
  an unbound plan by name before it spends anything. Deadline: 2026-12-14.

### ORPHAN-MEDIUM-842 — Rust unsafe-block lint is not denied and CI relaxes two denials

- **Wave-2 key:** R7-060 (register row; named by design G018 as not covered).
- **Problem:** `sens-api-gateway/Cargo.toml:561-571` and the wasm decoder template do not deny
  `clippy::undocumented_unsafe_blocks`, and `sens-api-gateway-ci.yml:221-222` passes
  `-A clippy::expect_used` and `-A clippy::indexing_slicing`, which the manifest denies.
- **Planned fix:** tracked deferral (product lane): deny the lint in both manifests and remove the
  two CI overrides. Deadline: 2027-01-13.

### ARIA-HIGH-530 — the required aria-kernel check passes on inputs it does not watch

- **Wave-2 key:** ci-surface-1 (blind-spot audit).
- **Problem:** `KERNEL_SURFACE` (`aria-kernel.yml:84-92`) omits paths its suite and lane steps read,
  so such a PR sets `kernel=false` (`:108`) and the verdict accepts the skipped jobs (`:494`); the
  pre-push selector keeps a different list (`aria-suite-changed.mjs:58-66`).
- **Planned fix:** `G001-surface-manifest` (L6, Part of) makes one surface manifest every reader
  uses; `G001-surface-gates` (L7) proves each read path is covered and closes it. Deadline:
  2026-12-14.

### ARIA-HIGH-531 — a type-less scope glob makes the whole tree look observed

- **Wave-2 key:** R7-051 (register row; design G010, step A).
- **Problem:** `observation_coverage` counts any declared-scope hit as observation and derives
  parsable types from it (`:248-268`), so banned-phrase's `**` scope (added by cb2dedf27) turns a
  0.781 red verdict green and `capability_gap` (`:409-416`) never routes an unobserved surface to
  skill genesis.
- **Planned fix:** bucket `G010-014-stepA` (landing L6): only typed globs of dispatchable adapter
  rows observe, read from the live registry. Deadline: 2026-12-14.

### ARIA-LOW-532 — helm templates are unrendered for infrastructure-policy observation

- **Wave-2 key:** R7-057 (register row; named by design G017).
- **Problem:** 17 committed helm template files (for example
  `infrastructure/helm/aquaculture/templates/backend-services.yaml`) are Go templates; without a
  helm binary the infrastructure-policy readers can only exclude them by name.
- **Planned fix:** tracked deferral: provision a pinned helm binary and observe the rendered
  manifests. Deadline: 2026-10-28.

### ARIA-LOW-533 — SECURITY_TOOLS is a hand-kept list

- **Wave-2 key:** R7-058 (register row; named by designs G017 and G044).
- **Problem:** `calibration_dials.SECURITY_TOOLS` (`:49-52`) lists security adapters by hand beside
  their manifests, and its pin (`test_calibration_actuator.py:195-201`) matches ids by name, so a
  security adapter whose id does not name its class is missed.
- **Planned fix:** tracked deferral: a manifest field declares the class, and `SECURITY_TOOLS` is
  derived from the manifests. Deadline: 2026-10-28.

### ARIA-HIGH-534 — the finding sweep's output never lands

- **Wave-2 key:** R7-009 (register row; design G020, N1).
- **Problem:** `planSweep` moves past-deadline rows to BLOCKED (`finding-registry.ts:1212-1231`),
  but `debt-plan-truth` counts only OPEN and IN-PROGRESS as active (`:91-93`) and throws when a
  CRITICAL leaves that set without a closer (`:202-225`), so the sweep PR cannot merge.
- **Planned fix:** bucket `R7-unresolved-states` (landing L7): one `isUnresolved` in the registry
  store, imported by `debt-plan-truth`. Deadline: 2026-12-14.

### ARIA-MEDIUM-535 — owner_user has no canonical identity

- **Wave-2 key:** R7-010 (register row; design G020, N2).
- **Problem:** The registry holds `okan`, `@okan-wqm`, `Okan-Wqm` and an email as `owner_user`,
  while the BLOCKED override is tied to the CODEOWNERS handle (`README.md:158`); `add` stores the
  value as given (`finding-registry.ts:469`).
- **Planned fix:** tracked deferral: one canonicaliser applied at `add` and `assign`, plus
  append-only `assign` rows for the existing spellings. Deadline: 2027-01-13.

### ARIA-HIGH-536 — vendor-fact classifiers read model-authored content

- **Wave-2 key:** poc-1 (blind-spot audit).
- **Problem:** `extract_auth_failure` and `extract_credit_exhaustion` match markers in the whole
  stream, assistant text and tool results included (`claude_runtime.py:1903`, `:2183-2190`), and
  Codex matches every event (`codex_runtime.py:215`). An agent that writes 'billing' and times out
  cools the provider fleet-wide and is requeued free.
- **Planned fix:** bucket `G019-login-vendor-facts` (landing L7): vendor facts come only from the
  CLI's error channel. Deadline: 2026-12-14.

### PROC-LOW-053 — the commit-msg gate has no Part-of form for a partial fix

- **Raised by:** the C2-W1 landing (landing L2), whose plan lands two partial fixes.
- **Problem:** `commit-msg-validator.ts:102` requires a `Closes:` trailer on every `fix`, `security`
  and `feat` commit (`:615-626`), and no other trailer satisfies it. A commit that fixes part of a
  registered finding must claim a false closure, take a type other than its own, or be allowlisted:
  `d046483b` and `b977da29` (two `fix(aria)` halves of ARIA-HIGH-199 and -198) sit in
  `PRE_PHASE6_SHAS` (`:363-381`, 4da6dfae7), and 068aa2703 was typed `refactor(web)`. Landing L2's
  `G023-254-sliceA` (Part of ARIA-MEDIUM-254 and ARIA-MEDIUM-512) and `R7-t2-anchor-read` (Part of
  ARIA-HIGH-281) commits are typed `refactor` for this reason.
- **Planned fix:** the validator accepts `Part of: <review_file>#<ID>` as the traceability trailer of
  a `fix`, `security` or `feat` commit, checked against the registry and the row's review file like
  `Closes:`, and closure derivation never reads it as a closure. Deadline: 2027-04-13.

## Registry amendments recorded at the L1 registry step

- **ARIA-HIGH-281** (wave-2 key R7-008): reopened by `finding-registry reopen`, which rejects
  closer 9665c5862 (false close: the T2 probe reads a root-owned anchor through the hardened git
  as gharunner, git refuses it, and nothing refreshes that checkout). The plan dates it
  2026-10-28; no governed verb sets a deadline, so the row keeps 2026-10-09 until the operator
  re-dates it (wave-2 operator question Q12). Fix: bucket `R7-t2-anchor-read`.
- **ORPHAN-MEDIUM-532:** to be treated as HIGH. The crossing happened: `runs.jsonl` passed the
  64 MiB per-surface cap and state publishes are refused. The ID carries the severity and no
  governed verb changes it; the plan ranks its bucket `R-532-size-consumer` HIGH.
- **ORPHAN-HIGH-430:** to be treated as MEDIUM. No deployment unit runs the daemon, and production
  uses the correct 24-hour window. Same constraint; the plan ranks its bucket
  `R-430-watchdog-window` MEDIUM.
- **ARIA-HIGH-415:** its closing evidence must also cite
  `aria-kernel/tests/test_auto_cycle_observation_steps.py`, the only test that pins the workflow
  half. It closes from its repair-stack trailer; the L1 PR body carries this citation.

## Closers rejected before the L1 merge

The registry's override verb (`finding-registry reopen --reject-closure`) records each SHA
below in the row's `rejected_closing_commits`, so the closure derivation does not resolve the
row from that commit when this landing PR merges. Each row stays OPEN; its notes carry the
reason. The rejection binds the SHA (PROC-MEDIUM-051).

- **ARIA-CRITICAL-215:** `3ff275a5f`.
- **ARIA-HIGH-414:** `fa29eea45`, `bcf211fcc`, `94501f67e`, `02e66c6b2`, `2d70a127e`.
- **ARIA-MEDIUM-438:** `d62409e5a`, `721dc1cbf`.
- **ARIA-HIGH-443:** `8c575da19`.
- **ARIA-LOW-445:** `18071863c`.

## Registry amendments recorded at the C2 registry step

- **ARIA-HIGH-143** (wave-2 key security-2): reopened by `finding-registry reopen`, which rejects
  closer e6cbd8dd4. The blind-spot audit measured that the managed spawn still shares the host
  network namespace (`MANAGED_SPAWN_ALLOW_NETWORK = True`, no `--unshare-net`, `resolv.conf` bound)
  and that a direct connect to a public address succeeds inside it. `HTTPS_PROXY` is advisory, so
  the row's own rule, egress confined by construction, was never met. The plan listed security-2 as
  a new row; the G008 design reopens ARIA-HIGH-143 instead, so one defect keeps one ID. Its review
  file stays `docs/reviews/claude/2026-09-12-aria-live-chain-blockers.md`, which the fix commit's
  `Closes:` trailer cites. No governed verb sets a deadline, so the row keeps 2026-09-22 and the
  daily sweep will mark it BLOCKED once this landing merges, until the operator re-dates it (wave-2
  operator question Q12). Fix: bucket `G008-security-1-2` (landing L5).
- **ORPHAN-MEDIUM-432:** the plan marks it a duplicate of ARIA-HIGH-045. It keeps its own row and
  closes with its own trailer, citing its own review file, in bucket `G002-045-gate`.
- **ARIA-CRITICAL-009, ARIA-CRITICAL-015:** the G020 design dates both 2026-10-31 through
  `finding-registry assign`, a verb that bucket `G020-044-accountability` adds (landing L6). The
  verb does not exist at this registry step, so those rows, and ARIA-HIGH-281's plan date
  2026-10-28, are re-dated after that bucket lands, with the dates the operator confirms (Q12).
- Rows this step does not mint: no verify-first register row belongs to a C2 bucket. R7-006, R7-012,
  R7-013 and R7-014 are refs of later buckets and are minted at their chunks' registry steps.
