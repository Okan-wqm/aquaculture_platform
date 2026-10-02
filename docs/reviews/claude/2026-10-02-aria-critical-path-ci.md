# ARIA critical path — failing-CI plan source and the red nightly fuzz (2026-10-02)

Context: the ARIA chain-closing plan (rev 6) has step 9, "a strict cycle takes one of ARIA's own
F findings to a converged plan, an implementation and a pull request", blocked by B1: every cycle
since 2026-09-29 picked a failing CI run instead of an F finding. Rev 6 assumed that greening the
red scheduled workflows on `main` would let F findings through. Reading the source showed it
cannot, and that one of the red workflows is a pinned-action defect rather than an operational
condition.

Owner: claude (implementation), okan (review, operator steps).

## ARIA-HIGH-250

`scan_failing_ci` (`aria-kernel/aria_kernel/plan_synthesizer.py`) ran
`gh run list --branch main --status failure --limit 5`. A failed run stays failed after its
workflow goes green, so the source always returned the five newest failures on `main`, red or
recovered. `failing_ci` ranks above `f_finding` (`_SOURCE_PRIORITY`, priority 1 against 3), and
`V9PressureSourceProvider.synthesize` (`cycle_phases/plan_source.py:188`) takes the first
candidate that converts, so as long as `main` had ever failed five runs no cycle could reach an F
finding.

Evidence:

- `aria/state` governance, `plan_candidate_source_selected`: F-013 and F-012 on 2026-09-20; then
  `failing_ci` in every cycle — ci-run-36455014546 (09-29 14:33Z cycle), 36639257105,
  36785618591 and 36940910761 (Database WAL Archive Freshness, 10-01 23:27Z).
- Live read on 2026-10-02 at 08:55Z: the old query returned five failures, two of them the same
  workflow. Read with the fixed semantics, eight workflows are red on `main` now: Nightly Fuzz -
  ST Parser, Deploy Capacity Maintenance, Database WAL Archive Freshness, Scheduled Workflow
  Watchdog, ARIA External Watchdog, aria-readiness-claim, aria-daily-report and CI - Affected.

Rule: A failing-CI plan candidate names a workflow that is red now. A workflow whose newest
pass/fail run succeeded supplies no candidate; a cancelled, skipped or otherwise undecided run
neither clears a red workflow nor turns a green one red; one candidate per red workflow, keyed by
workflow id rather than display name.

Fix: the source reads the newest 200 completed runs on the branch, orders them by `createdAt`,
takes each workflow's newest decisive (success/failure) run and keeps it when it failed. Tests in
`aria-kernel/tests/invariants/v9/test_phase_v9_4_pressure_sources.py`
(`TestV9FailingCiIsCurrentlyRed`, six cases) fail on the old source and pass on the new one.

Not done here: making the eight workflows green. Each has its own cause (EDGE-MEDIUM-043 below
is one; the WAL archive needs a backup decision from the operator). Until they are green the
strict cycle still selects a failing CI run, which is the correct behaviour now that the
candidate is real.

## EDGE-MEDIUM-043

The nightly ST-parser fuzz (`.github/workflows/fuzz-st-parser-nightly.yml`) has failed every night
since 2026-08-31, within its first minute, with `'toolchain' is a required input`. Dependabot #1264
(2026-08-30) moved its `dtolnay/rust-toolchain` pin from `efcb852` to `6c977a6`. The action takes
its default toolchain from the branch its ref names: `efcb852` is a `nightly`-branch commit whose
`action.yml` declares `toolchain: {required: false, default: nightly}`; `6c977a6` is on `master`,
where `toolchain` is required and has no default. The step passed no `toolchain`, so it relied on
the pin's branch, and a SHA pin carries none.

Evidence:

- Last green run 33298733756 (2026-08-30, pin `efcb852`, log shows `toolchain: nightly`); first
  red run 33368535874 (2026-08-31); 33 consecutive red nights to 2026-10-02 (36978496183).
- `action.yml` at both SHAs read through the GitHub API; `compare` shows `6c977a6` is an ancestor
  of both `master` and `nightly` and `efcb852` diverged from both.
- Every other `dtolnay/rust-toolchain` step under `.github/` already passes `with.toolchain`.

Rule: Every rust-toolchain step names its toolchain; the installed toolchain never depends on
which branch the pinned commit came from.

Fix: the step passes `toolchain: nightly`. `tests/invariants/toolchain-config-ssot.spec.ts` scans
every workflow and local composite action and fails on a `dtolnay/rust-toolchain` step without a
non-empty `with.toolchain`; it fails on the old workflow and passes on the new one.

## ARIA-MEDIUM-251

`aria-daily-report.yml`'s `commit-report` job runs on the self-hosted runner and checks out into its
own `report-checkout/` (ORPHAN-HIGH-736, so its clean never reaches ARIA's state store). Its
enterprise preflight step runs with `working-directory: report-checkout` and a report path relative
to it, but called `verify_workflow_preflight(workspace_root=os.environ["GITHUB_WORKSPACE"])`. On
that runner `GITHUB_WORKSPACE` is the shared ARIA workspace, where this job's `report-checkout/` and
`dataflow-integrity-watchdog`'s `watchdog-checkout/` are untracked directories, so the
clean-worktree check (`preflight.py:677`) refused every run.

Evidence:

- Last green run 32225322089 (2026-08-19, the day the isolated checkout landed in #1287); red every
  day since with `workspace_worktree_not_clean;workspace_worktree_dirty_paths:report-checkout/;watchdog-checkout/`.
- The same `verify_workflow_preflight` call, rooted at a clean checkout of `main` with the job's
  arguments, returns `valid=True`.

Rule: A job that checks out into its own subdirectory preflights that subdirectory, the tree it
writes.

Fix: the preflight is rooted at `os.getcwd()`, the step's `working-directory`.
`aria-kernel/tests/test_z1_store_isolation.py` requires every self-hosted job with a scoped checkout
to run its preflight inside that checkout and never at `GITHUB_WORKSPACE`; it fails on the old
workflow and passes on the new one.
