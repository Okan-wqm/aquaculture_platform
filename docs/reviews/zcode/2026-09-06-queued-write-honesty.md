# Queued-write honesty — second branch sweep, 2026-09-06

Reviewer: zcode. Cycle: `2026-09-05-branch-sweep`. Target: `origin/main` @ `5cf4757b9`.

Recovered from `claude/mobile-graphql-contract-0jj9jg`. PR #1420 landed this fix for six sibling
pages and left three; the branch itself is 13 commits and 17 conflicts behind main, so the remaining
three were re-derived rather than merged.

## MOB-HIGH-020 — a device-queue write was answered with a success screen

**Severity:** HIGH. **Owner:** mobile-app-auditor. **State:** IN-PROGRESS.

**Evidence.** AquaMobil accepts writes offline by putting them in the device queue. The queue is not
the database: the server can still reject the operation when it syncs. Three pages ended their
submit path at `await addToQueue(...)` followed by `setShowSuccess(true)` and a 1.5-second
`navigate(...)`, so the operator was told the work was done and taken away from the screen before
anything could be said about it:

- `pages/feeding/RecordFeedingPage.tsx` queues on **every** submit, online or not, and both its
  paths (`recordMealFeeding`, `finalizeMeal`) showed the green tick.
- `pages/storage/StockMovementPage.tsx` and `pages/storage/StockTransferPage.tsx` chose the heading
  with `{isOnline ? 'Movement Recorded!' : 'Queued for Sync'}` — from a connectivity flag, not from
  what happened. That is exactly wrong on the recoverable-transport fallback beneath it: when the
  online mutation fails with a network error, the page queues the write while `isOnline` is still
  `true`, so the screen read **"Movement Recorded!"** for a write only the device had.

For feeding this is the highest-frequency action in the product, and the loss is silent: a rejected
sync leaves the meal unlogged with nobody looking.

**Rule violated.** A queued write is not a recorded write. The screen reports the operation's real
state, and never derives that state from a connectivity flag.

**Fix.** All three pages keep the operation id `addToQueue` returns and render the shared
`QueuedStatusBadge`, which reports pending / syncing / synced / failed — the pattern the six sibling
pages already use. `RecordFeedingPage`'s green success screen is deleted rather than left
unreachable, because that page has no path that records anything directly. The storage pages' own
success screen stays for the genuine online path and its heading no longer consults `isOnline`,
since every queued path now leaves before reaching it.

`tests/invariants/mobile-queued-write-honesty.spec.ts` closes the class: every page under
`web/apps/aquamobil/src/pages` that calls `addToQueue(` must render the badge. The rule is derived
from the source rather than listed, so a tenth queueing page is covered the day it is written.
`ChatRoomPage` is the one allowlisted exception, with its reason recorded — chat carries `_status`
`'pending'` / `'failed'` on each optimistic bubble, which is finer-grained than one badge per
screen — and the spec asserts the allowlisted page still queues, so a stale entry cannot become a
hole.

**Closure criterion.** `web/apps/aquamobil` is green (66 files, 383 tests) with the feeding spec now
asserting the queued screen and the absence of the "Recorded!" heading; `tsc --noEmit` and ESLint are
clean; the new invariant passes.
