# ARIA — every adapter runs in a room that holds (2026-10-10)

Owner: claude (implementation), okan (review).

## ARIA-CRITICAL-399 — adapters ran unconfined with the runner's credentials (adapter-runtime scope)

### Symptom (ARIA-CRITICAL-399)

Every adapter run started as a bare child of the kernel:

- `tool_runner.run_tool` passed `env=dict(os.environ)` (`tool_runner.py:133-148` before this
  change);
- `fixture_runner.run_fixture_case` passed no `env=` at all (`fixture_runner.py:777-785`);
- `skill_genesis_sandbox.execute_in_sandbox` built its own bwrap argv, but chose it with
  `shutil.which`, fell back to firejail (which applied none of the read-only binds), bound the
  whole workspace and passed no `env=` either. It has no production caller.
- `skill_genesis.execute_adapter_against_corpus`, the LIVE genesis calibration run, passed no
  `env=` and had no room at all. It is the `SandboxFn` that
  `dispatcher_factory.select_sandbox_runner` (`:253-272`) returns, which the nightly
  orchestrator wires into convergent skill authoring (`autonomy_orchestrator.py:2014-2025` →
  `convergent_skill_authoring.py:474`). It is reached only by a `convergent=True` genesis
  request, which today only the operator CLI seeds, so it is latent rather than proven live.
  Found by `staging`'s review of d188cad26, which missed it.

On the nightly lane the cycle step holds `GH_TOKEN` (job token: contents, issues and
id-token write), the OIDC request variables and `GITHUB_ENV`. It also writes the GitHub App
private key to `$RUNNER_TEMP/aria-gh-app-private-key-<run>-<attempt>.pem`
(`aria-auto-cycle.yml`, "Run the nightly cycle"). The durable store is checked out inside the
workspace: on the runner it is
`/home/gharunner/actions-runner/_work/aquaculture_platform/aquaculture_platform/.aria-state-store`,
and `RUNNER_TEMP` is the sibling `_work/_temp`.

