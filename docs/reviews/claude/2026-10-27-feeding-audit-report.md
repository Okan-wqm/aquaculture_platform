# Feeding production E2E audit: report (2026-10-26)

<!-- markdownlint-disable MD013 -->

An end-to-end audit of the ten Production > Feeding tabs (frontend, GraphQL, handlers, database; read, create, edit, delete) on production, with the Codex Test Tenant. One agent per tab read the code and exercised the live system; a second phase wrote to an isolated ZZ-AUDIT chain, cleaned it up by SQL (269 rows, backed up) and left only the audit-log rows. This report compiles what it found, what has been fixed, and what is registered.

## Result

191 distinct findings (3 critical, 26 high, 92 medium, 70 low), plus 37 informational notes and 3 confirmed-working checks. A finding that several tabs hit is counted once, in the tab that owns it; the 11 cross-references are left out of the counts.

| Tab                              | Critical |   High | Medium |    Low |   Info |
| -------------------------------- | -------: | -----: | -----: | -----: | -----: |
| Meal Board                       |        1 |      4 |     10 |      8 |      2 |
| Forecast                         |        0 |      2 |      5 |      5 |      4 |
| Records                          |        0 |      3 |     15 |      8 |      3 |
| Summary                          |        0 |      3 |      8 |      7 |      5 |
| Growth                           |        0 |      1 |     10 |      2 |      5 |
| FCR                              |        0 |      2 |      8 |      2 |      3 |
| Production Plan                  |        0 |      1 |      8 |     13 |      4 |
| Protocols                        |        1 |      2 |      7 |      8 |      5 |
| Assignments                      |        0 |      2 |     15 |     13 |      4 |
| Sampling                         |        0 |      4 |      6 |      4 |      2 |
| Cross-tab (verified by the lead) |        1 |      2 |      0 |      0 |      0 |
| **Total**                        |    **3** | **26** | **92** | **70** | **37** |

Most of the critical and high findings are a handful of root causes seen from different tabs, so the next section is the one to read first.

## Root causes, and where each stands

| #   | Root cause                                                                                                                                                                                                                         | Seen in                                                               | Registry                                                              | Status                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | Background workers read nothing under FORCE row-level security: the feeding engine's tenant discovery, run ledger and zone read, then every task cron and the AutoRule engine (a runner with only a `search_path` binds no tenant) | Meal Board, Forecast, Assignments, FCR, Summary                       | FARM-CRITICAL-479, FARM-HIGH-481, FARM-HIGH-482 (part), PLAT-HIGH-938 | 479 and 481 fixed in PRs; 938 tracks the seven files that still iterate schema names |
| 2   | GraphQL inputs without validators are rejected by the global whitelist pipe (`batches(filter:)`, `recordGrowthSample`, `growthMeasurements(filter:)`)                                                                              | Summary, Growth, FCR, Records, Production Plan, Assignments, Sampling | FARM-HIGH-480, FARM-HIGH-482, PLAT-HIGH-922 (umbrella)                | fixed in PRs; the umbrella ratchet stays open for the other files                    |
| 3   | The web sends stored values where the schema wants enum names, and a display name where it wants a user id                                                                                                                         | Protocols (create and edit both fail), Sampling                       | FARM-HIGH-482                                                         | fixed in a PR                                                                        |
| 4   | The alert engine could not open an incident for a farm signal (uuid column, synthetic key) and no service could dead-letter, so one MealUnderfed event looped for days                                                             | Meal Board                                                            | ALERT-HIGH-025, PLAT-HIGH-933                                         | fixed in a PR; MealUnderfed is now once per unit per day                             |
| 5   | A rate-limited refresh reached the browser as a server error, the client read it as a dead session, and notification-service answered every call UNAUTHENTICATED                                                                   | all tabs (people logged out)                                          | PLAT-HIGH-934, PLAT-HIGH-935, FE-HIGH-396, SEC-MEDIUM-212             | fixed in PRs                                                                         |
| 6   | NATS handlers in notification-service wrote under RLS with no tenant bound                                                                                                                                                         | Meal Board (alerts), Records                                          | PLAT-HIGH-936, PLAT-HIGH-937                                          | 936 fixed in a PR; 937 tracks three services with the same gap                       |
| 7   | Feeding record money integrity: a negative amount is accepted, an edit never re-prices, no unit on a UI-created record, cost and currency disagree                                                                                 | Records, Summary                                                      | FARM-HIGH-485, FARM-HIGH-486, FARM-HIGH-487                           | registered now                                                                       |
| 8   | Authorization: two production-plan reads ignore the caller's assigned sites                                                                                                                                                        | Production Plan                                                       | FARM-HIGH-484                                                         | registered now                                                                       |
| 9   | Protocol editor semantics: an edit cannot clear fields, the FCR matrix is transposed                                                                                                                                               | Protocols                                                             | FARM-HIGH-488                                                         | registered now                                                                       |
| 10  | Read models that contradict each other or fail: a client-side FCR formula, `growthAnalysis` always failing, the simulator's feed lookup, the Forecast tab's unreachable tenant pool                                                | FCR, Growth, Forecast                                                 | FARM-HIGH-489, FARM-HIGH-490, FARM-HIGH-491                           | registered now                                                                       |
| 11  | Meal flows: a partial pour writes NULL into a NOT NULL column, and no UI path creates a day plan                                                                                                                                   | Meal Board                                                            | FARM-HIGH-492, FARM-HIGH-493                                          | registered now                                                                       |

The medium and low findings are not registered one by one: they are listed below, with the tab that owns each, and the evidence for every entry sits in the audit archive named at the end. A medium that belongs to one of the root causes above is closed by fixing it.

## Registered findings

The ten root causes that were not already registered by the first series. Each is a defect seen on production or in the source, with the evidence cited; the owner is Okan-wqm and the deadline 2026-11-10.

## FARM-HIGH-484 — tankGrowthProjection and temperatureScenarios do not enforce the caller's assigned sites: a MODULE_USER can read any site's tanks, fish counts, biomass and feed totals, or the whole tenant

