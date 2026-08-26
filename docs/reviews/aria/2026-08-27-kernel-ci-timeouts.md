# ARIA review — 2026-08-27: kernel CI lane timeouts are shorter than the suite they run

The `aria-kernel-fast` and `aria-kernel` lanes on PR #1331 died at exactly
15m15s and 20m15s — their own `timeout-minutes` (15 and 20). The kernel
suite has grown to 5048 tests (~96 minutes on the shared self-hosted box,
well over the fast lane's budget even on hosted runners); the suite
script's own doc comment still says "~215s". GitHub reports a
timeout-killed job as `cancelled`, which made these look like deliberate
mystery cancellations across PRs #1329 and #1331.

## Measured facts

- PR #1331 run 33019494491 (`aria-kernel-fast`, `unittest` job):
  cancelled at 15m15s; `timeout-minutes: 15` at
  `.github/workflows/aria-kernel-fast.yml:34`.
- PR #1331 run 33019494559 (`aria-kernel`): cancelled at 20m15s;
  `timeout-minutes: 20` at `.github/workflows/aria-kernel.yml:43`.
- The identical 15m15s/20m15s signatures appeared on PR #1329's reruns
  (runs 32773208178/32773208196) — the pattern predates this PR.
- Local suite measurement: `Ran 5048 tests in 5747.674s` (~96 min wall on
  the memory-contended droplet; hosted runners are faster but not 4x).

## ARIA-MEDIUM-020 — kernel CI lane timeouts are shorter than the suite they run, so every PR's kernel lanes cancel

Any PR touching an ARIA surface gets `unittest`/`aria-kernel` cancelled by
their own job timeouts; the lanes can never go green, the scheduled-workflow
watchdog sees stale/failing lanes, and reviewers lose the kernel signal the
gates exist to provide.

## Fix

Raise the budgets to fit the measured suite with headroom:
`aria-kernel-fast` 15 → 45 minutes, `aria-kernel` 20 → 60 minutes. Both
remain far below the 360-minute platform ceiling and only bound the suite
they run.
