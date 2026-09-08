# The quote and the invoice named different prices — 2026-09-07

Reviewer: zcode. Cycle: `2026-09-05-branch-sweep`. Target: `origin/main` @ `4c35ddac1`.

Headline surfaced by `claude/superadmin-panel-audit-dm2t1v` (as BILLING-CRITICAL-003 there),
verified against current main, and re-derived here. The branch is not merged.

## BILLING-CRITICAL-007 — an annual tenant was invoiced 15% above the price they signed

**Severity:** CRITICAL. **Owner:** billing-expert. **State:** IN-PROGRESS.

### Evidence

What a longer billing cycle costs was written twice, in two different services, and the two
copies disagreed.

`apps/admin-api-service/src/billing/services/pricing-calculator.service.ts` declares the
commitment discount and applies it to the quote an operator approves:

```ts
const BILLING_CYCLE_DISCOUNTS: Record<BillingCycle, number> = {
  [BillingCycle.MONTHLY]: 0,
  [BillingCycle.QUARTERLY]: 0.05,
  [BillingCycle.SEMI_ANNUAL]: 0.1,
  [BillingCycle.ANNUAL]: 0.15,
};
```

`apps/billing-service/src/billing/billing-scheduler.service.ts:304` issues the invoice:

```ts
lineItems[0].unitPrice = basePriceMoney.multiply(cycleMonths).toDecimal().toNumber();
```

Months, no discount. So a tenant who signed an annual commitment at `monthly × 12 × 0.85` was
invoiced `monthly × 12` — **15% above the agreed price, every year** — and a quarterly one 5%
above. Both figures are plausible on their own, and nobody reconciles a quote against an invoice
by hand, so nothing said so. The existing scheduler spec asserted `100 × 3 = 300` for a quarterly
subscription: the defect was not merely untested, it was pinned.

Two more defects sat in the same column.

**`pricing.basePrice` had two readers that disagreed about its unit.**
`create-subscription.handler.ts:204` publishes it as `monthlyPrice` on `SubscriptionCreated` and
the scheduler MULTIPLIES it by the cycle's months — it is the monthly rate.
`get-tenant-billing.handler.ts:calculateMonthlyPrice` DIVIDED it by the same number, so an annual
tenant on $99/month was reported to the tenant-admin UI as $8.25/month.

**`annualTotal` used the wrong rate.** It was computed as `monthlyTotal * 12 * (1 - cycleDiscount)`
where `cycleDiscount` belongs to the REQUESTED cycle — so the annual figure shown beside a monthly
quote applied 0% and overstated the annual price by 15%, making the commitment look worse than it
is and arguing against the upsell it exists to support.

### Rule violated

A price rule that has to hold across a service boundary is declared once, above both services, and
both sides compute through it.

### Fix

`libs/backend-common/src/billing/billing-cycle-terms.ts` holds the commercial terms and one
`cycleAmountFor(monthly, cycle)`. It lives in `backend-common` rather than in either service
because both sides of the disagreement are in different services — admin-api quotes,
billing-service invoices — and a rule spanning a boundary cannot be owned by one side of it.

- **Tier 2 (automatic).** The quote and the invoice both call `cycleAmountFor`. Stating different
  prices now requires changing one function.
- **Tier 3 (detectable).** `tests/invariants/billing-cycle-terms-single-source.spec.ts` fails on a
  commitment-discount rate table declared outside that file, in either spelling the codebase uses —
  a fraction in a rate map (`annual: 0.15`) or an integer percent inside a per-cycle pricing object
  (`annual: { …, discountPercent: 20 }`). One site is allowed by name under BILLING-HIGH-009 below;
  a second unlisted one fails.

`cycleAmountFor` returns the invoice's decomposition — `gross`, `commitmentDiscount`, `net` — and
the scheduler writes the gross on the line item and the discount into the invoice's own `discount`
column, so what the customer was granted is named on the document instead of folded into a unit
price no one can reconcile against the quote. The monthly zero is written too: a stored `0` says
the discount was computed and none applied, where NULL is indistinguishable from an invoice issued
before the rule existed.

