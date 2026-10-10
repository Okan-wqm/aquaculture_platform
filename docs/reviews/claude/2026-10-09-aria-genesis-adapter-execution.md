# ARIA adapters execute unsandboxed with the runner's authority

Recorded 2026-10-09 from the independent security review of PR #1900
(`claude/aria-skill-genesis-validation`, head `fbfef05c5`), which wires
`skill_genesis.materialize_generated_adapter` into the skill-genesis drainer so
that an LLM-drafted adapter is written, checked and registered as a `SHADOW`
tool. The review's verdict was DO NOT MERGE; #1900 is a draft and has left the
landing train. The defects below are on `main` today or are introduced by
that wiring. Each one was reproduced by a probe against the #1900 tree. This
record exists so the fix lane has a registry row to close.

## Scope: every adapter execution, not only genesis-drafted adapters

The security review of #1898 (fixture refresh) found that the defect is not
specific to genesis. Every adapter the kernel executes runs as an ordinary
host process with the runner's full environment:

- `tool_runner.run_tool`, `aria-kernel/aria_kernel/tool_runner.py:133-148`,
  calls `subprocess.run(..., env=dict(os.environ))`.
- `fixture_runner`, `aria-kernel/aria_kernel/fixture_runner.py:608`, calls
  `subprocess.run(...)` with no `env=`, so the child inherits the parent's
  environment.

This applies to curated adapters under `tools/aria-adapters/` as much as to
generated ones. A curated adapter is reviewed code, but its dependencies and
inputs are not. ARIA-CRITICAL-399 therefore covers ALL adapter execution:

- a scrubbed environment, with an explicit allowlist that never includes a
  token, a key path or proxy credentials;
- the sandbox (no network, non-root uid, workspace bound read-only to the
  declared scope).

The genesis-specific items below still apply on top of that.

## ARIA-CRITICAL-399 — a generated adapter runs as an ordinary host process

**C1: no sandbox at execution.**

- A registered adapter runs through `tool_runner.run_tool`. At
  `aria-kernel/aria_kernel/tool_runner.py:133-148` that is a plain
  `subprocess.run(runner["argv"], env=dict(os.environ), shell=False)`.
- The child inherits the runner's uid (root on the droplet), the host
  network, and the whole cycle environment, including `GH_TOKEN` and the
  GitHub App private-key path.
- `skill_genesis_sandbox.execute_in_sandbox`
  (`aria-kernel/aria_kernel/skill_genesis_sandbox.py:180`) has no production
  caller.
- Probe `probe1900b`: a materialized adapter ran `id -u` as root, read an
  injected environment secret, and wrote outside its declared scope. Each of
  these happened during an ordinary `run_tool` call.

**C2: the import allowlist does not contain the code.**

- `verify_adapter_imports` (`skill_genesis_sandbox.py:114`) inspects only
  `ast.Import` and `ast.ImportFrom` nodes (lines 138-140).
- The probe found that all of the following pass the allowlist and reach the
  operating system:
  - `__import__('subprocess')`
  - `sys.modules['os']`
  - `exec` / `eval` / `compile` of a string
  - `getattr(sys.modules['builtins'], '__im' + 'port__')`
  - `os.path.os.system`
  - `open()` / `pathlib` writes anywhere

**C3: a SHADOW adapter can promote itself.**

- The adapter can start a detached child (`start_new_session=True`) that
  sleeps past the run's mutation check and then rewrites
  `aria-tools/registry.json`, setting its own status to `ACTIVE`.
- The run's envelope reports no repository mutation, and nothing detects the
  promotion (probe `probe1900c`).
- With scope `["**"]` or a narrow scope alike, the same adapter rewrote
  `.github/workflows/ci.yml` in the workspace (probe `probe1900d`).

**H1: Phase 2 calibrates the wrong bytes.** The authoring loop calibrates the
file named by the drafter's `draft_id`, not the bytes the materializer later
writes and registers. The adapter that passes calibration need not be the one
that runs.

**H2: the signature proves nothing about provenance.** The materializer writes
the adapter, computes the sha256 of the bytes it just wrote, stores that in
the bundle, and then `verify_adapter_signature` compares the file against that
bundle. Nothing re-verifies the hash at dispatch, and nobody other than the
writer ever attested to it.

**Further defects found by the same review:**

- Adapter and bundle writes follow symlinks and overwrite existing files.
  There is no `O_EXCL | O_NOFOLLOW`.
- A failure in `register_tool` after the write leaves the adapter and bundle
  behind.
- The manifest's read scope and timeout are not bound to the seed's
  envelope.

## What the fix lane must deliver

This is not started here; it is a separate lane, owner `claude`, deadline
2026-10-16. It must deliver:

0. Every adapter execution — `tool_runner` and `fixture_runner` alike, curated
   or generated — runs with a scrubbed, allowlisted environment and inside the
   sandbox. The genesis items below come on top of that.
1. Execution of every genesis-origin tool goes through the sandbox
   (`execute_in_sandbox` or its successor). That means no network, a
   scrubbed environment, a non-root uid, read-only workspace binds limited to
   the declared scope, and a writable scratch directory only. The keying is on
   the tool's genesis origin, which `tool_runner` must consult. It is not
   based on manifest fields the drafter controls.
2. Phase 2 calibrates the exact bytes that will be materialized. The bytes
   are hashed once and the same digest is checked at registration and at
   every dispatch.
3. Before a genesis adapter's first execution there is either real provenance
   (an attestation by a key the writer does not hold) or explicit operator
   approval.
4. Registry status changes are made only through the governed transition
   path. A process that a tool run started cannot write `registry.json`.
5. Adapter and bundle writes use `O_EXCL | O_NOFOLLOW`; a failure after any
   write removes everything that write created; the manifest's scope and
   timeout are bound to the seed.

Until that lane lands, #1900 stays a draft, and the genesis drainer must not
be given a materializer.
