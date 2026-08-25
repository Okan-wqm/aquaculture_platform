# ARIA review — 2026-08-25: cycle seal deadline anchored to the wrong clock

The dispatched producer cycle
`Okan-wqm/aquaculture_platform/actions/runs/32771477211` sealed its kernel
state at the wall-clock deadline but the JOB was cancelled by the GitHub
platform ceiling before the close-out steps (state verify, state publish)
could run — conclusion `cancelled`, the lane stayed red, and the night's
evidence never reached the `aria/state` branch.

## Measured facts

- Job started `2026-08-24T20:05:27Z`; platform ceiling (timeout-minutes 360)
  therefore `02:05:27Z`. Job `completed_at` `02:10:27Z` (cancelled).
- The `Run the nightly cycle under the resolved profile` step started
  `20:23:08Z` — **17m41s of setup** before it, dominated by the fresh-store
  restore of the `aria/state` branch (838 MB clone; the store had been wiped
  for a from-scratch bootstrap).
- The step computes
  `ARIA_JOB_DEADLINE_EPOCH = <step start> + 360m - 10m margin`, i.e.
  `02:13:08Z` — **8 minutes past the job ceiling**. The workflow's comment
  assumes "~5m of setup steps already spent"; a fresh restore costs 3.5x
  that, and the 10-minute margin is consumed before the cycle's first phase.
- The night-close defence (ORPHAN-662) fired exactly at its deadline — the
  kernel behaved as configured; the configuration anchored the deadline to
  the wrong clock.

## ARIA-HIGH-019 — the seal deadline is anchored to the nightly step's start, so a slow restore pushes the seal past the job ceiling

Any run whose pre-step setup exceeds the 10-minute margin (measured: every
fresh-store bootstrap; tonight's was 17m41s) seals AFTER the platform
ceiling cancels the job. The producer lane then cannot go green on exactly
the runs that follow a state-store reset — the runs that most need to
publish.

## Fix

Anchor the epoch to the job's launch: a step immediately after checkout
exports `ARIA_JOB_LAUNCH_EPOCH` to `GITHUB_ENV`; the nightly step computes
`ARIA_JOB_DEADLINE_EPOCH = ARIA_JOB_LAUNCH_EPOCH + 360m - 10m`. The margin
then genuinely belongs to the close-out steps regardless of how long the
restore took. Local dispatches without the anchor keep the old step-clock
fallback.
