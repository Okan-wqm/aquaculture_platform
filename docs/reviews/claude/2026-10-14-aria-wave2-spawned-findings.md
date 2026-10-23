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
- **Landed (L2, `G026-443-A12-4`):** the one scanner, renamed `unmodelled_shell_syntax`, refuses by
  name `$` and backtick outside single quotes, `\$`, `` \` `` and backslash-newline inside double
  quotes, unquoted `*`, `?` and `[`, tilde prefixes, brace expressions and unquoted backslash-newline;
  the gate names them `shell_expansion_in_command`. It tracks braces as bash's `brace_gobbler` does
  (a `}` before any separator does not close the word's `{`), in one linear pass.
  `test_bash_expansion_differential.py` runs every admitted line through bash in two locales: 1815
  admitted lines ran a different argv before, 0 after; `test_sandbox_and_perimeter_hardening.py`
  holds the bypass lines (allow before, deny after) and the linearity pin. The lexer after the
  scanner, stdlib `shlex.split`, is superlinear: ARIA-MEDIUM-538.

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

### ARIA-LOW-537 — the T2 probe tests fake the whole process identity

- **Raised by:** PR #1961's CI. The aria-kernel lane's shard 8 failed on the hosted runner, whose
  account is uid 1001, and on its re-run; the module is green as root and as uid 1000.
- **Problem:** `_as_runner` in `test_t2_boundary_probe.py:68-69` played the runner account by
  patching the real `pwd.getpwuid` and `os.geteuid`, so every module in the process read the
  euid as 1000. The probe CLI resolves its tools root through `refuse_foreign_owned_root`
  (`tool_registry.py:238`, added by ARIA-HIGH-426), which reads that euid
  (`write_root_owner.py:50-52`) and accepts only that uid or root as the owner (`:90`). The test's
  temp tree, owned by the real account (uid 1001), read as foreign, the registry read failed, and
  the probe reported `runner_key_registry_unavailable` (`habitat.py:303-304`). Production is
  unaffected: the hourly timer really runs as gharunner.
- **Fix (landed in PR #1961):** the probe reads its account through one seam,
  `habitat._running_account()`, and the tests patch only that seam, so the process keeps its real
  identity. The new test `test_playing_the_runner_account_leaves_the_process_its_own_identity`
  fakes an account that differs from the real one and asserts that `os.geteuid`, `pwd.getpwuid`
  and `write_root_owner._effective_uid` stay real; it fails on any host before the fix.

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
- **Landed (L2):** `cost_telemetry.py` and its test are deleted, `plan_016_metrics` exposes 12
  metrics, the `cost_telemetry` ledger row is gone from `state_manifest` (the `cost_telemetry`
  profile surface stays: `cost_attribution` uses it; `origin/aria/state` holds no
  `cost-telemetry.jsonl`), and Plan 020 marks Phase 13 retired in favour of the admission row.
  `test_plan_016_metrics.py` (metric set, module gone, manifest row gone) was red before and is
  green after; the replay fixtures and the `test_agent_eval.py` metric count follow. The dead
  cost hook in `cycle_phases/cost_telemetry.py` and plan 032's ARIA-032-D1 belong to
  `G026-A12-1-cost-booking`.

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
- **Landed (L2):** a rejection carrying any of `agent_invocations.CREDENTIAL_REFUSAL_CODES` is never
  sealed. Its row has `output_path: null`, `output_withheld: "credential_refusal"` and
  `withheld_sources` (each raw file under `outputs/` with the digest it was judged at). The kernel
  deletes those files before the journal append, on journal replay and on idempotent replay, only
  when their bytes still hash to the judged digest and no path component is a symlink. Unreadable
  envelope bytes are scanned, the verdict reduces every other reason to its code, and no
  out-of-scope observation is copied from a refused envelope. `integrity verify` and every publish
  refuse `refused_output_present`: any file under `outputs/` whose bytes hash to a refused digest,
  rows from before the fix included. `test_submit_withholds_refused_output.py` (22 tests) was red
  before and is green after. The submit path is the one this row names; the delivery path that
  never submits is ARIA-HIGH-540, and refused validation logs are ARIA-MEDIUM-539.

### ARIA-MEDIUM-516 — spine refresh runs adapters without their declared input

- **Wave-2 key:** R7-041 (register row; ARIA-HIGH-045 design, N2).
- **Problem:** `spine_orchestrator._run_one` (`:221-230`), the gateway scheduler and `tool run` omit
  the manifest `default_input` that only the cycle merges (`cycle.py:1368`), so tenant-scoping and
  security-boundary exit 1 in `requireScanRoots`. The refresh also trusts a pre-record status and
  names `schema-drift-adapter`, which has no manifest.
- **Planned fix:** bucket `G002-045-runs` (landing L3): one `default_input` merge in `run_tool`, the
  refresh judged by the recorded status, the adapter list derived from manifests. Deadline:
  2027-01-13.
- **Landed (L3, `G002-045-runs`):** `run_tool` merges the manifest `default_input` for every caller
  (caller keys win) and returns the row `record_run` stored, so `tool run`, the gateway scheduler
  and the refresh judge a run by its recorded status. The refresh's adapter set derives from
  `architecture_spine_gate.SPINE_INVARIANTS` (no `schema-drift-adapter`, no `test-gap-adapter`); it
  snapshots the working tree, treats only an `ok` cached row as fresh, and names quarantined and
  unregistered adapters without running them. `test_tool_runner_default_input.py` and
  `test_spine_orchestrator.py` were red before and are green after. The same change stops a
  `repo_snapshot` declared in a manifest's `default_input` from replacing the run's own snapshot (no
  shipped manifest declares one; no separate row).

### ARIA-LOW-517 — the prefixed sha256 digest has no single owner

- **Wave-2 key:** E11-4 (Z.ai ID; a wave-2 stub of the wave-1 review).
- **Problem:** 163 sites in 90 kernel modules compose `"sha256:" + ...` inline, about 15 private
  helpers re-implement it (four identical lease-token hashers, e.g. `agent_invocations.py:2497`,
  `worker_dispatch.py:500`), and 13 sites restate the validator `ledger.is_sha256_digest`
  (`ledger.py:248`) owns.
- **Planned fix:** `G006-digest-owner` (L3) adds `digest.py` as the one owner (Part of);
  `G006-digest-sites` and `G006-digest-codemod` (late chain) move every site and close it. Deadline:
  2027-04-13.
- **Part landed (L3, `G006-digest-owner`, step C1):** `aria_kernel/digest.py` is the one owner of the
  shape (a stdlib-only leaf: `sha256_digest*`, `is_sha256_digest`, fingerprints, sentinels).
  `ledger.py` binds `digest.is_sha256_digest` and deletes its regex copy, `_LEDGER_EVENT_ID` and
  `_replay_payload_sha256`; `_record_hash` and the replay payload digests compose through
  `ledger.sha256_digest_of_canonical_json`. Byte-identical: `test_digest_byte_pins.py` (12 golden
  values) and 460 aria/state ledgers that replay identically. The other sites move in
  `G006-digest-sites` and `G006-digest-codemod`, which close this row.

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
- **Landed (L3, `R6-credential-shapes`):** `secret_scrub.CREDENTIAL_SHAPES` is the one table (49
  rows with detect, value-spanning redact, views and a fixture), proven at import: no row or view may
  leave a refusal hit or any part of a fixture's secret. New redact rows cover PEM key blocks,
  `aws_secret_access_key` values and named secret assignments; `gh[pousr]_` tokens are redacted.
  `write_sanitized_json` refuses, writing nothing, a credential-shaped mapping key and any refusal
  hit in the bytes it would write. The refusal set, DLP, `system_one`, habitat, vault and harness
  views read the table. `test_credential_shapes_single_owner.py` was red before and is green after.
  The views the redact view does not cover are ARIA-MEDIUM-546; run artifacts are ARIA-LOW-547.

### ARIA-HIGH-520 — the closure policy's missing refs hide the Mode-A blocker

- **Wave-2 key:** A19-1 (Z.ai ID; a wave-2 stub of the wave-1 review).
- **Problem:** `_valid_operator_policy_shape` returns False for any absent regression ref
  (`autonomy_evidence.py:4111-4112`), and `_apply_operator_prerequisites` then returns early
  (`:4203-4212`) before the Mode-A check (`:4272-4277`). 17 refs are absent, so the operator is
  always shown `operator_prerequisite_policy_invalid`.
- **Planned fix:** `G003-A19-1-AB` (L4, Part of) reports unresolved refs as an engineering blocker
  and composes every blocker; `G003-A19-1-CD` (late) remaps the deleted ref and closes it. Deadline:
  2026-12-14.

### ARIA-MEDIUM-662 — a pinned ref below a symlinked directory reads as an owed proof

- **Raised by:** the ARIA order chain's `G003-A19-1-AB` item, landing the wave-3 bucket after
  ARIA-HIGH-520 closed on main in another form (02e4c0dc6).
- **Problem:** `_valid_operator_policy_structure` classifies each regression ref with one
  `_git_tree_entry` call on the ref (`autonomy_evidence.py:4173`) and collects every miss as
  unresolved (`:4182`). `ls-tree` finds nothing below a symlink, so a target tree whose
  `aria-kernel/tests` is a symlink reads as engineering backlog, not an invalid policy; with Mode-A
  proven, `enterprise_readiness` stays `live_proven`. Before 02e4c0dc6 this shape was
  `operator_prerequisite_policy_invalid`. The pinned-reference comparison (`:4204`) also runs after
  every ref, pinned or not, has reached git. `autonomy_closure._closure_policy_resolved` (`:290`)
  reads the same shape.
- **Planned fix:** one classification per pinned ref: a regular blob is landed; absent with every
  existing ancestor a tree is unlanded; anything else is an invalid policy, and a git failure on the
  ref or an ancestor is invalid. The pinned references are compared before any ref reaches git.
  Test-first, in this item's fix commit. Owner Okan-wqm, deadline 2027-01-18.
- **Landed (L4, `G003-A19-1-AB`):** `_regression_ref_presence` classifies each pinned ref (landed,
  unlanded, irregular) and `_valid_operator_policy_structure` compares the pinned references before
  the loop. `OperatorPrerequisiteTests`: a symlinked ancestor, a git failure on an ancestor and an
  unpinned ref were red on main; symlink, tree and gitlink at the ref stay invalid.

### ARIA-MEDIUM-663 — an owed closure proof leaves readiness live_proven

- **Raised by:** the ARIA order chain's `G003-A19-1-AB` item (design G003 part B, test B).
- **Problem:** `_apply_operator_prerequisites` adds `closure_policy_regression_refs_unresolved`
  without changing the state (`autonomy_evidence.py:4306`, `_with_capability_blocker` at `:3932`),
  so with Mode-A proven a status reports readiness, and the overall state, `live_proven` while a
  test the closure policy pins is absent. Every other engineering blocker of the derivation demotes
  its capability to `declared` (`:4439`). The closure predicate refuses on the blocker
  (`autonomy_closure.py:440`); the status and the CLI do not.
- **Planned fix:** `_with_prerequisite_blockers` folds the operator and engineering blocker sets into
  one state (operator: `operator_blocked`; engineering only: `declared`; otherwise the derived state)
  and replaces `_with_capability_blocker`; Mode-A is still judged on the readiness as derived.
  Test-first, in this item's fix commit. Owner Okan-wqm, deadline 2027-01-18.
- **Landed (L4, `G003-A19-1-AB`):** `_apply_operator_prerequisites` collects the operator and
  engineering blockers and folds them once through `_with_prerequisite_blockers`.
  `test_an_owed_proof_demotes_proven_readiness_to_declared` was red on main (`live_proven`); the
  landed-refs control stays `('live_proven', ())`.

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
- **Landed:** 2f66f8923 (PR #1996): `read_paths_ref` on the row and `runs_reader.run_read_paths`
  as the one reader. The bucket's index shape (`read_paths_count/digest/sample`, `run_row_index`)
  and its backfill did not land: their failure no longer happens on main (ARIA order chain,
  `R-NEW-runs-bound`). The remaining row and window bounds are ARIA-HIGH-617 (closed by that
  chain item), ARIA-HIGH-618, ARIA-MEDIUM-619, ARIA-MEDIUM-626 and ARIA-HIGH-629.

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

### ARIA-MEDIUM-538 — the Bash gate's argv lexer is superlinear in the line

- **Raised by:** the `G026-443-A12-4` fix round (landing L2).
- **Problem:** `argv_of` (`command_policy.py:304-307`) hands every line the scanner admits to stdlib
  `shlex.split`, whose token builder appends one character at a time. One admitted word of 200k
  characters takes 1.48 s, 400k 3.25 s and 800k 12.25 s; `decide_pre_tool` on an 800k-character
  line took 12.4 s, all in shlex. The PreToolUse hook (`hooks.py:114`) runs it on every Bash call,
  and the only bound is the broker's 8 MiB request cap (`hook_broker.py:69`). Pre-existing: the
  same lines are shlex-split at 013f20324.
- **Planned fix:** a fail-closed command-length bound in the hook, or the one scanner producing the
  argv in its own linear pass, checked against bash by `test_bash_expansion_differential.py`. No
  wave-2 bucket owns it. Deadline: 2027-01-13.

### ARIA-MEDIUM-539 — refused secret-shaped validation logs stay published

- **Raised by:** the `R6-refused-output` reviewers, accepted by its fix round (landing L2).
- **Problem:** the implementation delivery refuses a run whose recorded validation output is
  secret-shaped (`gate_output_secret_shaped`, `implementation_delivery.py:893-900`), reading that
  output back from the store's validation logs (`:437-465`). Nothing withholds those log files, and
  no publish gate checks them, so they stay on the published `validation_run_logs` surface
  (`state_manifest.py:562`). Same rule as ARIA-HIGH-515.
- **Planned fix:** the refusal withholds the refused log files, and the publish gate refuses a log
  whose digest a refusal recorded, both through the one `CREDENTIAL_REFUSAL_CODES` owner. No wave-2
  bucket owns it. Deadline: 2026-10-31.

### ARIA-HIGH-540 — a delivery-path credential refusal leaves the refused bytes published

- **Raised by:** the `R6-refused-output` reviewers, accepted by its fix round (landing L2).
- **Problem:** on the implementation-delivery path the kernel judges the envelope
  (`implementation_delivery.py:855-873`) and a rejection raises `ImplementationDeliveryRefusal`. The
  executor then records governance and HUMAN_REQUIRED and releases the claim
  (`ci_executor.py:5632-5690`) without `submit_claim_result`, the only caller of
  `_withhold_submission_sources` (`agent_invocations.py:6355-6458`). The refused envelope and
  transcript stay under `outputs/`, and the publish gate has no row to read. A reviewer probe showed
  the raw envelope still in place with `integrity verify` valid. The verdict text is already
  redacted (ARIA-HIGH-515's fix); the bytes are not.
- **Planned fix:** bucket `R6-transcripts` (holds `ci_executor.py`): on a `result_admissible` refusal
  whose codes meet `CREDENTIAL_REFUSAL_CODES`, the executor submits (the kernel records the withheld
  row and deletes the sources), then escalates as today. Deadline: 2026-10-31.

### ARIA-LOW-541 — the evaluator worktree guard misses a module ledger executes

- **Raised by:** the `G006-digest-owner` implementer (landing L3).
- **Problem:** `ledger.py:19` imports `state_store_lifecycle_arcs` and runs it on every append, but
  `_COMMON_AUTHORITY_PATHS` (`autonomy_evidence.py:936-951`) does not list it, and
  `_evaluator_worktree_blocker` (`:1957`) checks git status over that set only. So a dirty copy of
  an executed module passes the guard. The set is hand-kept; `G006-digest-owner` added `digest.py`
  to it by hand for the same reason.
- **Planned fix:** derive the set from ledger's kernel import closure, or an invariant that compares
  that closure with the set. No wave-2 bucket owns it. Deadline: 2027-04-14.

### EDGE-MEDIUM-044 — a sens-api-gateway invariant test is never built

- **Raised by:** the `G018-rust-source` implementer (landing L3).
- **Problem:** `sens-api-gateway/Cargo.toml` declares 43 of the 44 `tests/invariants/*.rs` as
  `[[test]]` targets (`:586-938`); `d3_boot_order.rs` is missing, and cargo auto-discovery finds
  only `tests/*.rs` and `tests/*/main.rs`, so `cargo test --all-targets`
  (`sens-api-gateway-ci.yml:257`) never compiles it. The rekey runbook
  (`db-migration-rekey-ceremony.md:193`) says it enforces the boot order at CI time.
- **Planned fix:** declare the target and fix what the compiled test reports (edge gateway, product
  lane). Deadline: 2027-01-14.

### EDGE-LOW-045 — the panic-safe protocol reader is compiled into no target

- **Raised by:** the `G018-rust-source` implementer (landing L3).
- **Problem:** no `mod protocol_reader` exists, so `sens-api-gateway/src/protocol_reader.rs`, whose
  header says external PLC, Modbus, LoRa and mTLS payloads must be decoded through its checked
  cursors, is built by no target; nothing decodes through it and its two unit tests never run.
  SENSOR-LOW-022 assumes it is the shared reader.
- **Planned fix:** wire it in or delete it and correct SENSOR-LOW-022's premise (edge gateway).
  Deadline: 2027-04-14.

### ARIA-LOW-542 — an untracked file under a scan root crashes an adapter in the room

- **Raised by:** the `G018-rust-source` implementer; observed independently by `G002-045-runs`
  (landing L3).
- **Problem:** the adapter room shows the tracked view, but `collectFiles` (`adapter-fs.ts`) lists a
  masked untracked entry and the adapter fails to open it: with `digest.py` untracked,
  kernel-dead-wire-adapter exited 1 with `EACCES` in the room and 0 outside it. The fixture contract
  keeps only `stderr_hash` (`fixture_runner.py:870`), so the cause is invisible. CI checkouts have no
  untracked files; operator and dev checkouts do.
- **Planned fix:** walk the view the room grants (or report an unreadable entry as an observation),
  and record bounded, scrubbed stderr text beside its hash. Deadline: 2027-04-14.

### ARIA-LOW-543 — the TypeScript adapters read through symlinks

- **Raised by:** the `G018-rust-source` fix round (landing L3).
- **Problem:** `readWorkspaceFile` and `workspacePathExists` (`adapter-fs.ts:230-239`) follow
  symlinks, and `resolveInsideWorkspace` and five per-adapter wrappers check containment only
  lexically, so an explicitly named tracked symlink (kernel-dead-wire's policy dir, typeorm's
  module-schema path) is read from outside the workspace. The Rust reader already reads through
  `containedWorkspace`.
- **Planned fix:** route these reads through `containedWorkspace`. Deadline: 2027-04-14.

### ARIA-LOW-544 — the upstream manifest grammar has two copies

- **Raised by:** the `G018-rust-source` fix round (landing L3).
- **Problem:** `local-rumqttc-fork-hygiene.spec.ts:65` `parseManifest` and `rust-cargo.ts:795`
  `parseUpstreamManifest` hold the same `UPSTREAM-MANIFEST.sha256` grammar and Map shape.
- **Planned fix:** the gate imports `parseUpstreamManifest`. Deadline: 2027-04-14.

### ARIA-LOW-545 — twin_test_surface keeps a second Rust test rule

- **Raised by:** the `G018-rust-source` fix round (landing L3).
- **Problem:** `_is_rust_spec` (`twin_test_surface.py:71`, `:101-108`) calls Rust code a test when it
  sits under `tests/` or contains `#[cfg(test)]`. The adapter reader disagrees:
  `sens-api-gateway/src/scripting/bytecode_e2e_tests.rs` (no `#[cfg(test)]`, gated by its declaring
  mod) is harness there and not spec evidence for the twin.
- **Planned fix:** the twin asks the TypeScript reader or drops its Rust rule. Deadline: 2026-11-15.

### ARIA-MEDIUM-546 — the redact view covers only the refuse view

- **Raised by:** the `R6-credential-shapes` reviewers, accepted by its fix round (landing L3).
- **Problem:** 22 rows that the dlp, `system_one` and harness views of `secret_scrub.CREDENTIAL_SHAPES`
  detect (Stripe, Slack, npm, GitLab, Google and DigitalOcean tokens, JWTs, password lines, among
  others) come out of `artifact_safety.scrub_text` unredacted, because `validate_credential_table`
  checks the redact view only against redact and refuse rows. The GitHub token family has 7 rows
  with 7 regexes, the habitat row lacks `ghr_`, and `github_writes._TOKEN_CLASSES` (`:38-44`) is a
  second prefix list.
- **Planned fix:** every credential row gets a value-spanning redact pattern, checked for
  over-redaction against negative fixtures, and the table requires the redact view to cover every
  credential-kind detect view. No wave-2 bucket owns it. Deadline: 2026-10-31.

### ARIA-LOW-547 — run artifacts are written with no credential refusal

- **Raised by:** the `R6-credential-shapes` fix round (landing L3).
- **Problem:** `runtime_artifacts.write_run_artifact` writes `scrub_json(payload)` to the published
  `runtime_artifact_hot` surface with no key check and no byte scan, so a credential in a mapping key,
  or a refusal hit that JSON escaping forms, is published verbatim. `write_sanitized_json` now refuses
  both.
- **Planned fix:** the writer runs `refuse_credential_keys` and `refuse_unredacted_credentials`,
  and an `ArtifactSafetyError` takes the existing `write_failed` path. Owner: the next bucket
  holding `runtime_artifacts.py` (R-NEW-runs-bound) or `R6-transcripts`. Deadline: 2026-10-31.

### INFRA-MEDIUM-222 — the lint quarantine expires on one unmeasured date

- **Wave-2 key:** HL-LINTQ-1 (human-loop design `HL-ops.md` §4.5 and its binding safety review,
  row 10).
- **Problem:** all 40 entries of `targets.lint.knownUnstableProjects` in
  `scripts/ci/affected-target-policy.json` expire on 2026-10-31, a date set without a measurement
  and owned by the operator. `validateQuarantine` (`write-affected-target-report.mjs:81-93`) refuses
  the whole file once one entry is past its date, so from 2026-11-01 the lint, test,
  test:integration, test:contract and test:invariant lanes fail on every PR and main push. No check
  bounds a lint expiry, counts the lint entries or ties them to measured debt.
- **Planned fix:** bucket `HL-lint-quarantine` measures each quarantined project with its own lint
  invocation, per rule, and commits the measurement. A project that measures clean leaves the
  quarantine. A project with security-class lint (getRepository, JWT_SECRET, the aquaculture tenant
  rules) is never renewed. The others expire at a bound computed from their debt (at most 90 days),
  owner claude. The invariant spec checks measurement, bound and anchor, and ratchets the lint
  count. The policy file gets a CODEOWNERS line. Deadline: 2026-10-30.
- **Landed (ARIA order chain, `HL-lint-quarantine`):** `scripts/ci/lint-debt-measure.mjs` measured
  all 40 entries at `340df8b7e`. 36 linted clean and left; backend-common (791), event-bus (25),
  outbox (13) and storage (17) were renewed with zero security-class problems, after the three
  getRepository errors in backend-common were paid down. `affected-target-quarantine-ssot.spec.ts`
  runs `--verify` (measurement, bound, anchor, renewability), ratchets the lint count to 4 and pins
  the CODEOWNERS lines. It was red on the old policy and is green on the renewed one.
- **Landed, review round (same PR):** the renewal moved the dates but kept the cliff. On
  2026-11-07 three entries would have expired and the writer would have refused the whole file
  again. The affected-lane partition now lives in `scripts/ci/lib/affected-target-policy.mjs`. A
  malformed entry still refuses the file. An expired entry quarantines nothing: its project is
  gated strictly for that target, and nothing else changes. The spec replays the writer's partition
  over the live policy one day past every date the file names. It no longer compares the file with
  today's date, which would have turned `invariants:fast` red on every PR on the same day.
  `--verify` also pins `measured_at` between the measured commit's day and today. The one
  non-security restricted-syntax selector is now named rather than picked by array position.

### INFRA-HIGH-223 — withdrawn before push (2026-10-16)

INFRA-HIGH-223 claimed that a `getRepository` call or `JWT_SECRET` read added to a lint-quarantined
project passes every lane. That was false for TypeScript files. The lint job runs
`scripts/ci/lint-changed-files.sh` before the affected lane, and `lint-changed-files.mjs` lints
every changed `.ts`/`.tsx` file at base and head, whatever the quarantine says. A new error-level
finding fails it (`lint-changed-files.mjs:575-586`). `no-direct-getrepository-call.spec.ts` also
catches an unannotated `getRepository` under `libs/`. The row was withdrawn before the branch was
pushed and never reached main. Its second-lane fix direction is dropped, because that lane would
duplicate `lint-changed-files`. The real residual is INFRA-MEDIUM-224.

### INFRA-MEDIUM-224 — a baseline file hides changed-file lint inside a quarantined project

- **Raised by:** the `HL-lint-quarantine` review (ARIA order chain). It replaces INFRA-HIGH-223.
- **Problem:** `lint-changed-files-baseline.txt` skips 16 files, and one of them lies inside a
  lint-quarantined project: `libs/backend-common/src/bootstrap/create-service-app.ts`, the
  bootstrap every service runs. The affected lane does not lint backend-common, the changed-file
  lint skips the file, and `lint:all` excludes the project. A `JWT_SECRET` read or an aquaculture
  tenant-rule violation added there passes CI. An unannotated `getRepository` is still caught by
  the invariant spec. The other 15 baseline files sit in projects the affected lane lints strictly.
  The baseline is a leftover of the strict changed-file mode that the base comparison replaced on
  2026-06-09.
- **Fix (same PR):** the entry leaves the baseline, so the file gets the same base-versus-head
  regression lint as every other changed file. `affected-target-quarantine-ssot.spec.ts` fails when
  a baseline entry lies inside a lint-quarantined project. Deadline: 2026-10-31.

### INFRA-MEDIUM-228 — the integration lane runs twice, and a duplicated policy key is read silently

- **Wave-2 key:** ci-surface-3 (designs G042-S §1 and G042 §1, bucket
  `G041-G042-reviewed-exception`).
- **Already fixed on main, not in this row:** the duplicated `test:integration` key in
  `affected-target-policy.json` (deleted by 508b44849), and the writer refusing the whole policy
  file over an expired entry of another target (579a34c71, INFRA-MEDIUM-222).
- **Problem:** `ci-affected.yml` runs `affected-target-policy.sh --target test:integration` from
  two steps of the `test` job (:533 and :594), so every PR that touches farm-service or
  auth-service runs their Testcontainers suites twice inside a 45-minute job budget.
  `test-target-ci-reachability.spec.ts` sees the target twice and checks only that it is driven.
  The policy file, the npm exceptions file and the lint-debt renewal are all read with
  `JSON.parse`, which keeps the last of two equal keys. A second block for a target therefore
  shadows the first without a signal, and `lint-debt-measure.mjs --renew` drops it from the file
  when it rewrites the policy.
- **Planned fix:** one strict JSON reader (`scripts/ci/lib/strict-json.mjs`) that refuses a
  duplicated key, used by every reader of those files; a repo-wide spec over every tracked `*.json`;
  the second integration step deleted; and a reachability test that each target is driven at most
  once per workflow. Deadline: 2027-01-15.
- **Landed (ARIA order chain, `G041-G042-reviewed-exception`):** `scripts/ci/lib/strict-json.mjs`
  refuses a repeated key; the affected-target writer, `lint-debt-measure.mjs` (verify and renew)
  and `npm-audit-gate.mjs` read through it, and `json-duplicate-keys.spec.ts` runs it over every
  tracked `*.json`. The second `test:integration` step is gone, and `test-target-ci-reachability`
  fails on a target driven twice. Red first: the writer, the renewal and the gate each accepted a
  duplicated key, and the reachability test reported `test:integration: ci-affected.yml x2`.

### INFRA-LOW-229 — the reviewed-exception rules have four copies

- **Wave-2 key:** ci-surface-9 (designs G041-S §4 and G041 §4, bucket
  `G041-G042-reviewed-exception`).
- **Problem:** `scripts/ci/lib/reviewed-exception.mjs` owns the shape of a reviewed exception
  (owner, a reason of at least 30 characters, an ISO expiry, a registry-shaped finding id). Three
  invariant specs restate it, because a jest spec cannot import an `.mjs` module.
  `invariant-reachability.spec.ts` accepts a dormant waiver with reason `tbd` and finding_id `TODO`,
  which the lib refuses. `affected-target-quarantine-ssot.spec.ts` (`isEntry`) and
  `npm-audit-exception-ssot.spec.ts` copy the rules and regexes, so tightening the lib leaves them
  behind. `npm-audit-gate.mjs` says the exceptions file is empty and the ratchet is at 0; five
  advisories are active.
- **Planned fix:** each committed exception file is checked by the code that owns its rules: the
  dormant manifest through the lib, the quarantine policy through the writer for every target it
  names, and the npm file through the gate. The copies and the stale prose are deleted. Deadline:
  2027-04-15.
- **Landed (ARIA order chain, `G041-G042-reviewed-exception`):** the dormant manifest goes through
  the lib's new `validateReviewedExceptions` (called from the spec by `helpers/esm-export.ts`, which
  also replaces the quarantine spec's private module shim). The quarantine spec runs the writer
  over the committed bytes for every target instead of `isEntry`'s copy, and the npm spec runs the
  gate on the committed file instead of its re-declared constants. Red first: the dormant check
  accepted `{reason: "tbd", finding_id: "TODO"}`.
- **Scope, after the independent verification (round 1):** this row names the copies of the
  three files whose shape the lib already owns, and those are what it closes. Two more lists are
  reviewed exceptions outside the lib, and each has its own row: the full lint lane's
  `lint-all-exclusions.json` (INFRA-LOW-231) and the seven `.claude/allowlists` ratchets whose
  specs carry their own rules (INFRA-LOW-232). The same round pinned the owner's refusals that
  the deleted copies used to restate: a non-GHSA key, a string `packages`, an empty or missing
  `scopes`, and an expiry that is not an ISO date.

### INFRA-LOW-231 — the full lint lane's exclusions carry no owner, expiry or finding

- **Raised by:** the independent verification of the `G041-G042-reviewed-exception` fix
  (round 1).
- **Problem:** `scripts/ci/lint-all-exclusions.json` maps backend-common, event-bus, storage and
  outbox to bare reason strings, and `lint-all.mjs` excludes every key from `lint:all` (ci-full:
  the weekly schedule, workflow_dispatch and release tags) with no date.
  `lint-quarantine-ssot.spec.ts` checks a reason length, a ceiling of 6 and that each key is
  also a key of the affected lane's lint quarantine. It compares keys only, so after the
  affected-lane entries lapse (event-bus, outbox and storage on 2026-11-06), the affected lane
  gates those projects while `lint:all` keeps skipping them. The reason floor is now read from the
  lib, not re-typed. Two docstrings still say `build-status` depends on `lint:all`
  (`lint-all.mjs:7`, `lint-quarantine-ssot.spec.ts:16`), but ci-full has no `pull_request`
  trigger.
- **Planned fix:** `{owner, reason, expires_on, finding_id}` entries checked through
  `validateReviewedExceptions`. What an expired full-lane entry does is the operator's decision,
  as in INFRA-MEDIUM-222: a lapsed date must not turn the whole lane red. Deadline: 2027-04-15.

### INFRA-LOW-232 — seven allowlist specs carry their own reviewed-exception rules

- **Raised by:** the independent verification of the `G041-G042-reviewed-exception` fix
  (round 1).
- **Problem:** `no-dead-guards.spec.ts:177`, `retention-authority-ssot.spec.ts:102`,
  `admin-mutation-audit-coverage.spec.ts:74`, `platform-capability-coverage.spec.ts:73`,
  `plan-catalog-ssot.spec.ts:101`, `scheduled-jobs-leased.spec.ts:136` and
  `web-design-system-ratchet.spec.ts:387` each check `{owner, reason, expiry, findingId}` entries
  under `.claude/allowlists/` with rules of their own. They disagree with the lib and with each
  other on the expiry boundary (`<=`, `>` or `>=` today), the reason floor (non-empty, over 20, at
  least 30) and the id grammar. A waiver with reason `tbd` and findingId `X-Y-1` passes four of
  them. Measured 2026-10-17: all 72 governed entries meet the lib's rules, so no live entry is
  weaker today.
- **Planned fix:** the lib's field names (or one field mapping in the lib), and each spec checks
  its entries through `validateReviewedException` via `tests/invariants/helpers/esm-export.ts`.
  Deadline: 2027-04-15.

### PROC-LOW-055 — the finding-id grammar is stated in many places

- **Raised by:** design G041-S §1 ("register as its own finding at implementation time"), at the
  `G041-G042-reviewed-exception` fix, which leaves the lib's `FINDING_ID` as it is.
- **Problem:** the registry schema (`findings.jsonl.schema.json:24`) admits a closed prefix list,
  the `CVE` classifier and three digits. `reviewed-exception.mjs` admits any letters-only prefix
  and no `CVE`, so it refuses `P0-CRITICAL-001` and `RUST-CVE-001`. The `Closes:` trailer pattern
  (`commit-msg-validator.ts:117`) admits no `CVE`, so a CVE-classified row cannot be closed by a
  trailer. `banned-phrase-excuse.ts:66` admits `NIT` and two-digit ids that no row can carry.
  Measured 2026-10-17: 9 of 2767 registry ids fail the lib, all RESOLVED, so no live exception is
  affected today.
- **More copies (independent verification, round 1):** the row's title says "four ways"; the row
  is hash-chained, so the count is corrected here. Besides the four cited in the row, the grammar
  is restated at `tools/gates/banned-phrase.ts:169`, `tests/invariants/claude-md-accuracy.spec.ts:143`,
  `plan-catalog-ssot.spec.ts:104`, `scheduled-jobs-leased.spec.ts:137` and `:208`,
  `admin-mutation-audit-coverage.spec.ts:75`, `platform-capability-coverage.spec.ts:74`,
  `web-design-system-ratchet.spec.ts:392`, `finding-id-aliases.spec.ts:144`,
  `aria-kernel/aria_kernel/plan_origin.py:57` (the `Closes:` trailer, a Python copy),
  `adapter_quarantine.py:31`, `plan_convergence.py:35`, `twin.py:982`, and the kernel tests
  `test_control_reachability.py:109` and `test_surface_reachability.py:159`. Purpose-narrow forms
  also exist: `tools/gates/finding-registry.ts:826` and `plan_origin.py:78` (ORPHAN ids only) and
  `three-store-invariants.spec.ts:1319` (P0 ids only). The fix covers every one of them, so this
  row cannot close while any copy remains.
- **Planned fix:** one exported grammar derived from the registry schema, and every gate's
  pattern built from it. Deadline: 2027-04-15.

### ARIA-HIGH-617 — a wide scope violation is too large to record, so the tool is never quarantined

- **Raised by:** the wave-3 `R-NEW-runs-bound` implementation (fix notes, item C). Re-measured on
  origin/main 45dd64142 by the ARIA order chain, which lands what of that bucket main still lacks.
- **Problem:** ARIA-HIGH-523 (2f66f8923) moved a run's `read_paths` out of its runs.jsonl row, but
  the row still carries `scope_violations` in full, and that list is derived from `read_paths`.
  `read_paths` is the adapter's own report, bounded only by the 12 MiB stdout cap. With 20,000
  reported out-of-scope paths the row is 1,600,188 bytes. The declared append refuses it
  (`LEDGER_ROW_MAX_BYTES` = 1 MiB) before `evaluate_health` runs. No runs row is written, the tool
  stays SHADOW and the tools phase aborts the cycle. A narrow-scope adapter that reads every
  tracked file today makes an 809,355-byte row (12,381 violations), 77% of the cap.
- **Planned fix:** the row carries the first 20 violations plus a total and digest marker, in the
  `ledger_inline` sample shape. The run artifact holds the whole list. Deadline: 2026-12-17.
- **Landed (ARIA order chain, `R-NEW-runs-bound`):** `tool_health._ledger_row_fields` stores
  `ledger_inline.sample_inline_list` of the scrubbed violations: the first 20 plus
  `scope_violations_spilled` (total, sha256). `payload.scope_violations` holds the whole list.
  `spill_evidence_validation` now uses the same helper. In `test_run_row_read_set_ref.py`, 20,000
  reported out-of-scope paths raised `LedgerRowTooLargeError` before the fix. After it the row is
  under 16 KiB and the tool is quarantined. A production-shaped run that also carries 50
  raw-finding samples makes a 29,719-byte row.
- **Verification round 1 (same branch, before merge):** that first commit left the failure open in
  three places. (1) Where no artifact holds the read set, the row kept `read_paths` inline without
  a bound. The adapter can force that state: the artifact encoder refuses a credential-shaped key
  in its `parsed_output`, or a credential shape in a reported path, and a full disk fails the write
  too. A v1 row writes no artifact at all. 20,000 paths then made a 1.24 MB row, and the run was
  neither recorded nor quarantined. (2) The sample was bounded by count only: twenty 60,000-character
  entries made a 1.2 MB row. (3) A `.env` read reported after 20 others was missing from the row
  sample. The fix: `sample_inline_list` bounds the sample by bytes, counted in the ledger's own
  row encoding (`ledger.canonical_json`). Its marker carries reason code, total, sampled, digest
  (`ledger.sha256_digest_of_canonical_json`, the spelling `read_paths_ref` uses), verification
  status and `json_pointer` or recovery text. On a row with no artifact, both lists stay whole up
  to the per-field inline budget and keep a `digest_only` sample beyond it. Forbidden reads lead
  the list. Each case is a red-first test in `test_run_row_read_set_ref.py`: a credential key, an
  escape-formed path, a full disk, v1, long entries, a non-string entry, a single 1.1 MB entry and
  a forbidden read after 25 others. All of them are now recorded and quarantined, with the rows
  under 2 x 128 KiB plus 16 KiB.
- **Verification round 2 (same branch, before merge):** the rows were bounded, but the
  consequence "the cycle aborts" was still reachable two ways. (1) The pressure phase cited
  `run_read_paths(run)` whole for every `scope_violation` or `evidence_error` run of the cycle,
  and appends the cycle's pressures as one pressure-log.jsonl row under the same 1 MiB cap; the
  phase has no `on_error` (`cycle.py`). 20,000 paths made that row 1,243,619 bytes, so the run was
  recorded and its tool quarantined, and the cycle then aborted in the pressure phase. The
  `evidence_error` variant had existed on main since ARIA-HIGH-523. (2) Structure instead of size:
  an entry nested about 1,200 deep made `artifact_safety.scrub_json` (one Python frame per level)
  raise RecursionError out of `record_run` before the append, in v2-shadow (the artifact payload,
  also through `parsed_output.metadata`) and in v1 (the row's read set, which the first fix
  commit had started to scrub). Nested about 20,000 deep, `json.loads` raised it in the parser.
  The fix: `pressure._run_path_citations` cites at most 20 paths within 4 KiB
  (`ledger_inline.bounded_prefix`, which `sample_inline_list` now also uses), and a scope
  violation cites the violations its row keeps, forbidden reads first. `tool_runner._parse_tool_output`
  refuses output nested past the kernel's lexical bound (`ledger.json_nesting_within_limit`)
  before decoding it, as `output_nesting_too_deep`, so the run ends `schema_error`, recorded and
  quarantined. Also in this round: the row's `evidence_validation` is scrubbed (its
  `read_path_outside_snapshot` errors echoed each reported path raw), runs compaction leaves a
  row its writer already sampled alone, and `spill_oversized_inline` and the
  `spill_evidence_validation` gate count and digest in `ledger.canonical_json`. Each is a test in
  `test_run_row_read_set_ref.py` or `test_evidence_validator_empty_read_paths.py` that failed
  before it. Not covered: the hot artifact's size (ARIA-HIGH-629) and the runs row's missing
  boundary encoder (ARIA-MEDIUM-630).
