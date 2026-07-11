# Farm finance capability — product-gap findings (2026-07-06)

Product owner request (finance tabs in the farm and HR modules, auto-connected
to recorded cost data, user-defined dynamic expense categories, charts by
day/week/month/year and per batch, 100% tenant isolation) surfaced two
structural gaps in the farm domain. Tracked here so the closing commits carry
auditable `Closes:` trailers per the CLAUDE.md traceability rule.

---

## FARM-HIGH-144 — No operational finance ledger; cost data scattered across five domains with no aggregation surface

**Severity:** HIGH · **Owner:** farm-expert · **Deadline:** 2026-07-20

Money data already recorded through farm forms lives fragmented on
`feeding_records.feedCost`, `batches_v2.purchaseCost`, `work_orders.costSummary
/ estimatedCost`, `health_events.estimatedCost` and
`harvest_records.totalRevenue / harvestCost` — with **no** ledger, no OPEX
taxonomy (electricity, oxygen, insurance, software, sludge handling…), no
user-defined expense categories, no time/batch aggregation and no finance
surface in the farm module. Farm operators cannot answer "what did this farm /
batch cost this month?" from the product.

**Architectural resolution (tier 1/2):** a `finance` domain in farm-service
where MANUAL entries are per-tenant rows (`finance_categories`,
`finance_expense_entries`, `finance_settings` — schema-per-tenant, RLS), the
category taxonomy is dynamic DATA (user add/rename/archive; system categories
bound by stable `code`), DERIVED costs stay query-time projections of their
source-of-truth rows via the declarative `DERIVED_COST_SOURCES` registry
(copying them would recreate the documented feed_inventory dual-ledger drift
class — projection-at-read makes drift structurally impossible), and computed
lines (Other variable cost = 5% of operational cost) evaluate at read time
from a category-attached rule.

## FARM-MEDIUM-145 — Tenant default currency has no SSoT; three services hardcode three different literals

**Severity:** MEDIUM · **Owner:** farm-expert · **Deadline:** 2026-07-20

`feeds` / `equipment` entities default `currency` to `'TRY'`,
`create-feeding-record.handler.ts` defaulted to `'NOK'`, and hr-service's
`employee.entity.ts` defaults to `'USD'` — three independent hardcoded
literals with no tenant-level source. A tenant recording feed in one form and
equipment in another silently books in different currencies.

**Architectural resolution (tier 2 + 3):** per-tenant
`finance_settings.defaultCurrency` (platform default NOK per product owner)
resolved exclusively through `FinanceSettingsService`; the hardcoded feeding
literal deleted; `FinanceSettingsUpdated` outbox event projects the currency
into hr-service so a second tenant-editable source never exists; a
currency-literal ban invariant spec (`finance-currency-ssot.spec.ts`) makes
regressions detectable at PR time.

## FARM-HIGH-151 — Remaining farm create-handlers still seed an entity currency default from a hardcoded literal

**Severity:** HIGH · **Owner:** farm-expert · **Deadline:** 2026-08-15

The FARM-MEDIUM-145 fix migrated the two handlers the finding named
(`create-feeding-record`, HR `create-employee`) and the whole finance domain
to the currency SSoT. Eight further farm create-handlers still carry an
`input.currency || 'TRY'` / `?? 'TRY'` (and one `?? 'NOK'`) entity-seed default:
`create-batch`, `create-cleaner-batch`, `create-chemical`, `create-consumable`,
`create-equipment`, `create-feed`, `add-feed-inventory`, plus the purchase-order
path. These feed the finance ledger as DERIVED costs (e.g. `batch.purchaseCost`
→ FINGERLINGS), so a tenant whose default currency is NOK can still see a
`TRY`-stamped fingerling cost in the ledger.

**Why not closed here:** each handler needs `FinanceSettingsService` injected +
its unit spec's constructor updated — an 8-handler change with real regression
surface that should not ride into the finance-capability PR blind. The
`finance-currency-ssot.spec.ts` invariant's `GUARDED_FILES` set is the ratchet:
migrate a handler, add it to the guarded set. Tracked as HIGH debt with owner +
deadline per the CLAUDE.md partial-fix rule.

**RESOLVED (2026-07-07):** all handlers migrated to the currency SSoT.
Auditing the whole farm write surface (not just the `||`/`??` form) surfaced
**two more** hardcoded-currency create-handlers the original finding missed
because they used a bare `currency: 'TRY'` assignment rather than a fallback:
`create-harvest-record` (revenue + customer-delivery lines — this one feeds the
`HARVEST_REVENUE` derived cost, so its currency drift was the most consequential)
and `create-worker`. All ten now inject `FinanceSettingsService` (exported by
`FinanceModule`, wired into `BatchModule`/`ChemicalModule`/`ConsumableModule`/
`EquipmentModule`/`FeedModule`/`InventoryModule`/`HarvestModule`/`WorkerModule`;
`FeedingModule` already imported it) and resolve the tenant default via
`getDefaultCurrency(tenantId)` — every `?? 'TRY'` / `|| 'TRY'` / `?? 'NOK'` and
bare `currency: 'TRY'`/`'NOK'` literal is deleted. The five affected unit specs
(`create-batch`, `create-cleaner-batch`, `add-feed-inventory`,
`create-harvest-record`, `create-worker`) pass a mocked resolver. All ten files
are added to `finance-currency-ssot.spec.ts` `NAMED_GUARDED_FILES`, and the
invariant regex was hardened to also catch the bare `currency: '<ISO>'` form —
so the ratchet now blocks both regression shapes. No hardcoded-currency
create-handler remains anywhere in farm-service.
