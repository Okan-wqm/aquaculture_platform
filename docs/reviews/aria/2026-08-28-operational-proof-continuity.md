# ARIA review — 2026-08-28: Operational Proof continuity

Run `33113524069` passed the ARIA suite and then aborted all 30 burn-in cycles
because the proof bootstrapped scratch state instead of restoring the published
`aria/state` reference. Canonical restore also binds the durable tools root by
default, which appends governance and index bytes before a read-only proof can
measure them.

## ARIA-HIGH-024 — Operational Proof does not prove published state continuity

The proof must use the canonical state checkout in read-only mode, require an
exact non-genesis state-branch reference, forbid burn-in recovery, verify the
same remote tip before and after measurement, and preserve failure artifacts
without changing the failing exit status.

Evidence: `.github/workflows/aria-operational-proof.yml`,
`.github/actions/restore-aria-state/action.yml`,
`aria-kernel/aria_kernel/cycle.py`, and GitHub Actions run `33113524069`.

## ARIA-MEDIUM-025 — Burn-in terminal summaries omit stopped and aborted rows

The cycle lifecycle defines completed, failed, stopped, and aborted as terminal,
but the aggregate burn-in summary recognizes only completed and failed. This
misreports valid terminal rows as missing while stopped and aborted cycles must
still remain invalid acceptance evidence.

Evidence: `aria-kernel/aria_kernel/cycle.py` and
`aria-kernel/aria_kernel/burn_in.py`.
