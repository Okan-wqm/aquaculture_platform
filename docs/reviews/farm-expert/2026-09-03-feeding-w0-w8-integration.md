# Feeding W0–W8 integration — findings that do not close in this rebase (2026-09-03)

Scope: the integration of PR #1031 (`claude/farm-feeding-protocol-f92y38`, the W0–W8 repair
programme for `docs/reviews/claude/2026-07-27-feeding-v2-post-merge-audit.md`) onto the
`claude/branch-evaluation-merge-s5grgw` head (`599d6d323`).

The PR body listed ten findings as still open. Seven of them ARE closed by commits on the branch
and the trailers are carried through the rebase unchanged; they are recorded below with the commit
that closes each, so a reader is not sent looking for work that is already done. Three are not
closed by any commit on the branch and are not closed here either. This document states, for each
of those three, the owner, the deadline and the criterion a closure must satisfy.

## Why the three cannot close inside this rebase

The integration contract for this branch keeps `docs/reviews/_registry/findings.jsonl` at the
integration head's version: the 77 registry rows the branch appended are extracted for the
integrator's hash-chain ceremony and are NOT merged here, because appending them means recomputing
the chain and that ceremony belongs to one owner, not to every branch that lands.

`FARM-MEDIUM-258`, `FARM-LOW-268` and `FARM-LOW-277` are three of those 77 rows. Until the ceremony
runs, they do not exist in the registry this tree carries, and `tools/gates/commit-msg-validator.ts`
refuses a `Closes:` trailer naming an id the registry does not hold — correctly, since an
unvalidated trailer is exactly the audit theater the rule exists to prevent. A `fix` commit for any
of the three is therefore unlandable in this tree, and landing the change WITHOUT its trailer would
be worse than not landing it: the code would move and the ledger would not know why.

The blocker is the ceremony, not the engineering. Each entry below is written so the fix can be
made in one sitting once the rows are in the registry.

## FARM-MEDIUM-258

**Manual (unplanned) feeding resolves its storage site only through a bound day plan, and applies
growth only when a plan binds.** State: OPEN. Owner: `farm-expert`. Deadline: 2026-09-19.

Evidence:

- `apps/farm-service/src/feeding/handlers/create-feeding-record.handler.ts` passes
  `siteId: boundPlan?.siteId` into `FeedingLedgerService.recordFeed`, so an unplanned record on a
  unit with no day plan carries no site at all.
- The same handler applies growth only inside its `if (boundPlan)` branch, so a feeding that cannot
  be attached to a plan contributes feed to the batch aggregate and nothing to biomass.

Partially mitigated in this integration, and the remainder is real. W2's multi-lot allocator
(`FeedAllocationService.allocateForDeduction`) treats `siteId` as a PREFERENCE, not a filter: the
unit's site is drained first and the tenant-wide pool continues from there. An absent `siteId` is
therefore "no preference over one tenant pool", not "the wrong warehouse", which is what the
original finding describes. What remains is that the preference is silently lost whenever no plan
binds, and that growth is skipped in the same branch.

Closure criterion: the feeding site is resolved from the UNIT (tank/equipment → site) independently
of whether a day plan binds, so `recordFeed` receives a site on every path; and biomass growth is
applied for an unplanned feeding whose unit has a resolvable expected FCR, with the reason recorded
in `recalcLog`. A regression spec must fail when the plan branch is removed — the current suites
stay green, which is why this finding exists.

## FARM-LOW-268

**`correctMealPour` re-prices the WHOLE pour at today's feed price, so a correction of a few
kilograms rewrites the cost of the original meal.** State: OPEN. Owner: `farm-expert`.
Deadline: 2026-09-19.

Evidence:

- `apps/farm-service/src/feeding-protocol/services/meal-execution.service.ts` recomputes the pour's
  cost from the CURRENT `Feed.pricePerKg` when it applies a correction, rather than pricing only the
  delta.

Root cause: cost is recomputed from a mutable master-data field instead of being treated as a
ledger fact that accretes. A feed whose price moved between the meal and its correction therefore
restates history, and the restatement flows into batch `totalFeedCost` and every finance derivation
that reads it.

Closure criterion: a correction prices only its DELTA, at the price in effect for that delta, and
leaves the original pour's recorded cost untouched; `batches_v2.totalFeedCost` moves by the delta's
cost and by nothing else. Verified by a spec that changes `pricePerKg` between the pour and the
correction and asserts the original cost is unchanged — that spec must be red against the current
implementation before it is accepted.

## FARM-LOW-277

**`RemovalQuantityPolicyService`'s three-mode contract does not reach the code: mode (c) is
unreachable through the DTO, and `countDerived` is never read by any caller.** State: OPEN.
Owner: `farm-expert`. Deadline: 2026-09-26.

Evidence:

- `apps/farm-service/src/batch/services/removal-quantity-policy.service.ts` documents three input
  modes and implements all three, including the kg-only mode that derives `count` and flags it with
  `countDerived: true`.
- `apps/farm-service/src/batch/dto/record-mortality.dto.ts` declares `count!: number` with `@Min(1)`
  and a non-nullable `Int` GraphQL field, so a kg-only submission is rejected by validation before
  the service is reached — mode (c) has no caller.
- `countDerived` appears nowhere outside the service and its own spec: no `TankOperation` column
  carries it and no event field publishes it, although the service's docblock states that it is
  "TankOperation + event'e işlenir".

Root cause: a policy SSoT was written for a surface that was never widened to admit it. The service
is not wrong; the boundary around it never changed, so a documented mode is dead code and a
documented provenance flag is dropped on the floor.

Closure criterion (both halves, or neither — a reachable mode whose provenance is discarded is worse
than an unreachable one): `count` becomes optional on the mortality/cull/transfer inputs with a
class-level rule that at least one of `count`/`biomassKg` is present; and `countDerived` is
persisted on `TankOperation` and carried on the removal events, so a downstream consumer can tell a
counted removal from a derived one. Both halves need a migration (nullable column → backfill →
constraint), an event-contract change with its JSON Schema, and regenerated client artifacts —
which is why this one carries the later deadline of the three.

## Closed on the branch — recorded here so the PR body's list is not read as current

| ID              | Closed by                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FARM-HIGH-247   | `fix(farm): band/yem/FCR çözümünü tek servise indir, canlı çözümü plana yaz`                                                                                        |
| FARM-HIGH-248   | `fix(farm): yem düşümünü çok-lotlu FEFO tahsisine çevir…` + `fix(farm): make the unit-growth lock protocol impossible to compose wrongly`                           |
| FARM-MEDIUM-254 | same W2 commit, completed by `fix(farm): let a feed return restore the lot identity the ledger took`                                                                |
| FARM-MEDIUM-256 | `fix(farm): yemleme takvimini tenant'ın yerel gününe bağla…` + `test(farm): stop stubbing the TankBatch writer a suite asserts`                                     |
| FARM-MEDIUM-288 | `fix(farm): DAILY büyüme rollup'ını kümülatif mutabakata çevir` + the unit-growth lock commit + `fix(farm): give the feeding PG spec the real engine collaborators` |
| FARM-LOW-263    | `fix(farm): band/yem/FCR çözümünü tek servise indir, canlı çözümü plana yaz`                                                                                        |
| FARM-LOW-270    | `fix(farm): yemleme takvimini tenant'ın yerel gününe bağla, saat SSoT'sini tek servise indir`                                                                       |

Each of those commits carries its own `Closes:` trailer naming the finding, and the trailers survive
the rebase, so the merged history proves the closure without this table. The table exists only
because the PR body still lists them as open.