- **Rule:** A site-scoped read is fail-closed for a non-manager: only assignedSiteIds, never the tenant-wide scope, in one shared helper.
- **Evidence:** `apps/farm-service/src/production-plan/resolvers/production-plan.resolver.ts:26`, `apps/farm-service/src/production-plan/resolvers/production-plan.resolver.ts:62`, `apps/farm-service/src/feeding-protocol/resolvers/feed-forecast.resolver.ts:63`.
- **What was seen:** Static plus the contrast with protocolFeedForecast, which is fail-closed. As TENANT_ADMIN tankGrowthProjection(input:{}) returned both sites' tanks; not exercised as a MODULE_USER (the test account is TENANT_ADMIN). Fix: take @CurrentUser in both reads and extract the forecast resolver's gate into one helper, plus a spec per role.

## FARM-HIGH-485 — Feeding records: a negative amount is accepted and mints phantom stock, lowering an amount returns the stock but keeps the cost, and an edit never re-prices the record, the batch cost or the finance expense

- **Rule:** A ledger movement is validated at the boundary (a quantity is positive) and a correction moves stock, cost and the finance expense by the same delta.
- **Evidence:** `apps/farm-service/src/feeding/handlers/update-feeding-record.handler.ts:131`, `apps/farm-service/src/feeding/resolvers/feeding.resolver.ts:921`, `apps/farm-service/src/feeding/query-handlers/get-feeding-summary.handler.ts:87`.
- **What was seen:** Confirmed live on a ZZ-AUDIT chain (cleaned up): a record edited to a negative amount was accepted and the summary summed it. updateFeedingRecord forwards no feedCost, so costDiff in the handler is always 0. Fix: validate amount > 0 in the DTO and the handler; recompute feedCost from the delta (same rule as recordFeed) and adjust Batch.totalFeedCost; exclude voided rows from aggregates.

## FARM-HIGH-486 — Feeding cost is computed from the feed's own price currency but stamped with the tenant default currency, and the summary labels every total NOK and adds mixed currencies together

- **Rule:** A monetary amount carries the currency it was computed in, and an aggregate is per currency, never a literal default.
- **Evidence:** `apps/farm-service/src/feeding/services/feeding-ledger.service.ts:119`, `apps/farm-service/src/feeding/services/feeding-ledger.service.ts:398`, `apps/farm-service/src/feeding/resolvers/feeding.resolver.ts:760`, `web/modules/farm-module/src/pages/feeding/components/FeedingSummaryTab.tsx:261`.
- **What was seen:** Live: finance_settings.defaultCurrency TRY, feeds priced in TRY, feeding_records.currency USD on all 7 rows; the card shows 'Total Cost 12012 NOK'. Fix: store the price currency with the cost, return currency and per-currency totals from feedingSummary, drop the literal NOK.

## FARM-HIGH-487 — A feeding record created from the UI has no tank: growth credit, day-plan binding and site attribution are silently skipped, and the API accepts an unknown tank or a tank that does not hold the batch

- **Rule:** A feeding record of a batch that sits in a unit names that unit, and the ledger refuses a record whose unit does not hold the batch.
- **Evidence:** `web/modules/farm-module/src/pages/feeding/components/FeedingRecordsTab.tsx:182`, `apps/farm-service/src/feeding/handlers/create-feeding-record.handler.ts:112`.
- **What was seen:** Static: no input ever writes tankId, and every tank-dependent behaviour in createFeedingRecord is keyed on payload.tankId. Not yet seen live (7 of 7 live rows were created through the API or the meal board and carry a tank). Fix: a Tank select (tanks holding the chosen batch), tankId required for a batch in a tank, server-side existence and containment check.

## FARM-HIGH-488 — Protocol editor: an edit cannot clear optional columns (species, temperature adjustments, description) and the FCR-matrix editor is transposed against the backend contract

- **Rule:** A cleared field is cleared (null is a value, undefined is not) and the editor's matrix axes are the backend's: `fcrValues[temperatureIndex][weightIndex]`.
- **Evidence:** `apps/farm-service/src/feeding-protocol/handlers/protocol-crud.handlers.ts:211`, `web/modules/farm-module/src/pages/feeding/components/ProtocolBuilderTab.tsx:280`, `web/modules/farm-module/src/pages/feeding/components/ProtocolBuilderTab.tsx:433`, `apps/farm-service/src/feeding-protocol/services/protocol-validation.service.ts:1`.
- **What was seen:** Source plus a live render: after '+ Add weight' the editor holds 5 rows x 4 columns and the server check 5 !== 4 rejects it; a square default grid is accepted and stored with its axes swapped. TypeORM skips undefined properties, so an emptied field never reaches the UPDATE. Fix: send null to clear (set speciesId and speciesName together) and transpose the editor; add a handler spec (none exists).

## FARM-HIGH-489 — The FCR tab computes a third, client-side FCR from stale snapshots that disagrees with the backend FCR authority once a weighing, a mortality, a cull or a transfer exists

- **Rule:** One FCR SSoT: the backend authority serves the per-batch FCR and the client renders it, it does not recompute it.
- **Evidence:** `web/modules/farm-module/src/pages/feeding/components/FCRAnalysis.tsx:52`, `apps/farm-service/src/growth/services/fcr-calculation.service.ts:508`.
- **What was seen:** Live recompute: displayed biomass is the stored snapshot (250 / 240 / 250 kg) while the live derived biomass is 245.75 / 237.36 / 250 kg. Today every batch reads 'No Data' (no weighing exists). Fix: serve the cumulative FCR from the backend in the batch list and delete the client formula.

## FARM-HIGH-490 — growthAnalysis always fails with INTERNAL_SERVER_ERROR (a flat result returned as a nested type) and the growth simulator's feed lookup never works (wrong SQL placeholders swallowed into an empty cache)

- **Rule:** A resolver returns the type its field declares, and a query that fails is not cached as an empty answer.
- **Evidence:** `apps/farm-service/src/growth/resolvers/growth.resolver.ts:468`, `apps/farm-service/src/feeding/services/feed-selector.service.ts:110`.
- **What was seen:** Live: 'Cannot return null for non-nullable field GrowthAnalysisResponse.batchCode'; the simulator's 91 projection rows carry feedCode null and feedRequirements [] while the batch has an active feed assignment. Fix: map the handler result, bind $(i+2) (or = ANY($2::uuid[])), stop caching the failure, add specs (none cover FeedSelectorService or GrowthSimulatorService).

## FARM-HIGH-491 — The web Forecast tab can only show an informational SITE row: the authoritative tenant pool is unreachable, so it shows 'runs out in 0 d / Action required' for feed the pool covers for 68 days while mobile says OK

