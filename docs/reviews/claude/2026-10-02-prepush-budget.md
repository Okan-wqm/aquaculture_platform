# Pre-push ARIA suite — selection by spelling, no budget (2026-10-02)

Context: program plan F-P5. `.husky/pre-push` runs `scripts/ci/aria-suite-changed.mjs` on every
push that touches an ARIA surface. On 2026-10-02 a push that touched docs and a few kernel modules
ran 4,454 kernel tests in 6,357 s (106 min) on the shared production host; earlier pushes took
100 minutes to four hours under load, and every other lane on the host waited behind them. The
kernel lane (`.github/workflows/aria-kernel.yml`) runs the same suite, sharded, on every PR that
touches an ARIA surface, so the hook bought an early signal at 5-20x the cost of the authority.

Owner: claude (implementation), okan (review). Deadline 2026-10-16.

## PROC-MEDIUM-045 — The pre-push selector picks kernel tests by spelling and has no budget

Three defects in one gate, measured on `main @ 44983f55d`:

1. **Selection by text, not by dependency.** `addByToken`
   (`scripts/ci/aria-suite-changed.mjs:162`) selects every top-level test module whose source
   contains the changed module's basename. `ledger` is spelled in 330 test modules, so a
   `ledger.py` change selected 330 modules (4,322 test functions, ~6,180 s at the measured
   1.43 s/test). A `tools/aria-poc/README.md` change selected 24 modules (543 tests) through the
   token `README`, while nothing in the kernel reads that file.
2. **A full-suite floor.** A kernel change whose token matched nothing fell back to the whole
   suite (`:213`), and a change to the selector or runner ran the whole suite as its
   "self-validation" (`:117`) — a suite that never executes a line of the selector.
3. **No ceiling and no queue.** Nothing bounded the run's wall time, and concurrent pushes on the
   host ran their suites side by side.

The scoped runner had a fourth, latent defect: it named every module `tests.<basename>`
(`scripts/ci/aria-suite-run.sh:64`), so a module under `tests/invariants/` could not be run
scoped at all. Once modules run one per invocation, a second one surfaces: a module of plain
pytest functions makes Python 3.12's unittest exit 5 ("NO TESTS RAN"), and `set -e` aborted the
runner before the pytest half ran (measured: `test_knowledge_graph_replay.py` failed that way).

### Fix (same branch)

- `scripts/ci/aria-import-graph.py`: a static `ast` graph of the kernel and `tools/aria-poc`
  (imports, relative imports, `import_module`, dotted `mock.patch` targets, the `_EXPORT_MODULES`
  re-export table, path literals naming a changed file). Nothing is executed; per-file facts are
  cached by content digest under `.git/`. Tiers: changed test → owner (`tests/test_<stem>.py`, a
  `test_<stem>_*.py` module that imports the change, a surface's declared contract test) →
  direct importer/reader → importer of a direct module (depth 2). Nothing deeper.
- `scripts/ci/aria-suite-changed.mjs`: runs the longest prefix of (tier, cheapest estimate, path)
  that fits `ARIA_PREPUSH_BUDGET_S` (default 300), one runner call per module, timed into a local
  duration record; names what it skipped and the CI lane that runs it; holds a host-wide `flock`
  at `nice 10`; `ARIA_SUITE_FULL=1` keeps the full run. No full-suite floor. A gate change runs
  the jest specs that pin the gate, marked `ARIA_SUITE_GATE_RUN=1` so a selector started inside
  them cannot start that run again. One exit point (`process.exitCode`): `process.exit()` after a
  write to a pipe dropped the tail of a 225 KB `--plan` (cut at 65,536 bytes).
- `scripts/ci/aria-suite-run.sh`: scoped mode takes `aria-kernel/...` paths and keeps the package;
  either collector may own nothing (exit 5), both owning nothing fails, both halves always run.
- Pinned by `tests/invariants/aria-suite-selector.spec.ts` and the two selector probes in
  `tests/invariants/aria-doc-runtime-ssot.spec.ts`.

### Measured after the fix (same host, 2026-10-02)

| Change                                           | Old selector                       | New: graph reach                        | New: run (budget 300 s)                                          |
| ------------------------------------------------ | ---------------------------------- | --------------------------------------- | ---------------------------------------------------------------- |
| `aria_kernel/ledger.py`                          | 330 modules, 4,322 tests, ~6,180 s | 610 (6 owner, 185 direct, 419 indirect) | 41 modules, 236 s cold; 56 modules, 264 s with a duration record |
| `docs/aria/SPEC.md` + `tools/aria-poc/README.md` | 24 modules, 543 tests, ~776 s      | 0                                       | 0 modules, 0.3 s                                                 |
| `docs/` only                                     | 0 (not a surface)                  | —                                       | 0 modules, 0.07 s                                                |

### Observations, not filed

- The plan's "≤40 modules for a `ledger.py` change" cannot hold for the selection: 185 test
  modules import `ledger.py` directly. The budget bounds the run instead; CI runs the reach.
- 42 kernel test modules read `docs/aria/SPEC.md` by path. `docs/` is not on the hook's surface
  list (unchanged, as before), so a SPEC edit runs none of them locally; `aria-kernel.yml`
  triggers on `docs/aria/**` and runs them.
- The first run of the new selector spec on this host spawned 83,798 tasks: its fake `bash`
  appended its argv to its own file, and the runner's shebang resolved back to the shim. Shims
  now live in `bin/` and write only to `log/`; the gate's jest run is re-entry-guarded.
