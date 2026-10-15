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
