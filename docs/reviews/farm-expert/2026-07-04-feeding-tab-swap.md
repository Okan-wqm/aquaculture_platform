# Farm — feeding Daily-Plan / Daily-Execution tabs were swapped — 2026-07-04 (Phase 4)

## FARM-MEDIUM-138 — the Feeding page rendered the calculated plan under "Daily Execution" and the manual actual-fed entry under "Daily Plan" — RESOLVED (Phase 4)

**Symptom.** In `FeedingPage.tsx` the two tabs rendered each other's content:
- **Daily Plan** tab → `PlannedVsActualSection` (the planned-vs-actual comparison
  that opens `RecordFeedingModal` — the operator's MANUAL actual-fed write path).
- **Daily Execution** tab → `DailyPlanTab` (the read-only CALCULATED per-tank plan
  driven by `useDailyFeedingPlan`).

So an operator opening "Daily Plan" got a data-entry surface, and "Daily Execution"
showed a read-only plan — the opposite of what each tab means, and of the
operator's model (plan = what SHOULD be fed; execution = what WAS fed).

**Fix.** Swap the tab bodies to match their labels:
- **Daily Plan** → `DailyPlanTab` (calculated per-tank plan, protocol-rate SSoT
  from Phase 3) + the multi-day `DailyFeedPlan` forecast. Read-only.
- **Daily Execution** → `PlannedVsActualSection` (manual actual-fed entry via
  `RecordFeedingModal` + planned-vs-actual variance). The write path.

The backend (`recordDailyFeeding`, inventory decrement) was already correct; this
is purely the presentation wiring. FE-only — no backend/contract change.

## Verification
`FeedingPage.spec` gains a test that clicking **Daily Execution** fires
`query DailyFeedingExecutions` (proving the manual-entry section now lives there);
farm-module 27 files / 107 tests green; tsc + eslint clean.