- **Verification round 3 (same branch, before merge):** the parse boundary still let two kinds of
  output through. (1) `json.loads` raises a plain ValueError, not a JSONDecodeError, for an
  integer longer than 4,300 digits, and the parser caught only JSONDecodeError: the error left
  `run_tool` before `record_run`, so a report that read `.env` went unrecorded (also on main).
  (2) The parser's nesting bound equalled the readers' bound (128), but a runs row nests a parsed
  value one level deeper than stdout (`runner.raw_findings_sample`, `evidence_validation`'s
  `finding_id`) and a fixture-runs case three levels deeper, so output at the bound was recorded
  and quarantined and then refused by every publish (`snapshot_ledger_invalid:runs.jsonl`), with
  no way to drop a sealed row. The fix: the parser refuses a value the decoder cannot build as
  `output_value_not_decodable`, and bounds nesting at `tool_runner.TOOL_OUTPUT_NESTING_MAX_DEPTH`
  (124): `ledger.LEDGER_ROW_NESTING_MAX_DEPTH` (127, the readers' 128 less the level contention
  replay's `producer_payload` adds) less the three levels a row adds. The append primitive now
  also refuses a row past that bound (`LedgerRowTooDeepError`, a `LedgerRowTooLargeError`), so no
  writer can seal a line the readers or the replay would refuse. Also in this round: a sample
  skips an entry too long for its budget instead of stopping at it (an oversized forbidden read
  reported first had hidden the `.env` read behind it), `record_run` scrubs `evidence_validation`
  before it bounds it, and `runs_reader.run_path_citations` is the one citation of a run
  (pressure and capability gap). Each is a test that failed before it. ARIA-MEDIUM-647 is
  registered for v1's inline emitted lists.
- **Verification round 4 (same branch, before merge):** a sibling append still decided the
  quarantine. After the runs row, `record_run` appends one raw-findings row per finding (and, for
  an ACTIVE tool, a findings row and a seeding row) before `evaluate_health`, and those rows hold
  the adapter's finding with no bound: one finding whose id was 600,000 bytes made the
  raw-findings row 1.2 MB, the batch was refused, the runs row said `scope_violation` and the tool
  stayed SHADOW; an in-scope run with such a finding failed the tools phase every night. The fix
  is at the parse boundary: `_parse_tool_output` refuses a findings entry past
  `tool_runner.TOOL_OUTPUT_FINDING_MAX_BYTES` (an eighth of the row cap, measured in
  `ledger.canonical_json`) as `output_finding_too_large`, so the run is `schema_error`, recorded
  and quarantined. A finding at the bound, shaped to be stored largest (an id of backslashes,
  which `finding_summary`'s `str()` escapes twice), fits every row that holds it. Also in this
  round: the bounded `evidence_validation` names a rebuild from the output as its recovery,
  since the artifact holds the same bounded object and v1 writes none. Each is a test that failed
  before it (`test_tool_output_finding_bound.py`, `test_run_row_read_set_ref.py`).
  ARIA-HIGH-654 (output that is not UTF-8) and ARIA-MEDIUM-655 (the scrubber's quadratic cost)
  are registered.

### ARIA-HIGH-618 — memory candidates or raw-finding entries make a run unrecordable

- **Raised by:** the wave-3 `R-NEW-runs-bound` fix round (item A, security), widened by the order
  chain's re-measurement on origin/main 45dd64142.
- **Problem:** `tool_runner._valid_memory_candidates` keeps every well-formed candidate, and
  `_raw_finding_sample` keeps the first 50 raw findings at whatever size the adapter wrote them.
  The default v2-shadow row carries both. 6,000 candidates (1,683,719 bytes), or 50 findings of
  about 28 KB each (1,411,985 bytes), make the row append raise before `evaluate_health`. The run
  is neither recorded nor quarantined. `memory._ingest_memory_candidates` reads the candidates off
  the row, and the artifact does not carry them.
- **Planned fix:** the artifact carries the candidates and the raw-finding sample. The row keeps
  count, digest and sample, memory ingestion reads the artifact, and the quarantine verdict no
  longer depends on the append succeeding. Taking the raw-finding sample off the v2-shadow row
  changes what the runtime artifact contract says v2-shadow preserves, and ADR-035 makes v2 the
  operator's decision. So that half waits for that decision, or keeps the contract through the
  artifact. Owner Okan-wqm, deadline 2026-10-30.
- **Why ARIA-HIGH-617 did not take this along (restated at verification round 1):** ARIA-HIGH-617
  changed one v2-shadow field, `scope_violations`. That list is derived from the read set, the
  artifact already holds it, and the row's marker now carries the truncation fields ADR-035 asks
  for (pointer, digest, count, reason code, verification status). The two fields here are not
  like that. `raw_findings_sample` is the one row field `record_run` already drops in `v2` and
  keeps in `v2-shadow`, so moving it is the v2 decision itself. `memory_candidates` has a row reader
  (`memory._ingest_memory_candidates`) that must move to the artifact first. Each is a change of
  its own in other modules.

### ARIA-MEDIUM-619 — evidence_validation still sets the runs surface's publish bound

- **Raised by:** the wave-3 `R-NEW-runs-bound` implementation (item B).
- **Problem:** every runs row inlines `evidence_validation`, which `ledger_inline` bounds at 128 KiB
  per object. Seven days at 75 runs a day of maximal objects is 65.6 MiB, over the 64 MiB
  per-surface publish cap, so adapter output alone could get publishes refused again. Today the
  margin is wide: the live runs.jsonl on origin/aria/state 8e39b2eeb is 39,116,912 bytes, and
  ARIA-HIGH-523 measured a 12.3 MB week at the 2026-10-15 rate.
- **Planned fix:** the row keeps the structural keys plus count, digest and sample, and the run
  artifact holds the whole object. Deadline: 2026-11-15.

### ARIA-MEDIUM-626 — the runs publish window is bounded only by adapter output

- **Raised by:** the independent verification (round 1) of the order chain's `R-NEW-runs-bound`
  item. That item is order-map SUP-01, "Bound runs.jsonl by bytes", whose test-first reads: a publish
  whose runs surface would exceed its byte budget compacts to under the budget, never refuses.
  ARIA-HIGH-617 bounds a row's read-set lists. That is not this.
- **Problem:** `bound_compactable_surfaces` slims only rows older than seven days. If the surface is
  still over 64 MiB it raises `SurfaceBoundError`. At 75 runs a day, rows averaging over about
  125 KiB fill the window. `memory_candidates` and `raw_findings_sample` have no bound below the
  1 MiB row cap. ARIA-HIGH-618 names the rows over that cap, not the sub-cap rows that fill the
  window, and evidence_validation's share belongs to ARIA-MEDIUM-619. Today the live runs.jsonl is
  39,116,912 bytes and grows by about 12.3 MB a week.
- **Planned fix:** bound every adapter-controlled row field by construction (ARIA-HIGH-618's
  artifact move with byte-bounded samples, plus ARIA-MEDIUM-619), pinned by a test that writes a
  week of maximal rows. The alternative is a publish compaction that brings the window under
  budget. Owner Okan-wqm, deadline 2026-11-15.

### ARIA-HIGH-629 — a hot run artifact has no size bound, so one run can refuse every publish

- **Raised by:** the independent verification (round 2) of the order chain's `R-NEW-runs-bound`
  item (correctness lens).
- **Problem:** `write_run_artifact` encodes the whole payload with no bound against the snapshot's
  64 MiB per-file cap (`state_snapshot.SNAPSHOT_MAX_SURFACE_BLOB_BYTES`), and `tool_runner` keeps
  stdout and stderr whole, also past the 12 MiB parse cap. A file over the cap makes the snapshot
  raise `snapshot_surface_too_large`, so every publish is refused until hot retention (20 cycles)
  drops the artifact. On origin/main a `budget_exceeded` run with 70 MiB of stdout writes a
  73,401,132-byte artifact. ARIA-HIGH-617's `payload.scope_violations` is a fourth copy of a
  scope-violating run's read set and lowers the threshold for parsed runs: a report just under
  12 MiB with 5 non-ASCII characters per path gives a 67,176,917-byte artifact.
- **Planned fix:** the artifact is bounded below the cap at write time: stdout and stderr kept as
  bounded heads plus size and digest once `parsed_output` holds the parse, a bulk that cannot fit
  spilled with reason code, total and digest, and `payload.scope_violations` stored as positions
  into `payload.read_paths`. Test-first: a 12 MiB non-ASCII report and a 70 MiB `budget_exceeded`
  stdout each leave an artifact under the cap, and the next snapshot succeeds. Owner Okan-wqm,
  deadline 2026-10-31.

### ARIA-MEDIUM-630 — runs rows reach the published surface without the boundary encoder

- **Raised by:** the independent verification (round 2) of the order chain's `R-NEW-runs-bound`
  item (security lens).
- **Problem:** `record_run` appends the runs row through the declared append, with no
  `artifact_safety.sanitized_json_text` step (ARIA-LOW-547 made that the one encoding step of every
  published JSON writer, and the run artifact goes through it). On a row with no artifact the
  read-set sample is only `scrub_json`ed. `scrub_json` never rewrites a mapping key and cannot see
  a refusal hit the row's ASCII escaping forms. So a read-set entry `{<ghp_ token>: "docs/x.md"}`
  puts the token on the row line in v1 and in v2-shadow (where the key also fails the artifact
  write), and `"x" + U+00EA + "ws_secret_access_key=" + U+001A` makes the row line hit the
  `aws_secret_access_key` refusal pattern twice. Both lines fail
  `implementation_safety.verify_no_secret_in_diff`. Not new: on origin/main the lists were stored
  raw. ARIA-HIGH-617's round 2 scrubs the row's `evidence_validation`, which echoed each reported
  path raw.
- **Planned fix:** the declared append of a published surface (or `record_run`'s row) goes through
  `scrub_json` plus the `sanitized_json_text` refusal, and a refused list falls back to a
  `digest_only` marker with a reason code. Test-first: each case's row line passes
  `verify_no_secret_in_diff`. Owner Okan-wqm, deadline 2026-11-15.

### ARIA-MEDIUM-647 — a v1 row keeps an ACTIVE tool's emitted lists inline with no bound

- **Raised by:** the independent verification (round 3) of the order chain's `R-NEW-runs-bound`
  item (completeness lens).
- **Problem:** in the v1 format (no artifact) `record_run` keeps `emitted_observations` and
  `emitted_findings` on the runs row whole (ORPHAN-HIGH-798's v1 exception), bounded only by the
  12 MiB stdout cap. 3,000 emitted findings (1,486,891 bytes) make the append raise
  `LedgerRowTooLargeError` before `evaluate_health`: no runs row, and a tool that read `.env`
  stays SHADOW. The same input in v2-shadow is recorded and quarantined. No workflow selects v1
  today, and only an ACTIVE tool emits.
- **Planned fix:** the v1 row samples the emitted lists through `ledger_inline.sample_inline_list`
  once observations have a durable home besides the row (findings.jsonl already holds every
  emitted finding), or the quarantine verdict is decided before the append as ARIA-HIGH-618
  plans. Test-first: the 3,000-finding v1 run is recorded and quarantined. Owner Okan-wqm,
  deadline 2026-11-15.

### ARIA-HIGH-654 — adapter output that is not UTF-8 leaves run_tool before the run is recorded

- **Raised by:** the independent verification (round 4) of the order chain's `R-NEW-runs-bound`
  item (correctness lens).
- **Problem:** `adapter_room.run_adapter` runs the adapter with `text=True`, so subprocess decodes
  stdout and stderr as strict UTF-8 inside `subprocess.run`. One byte that is not UTF-8, in a
  metadata string or in a stderr warning, raises `UnicodeDecodeError` (a ValueError). `run_tool`
  catches only `SandboxUnavailable`, `TimeoutExpired` and `OSError`, so the error leaves before
  `record_run`: no runs row, and a tool whose report shows a `.env` read stays SHADOW. The tools
  phase propagates it, so the cycle aborts every night; the fixture refresh lane shares
  `run_adapter` and dies the same way. Also on origin/main.
- **Planned fix:** `run_adapter` returns bytes. `run_tool` and `run_fixture_case` decode stdout
  explicitly, and output that is not UTF-8 is a named parse code (`output_not_utf8`), so the run
  is `schema_error`, recorded and quarantined; stderr is decoded with `errors="replace"` before
  `adapter_stderr_sample`. The other two callers decode the same way. Test-first from the probe,
  in v1 and v2-shadow. This changes the sandbox's one process start and its four callers, so it is
  a change of its own. Owner Okan-wqm, deadline 2026-10-31.

### ARIA-MEDIUM-655 — the scrubber's cost is quadratic in an alphanumeric run's length

- **Raised by:** the independent verification (round 4) of the order chain's `R-NEW-runs-bound`
  item (security lens).
- **Problem:** `secret_scrub._redact_counted`, the one redaction loop every scrubber runs, takes
  0.30 s on a 5,000-character alphanumeric run, 4.71 s at 20,000 and 19.6 s at 40,000; a
  600,000-character id did not finish within 10 minutes. `record_run` scrubs adapter strings
  (`evidence_validation`, then the artifact payload) before `evaluate_health`, so one such string
  in adapter output stalls the run ahead of its quarantine until the phase deadline kills the
  cycle. Older than `R-NEW-runs-bound`, which adds one pass in v2-shadow and the first in v1.
- **Planned fix:** the redact rows run in linear time (bounded quantifiers or a length-capped
  pre-tokenisation). Test-first: a 1 MB alphanumeric string scrubs within a fixed time budget and
  the credential-shape tests stay green. Owner Okan-wqm, deadline 2026-11-15.

### ARIA-MEDIUM-656 — a pr-lifecycle observation still carries and binds a PR's change

- **Raised by:** the ARIA order chain, landing the wave-3 `G003-md1-binding` bucket (key
  merge-delivery-1). Main closed ARIA-HIGH-521 in another form (577741a4d): the perimeter now binds
  from the latest row that carries a `change_id`, so the merge lane's own `observed` row no longer
  blocks every ARIA PR. The writer and the readers stayed as they were.
- **Problem:** `auto_merge.record_pr_lifecycle` takes any event string, defaults to `observed`, and
  copies `change_id`, `proposal_id`, `task_id`, `assignment_id` and `merge_route` from its payload
  onto every event (`auto_merge.py:574`, `:605-618`). Five readers pick the binding by their own
  rules: `auto_merge.pr_change_binding` (any row carrying a change id, `:503`, read by
  `change_for_pr` and the perimeter), `change_outcome._merge_index` (every change any row names,
  `:468`), `_capture_assessment_inputs` (`:883`), `self_revert._reverted_suite` (the latest
  proposal, `:1189`) and `human_merge_decision` (`:534`). Measured on origin/main a488a36f2 with the
  bucket's tests: an observed row naming `chg_forged` makes `change_for_pr` return it, and an
  unrelated change named only by an observed row is credited with the PR's merge. The production
  GitHub adapter carries none of these fields, so the lane's own observation does not re-bind a PR
  today. A legacy row or any payload-carrying caller does.
- **Planned fix:** `merge_record.pr_change_binding` owns the binding (the PR's `opened` rows), the
  writer takes a required event from a closed vocabulary and writes binding fields only on
  `opened`/`pr_dry_run`, every reader goes through the owner, and the second owner in `auto_merge`
  is deleted. Deadline: 2027-01-17.
- **Landed (ARIA order chain, `G003-md1-binding`):** `merge_record.pr_change_binding` returns a
  `PrChangeBinding` from the PR's latest `opened` row (`None` for a non-int PR key), and
  `record_pr_lifecycle` refuses an event outside `PR_LIFECYCLE_EVENTS` and writes the binding fields
  null on every non-binding event. `change_for_pr`, the perimeter, `human_merge_decision`,
  `_merge_index`, `_capture_assessment_inputs` and `_reverted_suite` read through it; the copy in
  `auto_merge` is gone. Red first on a488a36f2: `change_for_pr` returned `chg_forged`, an observed row
  credited an unrelated change with the merge; green in `test_pr_change_id_requirement`,
  `test_change_outcome` and the perimeter tests. The verification round found three more readers:
  `worker_dispatch.pr_for_assignment` took the assignment bridge (one of `BINDING_FIELDS`) from a
  row of any event, so a legacy observed or merged row routed `merge_if_green` to its PR (red:
  778 != 142 in `test_only_the_opened_row_binds_an_assignment_to_its_pr`); it now reads
  `merge_record.opened_row(rows, assignment_id=...)`. `merge_record.pull_requests_for_change` and
  `delivery_closure` compare with the owner's `PR_BINDING_EVENT` instead of the literal. The only
  copies of the rule left are ARIA-LOW-660's. The perimeter also no longer requires the PR's last
  lifecycle row to name the live head and base (577741a4d): the live head is judged against the
  committed commit by the delivered-head check and `verify_branch_update_lineage`, the base by the
  opened row against the live payload, and the merge lane re-reads the head before it merges. The
  claim-time expert-review capture, which appends no observation, now binds an ARIA-updated head
  (pinned by `test_a_claim_time_capture_judges_an_updated_head_by_the_lineage_verifier_alone`; main
  refused it as `pr_change_join_unavailable`).

### ARIA-LOW-657 — the opened row's delivered head is never compared with the committed commit

- **Raised by:** the wave-3 `G003-md1-binding` fix round (review item 2), re-measured on origin/main
  a488a36f2.
- **Problem:** the perimeter compares only the live head with `committed.commit_sha`
  (`merge_authority.py:1032`). An opened row recorded for another commit passes when the live head
  is the committed commit, and `pr_row_hash` (`:1152`) then names a delivery that is not the merged
  change. No producer on main writes that shape today.
- **Planned fix:** `pr_change_join_unavailable` when the binding's delivered head is not the
  committed commit. Deadline: 2027-04-17.
- **Landed (ARIA order chain, `G003-md1-binding`):** the perimeter refuses
  `pr_change_join_unavailable` when `binding.delivered_head_sha` is not `committed.commit_sha`. Its
  refusal of more than one change id, which main applied to every row of the PR, now counts only the
  PR's opened rows, since no other row binds. Red first:
  `test_an_opened_head_other_than_the_committed_commit_is_refused` got the change id with only
  `implementation_*` gaps; it is green now.

### ARIA-LOW-658 — the pre-merge capture drops the lineage verifier's refusal name

- **Raised by:** the wave-3 `G003-md1-binding` implementation (design D4), re-measured on
  origin/main a488a36f2.
- **Problem:** the updated-head branch raises `GovernanceError(f"{reason}:{exc.reason}")`
  (`merge_authority.py:1043`), but the capture's handler records `(reason,)` (`:1163`), so an
  unrecorded update is evidenced as plain `pr_change_join_unavailable`. The merge stays refused; the
  operator cannot tell an unrecorded commit from an unbound PR.
- **Planned fix:** the capture's reason takes the verifier's suffix before the raise. Deadline:
  2027-04-17.
- **Landed (ARIA order chain, `G003-md1-binding`):** the updated-head branch sets `reason` to
  `pr_change_join_unavailable:<verifier reason>` before it raises, so the evidence carries the
  verifier's name. Red first: `test_an_unrecorded_update_is_refused_by_the_verifiers_name` recorded
  the bare reason; it is green now, beside
  `test_an_updated_head_binds_through_the_shared_lineage_verifier`.

### ARIA-LOW-659 — updated-head evidence does not capture the update receipts it relied on

- **Raised by:** the wave-3 `G003-md1-binding` security review (fix notes, item A); re-read on
  origin/main a488a36f2, unchanged.
- **Problem:** the capture's sources hold no `tools/recovery/external-effects.jsonl`
  (`merge_authority.py:940`, `:946`). The updated-head branch calls `verify_branch_update_lineage`
  (`:1038`), which reads that ledger from disk (`branch_update_lineage.py:179`), and the second
  transaction re-checks only the captured sources (`:1114`). Not a weakening: the ledger is
  append-only and kernel-written. An updated-head evidence row cannot be replayed from its prefixes.
- **Planned fix:** capture the ledger, pass its rows to the verifier and bind the receipts' hashes
  into the evidence, in the next change that owns `branch_update_lineage.py` and
  `merge_authority.py`. Deadline: 2026-10-31 (dated by that review round).

### ARIA-LOW-660 — two more copies of the PR binding owner's opened-row rule

- **Raised by:** the wave-3 `G003-md1-binding` architecture review (fix notes, item B); re-read on
  origin/main a488a36f2, which also has the `implementation_reconciler` copy.
- **Problem:** `own_pr_delivery.aria_opened_prs` (`own_pr_delivery.py:34`) and
  `implementation_reconciler.py:178` select the latest `opened` row themselves;
  `human_merge_surface` (`:128`, `:153`, `:203`, `:219`) and `pr_branch_update.py:340` read a PR's
  change from that copy. They select the same row as the owner today, so a change to the owner's
  rule would not reach them.
- **Planned fix:** both built on `merge_record.pr_change_binding`, in the next change that owns
  `own_pr_delivery.py` and `human_merge_surface.py`. Deadline: 2026-10-31 (dated by that review
  round).

### ARIA-MEDIUM-664 — `state lease release --force-foreign` needs no operator act; the pin misses it

- **Raised by:** the wave-3 `G010-238-pin-breakers` implementation (residual 1; "not covered" in
  wave2/design/G010.md); re-read by the ARIA order chain on origin/main e1f659819.
- **Problem:** `--force-foreign` needs only a non-empty `--reason` (`cli.py:731-742`), and
  `release_writer_lease` then releases the lease whoever holds it (`state_writer_lease.py:763-766`;
  the holder's run liveness is only written into the reason). The ARIA-HIGH-238 pin classifies by
  parameter name (`test_operator_approval_callers.py:78`), so a raise with no approval-reference
  parameter is never seen.
- **Planned fix:** classify by authority effect, and prove a foreign release by an operator's GitHub
  act bound to the lease instance (or refuse it while the holder's run is live). Deadline:
  2027-01-18.

### ARIA-MEDIUM-665 — a `tool_unquarantine` act is bound to the tool, not to the quarantine

- **Raised by:** the wave-3 `G010-238-pin-breakers` implementation (residual 2); re-read on origin/main
  e1f659819.
- **Problem:** the surface's scope is `("tool",)` (`operator_approval.py:87`) and the verifier has no
  lower freshness bound (`:436-441`), so an unspent act posted for one quarantine of a tool releases
  its next quarantine within the act's max age. The breaker and MCP surfaces landed with ARIA-HIGH-238
  slices 1-2 bind to the instance; this one does not.
- **Planned fix:** add the quarantine's recorded instance to the scope, read by a `tool_registry`
  scope function and printed by `--print-approval-line`. Deadline: 2027-01-18.

### ARIA-LOW-666 — a stop with no recorded trip binds to the constant `none`

- **Raised by:** the wave-3 `G010-238-pin-breakers` implementation (residual 3, widened by its fix
  round); re-read on the landing branch from origin/main e1f659819.
- **Problem:** `trip_scope` binds to `NO_RECORDED_INSTANCE` when the state records no `tripped_at`
  (`circuit_breaker.py:502-524`, `operator_approval.py:97-108`). An unspent `tripped_at=none` act,
  posted while the breaker is ok, authorizes a later reset that truncates a window still
  accumulating failures (`reset_breaker` has no not-tripped no-op, `:557-560`), and a trip derived
  only from damaged rows records no stamp (`:326`). Since the chain's fix round 1, a recorded stamp
  that is not one timezone-aware ISO-8601 token also binds to `none`, as an undecodable state
  already did. Before that, `canonical_scope` refused such a stamp, so the stop could not be
  cleared through its verb at all. A writer of the state file could already produce `none` by
  dropping the field, so this adds no new way to reach it.
- **Planned fix:** every trip writes its instance, and a failure-breaker reset with nothing tripped
  is a no-op without an act. The stale-stamp half, a record that lags the ledger, is ARIA-LOW-670.
  One fix covers 666, 667 and 670. Deadline: 2027-04-18.

### ARIA-LOW-667 — reset and evidence quarantine cut the ledger without its lock

- **Raised by:** the wave-3 `G010-238-pin-breakers` implementation (residual 4); re-read on the
  landing branch from origin/main e1f659819.
- **Problem:** `reset_breaker` reads the trip scope, verifies the act over the network, then writes
  `{state: ok}` and truncates `failures.jsonl` with no lock (`circuit_breaker.py:527-570`), while
  `record_failure` appends under `append_jsonl`'s lock and restamps `tripped_at` (`:384-460`). A
  failure recorded in between is cut without the act having covered it; `quarantine_breaker_evidence`
  (`:577-720`) has the same shape.
- **Planned fix:** read the scope and write under the ledger's lock (re-read and compare after
  verification). Deadline: 2027-04-18.

### ARIA-MEDIUM-668 — an undecodable cost-breaker state reads as ok

- **Raised by:** the wave-3 `G010-238-pin-breakers` fix round (pre-existing); re-measured on the
  landing branch from origin/main e1f659819 (chain probe `probe_cost_truncated.py`: tripped, then
  `ok` after truncating the state file to 20 bytes).
- **Problem:** `cost_budget._read_json` returns the default `{state: ok}` on `JSONDecodeError`
  (`cost_budget.py:89-95`), so `current_state` (`:122-127`), which `auto_action_gate` reads, clears
  the cost stop with no operator act. The failure breaker fails closed on unreadable evidence
  (ORPHAN-CRITICAL-418); the cost breaker does not.
- **Planned fix:** an unreadable or undecodable cost state is `tripped`. Deadline: 2027-01-18.

### ARIA-LOW-669 — the pin's P5 checks the audit row, not the write that clears a stop

- **Raised by:** the wave-3 `G010-238-pin-breakers` fix round (rejected as outside the plan's P5);
  re-read on the landing branch from origin/main e1f659819.
- **Problem:** P5 (`test_operator_approval_callers.py:230`) pins the governance kinds that record a
  raise. The writes that clear a stop (`circuit_breaker.py:557-560`, `cost_budget.py:324`) are not
  pinned, so a new writer that clears a breaker without writing the row passes.
- **Planned fix:** an AST detector of the clearing writes, allowed only inside RAISING functions,
  with the narrowing writers declared. Deadline: 2027-04-18.

### ARIA-LOW-670 — a breaker act binds to a state record that can lag the ledger

- **Raised by:** the independent verification of the ARIA order chain item `G010-238-pin-breakers`
  (round 1, security lens), on the landing branch from origin/main e1f659819.
- **Problem:** `trip_scope` reads `tripped_at` from `autonomous-state.json`
  (`circuit_breaker.py:502-524`). That record is rewritten in place. `record_failure` appends the
  failure row first (`:420`) and restamps the state afterwards, in a separate write (`:441-445`). A
  kill between the two leaves a new failure under the old stamp. The module re-derives its verdict
  from the ledger for exactly this reason (`:336-337`). The reviewer names a second path: a publish
  race or gap recovery that adopts a remote state file still showing the old stamp
  (`state_store.rebase_store_onto_remote`). In both cases an unspent act for the old trip still
  passes, and `reset_breaker` truncates a window that holds a failure the act never covered
  (`:557`). The evidence quarantine binds to the same scope.
- **Planned fix:** with ARIA-LOW-666/667, derive the instance from the evidence itself (the newest
  in-window failure row's `ts`, or a digest of the ledger). Read it under the ledger lock, then
  re-read and compare it under that lock before the write. Deadline: 2027-04-18.

### ARIA-LOW-726 — hand-rolled infrastructure readers remain beside the owners

- **Raised by:** the wave-3 `G017-012-rules` fix round 1 ("New findings"); re-read by the ARIA
  order chain on the landing branch from origin/main 95c452105.
- **Problem:** `tools/gates/lib/infra` is the one reader for nginx, NATS and compose files
  (ARIA-HIGH-012), but specs keep their own: `nats-invariants.spec.ts:169-251` locates the GENERATED
  sentinels by text (once since the ARIA-HIGH-012 landing) and reads users by regex;
  `parseNginxLocations` (`nginx-route-resolution.spec.ts:89`), `parseLocations`
  (`mobile-static-asset-fail-closed.spec.ts:35`) and `blockBody` (`mobile-csp-headers.spec.ts:40`)
  count braces over raw text; seven compose environment readers
  (`action-link-origin-deployment-contract.spec.ts:96`,
  `auth-frontend-url-deployment-contract.spec.ts:57`,
  `farm-environment-deployment-contract.spec.ts:66`, `admin-api-production-posture.spec.ts:40`,
  `public-service-edge-hardening.spec.ts:137`, `postgres-runtime-contract.spec.ts:97`,
  `e2e/helpers/env.helper.ts:91`). A comment, a quoted brace or a `username` key can make a spec
  and the owner judge the same file differently.
- **Planned fix:** move each spec onto `readNginx` / `readNatsConf` / `readYamlDocuments` +
  `composeEnvironment` and delete its reader in the same change. Deadline: 2026-11-15 (dated by that
  fix round).

### ARIA-LOW-727 — nats-invariants.yml does not re-run on main for four of its PR inputs

- **Raised by:** the wave-3 `G017-012-rules` implementation (new finding 1); re-read on the landing
  branch from origin/main 95c452105.
- **Problem:** `pull_request.paths` (`nats-invariants.yml:57-63`) lists
  `platform/libs/event-bus/**`, both e2e NATS specs and the workflow itself; `push.paths` for main
  (`:64-82`) lists none of them. A merge that changes only one of those files is never checked
  against the merged tree on main.
- **Planned fix:** one path list for both events (or a test that compares them), in the change that
  next owns the workflow (wave-3 `G044-314-*`). Deadline: 2027-04-19 (LOW ceiling).

### ARIA-LOW-728 — 118 of the 122 tracked files under infra/ are empty placeholders

- **Raised by:** the wave-3 `G017-012-rules` implementation (new finding 2); re-measured on
  origin/main 95c452105 (59 terraform, 44 kubernetes, 12 helm, 3 scripts; the 4 non-empty files are
  the three argocd manifests and `infra/kubernetes/apps/gateway-api/deployment.yaml`).
- **Problem:** the placeholders (`infra/terraform/environments/prod/main.tf`,
  `infra/kubernetes/apps/auth-service/deployment.yaml`, …) classify as infrastructure
  (`classify.ts:75`) and read as empty, so an observer that walks `infra/**` would count 118 files
  that configure nothing as observed and clean. The real IaC lives under `infrastructure/` and
  `deploy/`.
- **Planned fix:** delete the placeholders (or fill the ones a deploy path uses) and have the
  infrastructure-policy adapter (`G017-012-adapter`) report an empty file as unobserved. Deadline:
  2027-04-19 (LOW ceiling).

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