- **Rule:** A surface shows the scope the backend decides on, and two surfaces do not contradict each other on the same snapshot.
- **Evidence:** `web/modules/farm-module/src/pages/feeding/components/ForecastTab.tsx:27`, `web/modules/farm-module/src/pages/feeding/components/DepletionForecastChart.tsx:58`.
- **What was seen:** Same instant, same snapshot: web (site GUI3 Kara RAS) 'GUI3-FD-1 runs out in 0d'; protocolFeedForecast(siteId: null) FD-1 368.8 kg no stockout; mobile warehouseSummary.feedCoverage FD-2 68 days OK. Fix: a 'Whole tenant pool' option as the default for managers, SITE_TRANSFER_NEEDED shown as a transfer hint, do not clamp the deficit to 0.

## FARM-HIGH-492 — A partial pour (finalize unticked, the modal default) writes NULL into the NOT NULL feeding_records.plannedAmount and should roll back, so the primary 'Add pour' flow cannot work

- **Rule:** A column that is NOT NULL is given a value on every path that inserts it, and a test boots the production column definition.
- **Evidence:** `apps/farm-service/src/feeding-protocol/services/meal-execution.service.ts:244`, `apps/farm-service/src/feeding/services/feeding-ledger.service.ts:135`.
- **What was seen:** Static plus the column definition read on production (plannedAmount numeric(10,3) NOT NULL, no default). Every real pour in production was finalize=true. The postgres fixture declares NOT NULL DEFAULT 0, which differs from production, which is why no test saw it. Fix: pass the meal's per-pour planned share (or make the column nullable), and add a postgres spec on the production definition.

## FARM-HIGH-493 — No UI path creates a day plan: the empty meal board has no action and 'Regenerate' acts on today's plan, not on the card's date, and reports GENERATED with a null plan id when it did nothing

- **Rule:** An operator can recover from a missing plan in the UI, and an operation that did nothing says so.
- **Evidence:** `web/modules/farm-module/src/pages/feeding/components/MealBoardTab.tsx:544`, `apps/farm-service/src/feeding-protocol/services/day-plan-admin.service.ts:101`.
- **What was seen:** With the cron down (FARM-CRITICAL-479) the 'Assignments without a plan today' strip lists the units but offers no button. On a COMPLETED plan the existing-plan filter misses it, persistDayPlan is ON CONFLICT DO NOTHING and the mutation answers outcome GENERATED with dayPlanId null. Fix: a per-unit 'Generate today's plan' action; take (unitId, planDate) and return an explicit NOOP outcome.

## Fixed so far (pull requests)

| PR                                                                         | Closes                                    |
| -------------------------------------------------------------------------- | ----------------------------------------- |
| #2157 feeding cron tenant context                                          | FARM-CRITICAL-479                         |
| #2158 Batch filter validators                                              | FARM-HIGH-480                             |
| #2159 MealUnderfed once per unit per day, dead-letter grants               | ALERT-HIGH-025, PLAT-HIGH-933             |
| #2160 throttle surfacing, user assertion, session kept on a refresh outage | PLAT-HIGH-934, PLAT-HIGH-935, FE-HIGH-396 |
| #2167 task crons and the AutoRule engine bind the tenant                   | FARM-HIGH-481                             |
| #2169 notification event handlers run in the event tenant's context        | PLAT-HIGH-936                             |
| #2175 growth input validators, enum wire values, measuredBy user id        | FARM-HIGH-482                             |
| #2177 refresh bucket sized for a shared address                            | SEC-MEDIUM-212                            |

The follow-up PRs #2167, #2169, #2175 and #2177 are for the findings this audit registered and left open in the first four. The two findings the follow-up work itself uncovered (PLAT-HIGH-937, PLAT-HIGH-938) are tracked, not fixed, in `docs/reviews/claude/2026-10-27-tracked-findings-fix.md`.

## Every finding, by tab

`FD-<tab>-<n>` is this report's own numbering (the order of the audit file). Severity is the auditor's; a registry id is given where the finding is registered.

### Meal Board

| ID       | Severity | Finding                                                                                                                                                                                                 |
| -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FD-MB-01 | CRITICAL | The meal-engine cron never runs for any tenant: day plans are never generated automatically (probable root cause: tenant discovery under FORCE RLS returns nothing)                                     |
| FD-MB-02 | HIGH     | `batches(filter:{...})` returns BAD_REQUEST for ANY non-empty filter; header KPIs show 0.0 t / 0 fish silently                                                                                          |
| FD-MB-03 | HIGH     | [STATIC, unverified live] A partial pour (checkbox "finalize" unticked = the modal default) writes a NULL into NOT NULL `feeding_records.plannedAmount` and should roll back                            |
| FD-MB-04 | HIGH     | No UI path creates a day plan: empty board has no action; "Regenerate" exists only on an existing card, acts on TODAY and the unit, not on the card's date                                              |
| FD-MB-05 | MEDIUM   | Header cards are scoped to an arbitrary first site and read a 4-day-old snapshot; mutually inconsistent with the board and with each other                                                              |
| FD-MB-06 | MEDIUM   | The plan card prints the frozen, @deprecated `snapshot` for feed/rate/FCR/biomass instead of the live `resolution`                                                                                      |
| FD-MB-07 | MEDIUM   | Ledger date/time of a pour is server "now" in UTC, not the plan date / site-local time                                                                                                                  |
| FD-MB-08 | MEDIUM   | Per-pour ledger rows carry the WHOLE meal's planned kg on the finalizing pour: false variance on multi-pour meals                                                                                       |
| FD-MB-09 | MEDIUM   | Command envelope is built per click inside mutationFn, so a retry after an ambiguous failure is a NEW command: duplicate pour + double stock deduction                                                  |
| FD-MB-10 | MEDIUM   | "Finalize" button discards errors (floating promise) - no feedback on failure                                                                                                                           |
| FD-MB-11 | MEDIUM   | Stock deduction silently crosses sites (D-9 fallback) while the header/forecast say the site has no stock                                                                                               |
| FD-MB-12 | LOW      | `feedingDayPlans(planDate, siteId)` args are not validated: invalid values return 500 with the raw database error                                                                                       |
| FD-MB-13 | LOW      | FE batch filter omits HARVESTING (feedable) and the header ignores growth                                                                                                                               |
| FD-MB-14 | LOW      | correctMealPour stock leg can fail ("kalan ... kg") after an upward correction followed by a larger downward one                                                                                        |
| FD-MB-15 | LOW      | UI details                                                                                                                                                                                              |
| FD-MB-16 | LOW      | Write-path cache invalidation is narrow                                                                                                                                                                 |
| FD-MB-17 | LOW      | Mixed tanks: all feed of a pour is attributed to the primary batch                                                                                                                                      |
| FD-MB-18 | INFO     | Works correctly (with proof)                                                                                                                                                                            |
| FD-MB-19 | INFO     | Production reality / coverage gaps                                                                                                                                                                      |
| FD-MB-20 | HIGH     | alert-engine: one MealUnderfed event re-inserts an alert_history row every ~30 s for days; incidents are never created (same loop explains the 99,565-row / 40,003-critical alert flood of this tenant) |
| FD-MB-21 | MEDIUM   | Pour modal keeps finalize/kg after Cancel (carry-over bit the test itself)                                                                                                                              |
| FD-MB-22 | MEDIUM   | Day badge "Underfed" is computed on in-progress days against meals that are not due yet                                                                                                                 |
| FD-MB-23 | MEDIUM   | TankBatch.lastFeedingAt is never written by the meal engine                                                                                                                                             |
| FD-MB-24 | LOW      | Forecast/stock snapshot does not follow pours; Records list rounds and shows UTC                                                                                                                        |
| FD-MB-25 | LOW      | Header/strip unchanged by writes                                                                                                                                                                        |

