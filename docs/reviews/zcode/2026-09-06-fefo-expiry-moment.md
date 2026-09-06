# FEFO expiry moment — second branch sweep, 2026-09-06

Reviewer: zcode. Cycle: `2026-09-05-branch-sweep`. Target: `origin/main` @ `5cf4757b9`.

Found while evaluating `wip/codex-farm-stock-mutation-20260816`. That branch is otherwise superseded
— main already carries `StockMutationLockAuthority` and the multi-lot FEFO engine — but its rewrite
happened to get one thing right that main gets wrong. Its own fix introduced a second clock
authority and was not taken; only the defect it exposes is addressed here.

## FARM-MEDIUM-317 — the expiry filter read the wall clock, not the deduction's moment

**Severity:** MEDIUM. **Owner:** farm-expert. **State:** IN-PROGRESS.

**Evidence.** `apps/farm-service/src/storage/services/feed-allocation.service.ts`, `loadCandidates`,
built its candidate pool with two temporal filters bound to two different instants:

```ts
.andWhere('(inv.expiryDate IS NULL OR inv.expiryDate > :today)', { today: new Date() })
.andWhere('(inv.receivedDate IS NULL OR inv.receivedDate <= :asOf)', { asOf: params.asOf })
```

`asOf` is the moment the deduction declares — the feeding time, threaded from
`resolveFeedDeductionLocation` — and the receivedDate clause correctly honours it so a backdated
record cannot consume a lot that arrived later. The expiry clause ignored it and read the wall
clock instead.

The consequence is asymmetric and silent: a deduction recorded retroactively (an offline mobile
record replayed, a correction entered days later) is judged against _now_, so a lot that was
perfectly valid when the fish were actually fed, and expired in the meantime, is excluded from the
pool. The allocation then either cascades onto a different lot — writing `stock_movements` rows that
misattribute physical feed to the wrong lot, which is exactly the EU 178/2002 traceability the
multi-lot engine exists to preserve — or fails the whole deduction as short.

**Rule violated.** One operation, one moment. Every temporal filter inside a single deduction binds
the instant the operation declares.

**Fix.** The expiry clause binds `params.asOf`, the same instant as its neighbour. A spec pins both
clauses against a fixed retroactive `asOf`, so a future edit cannot quietly reintroduce a second
clock in this query.

**Closure criterion.** farm-service is green (307 suites, 2162 tests) and the allocation spec asserts
both temporal clauses bind the same declared moment.

## FARM-MEDIUM-318 — the same comparison is still UTC-instant, not local day (NOT fixed here)

**Severity:** MEDIUM. **Owner:** farm-expert. **State:** OPEN. **Deadline:** 2026-10-03.

`inv.expiryDate` is a `DATE`. Comparing it to a timestamp makes Postgres widen the date to midnight
in the session zone (UTC), so the boundary falls at 00:00 UTC rather than at the site's local
midnight. For a site at UTC−7 a lot expiring "today" leaves the pool at 17:00 the previous local
afternoon. That contradicts the rule `FeedingClockService` states for the platform: no query
carrying day meaning uses `CURRENT_DATE`/`now()`; the local day is computed there and bound as
`$n::date`.

This is deliberately **not** fixed in the same change, for two reasons, and the debt is tracked
rather than hidden:

1. **Resolving the zone would close a module cycle.** `FeedingClockService` lives in
   `feeding-protocol`, and `feeding-protocol.module.ts` already imports `storage`'s
   `InventoryModule`. Injecting the clock into a storage service inverts nothing — it creates a
   cycle. The honest fix is to decide where the timezone SSoT belongs: `TenantLocalization` is
   currently an entity inside `feeding-protocol`, which is why the clock is stuck there, and a
   platform-level day authority is a design decision this sweep should not make unilaterally.
2. **The boundary operator is a domain rule, not a bug to guess.** The filter is `>`, which excludes
   a lot **on** its expiry date. Whether feed is usable through its expiry date or only up to it is
   a decision the owner makes; a sweep that quietly flipped it to `>=` would be inventing product
   behaviour under cover of a timezone fix.

**Closure criterion.** A recorded decision on where the day authority lives, the expiry comparison
bound as a `$n::date` in the site's zone, and the boundary operator settled with the domain rule
written down beside it.
