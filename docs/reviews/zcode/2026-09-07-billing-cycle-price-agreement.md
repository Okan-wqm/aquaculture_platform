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