### Forecast

| ID       | Severity | Finding                                                                                                                                                          |
| -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FD-FC-01 | HIGH     | The 07:00 "stock-coverage" job has never run in production; the snapshot is only refreshed by events and is 4 days old (VERIFIED symptom, HYPOTHESIS root cause) |
| FD-FC-02 | HIGH     | The web Forecast tab can only show an informational SITE row; the authoritative TENANT pool is unreachable and contradicts mobile (VERIFIED)                     |
| FD-FC-03 | MEDIUM   | 3 of 4 sites show "Forecast snapshot not computed yet" although data exists (VERIFIED)                                                                           |
| FD-FC-04 | MEDIUM   | Snapshot refresh misses the events that actually change the inputs (VERIFIED example, STATIC rule)                                                               |
| FD-FC-05 | MEDIUM   | Forecast does not use the engine's resolution rules, contrary to its own contract (STATIC; magnitude hand-computed)                                              |
| FD-FC-06 | MEDIUM   | `refresh: Boolean` makes a GraphQL _query_ write to the DB — safe but with sharp edges (answer to the lead; VERIFIED UI side, STATIC rest; NOT exercised live)   |
| FD-FC-07 | MEDIUM   | Header KPIs shown above this tab are misleading (VERIFIED)                                                                                                       |
| FD-FC-08 | LOW      | Fetched-but-unused fields: reorder, lead time and alert types are never shown; default lead time is applied silently in the UI (VERIFIED)                        |
| FD-FC-09 | LOW      | Expired stock counts as available stock (STATIC; data present but not on a protocol feed)                                                                        |
| FD-FC-10 | LOW      | Edge cases: zero biomass / no assignments / mortality (STATIC + data)                                                                                            |
| FD-FC-11 | LOW      | No cache invalidation toward the forecast query (STATIC)                                                                                                         |
| FD-FC-12 | INFO     | Forecast math verified against the database (VERIFIED)                                                                                                           |
| FD-FC-13 | INFO     | What the forecast actually reads (correcting the task brief)                                                                                                     |
| FD-FC-14 | INFO     | refresh:true — PASS (single approved write; idempotent; throttle silent) (VERIFIED)                                                                              |
| FD-FC-15 | LOW      | Empty-string siteId silently returns null (VERIFIED)                                                                                                             |
| FD-FC-16 | INFO     | Post-test snapshot state (for the parent)                                                                                                                        |

### Records

