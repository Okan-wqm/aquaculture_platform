# ARIA backlog cap — counts what ARIA cannot close, and freezes discovery (2026-10-03)

Context: evolution-wall audit of 2026-10-02, wall #7. Owner: claude (implementation), okan
(review). Deadline 2026-10-12.

## ARIA-HIGH-293 — the E25-a cap pauses discovery on findings only an operator can close

Measured on `main @ ed0af3c4e` and `aria/state @ 5351fcb18`:

1. **The cap counts every finding alike.** `cycle._backlog_below_cap`
   (`aria-kernel/aria_kernel/cycle.py:403-419`, members at `:424` and `:428-431`) compares
   `cycle_guard._open_finding_count` (`cycle_guard.py:83-95`, every OPEN or IN_PROGRESS row of
   the index) with `rhythm.backlog_cap` (`genesis_policy.py:206`, 25). Whether ARIA could close
   a finding plays no part, although the plan admission already answers that question
   (`finding_grounding.admit_finding`: trusted refs at an anchor on main, at least one surface
   outside `implementation_safety.READONLY_PATHS`).
2. **At the cap discovery stops, it does not slow.** `watchdog_sweep` (`cycle.py:3189-3196`) and
   `experiment_author` (`cycle.py:3364-3369`) are skipped on every cycle while the count holds
   at the cap. A finding whose surfaces are all read-only to ARIA is closed by an operator alone,
   so past the cap "ARIA cannot fix it" becomes "ARIA stops looking".
3. **The chain stops on the same count.** `tools/aria/chain_next_cycle.py:29-34` feeds
   `_open_finding_count` to `cycle_rhythm.evaluate_cycle_chain` (`backlog_at_cap`).
4. **No closure signal.** Nothing measures findings closed against findings opened, so a
   backlog that grows because nothing closes looks the same as one that grows because more is
   found. On 2026-10-03: 14 OPEN, 0 closed in 46 days, opened at 0.14-0.86/day, which reaches the
   cap between 2026-10-15 and 2026-12-20.

Today's 14, judged by the admission rule: 13 cite at least one writable surface (`web/`,
`apps/`, `libs/`, `docs/reviews/`); F-012 cites only `docs/adr/024-compliance-retention-matrix.md`
(`finding_surfaces_readonly`). The openers: `seed:drift-scan` 8 (F-001..F-008),
`ai_consensus:judgment_pipeline` 6 (F-009..F-014); neither is one of the two phases E25-a gates.

### Fix (same branch)

- `finding_grounding.closure_blocker`: the closability rule is the plan admission with the
  status gate widened to the backlog (`finding.BACKLOG_STATUSES`); runner faults are undecided.
- `cycle_guard.backlog_census`: closable / operator-only (with age) / undecided; the cap bounds
  closable + undecided. Closure SLO from `finding.backlog_flow` (event ledger): closable findings
  opened in `rhythm.closure_slo_window_days` against findings closed in it.
- `cycle_guard.admit_finding_opener`: pressure (cap reached, or a breached SLO the opener's
  origins fed) admits an opener once per `rhythm.opener_throttle_interval_hours`, recorded as
  `finding_opener_throttled`. Openers: `watchdog_sweep`, `experiment_author`, the judge fan-out
  of `judgment_pipeline`, `seed_drift_findings`.
- Operator-only findings older than `rhythm.operator_escalation_age_days` are escalated once each
  (`finding_operator_escalated`) and listed with their age by `aria doctor` (`finding_backlog`).
- Every rhythm value is bounded (`genesis_policy.RHYTHM_BOUNDS`); the chain reads the census.