Rounding is applied to the discount and deliberately not to the gross. Multiplying a stored rate by
a whole number of months introduces no precision, and rounding it would truncate a rate the
platform holds to four decimal places (ADR-0004); the discount is a fraction, so it is the step
that can go sub-cent, and rounding it there is also what makes `gross − commitmentDiscount === net`
exact. An existing precision case (`33.333` monthly stays `33.333`) caught a first version that
rounded both and is what forced this distinction.

### Verification

- `libs/backend-common/src/billing/__tests__/billing-cycle-terms.spec.ts` — 9 cases: totality over
  `BILLING_CYCLES` in both tables (a cycle added without a commercial term would reach
  `Money.multiply(undefined)` and invoice NaN), the four prices, the exactness property, and the
  rounding boundary.
- `billing-scheduler.service.spec.ts` — the `300` case is **corrected to 285**, not adapted: it
  encoded the defect. It now also asserts `subtotal 300`, `discount 15`, `amountDue 285`.
- `get-tenant-billing.handler.spec.ts` — 4 cases, one per cycle, asserting the stored monthly rate
  is reported unchanged.
- **Mutation-verified in both directions.** Against main's three files, **4 of the new behavioural
  cases fail** and the invariant reports **3 offending sites**. Against the fix, all pass.
- `apps/billing-service` full suite 630/630; `admin-api-service` billing/pricing 40/40;
  `npm run type-check` 41/41 projects green.

## BILLING-HIGH-009 — the catalogue promises 10/15/20 and the platform charges 5/10/15

**Severity:** HIGH. **Owner:** billing-expert. **Deadline:** 2026-10-05. **State:** OPEN.

Found by re-reading my own fix above, and it exposed a gap in that fix's gate. The first version of
the invariant matched only the fractional spelling, so it asserted "exactly one place" while a
second table sat outside its sight.

`plan-definition.service.ts:421-484` seeds each tier's per-cycle terms as an integer percent —
`quarterly: 10`, `semiAnnual: 15`, `annual: 20` — with absolute per-cycle base prices that agree
with those rates: Starter's monthly 99 becomes a quarterly 267, which is 10.1% off 297, and an
annual 950, which is 20.0% off 1188. The pricing calculator applies 5/10/15. Two internally
coherent price books, differing.

Nothing reads a plan definition's per-cycle `discountPercent`. The only readers of that field name
are `custom-plan.service.ts` and `custom-plan.entity.ts`, which is a custom plan's own discount — a
different concept, not keyed on a cycle.

**Not established, and deliberately not claimed:** which price book actually bills a given tenant.
`plan-definition.service.ts:522` returns `pricing.<cycle>.basePrice` to a caller this pass did not
trace. Settling it means deciding whether commitment terms are per-plan — operator-editable, and
therefore snapshotted at the sale so an edit cannot silently re-price existing customers — or
platform-wide. That is a commercial decision, not a refactor, which is why this is raised rather
than fixed here.

The invariant now matches both spellings and allows that one file **by name**, tied to this
finding. Removing the entry is how this closes; a third table fails the gate. A separate case
asserts the allowlisted file still produces a real match, so the exception cannot quietly become
vacuous and make this finding look closed.

## BILLING-HIGH-008 — nine more copies of the months-per-cycle table

**Severity:** HIGH. **Owner:** billing-expert. **Deadline:** 2026-10-05. **State:** OPEN.

Raised explicitly rather than folded into the CRITICAL or left unsaid. `BILLING_CYCLE_MONTHS` now
exists in `backend-common` and the two PRICING paths use it, but the table is still declared in
`create-subscription.handler.ts`, `billing-admin-nats.handler.ts`, `metered-billing.service.ts`,
`plan-definition.service.ts`, `subscription-core.service.ts` and `analytics.service.ts`. Those are
period-date arithmetic — `calculatePeriodEnd`, retention windows, analytics buckets — and have
never disagreed with the commercial terms, so they are not this defect. Consolidating them touches
six files across two services and is a separate reviewable change.

This is why the single-source invariant governs the commitment-discount table only: banning a
months table today would fail on nine sites this change does not fix, which would make the gate
unlandable for a reason it cannot defend. The scope is stated in the invariant's own header so the
next reader does not mistake the narrower rule for the whole rule.

## What this does not do