| ID       | Severity | Finding                                                                                                                                                                 |
| -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FD-RC-01 | HIGH     | The create form has no Tank field: every UI-created record is tank-less and silently skips growth, plan binding and site attribution                                    |
| FD-RC-02 | HIGH     | Editing a record never re-prices it: feedCost, Batch.totalFeedCost and the finance FEED expense stay at the original amount                                             |
| FD-RC-03 | MEDIUM   | There is no way to delete or void a feeding record                                                                                                                      |
| FD-RC-04 | MEDIUM   | Edit cannot re-submit rows whose amount has 3 decimals; amount precision is defined three different ways                                                                |
| FD-RC-05 | MEDIUM   | Edit is offered on meal-bound rows that the server refuses to edit (3 of 7 rows)                                                                                        |
| FD-RC-06 | MEDIUM   | The Site filter does nothing for Records; the page number is not reset when the batch filter changes                                                                    |
| FD-RC-07 | MEDIUM   | List ordering is not deterministic: ORDER BY feedingDate only                                                                                                           |
| FD-RC-08 | MEDIUM   | Currency and cost: the UI always sends a currency (default NOK) and the ledger never looks at the feed's own currency                                                   |
| FD-RC-09 | MEDIUM   | 9 of the 12 feeds offered in the picker cannot be recorded today (feeds.quantity is phantom for 5 feeds, 2 lots expired)                                                |
| FD-RC-10 | MEDIUM   | No audit trail for create/edit; verifiedBy is accepted and silently dropped; fedBy is client-supplied                                                                   |
| FD-RC-11 | MEDIUM   | Role gating: write buttons shown to everyone; reads are not site-scoped                                                                                                 |
| FD-RC-12 | MEDIUM   | Mutations do not refresh the other views that show their effect                                                                                                         |
| FD-RC-13 | LOW      | Tenant schema has no foreign keys for feeding_records (and 60 fewer than the template overall)                                                                          |
| FD-RC-14 | LOW      | DTO/validation gaps found by reading (all STATIC, Phase 2 candidates)                                                                                                   |
| FD-RC-15 | LOW      | Clearing a field on edit is a silent no-op                                                                                                                              |
| FD-RC-16 | LOW      | What the table shows vs the data                                                                                                                                        |
| FD-RC-17 | LOW      | UX / error-handling details (STATIC)                                                                                                                                    |
| FD-RC-18 | INFO     | Works correctly (proof)                                                                                                                                                 |
| FD-RC-19 | MEDIUM   | A lot received today cannot be consumed by a date-only record dated today (the Records form's own default)                                                              |
| FD-RC-20 | LOW      | Batch status read-model is not refreshed by a status change                                                                                                             |
| FD-RC-21 | LOW      | Storage > Feed stock table shows "-" in ITEM and LOCATION for every lot                                                                                                 |
| FD-RC-22 | INFO     | Correction to my Phase-1 "not verified" note about the outbox                                                                                                           |
| FD-RC-23 | HIGH     | An edit that lowers a record to a smaller (or zero, or negative) amount returns the stock but keeps the cost, and a NEGATIVE amount is accepted and mints phantom stock |
| FD-RC-24 | MEDIUM   | createFeedingRecord rejects any request that omits `feedingMethod` although the schema default is MANUAL                                                                |
| FD-RC-25 | MEDIUM   | Raw database errors reach the client as INTERNAL_SERVER_ERROR (B8-B11, D14)                                                                                             |
| FD-RC-26 | MEDIUM   | The Records "Columns" menu cannot ADD columns while the tab is mounted                                                                                                  |
| FD-RC-27 | MEDIUM   | Edit modal: a record whose actual amount is 0 opens with an EMPTY required field; negative rows cannot be re-submitted                                                  |
| FD-RC-28 | LOW      | Cost/currency presentation                                                                                                                                              |
| FD-RC-29 | INFO     | What passed (proof)                                                                                                                                                     |

### Summary

| ID       | Severity | Finding                                                                                                                                                         |
| -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FD-SM-01 | HIGH     | The Summary tab cannot be used in production: its batch list is empty (shared Batches BAD_REQUEST), nothing explains why, and feedingSummary is never requested |
| FD-SM-02 | INFO     | The INTERNAL_SERVER_ERROR in the first crawl was the refresh mutation, not the summary query                                                                    |
| FD-SM-03 | MEDIUM   | Clearing a date input yields INTERNAL_SERVER_ERROR and dead-ends the whole tab                                                                                  |
| FD-SM-04 | LOW      | Malformed entityId returns INTERNAL_SERVER_ERROR with the raw Postgres message                                                                                  |
| FD-SM-05 | HIGH     | Total Cost is always labelled "NOK" - the response carries no currency, and mixed currencies are summed blindly                                                 |
| FD-SM-06 | MEDIUM   | "Avg: x kg/feeding" actually shows kg per DAY                                                                                                                   |
| FD-SM-07 | MEDIUM   | FCR Analysis card: literal "0", "Actual FCR 0.00" in red for every live batch, Target == Theoretical                                                            |
| FD-SM-08 | MEDIUM   | Batch/site scoping is inconsistent: some batches can never be summarized, the Site filter is decorative, and there are two independent batch selectors          |
| FD-SM-09 | MEDIUM   | Day bucketing is the UTC date of the pour, and "variance" ignores skipped/missed meals and un-finalized pours (answers meal-board's question)                   |
| FD-SM-10 | MEDIUM   | No empty state: zero data renders a full, plausible set of zero cards                                                                                           |
| FD-SM-11 | MEDIUM   | feedingSummary has no site scoping and exposes cost to MODULE_USER                                                                                              |
| FD-SM-12 | LOW      | Aggregation happens in JS over full entities; float artefacts reach the API; unbounded window                                                                   |
| FD-SM-13 | LOW      | Realtime/cache coupling is partial                                                                                                                              |
| FD-SM-14 | LOW      | i18n and tests                                                                                                                                                  |
| FD-SM-15 | LOW      | feeding_records has no foreign keys in the database                                                                                                             |
| FD-SM-16 | INFO     | Displayed numbers equal the database (recomputed independently)                                                                                                 |
| FD-SM-17 | INFO     | Header KPI claims from forecast/meal-board hold (they show on this tab too)                                                                                     |
| FD-SM-18 | INFO     | mv_daily_batch_feeding does not exist; nothing here reads it                                                                                                    |
| FD-SM-19 | LOW      | Computed but never shown: waste, duration, appetite, daily trend                                                                                                |
| FD-SM-20 | HIGH     | The summary has no defence against negative or zero-amount records and keeps their cost                                                                         |
| FD-SM-21 | MEDIUM   | Total Planned / variance are ledger-based: a skipped meal's planned kg never appears (S10), manual 'planned' values from the Records form are mixed in          |
| FD-SM-22 | LOW      | Scope reconciliation: batch total != Σ tank summaries; tank mode trusts feeding_records.tankId (S12)                                                            |
| FD-SM-23 | INFO     | What passed                                                                                                                                                     |

### Growth

| ID       | Severity | Finding                                                                                                                                                                                                                                                                                                                                                         |
| -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FD-GR-01 | MEDIUM   | `growthAnalysis` fails for every batch (shape mismatch) — adjacent growth-domain API, found by fcr (rated HIGH there), confirmed live here                                                                                                                                                                                                                      |
| FD-GR-02 | HIGH     | Feed-type lookup in the simulator silently never works: `preloadFeedDataForBatch` uses wrong SQL placeholders, so every simulation falls back to a hard-coded feed-rate table and "Feed Requirements by Type" is always empty                                                                                                                                   |
| FD-GR-03 | MEDIUM   | The tab starts from the stocking placeholder weight, not from any maintained weight                                                                                                                                                                                                                                                                             |
| FD-GR-04 | MEDIUM   | SGR is a hard-coded 1.5 %/day: `Batch.sgr` is never written                                                                                                                                                                                                                                                                                                     |
| FD-GR-05 | MEDIUM   | Which number is right? Header KPI vs Production plan vs Growth tab (the 0.0 t vs 228.6 kg lead)                                                                                                                                                                                                                                                                 |
| FD-GR-06 | MEDIUM   | The tab picks its batch once at mount and ignores the page filters afterwards (verified live with the filter emulated)                                                                                                                                                                                                                                          |
| FD-GR-07 | MEDIUM   | A failed or loading batch list is presented as "No active batches found. Create a batch..."                                                                                                                                                                                                                                                                     |
| FD-GR-08 | MEDIUM   | `projectionDays` (and every other numeric input) has no upper bound; each simulated day costs a DB query                                                                                                                                                                                                                                                        |
| FD-GR-09 | MEDIUM   | "Expected FCR" is not an expectation, and the model contradicts the v2 protocol on the same page                                                                                                                                                                                                                                                                |
| FD-GR-10 | INFO     | SamplingModal defects (measuredBy name into a uuid column, UTC+ calendar-day shift, no delete) are recorded once in findings/sampling.md — I reached the same conclusions independently from code (measuredBy: handler :157 + uuid NOT NULL; TypeORM 0.3.31 DateUtils.mixedDateToDateString local-field formatting for `date` columns) and have nothing to add. |
| FD-GR-11 | MEDIUM   | Page status filter hides HARVESTING batches that are still fed                                                                                                                                                                                                                                                                                                  |
| FD-GR-12 | LOW      | Defects around the edges of the tab                                                                                                                                                                                                                                                                                                                             |
| FD-GR-13 | INFO     | Lead check: "the tab fired EquipmentList, ProtocolFeedForecast and EffectiveUnitTemperatures"                                                                                                                                                                                                                                                                   |
| FD-GR-14 | INFO     | Works correctly (with evidence)                                                                                                                                                                                                                                                                                                                                 |
| FD-GR-15 | MEDIUM   | (confirmed on a clean v2 case) The v2 assignment and protocol bands never reach the Growth tab, even for a batch whose assignment bands use a real, existing feed                                                                                                                                                                                               |
| FD-GR-16 | INFO     | The SQL-placeholder bug (Phase 1 finding "Feed-type lookup ... never works") is NOT disproved, but this fixture cannot prove it either                                                                                                                                                                                                                          |
| FD-GR-17 | LOW      | Header KPIs after the ZZ chain (what the user sees)                                                                                                                                                                                                                                                                                                             |
| FD-GR-18 | INFO     | Correction of a premise in the step message                                                                                                                                                                                                                                                                                                                     |

### FCR

| ID       | Severity | Finding                                                                                                                                   |
| -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| FD-FR-01 | HIGH     | FCR tab shows a false empty state in production: "No active batches found. Create a batch to analyze FCR."                                |
| FD-FR-02 | HIGH     | The tab's FCR is a third, client-side formula that disagrees with the backend FCR authority and uses stale snapshots                      |
| FD-FR-03 | MEDIUM   | No FCR can be shown until a weighing exists; every batch is "No Data" today (and variance prints a green 0.0%)                            |
| FD-FR-04 | MEDIUM   | Summary cards are statistically wrong/mislabelled                                                                                         |
| FD-FR-05 | MEDIUM   | Filters: Batch and Site controls do not do what they say                                                                                  |
| FD-FR-06 | MEDIUM   | SGR view and "Average SGR" are permanently 0.00%                                                                                          |
| FD-FR-07 | MEDIUM   | "Target FCR" can never follow the protocol: batch.fcr.target is a user-entered value with isUserOverride=true for every createBatch batch |
| FD-FR-08 | MEDIUM   | Stale numbers after feeding writes (static) + errors keep stale data silently (observed)                                                  |
| FD-FR-09 | LOW      | "FCR Historical Trend" is a hard-coded placeholder                                                                                        |
| FD-FR-10 | MEDIUM   | Backend FCR authority reports garbage for never-weighed batches (affects batchPerformance, not this tab today)                            |
| FD-FR-11 | INFO     | FCR jobs and alerts (task question: are analyze-fcr / feeding-v2-\* affected?)                                                            |
| FD-FR-12 | INFO     | Works correctly                                                                                                                           |
| FD-FR-13 | MEDIUM   | batchPerformance is cached 1 h and only mortality/cull evict it (static)                                                                  |
| FD-FR-14 | LOW      | Feed Used / Weight Gain columns print toFixed(0)                                                                                          |
| FD-FR-15 | INFO     | Phase-1 verdicts confirmed by this step                                                                                                   |

### Production Plan

| ID       | Severity | Finding                                                                                                                          |
| -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| FD-PP-01 | HIGH     | Site scope is not enforced on tankGrowthProjection / temperatureScenarios (MODULE_USER can read any site, or the whole tenant)   |
| FD-PP-02 | MEDIUM   | The Site selector is disabled and the tab has no site filter bar: only `sites[0]` (or a site chosen on another tab) is reachable |
| FD-PP-03 | MEDIUM   | The System (department) dropdown is not scoped to the site; picking another site's system gives a misleading empty state         |
| FD-PP-04 | MEDIUM   | `siteName` is always "" and `departmentName` always null (Tank.department relation is never loaded)                              |
| FD-PP-05 | MEDIUM   | "Current temperature (held)" mode issues one DB read per simulated day per tank (365 days = 3.7 s for 2 tanks)                   |
| FD-PP-06 | MEDIUM   | Unknown temperature is shown as 0 °C although the model applied no correction                                                    |
| FD-PP-07 | MEDIUM   | Role gate is hard-coded: `canManage = true`                                                                                      |
| FD-PP-08 | MEDIUM   | The projection is a simplified copy of the feeding engine, and the differences are silent                                        |
| FD-PP-09 | LOW      | Horizon input: every keystroke is a request; out-of-range values surface an opaque "Bad Request" plus a misleading empty state   |
| FD-PP-10 | LOW      | `temperatureScenarios(siteId: ID!)` has no UUID validation and leaks the Postgres error                                          |
| FD-PP-11 | LOW      | A scenario of another site is accepted; create accepts any siteId (no existence check, no FK)                                    |
| FD-PP-12 | LOW      | Scenario list reads every point of the tenant; soft-deleted scenarios' points are never purged                                   |
| FD-PP-13 | LOW      | Delete flow: no confirmation, success is silent, selection resets before the server answers, unhandled rejection                 |
| FD-PP-14 | LOW      | Write path shape: mutations run on the QueryBus, no event/audit/outbox, no idempotency, no update path, no name uniqueness       |
| FD-PP-15 | LOW      | Small contract/i18n drifts                                                                                                       |
| FD-PP-16 | LOW      | `tankGrowthProjection` is never invalidated by the writes it depends on                                                          |
| FD-PP-17 | LOW      | Units are resolved from `tanks` only; pond/cage (equipment-based) units would silently drop out                                  |
| FD-PP-18 | LOW      | Leftover test data visible in the UI                                                                                             |
| FD-PP-19 | INFO     | Numbers recompute exactly (works correctly)                                                                                      |
| FD-PP-20 | INFO     | Plan and forecast agree numerically (shared day-step)                                                                            |
| FD-PP-21 | INFO     | Tenant scoping and soft-delete semantics are correct in the handlers                                                             |
| FD-PP-22 | MEDIUM   | Double click on "Save" (and any repeated submit) creates duplicate scenarios                                                     |
| FD-PP-23 | LOW      | Calendar-invalid dates pass validation and surface a raw Postgres error                                                          |
| FD-PP-24 | LOW      | Create response echoes the input, not the stored values                                                                          |
| FD-PP-25 | LOW      | Orphan and cross-site scenarios are confirmed live (upgrade of the Phase 1 LOW)                                                  |
| FD-PP-26 | INFO     | Scenario temperatures outside the protocol's adjustment bands get multiplier 1.0, so warmer is not always faster                 |

### Protocols

| ID       | Severity | Finding                                                                                                                                       |
| -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| FD-PR-01 | HIGH     | Edit cannot CLEAR optional columns: "Any species", removed temperature adjustments, cleared description are silently kept                     |
| FD-PR-02 | HIGH     | FCR-matrix editor is transposed against the backend: non-square matrices can never be saved, square ones are stored transposed                |
| FD-PR-03 | MEDIUM   | No audit trail for protocol create / update / archive                                                                                         |
| FD-PR-04 | MEDIUM   | No delete / un-archive path; unique index on (tenantId,name) is global, so archived names are burned forever                                  |
| FD-PR-05 | MEDIUM   | Status is not a single predicate: DRAFT/ARCHIVED protocols are treated differently by each consumer; edit-to-DRAFT does not touch assignments |
| FD-PR-06 | MEDIUM   | Feed deletion/deactivation is not guarded by protocol bands (jsonb reference, no FK)                                                          |
| FD-PR-07 | MEDIUM   | Editing bands does not remap assignment state that stores array positions                                                                     |
| FD-PR-08 | MEDIUM   | Concurrent edits are last-write-wins; create/update are not transactional                                                                     |
| FD-PR-09 | LOW      | `isDefault` is a write-only flag                                                                                                              |
| FD-PR-10 | LOW      | Archive failure is silent; no feedback of what was paused                                                                                     |
| FD-PR-11 | LOW      | Settings fields exist on the entity but no API input can set them                                                                             |
| FD-PR-12 | LOW      | Defaults disagree: API create default ACTIVE, DB column default 'draft', UI default DRAFT                                                     |
| FD-PR-13 | LOW      | Server messages are Turkish and raw; DTO failures are masked as "Bad Request" [partly VERIFIED-LIVE]                                          |
| FD-PR-14 | LOW      | List is hard-capped at 100 with no paging UI; three screens share the cache entry                                                             |
| FD-PR-15 | LOW      | Legacy entry points: `/sites/feeding/protocols` does not redirect; `/feeding/protocols` is a 404                                              |
| FD-PR-16 | LOW      | No tests for protocol CRUD                                                                                                                    |
| FD-PR-17 | INFO     | v1 protocol API still live next to v2                                                                                                         |
| FD-PR-18 | INFO     | Works correctly (with evidence)                                                                                                               |
| FD-PR-19 | INFO     | Day-plan generation has produced nothing since 2026-10-11 (question sent to meal-board / forecast)                                            |
| FD-PR-20 | CRITICAL | The Protocols v2 tab can neither CREATE nor EDIT a protocol: every Save is rejected with a GraphQL enum error                                 |
| FD-PR-21 | MEDIUM   | Bands are stored in SUBMITTED order, not sorted                                                                                               |
| FD-PR-22 | INFO     | Works correctly (PASS), with evidence                                                                                                         |
| FD-PR-23 | PASS     | Update to DRAFT while assigned: nothing follows the status change                                                                             |
| FD-PR-24 | PASS     | Archive via the app (UI button) - transaction, events, plan untouched                                                                         |
| FD-PR-25 | PASS     | Archive edge cases                                                                                                                            |
| FD-PR-26 | OTHER    | UI feedback on a FAILED archive                                                                                                               |
| FD-PR-27 | INFO     | Not demonstrable here                                                                                                                         |

### Assignments

| ID       | Severity | Finding                                                                                                                                                              |
| -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FD-AS-01 | HIGH     | FeedingPage `Batches` query fails with BAD_REQUEST on every load: batch picker empty, header KPIs show false zeros                                                   |
| FD-AS-02 | HIGH     | Assignments produce no daily plans: the 06:00 job ledger has never been written and only ONE day plan exists in the tenant's whole history                           |
| FD-AS-03 | MEDIUM   | `effectiveFrom` is a stored decoration: future-dated assignments are live immediately, and the tab never shows it (nor `endedAt`)                                    |
| FD-AS-04 | MEDIUM   | Replacing / pausing / unassigning does not touch today's plan: plan stays bound to the replaced assignment, meals stay feedable                                      |
| FD-AS-05 | MEDIUM   | "Current feed" column is blank for every assignment that has not had a transition                                                                                    |
| FD-AS-06 | MEDIUM   | Assign silently replaces an existing live assignment; the picker gives no hint                                                                                       |
| FD-AS-07 | MEDIUM   | Pause/Resume/Unassign/Manual-transition failures are silent; manual transition offers choices the server must reject                                                 |
| FD-AS-08 | MEDIUM   | Sensor binding in the Edit modal: current sensor never displayed for tank units, "No sensor" cannot clear, no validation, two non-atomic writes                      |
| FD-AS-09 | MEDIUM   | Denormalised unit fields are never re-synced; deleting a tank leaves a live assignment                                                                               |
| FD-AS-10 | MEDIUM   | Resume can land on an ARCHIVED/DRAFT protocol; protocol status changes by `updateFeedingProtocolV2` do not pause assignments                                         |
| FD-AS-11 | MEDIUM   | No audit trail for assignment create/update/replace/unassign                                                                                                         |
| FD-AS-12 | MEDIUM   | Unassign and Resume emit no event; forecast stays stale; re-unassign overwrites `endedAt`                                                                            |
| FD-AS-13 | LOW      | Overrides edit has no immediate effect and no hint; `AssignmentOverrides.missedMealCatchUpPercent` has no write path and would block edits if ever set               |
| FD-AS-14 | LOW      | `protocolAssignments` is not site-scoped for MODULE_USER; resolver comment promises handler-level site checks that do not exist                                      |
| FD-AS-15 | LOW      | 100-row page, client-side ENDED filter, no paging UI; equipment picker capped at 100 mixed rows                                                                      |
| FD-AS-16 | LOW      | Batch filter bar is shown on this tab but only `siteId` is consumed                                                                                                  |
| FD-AS-17 | LOW      | Cache invalidation after writes is partial                                                                                                                           |
| FD-AS-18 | LOW      | `unitType` is client-trusted and mislabels cages stored without an equipment type                                                                                    |
| FD-AS-19 | LOW      | Write handlers use the ambient search_path, reads use the fail-closed boundary                                                                                       |
| FD-AS-20 | LOW      | Turkish server messages in an English UI; species-mismatch panel depends on matching that text                                                                       |
| FD-AS-21 | LOW      | No tests for the assignment write path or the tab                                                                                                                    |
| FD-AS-22 | INFO     | Which assignment-related tables are live (tenant 7f6b08ab…, 2026-10-26)                                                                                              |
| FD-AS-23 | INFO     | Works correctly (with evidence)                                                                                                                                      |
| FD-AS-24 | MEDIUM   | VERIFIED-LIVE: failures of Pause / Manual transition are silent (unhandled rejection, no message)                                                                    |
| FD-AS-25 | MEDIUM   | VERIFIED-LIVE: re-unassign rewrites `endedAt` (history falsified) and succeeds silently                                                                              |
| FD-AS-26 | MEDIUM   | VERIFIED-LIVE: Edit modal never shows the bound sensor of a tank unit and cannot unlink it; backend accepts anything                                                 |
| FD-AS-27 | LOW      | VERIFIED-LIVE: future `effectiveFrom` is live at once; unitType is client-trusted                                                                                    |
| FD-AS-28 | LOW      | VERIFIED-LIVE: error contract leaks and 500s for client mistakes                                                                                                     |
| FD-AS-29 | LOW      | VERIFIED-LIVE: Pause/Resume buttons have no pending guard                                                                                                            |
| FD-AS-30 | LOW      | Manual-transition modal sends only a feed id; with one feed across all bands the three buttons are indistinguishable, and once that feed is current all are disabled |
| FD-AS-31 | INFO     | Side effects observed for one manual transition / assignment chain (all attributable to the ZZ unit)                                                                 |
| FD-AS-32 | MEDIUM   | VERIFIED-LIVE: a PAUSED assignment can be resumed onto an ARCHIVED protocol; the tab then shows a healthy "Active" row that nothing consumes                         |
| FD-AS-33 | MEDIUM   | VERIFIED-LIVE: deleting (soft) a tank leaves its assignment ACTIVE and the tab keeps offering it                                                                     |
| FD-AS-34 | INFO     | Unassign of both ZZ rows                                                                                                                                             |

### Sampling

| ID       | Severity | Finding                                                                                                                                                                         |
| -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FD-SA-01 | HIGH     | The weighing write path is dead: RecordGrowthSampleInput has no class-validator decorators -> global whitelist+forbidNonWhitelisted rejects every non-empty input (BAD_REQUEST) |
| FD-SA-02 | HIGH     | Second blocker behind the first: the web form sends `measuredBy` as a display NAME, the column and the DTO contract are a user UUID                                             |
| FD-SA-03 | MEDIUM   | The "Sampling" tab in Feeding is a hard-coded placeholder; the real entry point is hidden in the tank drawer                                                                    |
| FD-SA-04 | MEDIUM   | A recorded weighing stamps batches_v2.weight.actual.totalBiomass = 0 (static; masked by a test mock)                                                                            |
| FD-SA-05 | MEDIUM   | `updateBatchWeightFromSample` (apply a stored sample) commits and then ALWAYS errors: it returns a Batch for a `GrowthMeasurement!` field (latent, no UI caller)                |
| FD-SA-06 | MEDIUM   | A weighing does not refresh forecast / production plan / meal board caches or the persisted forecast snapshot                                                                   |
| FD-SA-07 | MEDIUM   | Population and batch semantics in the form are wrong for mixed tanks                                                                                                            |
| FD-SA-08 | MEDIUM   | Calendar-day handling: a same-day weighing can be silently ignored for UTC+ users                                                                                               |
| FD-SA-09 | LOW      | Form cannot carry length/width/conditions/type/method: condition factor and length are NULL by construction                                                                     |
| FD-SA-10 | LOW      | Measurements are immutable and unlisted: no edit, no delete, no history UI                                                                                                      |
| FD-SA-11 | LOW      | Role gate mismatch (static; test account is TENANT_ADMIN)                                                                                                                       |
| FD-SA-12 | LOW      | Backdated samples compare against the latest-by-date measurement, not their predecessor                                                                                         |
| FD-SA-13 | INFO     | DB structure vs entity: 34/34 columns match; no FK on the tenant table                                                                                                          |
| FD-SA-14 | INFO     | Things verified to work (evidence)                                                                                                                                              |
| FD-SA-15 | HIGH     | CONFIRMED LIVE on the mutation itself: recordGrowthSample is rejected by the validation pipe (BAD_REQUEST); scalar-arg siblings pass the pipe and reach their handlers          |
| FD-SA-16 | HIGH     | THIRD blocker (new, live): the web form sends lowercase enum VALUES, the GraphQL schema only accepts the enum NAMES -> the request dies at variable coercion before the pipe    |

### Cross-tab (verified by the lead)

| ID       | Severity | Finding                                                                                |
| -------- | -------- | -------------------------------------------------------------------------------------- |
| FD-XT-01 | CRITICAL | Feeding engine cron never processes any tenant — feedingTenants() is always empty      |
| FD-XT-02 | HIGH     | batches(filter:{...}) returns BAD_REQUEST for ANY non-empty filter                     |
| FD-XT-03 | HIGH     | alert-engine poison-message loop: MealUnderfed is NAK'd forever, DLQ publish is denied |

## Evidence

Each tab's evidence (file and line citations, the SQL and GraphQL used, the screenshots and the measured numbers) is in the audit archive under `/var/aqua-kampanya-ciktilari/feeding-audit-2026-10-26/` on the production host: `findings/<tab>.md` (the findings above, in full), `maps/<tab>.md` (what each tab does and what it calls), and the cleanup backup. The clean-up of the audit's own rows is recorded there too.