Reproduced on the unmodified runners (this branch's base, 2b8385600) with the probe adapter
added here (`tests/_helpers/adapter_room_probe.py`), in the runner's layout under `/var/tmp`.
Through `run_tool`, the probe:

- saw `GH_TOKEN`, `ACTIONS_ID_TOKEN_REQUEST_TOKEN`/`_URL`, `GITHUB_ENV`, `RUNNER_TEMP`,
  `GIT_CONFIG_COUNT`/`GIT_CONFIG_VALUE_0` and `ARIA_TOOLS_DIR`;
- read the App key file;
- saw 574 host processes, 4 of whose `/proc/<pid>/environ` carry `GH_TOKEN=`;
- listed the store;
- wrote into the workspace.

The fixture runner ran the same probe the same way (`crash`, exit 3: the probe's "I reached a
secret" code).

### Root cause (ARIA-CRITICAL-399)

There was no single place where an adapter is started. Three call sites each spawned the
adapter themselves, and each chose its own environment and containment. Scrubbing the
environment alone would not have closed this, for two reasons:

- the key is a file the same uid can read;
- every scrubbed name is still in the kernel's own `/proc/<pid>/environ` for any process that
  shares its PID namespace.

### Fix (tier 1: an adapter cannot be started outside the room)

`aria_kernel/adapter_room.py` is the one place adapter code starts:
`prepare_adapter_spawn` builds the run and `run_adapter` executes it. The tool runner, the
fixture runner, the genesis sandbox and the genesis calibration executor all go through it. It
reuses the owners that already exist:

- **Environment.** `validation_env.build_validation_env`, the closed allowlist the validation
  lane uses. Exactly two names are declared on top of it:
  - `NODE_OPTIONS`, carrying the manifest's heap. It is composed with the operator's flags, as
    the tool runner always did. The fixture runner never set it, so its Node adapters ran on a
    smaller heap than the nightly runs.
  - `ARIA_REPO_ROOT`, the workspace. The five Python adapters read it; until now they found
    the root by walking up from their cwd, which gives the same value.

  The envelope records the report by name (`runner.spawn_environment`). The published by-cycle
  row records `runner.sandbox_backend`.

- **Room.** `implementation_safety.wrap_bash_in_sandbox` with:
  - `allow_network=False`;
  - a read-only workspace (`write_scope=()`);
  - the command's toolchain prefixes bound read-only (`validation_executable_binds`) for its
    `argv[0]` and for `node` (banned-phrase is `python3` but spawns ts-node). A `.py` program
    outside the workspace is bound only under the argv policy's trusted prefixes (a kernel
    test helper), so a path an agent chose, such as a drafted adapter's `adapter_path`, is
    never bound;
  - the checkout's read-only git shape (`derive_git_containment(commit_capable=False)`);
  - `MANAGED_SPAWN_ISOLATION_FLAGS`: private PID, IPC and UTS namespaces, `--new-session` and
    `--die-with-parent`;
  - an empty tmpfs over the store (`.aria-state-store` and the run's tools root) and the
    signing keys (`signing_keys_dir`), and over `RUNNER_TEMP` should it ever lie inside the
    workspace.

  Any bind of the finished room that would contain an unmasked `RUNNER_TEMP` (toolchain,
  interpreter, dependency tree or git) refuses the room by name. The check reads the argv, so
  every builder's binds are covered. One new keyword
  on `wrap_bash_in_sandbox`, `chdir`, starts the room in the runner's cwd. It defaults to the
  workspace, so existing callers get a byte-identical argv (pinned), and a directory outside
  the workspace is refused.

- **No backend.** There is no mock exemption: `CLAUDE_CLI_MOCK` governs Claude spawns, and an
  adapter is real code in every mode. Without a verified backend:
  - a tool run is `environment_unavailable` (the adapter never starts and the tool is not
    quarantined, the existing precedent at `tool_runner.py:123-133`);
  - a fixture suite is refused with `adapter_sandbox_unavailable`, which
    `refresh_fixture_suites` records as `fixture_refresh_blocked`;
  - the genesis sandbox raises `SandboxUnavailable`;
  - the genesis calibration executor returns its zero-metrics result with `exit_code=-4` and
    `adapter_sandbox_unavailable` (the drafted adapter does not calibrate, so it cannot
    converge).

  A mock night on a host without bwrap completes as degraded and names the tool
  (`MockNightWithoutBackendTests`).

After the change, the same probe in the same layout passes as an `ok` run:

- no forbidden name in its environment;
- the key file is `FileNotFoundError`;
- 0 `/proc` leaks, with at most 3 pids visible;
- the store is empty;
- the workspace write and the network connect are refused;
- `cwd` is the runner's.

The genesis sandbox and the genesis calibration executor run a drafted adapter in the same
room. Before this fix, `staging`'s repro (`GH_TOKEN` and the OIDC token visible, the fake key
read) reproduced on d188cad26; after it, the drafted adapter sees neither name and the key is
refused.

### Deviation from the plan, with evidence: read-only workspace, not `write_scope=None`

`write_scope=None` binds the workspace writable, minus `READONLY_PATHS`. `node_modules` is not
in `READONLY_PATHS`, and it is gitignored, so the tool runner's `git status` mutation check
cannot see it. Measured with the same builder: an adapter running under `write_scope=None`
replaced `node_modules/.bin/ts-node`, and `git status --porcelain` stayed empty. Under
`write_scope=()` the same write died with `EROFS`.

A later step that runs outside any room would then execute the planted file. The cycle's
baseline validation at the trusted HEAD is unwrapped (`validation._run_one`, ARIA-HIGH-124
round 4 note). No shipped adapter writes the workspace (parity below).
`test_tool_governance.test_tool_runner_repository_mutation_cannot_land` replaces the
"mutation quarantines" pin. The write now cannot land, so the run is the adapter's crash. The
post-run detector stays as a second line.

### Parity: all 15 registered adapters, in the room vs the pre-399 spawn

| Adapter                        | Exit room / ctrl | Findings | Observations | read_paths | evidence_sources | stdout identical | Seconds room / ctrl |
| ------------------------------ | ---------------- | -------- | ------------ | ---------- | ---------------- | ---------------- | ------------------- |
| agent-harness-security-adapter | 0 / 0            | 49       | 0            | 656        | 46               | yes              | 2.2 / 3.1           |
| banned-phrase-adapter          | 0 / 0            | 16       | 16           | 12         | 12               | yes              | 5.6 / 5.2           |
| bundle-budget-adapter          | 0 / 0            | 10       | 10           | 1915       | 1915             | yes              | 1.0 / 0.8           |
| cqrs-adapter                   | 0 / 0            | 6        | 0            | 92         | 3                | yes              | 0.3 / 0.2           |
| doc-staleness-adapter          | 0 / 0            | 250      | 333          | 1608       | 1608             | yes              | 1.1 / 1.0           |
| dual-alias-adapter             | 0 / 0            | 0        | 0            | 223        | 0                | yes              | 0.2 / 0.1           |
| event-contracts-adapter        | 0 / 0            | 0        | 254          | 76         | 0                | yes              | 5.7 / 5.7           |
| fe-dto-parity-adapter          | 0 / 0            | 0        | 0            | 2458       | 2458             | yes              | 6.2 / 6.6           |
| kernel-dead-wire-adapter       | 0 / 0            | 12       | 7            | 428        | 428              | yes              | 1.2 / 1.2           |
| outbox-adapter                 | 0 / 0            | 15       | 0            | 3102       | 12               | yes              | 2.4 / 1.9           |
| security-boundary-adapter      | 0 / 0            | 13       | 1722         | 5950       | 7                | yes              | 12.1 / 14.4         |
| typeorm-entity-schema-adapter  | 0 / 0            | 0        | 4282         | 397        | 0                | yes              | 2.0 / 1.9           |
| tenant-scoping-adapter         | 0 / 0            | 49       | 5309         | 4145       | 17               | no, see below    | 41.9 / 22.8         |
| test-gap-adapter               | 0 / 0            | 220      | 2623         | 7782       | 220              | yes              | 101.8 / 99.7        |
| lint-rules-adapter             | 0 / 0            | 5654     | 1            | 5746       | 5746             | yes              | 323.2 / 486.3       |

All 15 registered adapters exit 0 in both modes, with identical finding, observation, read-path
and evidence-source counts (the table shows one column per count because the two sides are
equal). 14 of 15 outputs are byte-identical.

tenant-scoping differs in one field: `metadata.observations_truncated.tenant_repository_call`
is 6762 in the room and 6776 outside. Each side was deterministic over two runs. The cause is
this host, not the room:

- The adapter type-checks with `ts.createProgram` (NodeJs resolution,
  `tenant-scoping-adapter.ts:490`), so it follows imports into `node_modules`.
- In this worktree `node_modules` is a symlink into `.worktrees/lineage-attest`. Its workspace
  links (`@aquaculture/testing -> ../../libs/testing`, and 25 more) therefore resolve OUTSIDE
  the room into another worktree's `libs/`, `web/`, `tools/` and `mcp/`, a different revision.
  Inside the room they dangle.
- With those four directories also bound read-only, the room's output is byte-identical to the
  control. On the runner, `node_modules` is a real directory and its links resolve inside the
  workspace.

Duration: the first tenant-scoping pair ran at load average 12 on 8 cores. Re-measured in
alternating pairs: room 57.9, 31.1, 33.5 and 19.5 s against control 34.8, 28.8, 39.8 and
31.0 s. The room adds no systematic cost. The adapter's budget is 420 s, so even the slowest
run used 14% of it. lint-rules, the largest adapter, took 323 s in the room and 486 s outside,
under the same load, against its 1500 s budget.

Where ts-node and Node write: the control run (pre-399 spawn, `HOME` and `TMPDIR` pointed at
empty directories) writes nothing under `HOME` or into the workspace or `node_modules`. The
TypeScript adapters and banned-phrase write the V8 compile cache of ts-node's
`v8-compile-cache-lib` to `$TMPDIR/v8-compile-cache-0/`. In the room, `TMPDIR` is the room's
own `/tmp` tmpfs, so the cache is per-run and discarded. tools/gates/tsconfig.json sets
`transpileOnly`, so there is no tsc incremental output. lint-rules runs ESLint with
`cache: false`.

The control's "workspace writes" were other agents editing this shared worktree at the same
time (`findings.jsonl`, `cycle.py`); no adapter wrote there.

Local adaptation: this worktree's `node_modules` is a symlink into a sibling worktree, and the
shared builder's nested-checkout dependency binds would mount `/var/aqua-saas/node_modules`
over it. For the parity run only, those binds were disabled and the symlink target was bound
read-only. On the runner both are no-ops: its workspace `node_modules` is a real directory, and
no ancestor of the workspace has one (checked up to `/`).

### Seams

`tests/test_adapter_room_seams.py` pins only the functions that start untrusted code, not the
whole kernel. Each seam (`run_tool`, `run_fixture_case`, `execute_in_sandbox`,
`execute_adapter_against_corpus`) must call
`prepare_adapter_spawn` and `run_adapter`, and must start no process of its own. The room has
exactly one process start, and its `env` is the built environment. The other two seams that run
repository or agent code were already pinned and are unchanged:

- validation: `test_validation_env.test_validation_module_reads_os_environ_only_as_the_builder_base`;
- agent spawns: `I_V12_ENV_03`.

The nightly lane must verify the backend whatever the mock mode, because a mock night still runs
every adapter. `notify` dropped the `effective_mock` clause from the "Ensure a verified
sandbox backend" step in 5b3970b05, using the wording agreed with `security`.
`LaneProvisioningTests` pins it from the second PR-2 commit on, so no commit carried a red test.

`state_store` is not touched. Its push identity rides `GIT_CONFIG_*` on purpose (yml publish
steps).

### Not done here

- The genesis items of 399 are split into **ARIA-HIGH-414** (OPEN, deadline 2026-10-31):
  - import-allowlist bypass by dynamic import;
  - H1/H2: calibration and dispatch not bound to the materialised bytes;
  - symlink-following writes and missing cleanup;
  - scope and timeout not bound to the seed;
  - promotion authority.

  The room now contains a drafted adapter at run time. Its env and key reach, network access,
  workspace or registry rewrite, and detached children are all closed. What stays open is
  whether those bytes should run at all.

- E2 (`MANAGED_SPAWN_ALLOW_NETWORK=True` for the implementer) and E3 (ARIA-HIGH-272) are
  unchanged and tracked in the plan's deferral table.
- A workspace nested under a checkout that has its own `node_modules` gets the parent's tree
  mounted over its own (`dependency_tree.installed_checkout` does not ask whether the
  workspace already has one). This is the shared builder's behaviour for request worktrees. It
  does not reach the runner (no ancestor `node_modules`), and it is reported here, not changed.
  Consequence on this repair host only: in a worktree whose `node_modules` is a symlink
  (`.worktrees/aria-repair-1`), every room, the validation room included, aborts with
  `bwrap: Can't bind mount /oldroot/var/aqua-saas/node_modules on …/node_modules`. So
  `test_adapter_fixture_evidence_contract.test_every_shipped_suite_runs_ok_through_the_evidence_validator`
  is red in this layout. It runs green where the tree is installed in place: in CI after
  `npm ci`, and on the runner. The new tests build their workspaces under `/var/tmp`, so they
  are unaffected.

- ARIA-HIGH-234 stays OPEN. A `gh` call inherits the `GIT_CONFIG_*` push credential triple
  (evidence below). `notify` traced the call the named test catches to `pr_manager.py:805-818`
  (`create_env = {**os.environ, ...}` for `gh pr create`), not to `GhCliIssueWriter`, and in CI
  the triple is set only as the publish/restore/release steps' own env. `main` recorded the
  residual against ARIA-HIGH-234.

## ARIA-HIGH-234 — push leg fixed by #1676, a `gh` residual remains (registry decision: `main`)

The rule is that a push carries exactly the identity the kernel chose for it.
`git_containment._publish_environment` (`git_containment.py:667-683`, #1676) drops
`GIT_CONFIG_COUNT`, `GIT_CONFIG_PARAMETERS` and every `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`
before the kernel's own git calls.

Evidence, run in this slot on this branch:

- `test_git_containment.test_ambient_git_config_injection_is_not_inherited` passes with the
  triple set in the environment.
- The finding's named test,
  `test_implementation_delivery.test_a_lane_that_cannot_mint_at_the_push_is_refused_at_the_credential_stage`,
  passes on a clean host.
- With the triple set (`GIT_CONFIG_COUNT=1`, `KEY_0=http.https://github.com/.extraheader`,
  `VALUE_0=AUTHORIZATION: basic …`), the same named test passes its push assertion: the
  push's credential names are exactly `["GH_TOKEN"]`. It then fails at
  `test_implementation_delivery.py:1688`: the `gh` call's credential names are
  `["GH_TOKEN", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]`.

So the push leg is fixed. The `gh` leg still inherits the ambient triple: the call the named
test catches is `gh pr create` with `create_env = {**os.environ, ...}` (`pr_manager.py:805-818`).
That is not a git call the kernel makes, but it is the residual the named test catches on a host
that sets the triple. Whether HIGH-234
closes, or this residual is recorded against it, is `main`'s registry decision. It is reported
here and not changed, because it is outside the adapter seams.

## Integration and security review of the whole stack (main, 2026-10-10)

Fixed in the follow-up commit:

- **Trusted program check.** The room bound a program under a trusted prefix by substring, so
  `/tmp/x/tools/aria-poc/evil.py` passed. It now requires the path to be under this checkout's
  root, with the prefix at the start of its checkout-relative path.
- **More directories hidden.** The room now also hides the request worktrees
  (`<checkout>/aria-worktrees`, where an implementer's signing keys sit until they are revoked)
  and the tools root the kernel resolves for the process even when no `store` is passed (genesis
  passes none; off CI that root holds `secrets/`).

Recorded, not changed here:

- **ARIA-HIGH-431:** the implementer's command policy uses the same substring trust
  (`implementation_safety.py:571-575`). The fix must anchor to the implementer's worktree root,
  which that function does not receive today.
- **ARIA-MEDIUM-432:** the room hides a fixed list of directories and shows the rest of the
  workspace. A tracked-files view is the tier-1 fix. bwrap should also be launched by its
  absolute path.

## ARIA-HIGH-414 — drafted adapter bytes: allowlist, custody, provenance, promotion (genesis, wave 2)

### Symptom (ARIA-HIGH-414)

Reproduced on this branch at 314c6a18e (`scratchpad/genesis/repro/head_repro.py` against
`git archive HEAD`):

- **H1 is live on main.** The nightly calibration (`autonomy_orchestrator.py:2101-2116` →
  `skill_genesis_drainer.py:299` → `convergent_skill_authoring.py:474` →
  `dispatcher_factory.select_sandbox_runner`) ran `adapter_path or draft_id`.
  `_normalize_drafter_response` never sets `adapter_path`, so it ran `python3 <draft_id>`, a path
  the drafter wrote. With `draft_id = "decoy.py"` the run printed the decoy's marker. The drafted
  `adapter_source` never executed, and `authored_validated` would have certified the decoy. (The
  2026-09-25 read-through, `docs/aria/reviews/2026-09-25-aria-tam-okuma/B04.md` item 2, saw the
  missing `adapter_path`.)
- **The allowlist did not hold.** `verify_adapter_imports` PASSED these spellings:
  - `import os.path` (allowlisted as written, and it binds `os`);
  - `pathlib.os.system`;
  - `gi_frame.f_builtins['__import__']`;
  - `__import__('subprocess')`;
  - `sys.modules['os']`.

  An adapter that passed it then started a process inside the room (`os.system` printed
  `ran-a-process-2`).

- **H2.** `verify_adapter_signature` returned True for swapped bytes that the same writer re-hashed.
  It had no dispatch-time caller (`control-reachability.dormant.json`, ORPHAN-HIGH-573).
- **Promotion.** A SHADOW tool carrying drafted code reached ACTIVE on the auto-promote token alone
  (`transition_tool`, token verifier mocked), and `last_transition` named no operator.
- The #1900 materializer's own defects are recorded above (2026-10-09): symlink-following writes,
  no cleanup when `register_tool` failed, the drafter's scope and timeout kept. It also wrote the
  adapter into the workspace, which the runner's checkout cleans every night while the registry
  row lives on.

Production (aria/state f5c5c86a1): 20 skill-genesis requests, all `convergent=false`; 15
curated tools, 0 genesis tools. Latent, never run.

### Root cause (ARIA-HIGH-414)

Nothing owned the drafted bytes. Each step re-derived them from something the drafter wrote:

- calibration used a path;
- materialization used a dict field;
- the signature used a hash the writer computed;
- dispatch used the manifest's argv.

The allowlist was a name check over a language that reaches modules without names.

### Decision (a): an AST-complete deny cannot hold for Python, so enforce at runtime

A name-based deny cannot be complete:

- the four spellings above use no import primitive;
- `functools.singledispatch` evaluates a string annotation;
- importing the allowlist itself preloads `os`, `posix`, `importlib`, `marshal` and
  `urllib.parse` (11 forbidden-root modules, measured under `python3 -I -S`).

The allowlist is therefore enforced where every spelling converges. Every drafted adapter runs
only under `tools/aria-poc/genesis_adapter_launcher.py`, inside the room. The launcher:

1. checks sha256(bytes) against the digest on its command line;
2. imports exactly the allowlist (+ `_strptime`);
3. deletes `_imp`'s native constructors (`create_builtin` raises no audit event, and this
   interpreter builds `_posixsubprocess` and `_socket` in);
4. installs a PEP 578 audit hook that refuses:
   - every further module load;
   - process creation, threads and tracing;
   - a second hook;
   - re-pointing a function's `__code__`;
   - any write-open (a writable `/proc/self/mem` would patch the hook away);
5. only then compiles the bytes.

The static check stays as the early, named refusal (+ `import a.b` binding `a`, the dynamic
primitives, `sys.modules`), documented as not the boundary.

Pinned: 22 spellings in `BYPASS_SPELLINGS`. Each runs through the launcher directly on every
host, and again through `run_staged_adapter` in a real bwrap room. Three of them pass the
static check and are refused at runtime
(`test_spellings_no_ast_walk_can_see_pass_it_and_the_launcher_refuses_them`).

### Fix (b)(c)(d): one owner of the bytes, `aria_kernel/genesis_adapter_custody.py`

- **Provenance.** The bytes come only from the primary drafter's ACCEPTED result:
  `dispatcher_factory.accepted_response` re-reads the sealed artifact and checks it against the
  row's `output_hash`. All 569 accepted rows in f5c5c86a1 carry one. The draft dict's
  `adapter_path`, `draft_id` and `_workspace_root` are never read. The workspace and store are
  the loop's.
- **Calibration** runs those bytes through the launcher and records the digest it ran
  (`skill-genesis/sandbox.jsonl`, `kind: adapter_calibration`, with the provenance).
- **Materialization** (`materialize_drafted_adapter`, wired as the drainer's `materialize_fn`;
  supersedes #1900) refuses unless:
  - the recorded calibration row named by the round's `calibration_ledger_hash` ran these exact
    bytes;
  - that row came from this drafter result;
  - the row passed on its own recorded numbers.

  The kernel binds scope, `allowed_read_globs`, runner, timeout (seed `timeout_ms`, else
  300 s), health thresholds, owner, kind and status. Health thresholds: a drafted `precision_min`
  would set its own bar, and the `{min,max}` range shape crashed `tool_health` on the first
  run.

  No adapter file is written. The bytes live in a hash-chained custody row
  (`skill-genesis/materializations.jsonl`), so nothing can follow a symlink. A refused
  registration appends a `withdrawn` row.

- **Dispatch.** `tool_runner.run_tool` and `fixture_runner.run_fixture_case` call
  `verify_genesis_dispatch`. A tool is a genesis tool if the kernel holds custody of it or its
  runner names the launcher. Such a tool runs only when:
  - its registered runner equals the custody runner;
  - its custody bytes hash to the custody digest;
  - that digest is the calibration's.

  The kernel's own launcher runs them, never a workspace copy. The run envelope records
  `runner.genesis_adapter_sha256`.

- **Promotion.** `transition_tool` (SHADOW → ACTIVE) calls `verify_genesis_promotion` among its
  structural gates, so no operator act is spent on a refusal. The custody must verify, and the
  authority must be an operator act or the panel token. The auto-promote token alone is refused.

  First runs (calibration, SHADOW) need kernel-recorded provenance. ACTIVE needs the existing
  operator or panel authority. This is main's ruling on the stub's "provenance or operator
  approval".

- **Python only.** `adapter_lang` other than python is refused at the seed and at staging. The
  allowlist exists for Python only. The drafter contract says so
  (`.claude/agents/aria-primary-drafter.md`).
- **Removed.** `skill_genesis_sandbox.execute_in_sandbox` (it ran a drafted adapter by file path)
  and `verify_adapter_signature` (a self-written hash). Their dormancy waivers went with them,
  and with `verify_adapter_imports` and `validate_generated_adapter`, which are now wired.
- **Adjacent.** The calibration scorer no longer raises `AttributeError` on an adapter whose
  stdout is JSON but not `{"findings": [...]}`; that is now a named shape refusal.

### Not done

- `cycle_phases/memory.py:23-27` still describes a `execute_in_sandbox` dispatch in its docstring.
  The function never existed on that path (B04 N14). It is not my file, so I am reporting it here.
- `validate_generated_adapter` still asks for `{min,max}` threshold ranges that `tool_health` cannot
  read. Genesis now binds thresholds, so the shape never reaches a registry row. The rule itself
  is unchanged.
- The calibration corpus reader scores only `label`. `finalize_corpus` writes `verdict` and
  `legacy_label`, so a finalized corpus scores every prediction as a false positive. That fails
  closed, and it is reported here, not changed.

## Wave 2 (sandbox, 2026-10-10): ARIA-HIGH-431 and ARIA-MEDIUM-432 fixed

### ARIA-HIGH-431: trusted repo code is anchored to the checkout's root

#### Symptom (ARIA-HIGH-431)

Measured on 0b88b2ccb through `hooks.decide_pre_tool`, the gate the implementer's Bash
actually meets, with the workspace set to the checkout:

- **Allowed:**
  - `python3 /tmp/x/tools/aria-poc/evil.py`;
  - `python3 <checkout>/apps/x/tools/aria-poc/e.py`;
  - `python3 /etc/x/aria-kernel/tests/_helpers/e.py`;
  - `python3 <checkout>/tools/aria-poc/../../apps/x/tools/aria-poc/e.py`.
- **Refused:**
  - `python3 tools/aria-poc/poc.py --help`, which is `command_policy`'s own allow
    example (`command_policy.py:180`), with "python runner cwd must be workspace-relative";
  - every other relative trusted script.

The gate was exactly backwards.

#### Root cause (ARIA-HIGH-431)

`verify_bash_command_allowed`'s `cwd` meant two things, depending on the caller:

- `hooks.py:135` and the hard-fail check (`implementation_safety.py:2390`) passed the
  absolute checkout root.
- `tool_runner`, `fixture_runner` and `tool_registry` passed the runner's checkout-relative
  cwd.

The function never received a root. So it trusted an absolute path by substring, and it
refused every relative path whenever the root came in as `cwd`.

The write scope is not the hole. All three trusted prefixes sit under `READONLY_PATHS`
(`tools/aria-poc/`, `tools/aria-adapters/`, `aria-kernel/tests/`). Those are ro-bound in
the implementer's sandbox and refused by the Edit/Write hook, so an implementer cannot
create a file under a trusted prefix of its own checkout.

#### Fix (tier 1: an untrusted path cannot carry a trusted spelling)

- `verify_bash_command_allowed(argv, *, cwd=".", checkout_root=None)`: `cwd` is always
  checkout-relative, and `checkout_root` is the caller's own fact.
- `implementation_safety.trusted_python_script` is the one owner of the rule. The argv
  policy and the adapter room's program bind both ask it; the room's own copy at
  `adapter_room.py:169-172` is gone. The rule:
  - the path relative to the root must start with a trusted prefix, with no `..`;
  - the resolved path must answer the same, so a symlink cannot carry the trust elsewhere;
  - an absolute path with no root is refused by name.
- `FORBIDDEN_ABSOLUTE_PYTHON_SCRIPT_PREFIXES` is gone, because the anchor subsumes it.
- Callers:
  - The hook passes the broker's own workspace (`hook_broker.serve_hook_broker`, from the
    settings the kernel compiled), never a path from the payload. The command runs at
    that root, because `cd` is not in the policy (`cd apps` is refused, measured).
  - The hard-fail check passes `context.workspace_root`.
  - `tool_runner`, `fixture_runner` and `tool_registry` pass
    `implementation_safety.KERNEL_CHECKOUT_ROOT`. An adapter's absolute program is
    trusted only as the running kernel's own code, the rule the room already bound by.
    The constant moved there from `adapter_room`.
  - `verification_gate` passes no root, so it refuses absolute programs.

Consequence: the implementer may now run `python3 tools/aria-poc/poc.py --help`, as the
policy always stated.

#### Evidence (ARIA-HIGH-431)

- `tests/test_python_script_trust.py`, run against 0b88b2ccb's kernel: 6 of the 8 gate
  subtests fail. The reviewer's four repros are allowed and the two relative trusted
  scripts are refused (`scratchpad/sandbox/red-head.log`). On this change all of them pass.
- The invariant `TrustedPrefixesAreReadOnlyTests` pins that every trusted prefix is a
  tracked directory under a `READONLY_PATHS` entry.

### ARIA-MEDIUM-432: the adapter room shows what git tracks

#### Fix (tier 1: what git does not track is not in the room)

`aria_kernel/workspace_view.py` assembles the room's workspace from git's own listing:
`ls-files --stage` plus `ls-files --others --directory`. It uses hermetic git (no
caller `GIT_*`, no fsmonitor, no untracked cache). That helper moved there from
`fixture_runner._git`, so there is one owner. The view is built like this:

- an empty tmpfs at the workspace path;
- each tracked top-level entry bound read-only into it (a tracked symlink is recreated as
  a symlink);
- every untracked path beneath a bound entry covered:
  - a directory by an empty tmpfs;
  - a file by `/dev/null`, so its name stays and opening it is refused, because the bind is
    `nodev`;
- `.git` bound;
- the root remounted read-only after the last mount inside it.

`_sandbox_argv(workspace_view=...)` uses the view in place of the workspace bind and the
`READONLY_PATHS` overlays. Each overlay re-binds a host path whole, `.env` among them, and
a view is read-only by definition (`write_scope` must be `()`).

The installed dependency trees come back where the adapters resolve them
(`_view_dependency_binds`):

- **A workspace whose tree is installed in place** (the runner) gets its own trees from
  their resolved source. Nothing is created in them.
- **A nested workspace** gets the ancestor checkout's tree, exactly as every other room
  binds it.

The fixed list of directories (`_masked_directories`) is gone. The store, the request
worktrees, the tools root's ledgers and `secrets/`, the signing keys and a `RUNNER_TEMP`
inside the workspace are hidden because git does not track them. Two refusals remain:

- a workspace that IS a private root is still refused by name;
- a bind that would contain an unhidden `RUNNER_TEMP` is still refused.

A workspace that is not a git checkout has no view, so it gets no room
(`adapter_room_workspace_view_not_a_checkout`). A submodule is refused as well, because
its untracked files are another repository's answer.

Test fixtures that ran adapters in a bare directory, or in one with an empty `.git/`
standing in for a checkout, are real checkouts now. They use one new helper,
`tests/_helpers/git_fixtures.track_existing`, which tracks only the named paths, so a store
inside stays untracked as on the runner. The fixtures are:

- `test_tool_governance`;
- `test_doctor.ToolsOrgan`;
- `test_incremental_learning`;
- `test_fixture_dir_state_store_layout`;
- `test_fixture_runner_row_cap`;
- `test_tool_runner_inline_row_cap`;
- `test_adapter_room`'s `RunnerLayout`.

bwrap is now launched by the absolute path the kernel resolved
(`implementation_safety._bwrap_executable`):

- only absolute `PATH` entries are searched, on the kernel's `PATH`;
- the probe and every room exec that path.

A bare `bwrap` in the argv used to be resolved again at exec time on the child's `PATH`,
because `subprocess` with `env=` searches that environment. So the probe could verify one
binary while a room ran another. Six tests that pinned `argv[0] == "bwrap"` now pin an
absolute path ending in `bwrap`.

#### Evidence (ARIA-MEDIUM-432)

- **Red at 0b88b2ccb.** Two live tests fail, the first with the probe's `crash` (exit 3):
  - `test_what_git_does_not_track_is_not_in_the_room_and_what_it_tracks_is`: the room read
    a gitignored `.env`, `certs/server.pem`, `src/local.key`, `deploy/prod/secret.yaml`
    and an untracked note (all `reached`);
  - `test_a_symlinked_tree_is_mounted_in_place_and_resolves_into_this_checkout`: the
    symlinked tree's workspace link dangled.
- **Green on this change.** The secrets are refused, while the tracked `src/app.ts`, the
  tracked `deploy/prod/values.yaml` and `node_modules` are read. A symlinked tree is
  mounted in place, and its relative workspace link resolves into THIS checkout's
  `libs/`.
- **Cost, measured on this host.** Building the view runs two git listings (about 50 ms).
  A `bwrap /bin/true` with the view (140 mounts) takes 138-140 ms, against 18-19 ms for the
  whole-workspace bind. One bind per tracked file was measured too and rejected: 1,598
  binds took 6.7-7.3 s per start, because bwrap re-reads the mount table on every bind.
  A copy of HEAD would be 137 MB per run.

#### Parity: all 15 registered adapters, old room vs the tracked view

Run back-to-back per adapter on this worktree. The old room is 0b88b2ccb's, with wave 1's
local adaptation for the symlinked `node_modules`. The new room runs unadapted.

| Adapter                        | Exit old / new | Findings | Observations | read_paths | evidence_sources | stdout identical | Seconds old / new |
| ------------------------------ | -------------- | -------- | ------------ | ---------- | ---------------- | ---------------- | ----------------- |
| agent-harness-security-adapter | 0 / 0          | 49       | 0            | 657        | 46               | yes              | 2.19 / 2.67       |
| banned-phrase-adapter          | 0 / 0          | 16       | 16           | 12         | 12               | yes              | 4.75 / 4.88       |
| bundle-budget-adapter          | 0 / 0          | 10       | 10           | 1915       | 1915             | yes              | 1.05 / 1.06       |
| cqrs-adapter                   | 0 / 0          | 6        | 0            | 92         | 3                | yes              | 0.31 / 0.46       |
| doc-staleness-adapter          | 0 / 0          | 250      | 333          | 1615       | 1615             | yes              | 1.28 / 1.32       |
| dual-alias-adapter             | 0 / 0          | 0        | 0            | 223        | 0                | yes              | 0.22 / 0.25       |
| event-contracts-adapter        | 0 / 0          | 0        | 254          | 76         | 0                | yes              | 6.02 / 2.31       |
| fe-dto-parity-adapter          | 0 / 0          | 0        | 0            | 2458       | 2458             | yes              | 3.58 / 3.50       |
| kernel-dead-wire-adapter       | 0 / 0          | 12       | 7            | 429        | 429              | yes              | 0.89 / 1.21       |
| outbox-adapter                 | 0 / 0          | 15       | 0            | 3102       | 12               | yes              | 1.89 / 1.77       |
| security-boundary-adapter      | 0 / 0          | 13       | 1722         | 5950       | 7                | yes              | 9.84 / 10.39      |
| typeorm-entity-schema-adapter  | 0 / 0          | 0        | 4282         | 397        | 0                | yes              | 1.43 / 1.80       |
| tenant-scoping-adapter         | 0 / 0          | 49       | 5309         | 4145       | 17               | no, see below    | 28.70 / 16.45     |
| test-gap-adapter               | 0 / 0          | 220      | 2623         | 7782       | 220              | yes              | 66.34 / 67.47     |
| lint-rules-adapter             | 0 / 0          | 5654     | 1            | 5746       | 5746             | yes              | 238.51 / 258.39   |

All 15 exit 0 with identical counts. 14 of the 15 outputs are byte-identical.

tenant-scoping differs in the one field wave 1 traced to this host:
`metadata.observations_truncated.tenant_repository_call` is 6762 in the old room and 6776 in the
view. The view's output is byte-identical to the unconfined control (the pre-399 spawn, same
run). Wave 1 attributed the 14 to the symlinked tree's workspace links, which dangled in the
old room. The view mounts the tree at the workspace's own path, so they resolve, now
inside the room.

The room has 186-188 mounts where the old room had 68; the number rises with each
untracked path a concurrent session adds. The durations stay within the host's load noise
(load 2-3 on 8 cores).

#### Semantics, and what is not done

- **The view is what git TRACKS, not what it does not ignore.** On a dirty operator
  checkout, an untracked file that is not ignored is in the snapshot's `allowed_paths`
  (`snapshot.py` working-tree mode lists `--others --exclude-standard`) but not in the room.
  Opening it is refused, as for any covered file. On the runner, the reset step's
  `git clean -ffdx -e node_modules` (`aria-auto-cycle.yml`) leaves no such file.
  Narrowing the snapshot to the same set is `snapshot.py`'s owner's decision, and it is
  recorded here, not changed.
- **A path created after the listing**, inside a bound directory, is visible until the
  room exits. The listing is taken immediately before the spawn.
- **The validation room and the implementer room are unchanged.** In a worktree whose
  `node_modules` is a symlink they still abort on the ancestor's tree. Adapter rooms no
  longer do: their own tree is bound in place.

### Peer review (sandbox) of fa29eea45 + bcf211fcc, and the fix

- **Confirmed: drafted bytes could build a code object.** CPython does not verify bytecode.
  `f.__code__.replace(co_code=…)` with an out-of-bounds `LOAD_CONST` was a SIGSEGV under the
  launcher (rc -11, reproduced on bcf211fcc). An out-of-bounds read is the known road to fake
  objects and native code, which no audit hook sees. `marshal.loads` also returned a code object.
  The launcher now also refuses `code.__new__` (`CodeType`, `code.replace`), `marshal.loads` and
  `marshal.load`. `_imp.get_frozen_object` raises `marshal.loads` too, and turns the refusal
  into its own "is invalid" ImportError. `compile()` raises `compile`, so the launcher's own
  compile and the stdlib's `exec` (dataclasses) still work. Pinned as bypass spellings
  `crafted_bytecode`, `code_type_constructor`, `marshal_loads` and `frozen_object_unmarshal`
  (`test_the_frozen_object_refusal_is_the_hook` shows the same call returns a code object
  without the launcher).
- **Overstated claim, corrected.** "Refuses every further module load" was too strong. The
  `import` event fires for `__import__`/`importlib` on a name not yet in `sys.modules`. A loader
  object can re-run a pure-Python stdlib file without it. That gains no capability: the native
  constructors are gone, so a re-run file has only the already-loaded C modules, whose levers
  are audited, and a file that needs another C module is refused at that import
  (`loader_runs_subprocess_source`). The launcher and `skill_genesis_sandbox` docstrings now say
  what holds: the adapter's native code is the C modules the allowlist loaded.

sandbox's re-review of 94501f67e confirmed the fix and left two notes, both closed in the next
commit:

- The loader pin (`loader_runs_subprocess_source`) was green for the wrong reason: it reached
  subprocess's cached `.pyc` and stopped at `marshal.loads`. It is replaced by
  `source_rerun_of_subprocess`, which compiles the source and stops at `import signal`
  (`genesis_adapter_import_refused:signal`).
- `_imp.init_frozen` still built a module from the interpreter's frozen bytecode with no import
  event. That bytecode is trusted and pure Python, so the capability was the same, but it was
  still a module load. The launcher now deletes `init_frozen` and `get_frozen_object` along with
  the native constructors (pinned: `frozen_module_build`, `frozen_object_unmarshal`).

## ARIA-HIGH-433 — calibration handed the adapter its answer key (genesis, wave 2)

### Symptom (ARIA-HIGH-433)

`execute_adapter_against_corpus` piped every fixture whole to the adapter
(`skill_genesis.py:410`, `json.dumps({"fixtures": fixtures})`, labels included). It then scored
the adapter against the same `label` field (`:457-462`). On HEAD 314c6a18e, an adapter that
printed the fingerprints labelled `tp` scored precision 1.0 and recall 1.0 on a 2 TP / 2 FP
corpus. That is the loop's structural exit (`convergent_skill_authoring.py:530-536`).

### Fix

`skill_genesis.calibration_fixture_view` projects each fixture onto
`CALIBRATION_FIXTURE_VISIBLE_FIELDS`. It is an allowlist of location fields, so a label field
added later is withheld too. `label`, `verdict`, `legacy_label`, `labeled_at`, `severity` and
`note` stay kernel-side for scoring. Pinned by `tests/test_genesis_calibration_answer_key.py`:
the echo adapter sees `evidence_refs`, `finding_fingerprint` and `finding_id`, and scores
0.0/0.0.
