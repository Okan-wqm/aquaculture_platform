# ARIA Wave 0 — burn-in lane collapses into the pipeline (2026-08-02)

Program: `docs/plans/2026-08-02-aria-full-autonomy-program/PLAN.md`, Wave 0
item 0.5 (the re-scoped remainder after the pipeline collapse itself was
found already aboard `main` via #1045 — see PROGRESS.md, 2026-08-02 entry).

## ORPHAN-HIGH-521 — `run_observe_burn_in` was a third cycle loop

The program's discovery phase counted the pipeline's entrances and found
three, not two: the live `run_enterprise_cycle`, the dead `run_phases=`
kwarg path (deleted by the collapse), and `burn_in.run_observe_burn_in` —
a hand-rolled loop that imported `cycle`'s private event factories
(`_started_cycle_row` / `_completed_event` / `_failed_event`), called five
observe primitives directly (`run_discovery`, `run_cycle_diff`,
`update_memory`, `run_pressure`, `triage_policy_apply`), and appended its
own started/terminal rows to `cycles.jsonl`.

Two structural consequences:

- **Lifecycle-ledger ownership was duplicated.** Both the pipeline and the
  burn-in loop wrote started/terminal rows with their own error handling;
  the burn-in failure path could in principle double-close a cycle the
  pipeline had already closed.
- **The observe lane's no-action guarantee was prose.** "A burn-in touches
  no claim / tool / PR surface" was true only because of which functions
  the loop happened to call — invisible to the pipeline's outcome ledger,
  skip records, and import-time well-formedness assert.

**Fix (same commit):** the burn-in lane becomes a _mode_ of the one
pipeline.

- `CYCLE_PHASES` gains a closed `modes` column (`CYCLE_MODES =
("standard", "burn_in")`, enforced by the import-time well-formedness
  assert). The default is standard-only, so a newly added phase can never
  leak into the burn-in lane by omission — joining `burn_in` is an
  explicit declaration reviewed on the table.
- The observe set — `discovery`, `cycle_diff`, `memory`, `pressure`,
  `triage` (a new burn_in-only row), `artifact_integrity` — declares
  `burn_in` membership as table data. `artifact_integrity` joins
  deliberately: `_runtime_status` reads its verdict, the check is
  read-only, and a per-cycle integrity read is a strengthening the old
  loop lacked.
- `run_enterprise_cycle(mode=...)` validates against the closed vocabulary
  before the started row lands; the driver records every out-of-mode phase
  as a skip naming the mode (`mode_not_included:<mode>`), so "not in this
  lane" and "silently absent" are different observations. Learning hooks
  are skipped by mode, mirroring the pre-collapse loop which never ran
  them.
- `run_observe_burn_in`'s per-cycle body is now a
  `run_enterprise_cycle(mode="burn_in")` call; its public signature,
  evidence bundle (derived from the returned state's declared state keys)
  and failure reports are preserved. Its failure path appends a terminal
  row only when the pipeline did not get to (`_cycle_has_terminal_row`) —
  single-owner lifecycle discipline with double-close prevention.

**Validation:** 10 new tests (`aria-kernel/tests/test_cycle_burn_in_mode.py`)
pin the burn-in phase set as exactly the observe set, the standard-only
default, the well-formedness bite on empty/unknown modes, the full
burn_in-mode run (ran set, mode-skip reasons, state-key projection), the
learning-hook mode skip, single started/terminal ledger ownership, the
standard lane's triage skip, the pre-ledger refusal of an unknown mode,
and — at the import-statement level — that `burn_in.py` imports only
`_failed_event` + `run_enterprise_cycle` from `cycle`, so a hand-rolled
loop cannot quietly return. Existing burn-in suites
(`test_observe_burn_in`, `test_burn_in_ladder_bridge`) pass unchanged.

Owner: aria-acceptance-gap-fixer. Deadline: 2026-08-09 (post-merge close
ceremony).
