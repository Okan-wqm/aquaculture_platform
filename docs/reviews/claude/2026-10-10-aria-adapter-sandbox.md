# ARIA — every adapter runs in a room that holds (2026-10-10)

Owner: claude (implementation), okan (review).

## ARIA-CRITICAL-399 — adapters ran unconfined with the runner's credentials (adapter-runtime scope)

### Symptom

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

### Root cause

There was no single place where an adapter is started. Three call sites each spawned the
adapter themselves, and each chose its own environment and containment. Scrubbing the
environment alone would not have closed this, for two reasons:

- the key is a file the same uid can read;
- every scrubbed name is still in the kernel's own `/proc/<pid>/environ` for any process that
  shares its PID namespace.

### Fix (tier 1: an adapter cannot be started outside the room)

`aria_kernel/adapter_room.py` is the one place adapter code starts:
`prepare_adapter_spawn` builds the run and `run_adapter` executes it. The tool runner, the
fixture runner, the genesis sandbox and the genesis calibration executor all go through it. It reuses the owners that already
exist:

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

- ARIA-HIGH-234 stays OPEN. `GhCliIssueWriter`'s `gh` calls inherit the `GIT_CONFIG_*` push
  credential triple (`github_adapters.py:267`, evidence below). That class is outside the adapter
  seams, and `main` has routed the residual to `notify`, who already edits it.

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

So the push leg is fixed. The `gh` leg still inherits the ambient triple:
`github_adapters.py:267` runs `gh` with no `env=`. That is not a git call the kernel makes, but
it is the residual the named test catches on a host that sets the triple. Whether HIGH-234
closes, or this residual is recorded against it, is `main`'s registry decision. It is reported
here and not changed, because it is outside the adapter seams.