It does not correct invoices already issued. Every non-monthly invoice generated before this change
overcharged by the commitment discount, and reconciling them means crediting real customers against
real Stripe payments — a commercial decision with a finance owner, not a code change. The
overcharged population is derivable: `billing.invoices` joined to `billing.subscriptions` on a
non-monthly `billing_cycle`, where the ratio of `total` to the subscription's monthly `basePrice ×
months` is exactly 1.

---

## 2026-09-08 — closing BILLING-HIGH-008 and BILLING-HIGH-009, and what re-reading them found

Both findings above described a codebase that has since changed under them, so each was re-derived
against today's `main` before being closed. The re-derivation found more than either had recorded.

### BILLING-HIGH-009 closes, but not for the reason it was raised

The 10/15/20 catalogue seed and `PricingCalculatorService` are both **gone**: ADR-0013 moved the
plan catalogue into billing-service and deleted the calculator with it. So the two price books that
disagreed no longer exist, and the commercial decision the finding demanded — per-plan or
platform-wide commitment terms — is answered by the code as it now stands: **platform-wide**, because
no per-plan commitment discount is declared anywhere in the tree.

That is not the whole of it. A **new** second discount table had appeared in the meantime, in
`apps/billing-service/src/billing/services/module-quote.ts`, and `module-pricing.service.ts:317`
read _that_ rather than `backend-common`. Two independent declarations of the same commercial rule,
in the same service, feeding the quote engine — the exact shape of BILLING-CRITICAL-007.

They agreed on every value (0 / 0.05 / 0.10 / 0.15), so nothing was mispriced. That is the reason
it was worth fixing rather than the reason to leave it: agreement between two copies is not a
property anything maintains.

**The gate did not see it.** `module-quote.ts` wrote its rates quoted — `quarterly: '0.05'` — and the
pattern required an unquoted decimal. A gate that reports a single source while a full second table
sits inside the tree it scans is worse than no gate, because it is believed. The quoted spelling is
matched now and a case pins it.

### BILLING-HIGH-008 closes, and the finding under-counted itself

It recorded "nine more copies … period-date arithmetic … have never disagreed with the commercial
terms". Re-reading each site found that the second half was false.

The duplicated thing was never the table. It was the **arithmetic**: four independent
implementations of _when does this period end_, each pairing its own months table with its own date
maths.

| Site                             | months                 | clamped |
| -------------------------------- | ---------------------- | ------- |
| `billing-scheduler.service.ts`   | `BILLING_CYCLE_MONTHS` | yes     |
| `create-subscription.handler.ts` | own `switch`           | yes     |
| `billing-admin-nats.handler.ts`  | own `switch`           | yes     |
| `subscription-core.service.ts`   | inline `switch`        | **no**  |

`SubscriptionCoreService.calculateNextPeriodEnd` used a bare `setMonth`. `setMonth(0 + 1)` on
31 January asks JavaScript for 31 February, and JavaScript answers 3 March. billing-service's three
copies all guard against exactly this and say so in a comment; admin-api's did not. One of four was
wrong, and nothing could tell — there was nothing for it to be wrong against. It has **no callers
today**, so this is a fuse that was removed, not a live defect that was fixed.

`metered-billing.service.ts` is **not** a copy: its cycle switch returns an `AggregationPeriod`, a
different concept. It is left alone, and the gate is built so it stays un-flagged.

`plan-definition.service.ts` holds `DAYS_PER_CYCLE` (30/90/180/365), a **days** table used for
proration share. That is a third quantity, deliberately approximate, and is out of this change.

### BILLING-HIGH-015 — the copy that was hiding a live defect

`AnalyticsService.calculateMonthlyPrice` used its months table to **divide**:

```text
case BillingCycle.ANNUAL: return basePrice / 12;
```

`billing.subscriptions.pricing.basePrice` **is** the monthly rate. `CreateSubscriptionHandler`
publishes it as `monthlyPrice` on `SubscriptionCreated`, and `BillingSchedulerService` _multiplies_
it by the cycle's months to price a period. So platform MRR counted an annual tenant on \$49/month as
\$4.08 — every non-monthly subscription under-reported by exactly its cycle length. `revenueByPlan`,
`arr` (`mrr × 12`), `arpu` and the revenue-growth comparison are all derived from that figure, so
they carry the same error.

This is the identical defect BILLING-CRITICAL-007 fixed in billing-service's
`GetTenantBillingHandler`, which documents the reasoning at its own callsite. It survived here
because admin-api reads the same column through its own read-only projection and carried its own
cycle table to divide by. Registered as **BILLING-HIGH-015** and fixed in the same change; it was
only visible once every restatement of the months table had been enumerated, which is the argument
for the consolidation rather than a coincidence alongside it.

### The fix

`libs/backend-common/src/billing/billing-cycle-terms.ts` owns the terms **and the arithmetic**:

- `BILLING_CYCLE_COMMITMENT_DISCOUNT` is now exact decimal **strings**, read back through
  `commitmentDiscountRateFor(cycle): Decimal`. `ModulePricingService.quote` prices in raw `Decimal`
  and never builds a `Money`, so a `Decimal` accessor — not `cycleAmountFor` — is what let it stop
  restating the table. Today's four rates round-trip through a `number` intact; that is a property
  of these values, not of the type, and it stops holding at a rate like 0.145.
- `addBillingCycle(start, cycle)` is the one period-end implementation. Four callers now import it
  and none writes date arithmetic, so the overflow cannot be reintroduced.
- `BILLING_CYCLES` / `BillingCycleValue` were a **third** declaration of the cycle set, restated
  inside the very module that exists to end restatement. Deleted; the module keys on `BillingCycle`
  from `@platform/event-contracts`, and `billing/index.ts` deliberately does not re-export it.

### The gate, and its blind spots

`tests/invariants/billing-cycle-terms-single-source.spec.ts` now fails a second copy of **either**
table, in **four** spellings: unquoted fraction, quoted fraction, integer percent, and `switch`.

The switch pattern matches "a case labelled with a cycle, followed inside the same statement by that
cycle's own month count" — one shape that covers `return 3`, `return basePrice / 3` and
`setMonth(getMonth() + 3)` without enumerating them, because a pattern built from the three known
spellings would have missed the fourth.

Verified by negative control rather than by assertion — the pre-fix files were restored and the gate
run against them:

- pre-fix `module-quote.ts`: **6 sites** reported (3 months + 3 quoted discounts). The old gate
  reported **0**.
- pre-fix switches: **8 sites** across `analytics.service.ts`, `subscription-core.service.ts` and
  `create-subscription.handler.ts`.

**Two things the gate does not catch, stated rather than left to be discovered:**

1. `case 'annual': end.setFullYear(end.getFullYear() + 1)` — an annual cycle written as one _year_
   contains no `12` to match. The `subscription-core.service.ts` switch was still caught, on its
   quarterly and semi-annual arms; a file whose only restatement was the annual-as-year form would
   pass.
2. Comments are blanked before matching, so a months table written in prose is not reported. That is
   deliberate: `metered-billing.service.ts` carries "combine all 6 months in the range query"
   directly under its `SEMI_ANNUAL` case and would otherwise be failed on the strength of a sentence.

A cheap literal pre-filter (`/quarterly|annual/i`) precedes the scan. Without it the bounded
backtracking window costs twenty seconds across ~3,800 files, in a lane named `invariants-fast`.

### Verification of the 2026-09-08 change

- `backend-common` 142 suites / 1561 tests green, including 19 new cases in
  `billing-cycle-terms.spec.ts` (clamping, leap years, non-mutation, time-of-day, exact rates).
- `billing-service` 34 suites / 745 tests green; `admin-api-service` 836 passed / 38 skipped.
- `npm run type-check`: all 41 projects green.
- `eslint` clean on all ten changed files. (`backend-common`'s project-wide lint is quarantined
  under ORPHAN-HIGH-588 for 891 pre-existing problems in unrelated modules.)

### What the 2026-09-08 change does not do

It does not consolidate `DAYS_PER_CYCLE`, and it does not touch the invoice-reconciliation question
the section above leaves open. It also does not correct MRR figures already written to
`admin.analytics_snapshots`: the snapshots hold the under-counted number, and recomputing history
means re-running the aggregation over past periods — tracked with BILLING-HIGH-015 rather than
folded in silently.
