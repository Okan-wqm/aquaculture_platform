# aria-poc test modules that no CI step runs (2026-10-07)

Context: while landing ARIA-MEDIUM-330, `tools/aria-poc/test_measure_watchdog_fp_rate.py` turned out
to be run by no workflow. Three other modules beside it had the same gap, and two of their tests
had rotted unseen.

Owner: claude (implementation), okan (review). Deadline 2026-10-14 (377), 2026-10-21 (378).

## ARIA-MEDIUM-377

Evidence (at `main@772dca4e6`):

- `.github/workflows/aria-kernel.yml:192`: the only step for aria-poc runs
  `unittest discover tools/aria-poc/invariants -p '*test*.py'`. Discovery reads that directory
  only, so the top-level modules were never collected.
- `tools/aria-poc/test_poc.py` (16 tests) and `tools/aria-poc/test_adapter_failure_states.py`
  (4 tests) pass locally and run nowhere.
- `tools/aria-poc/test_adapter_scope_narrow.py:56`: 2 of 7 tests fail with `FileNotFoundError`.
- `tools/aria-poc/test_measure_watchdog_fp_rate.py`: the same gap.
- `tests/invariants/test-target-ci-reachability.spec.ts` gates three things, each in both
  directions: Nx test targets, root `test:*` scripts and jest configs. It could not see Python
  modules that a `unittest discover` step drives.

Rule: a test nothing runs is not a gate. Every Python test module under `tools/aria-poc` sits where
a workflow's `unittest discover` step collects it. A test pins its subject to a committed
declaration, never to a runtime-compiled artifact.

### The two failing tests: the tests were wrong

`test_outbox_adapter_scanned_globs_narrow` and
`test_agent_harness_security_adapter_scope_unchanged` pin the adapters' `SCANNED_GLOBS` to
`aria-tools/registry.json`. That file is gitignored (`.gitignore:257`). `registry_compiler` builds
it at runtime from `tools/aria-adapters/*.tool.json`. A fresh checkout has no copy, and neither has
the CI job, whose bootstrap writes `.aria-ci/tools`. Wherever the tests could run, they failed
before asserting anything.

The adapters are correct. Both match the committed declarations the registry is built from:

- `outbox_adapter.SCANNED_GLOBS` equals the `outbox-adapter` row of the Plan 016 portfolio
  (`aria_kernel/adapter_portfolio.py`).
- `agent_harness_security_adapter.SCANNED_GLOBS` equals
  `tools/aria-adapters/agent-harness-security-adapter.tool.json`. The one exception is the literal
  `aria-tools/registry.json` entry, which the adapter reads directly.

The fix reads those committed declarations. The adapters' "source of truth" comments now name them
too.

### Fix

- The four modules move into `tools/aria-poc/invariants/`, which the existing step discovers. Each
  one now resolves the PoC and adapter files one directory up. In total, 62 tests run there and
  pass.
- `test_measure_watchdog_fp_rate.py` gets the same rename and the same path edit as on
  `fix/aria-finding-file-claim` (ARIA-MEDIUM-330), so whichever branch lands second merges cleanly.
- Gate: `tests/invariants/test-target-ci-reachability.spec.ts` gains both directions for Python
  suites:
  - every `test_*.py` / `*_test.py` under `PYTHON_TEST_ROOTS` (`tools/aria-poc`) must be collected
    by some workflow's `unittest discover <dir> -p <glob>` step. Collected means under `<dir>`,
    name matching `<glob>`, and only package directories (with `__init__.py`) on the way;
  - every directory a workflow discovers must exist and hold a module its pattern matches.

  Applied to origin/main's tree, the first check fails and names the four modules.

- `docs/aria/CONTRACTS.md` names the new path of `test_poc.py`.

## ARIA-MEDIUM-378

Found while fixing 377: the outbox pin had nothing live to compare against. The runner store's
compiled registry (`.aria-state-store/tools/registry.json`, 11 tools) has no `outbox-adapter` row.

- `aria-kernel/aria_kernel/adapter_portfolio.py:60`: the outbox, cqrs, banned-phrase and dual-alias
  adapters are declared only in `_MVP_ADAPTERS`.
- `adapter_portfolio.py:115`: every portfolio row runs `python3 shadow_runner.py`, a shim that
  emits zero findings. `outbox_adapter.py` therefore never runs outside tests.
- `aria-kernel/aria_kernel/registry_compiler.py:10`: `compile_registry` rejects `shadow_runner.py`
  as a stub runner and compiles only `*.tool.json` manifests.
- `aria-kernel/aria_kernel/cli.py:2343`: no workflow invokes `adapter-portfolio register-mvp`.

Rule: an adapter the portfolio names is registered from a committed manifest with its real runner,
or the portfolio does not claim it. ARIA-MEDIUM-378 is registered with owner claude and deadline
2026-10-21. It is not fixed in the 377 change.
