# ARIA Wave 1 — the scheduled lanes had been dead for seventeen days (2026-08-03)

Program: `docs/plans/2026-08-02-aria-full-autonomy-program/PLAN.md`, Wave 1.
Found while checking a Wave-0 follow-through gate ("delete the legacy
`gh pr create` pattern after one green scheduled executor run") that
turned out to be unreachable.

## What was actually happening

Watchdog incident issue #1005 has been open since **2026-07-17**, updated
hourly, listing ten of fourteen watched scheduled workflows as failing or
missing — including `aria-auto-cycle.yml`, ARIA's own nightly loop.

So the honest framing is not "nothing noticed". `scheduled-workflow-watchdog.yml`
noticed immediately and has been reporting every hour for seventeen days.
**Detection was never the gap.** The gap is that the alarm has no
consumer: ARIA kept planning, merging and accumulating "readiness" while
its main loop had not run once, and no gate anywhere objected.

Two distinct causes sit under those ten entries:

1. **A dependency-ordering defect the kernel owns** (fixed here).
2. **A self-hosted runner that is offline** — `aria-auto-cycle.yml` and
   `aria-agent-executor.yml` both declare
   `runs-on: [self-hosted, linux, claude]`, so their runs queue for 24h
   and are auto-cancelled. No code change can fix that; it is an operator
   action, recorded as such below.

## ORPHAN-HIGH-529 — kernel-running jobs did not provision the kernel

`aria-daily-report.yml`'s `generate-report` job ran its preflight step —
which imports `aria_kernel.preflight` → `workflow_contracts` → `yaml` —
**twenty-seven lines before** its `pip install -e aria-kernel` step. Every
scheduled run since 2026-07-17 died with `ModuleNotFoundError: No module
named 'yaml'`. The daily anchor is the committed audit record that stands
in for git history in ARIA's trust story, and it simply stopped being
produced.

The same class, found by sweeping every workflow:

- `finding-state-sweep.yml`, `rule-health-report.yml`, `aria-agent-eval.yml`
  and `aria-runner-capability-probe.yml` import the kernel with **no**
  install step at all.
- `aria-daily-report.yml`'s second job (`commit-report`) has no Python
  provisioning whatsoever — latent, because the first job always died
  before it could run.
- Six further jobs (`aria-auto-cycle`, `aria-kernel`, `aria-kernel-fast`,
  `aria-kernel-full`, `aria-merge-authority`, `aria-operational-proof`)
  each carried their own hand-rolled copy of the install block.

The root cause is not any one workflow: the coupling between "this step
runs kernel code" and "an earlier step installed the kernel" was
maintained by hand, per job, in eleven places, and nothing checked it.

**Fix:**

- `.github/actions/setup-aria-kernel` — one composite action providing the
  interpreter plus the kernel's declared dependencies, installed from
  `pyproject.toml` (never from a package list kept in the action, which
  would be the same duplication one level down). It ends by importing
  `aria_kernel` and `yaml`, so a provisioning failure names itself at
  provisioning time instead of surfacing as a `ModuleNotFoundError` inside
  unrelated business logic.
- Every kernel-running job now uses it, and the eleven hand-rolled install
  blocks are deleted. This mirrors what `ensure-sandbox-backend` already
  did for a duplicated step pair in this repo: copying is how copies
  drift; one definition removes the class.
- `tests/invariants/aria-kernel-workflow-setup.spec.ts` fails any job that
  runs kernel code without an EARLIER `uses: ./.github/actions/setup-aria-kernel`
  in the same job. Ordering is checked, not merely presence — provisioning
  after the first import is precisely the defect above — and jobs are
  checked independently because each job gets a fresh runner. The spec
  found thirty violations on its first run, all now fixed.

## ORPHAN-HIGH-530 — the watchdog's verdict has no consumer

`scheduled-workflow-watchdog.yml` maintains issue #1005 and fails its own
run, which is the right detection design. But nothing in ARIA reads it.
The autonomy ladder counts observe cycles, the merge authority checks its
gates, and the program plan assumes nightly evidence accumulates — all
while an open incident says the nightly has not run since 2026-07-17. A
signal that no gate consumes is the same defect class this program keeps
closing (ORPHAN-CRITICAL-498's family: a control that exists but is not
reachable from the path that needs it).

Not fixed in this PR, and deliberately not claimed as fixed: the
consumer belongs where ARIA's gates already live, and wiring it needs the
durable state store (PR 2.3) to record the freeze durably rather than
per-run. Registered with owner and deadline so it is tracked work rather
than an observation in a review file.

## Operator action required (no code substitutes)

The `[self-hosted, linux, claude]` runner is offline. Until it returns,
`aria-auto-cycle` and `aria-agent-executor` cannot run at all, which also
makes Wave 0 §0.7's follow-through gate ("one green scheduled executor
run under `ARIA_EXECUTOR_PR_VIA_KERNEL=1`") unreachable by waiting.
PLAN.md is corrected in this PR to state the real precondition instead of
implying the gate will pass on its own.

**Validation:** the new invariant (3 assertions) plus `invariants:fast`;
every touched workflow re-parsed as YAML. The four ubuntu-hosted lanes
(`aria-daily-report`, `finding-state-sweep`, `rule-health-report`,
`aria-agent-eval`) are expected to recover on their next scheduled run —
that recovery is the real verification, and it will show up as issue
#1005 shrinking rather than as anything this PR can assert.

Owner: aria-acceptance-gap-fixer. Deadline: 2026-08-10.

---

## ORPHAN-HIGH-530 closed — the consumer, and why not the obvious one

The finding above says detection worked and nothing consumed it. The
consumer now exists. Full record:
`docs/reviews/claude/2026-08-03-aria-w1-ladder-continuity.md`.

The obvious reading — "gate cycle recording on lane liveness" — is
**vacuous**: a dead lane runs no cycles, so `record_clean_cycle` is never
called and such a gate can only ever pass. The hazard is one level up.
`verdict_from_rows` had no time dimension at all, so thirty acceptance
events spanning a seventeen-day hole satisfied a threshold of thirty
exactly as well as thirty consecutive nightly ones. The ladder's premise
is "N CONSECUTIVE clean cycles"; counting cannot see a hole, and when the
lane returned the accumulated evidence would have gone on unlocking as if
operation had been continuous.

The check lives in `verdict_from_rows` because that is the ONE function
the real and mock ledgers both pass through — the same argument as the
state store's ancestry proof: a check at the callsite is a check the next
callsite can omit.

No second watchdog was built. `scheduled-workflow-watchdog.yml` did its
job throughout; a second detector would have been the copy-drift disease
ORPHAN-CRITICAL-513 already cost this repository once.
