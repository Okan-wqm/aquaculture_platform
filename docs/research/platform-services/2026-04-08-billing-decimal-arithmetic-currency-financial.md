# Research: Billing Decimal Arithmetic, Currency Semantics & Financial Audit Trail

**Topic:** Why DECIMAL/NUMERIC over FLOAT for money, locale-specific tax rounding rules, retroactive/credit-memo audit trail, audit decorator patterns for CQRS billing commands
**Date:** 2026-04-08
**Agent:** platform-services

## Sources
- [PostgreSQL 18 - Numeric Types (8.1)](https://www.postgresql.org/docs/current/datatype-numeric.html)
- [PostgreSQL 18 - Monetary Types (8.2)](https://www.postgresql.org/docs/current/datatype-money.html)
- [Stripe Docs - Working with multiple currencies](https://docs.stripe.com/currencies)
- [Stripe Docs - Zero-decimal currencies](https://docs.stripe.com/currencies#zero-decimal)
- [Microsoft Learn - Tax calculation rounding rules (Dynamics 365 Finance)](https://learn.microsoft.com/en-us/dynamics365/finance/localizations/global/tax-calculation-rounding-rules)
- [HMRC VATREC12030 - Rounding on invoices and rounding at retailers](https://www.gov.uk/hmrc-internal-manuals/vat-trader-records/vatrec12030)
- [EUR-Lex C-484/06 - CJEU Koninklijke Ahold on VAT rounding](https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:62006CC0484)
- [IEEE 754 - Standard for Floating-Point Arithmetic](https://ieeexplore.ieee.org/document/8766229)

## Key Findings

1. **`DECIMAL` and `NUMERIC` are equivalent in PostgreSQL** and are the only exact-arithmetic numeric types. Max declarable precision is 1000 digits. The industry standard for billing is `NUMERIC(19, 4)` — 15 integer digits and 4 fractional digits — matching SQL Server `MONEY` and accommodating sub-cent intermediate calculations that later round to cents at invoice finalization. `NUMERIC(12, 2)` is acceptable for stored final totals but risks precision loss on aggregation of many line items.
2. **Floating point is wrong for money, period.** IEEE 754 `DOUBLE PRECISION` cannot exactly represent `0.1`, `0.2`, `0.3` — their binary expansions are infinite. `0.1 + 0.2 === 0.30000000000000004` in every language that uses IEEE 754 (JavaScript, Go, Java, Python `float`). Aggregating a batch of a thousand invoice lines at this precision accumulates drift that surfaces at month-end reconciliation as "the ledger doesn't tie to Stripe by $0.07." Equality comparisons (`if (balance === 0)`) are also unreliable.
3. **PostgreSQL `money` type is explicitly discouraged** — it is locale-dependent (its scale derives from `lc_monetary`), single-currency per database, and lossy on cast. A multi-tenant SaaS with USD/EUR/GBP/TRY tenants cannot use `money`. Use `NUMERIC(19, 4)` plus a separate `currency_code CHAR(3)` column.
4. **TypeScript `number` silently corrupts `NUMERIC` on read.** TypeORM's default transformer for `numeric` columns returns a JS `string`, but many developers "helpfully" add a transformer that does `parseFloat(value)` and destroy precision at read time. The correct pattern is: store as NUMERIC in Postgres, decode as `string` in TypeORM, and convert to `Decimal` (decimal.js / dinero.js / big.js) at the boundary of any arithmetic. The entity getter should return `Decimal`, not `number`.
5. **Stripe's API uses integer minor units.** Every amount in the Stripe API is an integer in the smallest currency unit: USD cents, EUR cents, JPY yen (JPY is a *zero-decimal* currency — 1000 JPY is literally `amount: 1000`). Converting between internal `NUMERIC(19,4)` and Stripe's integer representation requires jurisdiction-aware scale: 2 for most, 0 for JPY/KRW/VND/CLP, 3 for BHD/JOD/KWD (three-decimal currencies). A hardcoded `* 100` is wrong for ~20 currencies Stripe supports.
6. **Tax rounding rules are jurisdiction-specific and legally binding.**
   - **UK (HMRC VATREC12030):** VAT may be calculated and rounded at line-item or invoice level. Per-line rounding must use arithmetic rounding (≥ 0.5p rounds up). "Rounding down always" is allowed only for the totals of VAT-registered retailers, not B2B invoices.
   - **EU (CJEU C-484/06 Koninklijke Ahold):** Member states may choose either rounding-up or nearest-cent rounding at the invoice-total or line-item level, but the method must be *consistent* and *disclosed*. Switching methods mid-period without an audit record is a tax-compliance failure.
   - **Germany / Austria / Netherlands:** typically 2-decimal rounding, banker's rounding (half-even) is accepted by most tax authorities for line items, arithmetic (half-up) for invoice totals.
   - **Switzerland:** CHF is still rounded to 0.05 CHF at point-of-sale (the "Rappen" has been demonetized below 5), but VAT calculations are to 0.01 CHF internally.
   - **USA:** sales tax is state/county/city-specific — there is no single federal rule. Most jurisdictions require half-up at the invoice-total level; some (California) require per-line rounding. This is why the rounding mode must be a *tenant × tax-jurisdiction* configuration, not a global constant.
7. **Retroactive adjustments and credit memos must be append-only.** An invoice that has already been sent (`status = sent`) cannot be mutated to change its total — instead, issue a `CreditNote` referencing the original invoice, carrying the delta, reason code, approver, and a new Stripe `credit_notes` record. The original `Invoice` row remains immutable from `sent` onward. This is both an accounting principle (GAAP / IFRS require audit trails) and a legal requirement in most VAT jurisdictions (amended invoices must reference the original).
8. **Audit trail fields mandatory on every billing mutation.** Every command handler in `apps/billing-service/src/billing/commands/` that mutates Invoice/Payment/Subscription/Refund must record: `actorUserId`, `actorRole`, `tenantId`, `commandId` (for dedupe), `ipAddress`, `userAgent`, `correlationId` (trace ID), `beforeState` (JSONB snapshot), `afterState` (JSONB snapshot), `reason` (free-text, required for refunds and credit notes). A `BillingAuditEntry` entity is the only sanctioned audit sink; writing audit data to application logs alone is not compliant with SOC 2 CC7.2.
9. **The audit decorator pattern.** A `@BillingAudit({ resource: 'Invoice', action: 'void' })` method decorator on command handlers attaches a class-level interceptor that (a) captures the before-state via a fresh read inside the same transaction, (b) invokes the handler, (c) captures the after-state, (d) writes a `BillingAuditEntry` in the same transaction as the mutation. The audit write must be in the same Postgres transaction as the state change — writing it "after the fact" from an event handler loses audits on crash and is non-repudiable.
10. **Overtime / retroactive pay is not in billing scope** — billing computes invoices from usage metrics and subscription plans. However, the *same* audit discipline applies: any retroactive invoice correction (e.g., a tenant was billed on the wrong plan tier for 3 months) must generate credit notes plus re-billing, never silent updates to the old invoice row.
11. **Currency conversion happens at one layer and is recorded.** If a tenant's local display currency differs from the billing currency (e.g., display in TRY, bill in USD), the conversion rate must be stored on the invoice row at the moment of creation — not re-derived from a live rate at display time. The `Invoice` entity must carry `currencyCode`, `baseCurrencyCode`, `exchangeRate`, `exchangeRateSource`, `exchangeRateAt`. This freezes the rate for the invoice forever, which is what GAAP requires.
12. **Partial payments and refunds must reconcile exactly.** `Payment.amount` SUM over an invoice must equal `Invoice.total` for `paid` status and must be less than `total` for `partially_paid`. A reconciliation CHECK constraint or scheduled verification query catches drift. Because `NUMERIC` is exact, `SUM(amount) = total` is a sound equality check — in contrast to floats, where such a check is unreliable.

## Security Concerns

- **CRITICAL:** A `number`-typed TypeScript property mapped to a Postgres `NUMERIC` column corrupts money at the ORM boundary. The type must be `string` or `Decimal`, and the entity must declare an explicit TypeORM transformer that round-trips via `Decimal.toFixed(scale)`.
- **CRITICAL:** `parseFloat`, `Number()`, `+string`, `+=`, `-=`, `*=`, `/=` applied to a money variable destroys precision. The only safe arithmetic is `a.plus(b)`, `a.minus(b)`, `a.times(b)`, `a.dividedBy(b)` on a `Decimal` instance with an explicit rounding mode.
- **CRITICAL:** A hardcoded `amount * 100` for converting to Stripe minor units is wrong for JPY (×1), BHD (×1000), and similar. A `CurrencyScale` lookup is mandatory.
- **CRITICAL:** Mutating a sent invoice's `total`, `lineItems`, or `tax` is a tax-fraud risk (a regulator sees the amended invoice, demands the original, and finds only the mutation). Enforced at DB level via a trigger or at service level via a domain invariant that rejects updates after `status >= sent`.
- **HIGH:** A billing command that writes state without a matching `BillingAuditEntry` is a SOC 2 CC7.2 finding — the audit trail is incomplete and non-repudiable.
- **HIGH:** Storing the exchange rate as a runtime-computed value rather than a persisted column means historical reports can re-compute with a new rate and show different numbers for closed periods. That's an immutability violation.
- **HIGH:** Rounding mode changes between periods without a `TaxRoundingModeChanged` domain event and audit entry constitute undisclosed tax-calculation tampering.
- **MEDIUM:** Aggregating invoice totals by reading rows into JS and summing in memory incurs round-trip precision loss and is slower than a single `SUM(total)` in SQL. Always prefer DB-side aggregation for money.

## Performance Concerns

- `NUMERIC` arithmetic is 10-100× slower than `BIGINT` arithmetic. For extremely hot paths (usage metering counters at 100K events/sec), store as `BIGINT` cents and convert to `NUMERIC` at the invoice-finalization boundary. For normal billing queries, the correctness trade-off favors `NUMERIC`.
- Index support: B-tree indexes on `NUMERIC` columns work fine for range queries (`WHERE total > 1000`), but storage cost is higher than `BIGINT`. For aggregates over usage metrics, a materialized view refreshed hourly avoids re-aggregating on every report.
- `BillingAuditEntry` rows grow unboundedly. Partition by month and retain for the jurisdictional retention period (7 years in most of EU/US for tax records, 10 years in Germany).

## Architectural Implications for platform-services reviews

- Every money column in `apps/billing-service/src/billing/entities/` — `Invoice.total`, `Invoice.subtotal`, `Invoice.tax`, `Invoice.amountPaid`, `Payment.amount`, `Plan.monthlyPrice`, `Subscription.proratedAmount`, `SubscriptionModuleItem.price`, `UsageAggregation.cost` — MUST use `@Column({ type: 'numeric', precision: 19, scale: 4 })` with a Decimal transformer.
- A shared `Money` value object (tuple of `Decimal` + `currencyCode`) is mandatory. Pure arithmetic via its methods enforces the rule that you cannot add USD to EUR without an explicit conversion step that freezes a rate.
- The `@BillingAudit` decorator must be applied to every `@CommandHandler` class that mutates Invoice/Payment/Subscription/Refund/Plan. Missing decorator = blocking review failure.
- `BillingAuditEntry` must be written in the same DB transaction as the mutation. The pattern is: command handler obtains a `QueryRunner`, executes domain logic, writes audit entry, commits — all atomic.
- `TaxRoundingMode` must be a config-service value scoped to `{tenantId, jurisdictionCode}`, loaded once per command execution, recorded in the audit entry. The rounding mode is never a constant in code.
- `CreditNote` entity must exist with a hard constraint that `parentInvoiceId` is non-null and references an immutable parent. Voiding an invoice creates a credit note for the full amount plus a new invoice if re-billing is needed — it does not mutate the parent.
- A CI check (static analyzer or custom ESLint rule) must flag any `number` typed field named `*Amount`, `*Price`, `*Total`, `*Fee`, `*Balance`, `*Cost`, `*Refund` in `apps/billing-service/**`.
- Currency-scale conversion to Stripe minor units must go through a `CurrencyScaleService.toMinor(amount: Decimal, currency: string): number` / `toMajor(minor: number, currency: string): Decimal` — never inline `* 100`.
- Unit tests must include: (a) `0.1 + 0.2` as Decimal yielding exactly `0.3`, (b) per-line vs invoice-total VAT rounding divergence examples from HMRC guidance, (c) round-trip USD ↔ cents and JPY ↔ yen, (d) attempt to mutate a sent invoice → rejected by domain invariant.

## Domain Rule Additions for platform-services (Billing Accuracy subsection)

- **[CRITICAL]** Every money column in billing entities MUST be `@Column({ type: 'numeric', precision: 19, scale: 4 })` with an explicit Decimal transformer. `number`, `float`, `double precision`, `real`, `money`, or `bigint` on a money field is a blocking review failure.
- **[CRITICAL]** TypeScript billing code MUST use `Decimal` (decimal.js or equivalent) for arithmetic on money. `parseFloat`, `Number()`, `+`, `-`, `*`, `/` operators on money variables are blocking review failures.
- **[CRITICAL]** Conversion to Stripe minor units MUST go through `CurrencyScaleService` with per-currency scale lookup. A hardcoded `* 100` is a blocking review failure.
- **[CRITICAL]** Invoice mutation after `status >= sent` MUST be rejected by domain invariant. Corrections are issued as `CreditNote` rows referencing the original. Mutating a sent invoice is a blocking review failure and a compliance risk.
- **[CRITICAL]** Every command handler mutating Invoice / Payment / Subscription / Refund / Plan MUST carry `@BillingAudit({ resource, action })` and emit a `BillingAuditEntry` in the same transaction as the mutation. Missing audit is a blocking review failure.
- **[HIGH]** `TaxRoundingMode` MUST be resolved from config-service per `{tenantId, jurisdictionCode}` and recorded in every `BillingAuditEntry`. Hardcoded rounding mode in a command handler is a HIGH finding.
- **[HIGH]** Every `Invoice` row MUST persist `currencyCode`, `baseCurrencyCode`, `exchangeRate`, `exchangeRateSource`, `exchangeRateAt`. Re-deriving exchange rate at display time is a HIGH finding.
- **[HIGH]** Reconciliation constraint: `SUM(Payment.amount WHERE invoiceId = X)` MUST equal `Invoice.total` when `Invoice.status = paid`. A scheduled reconciliation job or DB CHECK constraint enforces this. Drift → CRITICAL alert.
- **[MEDIUM]** Money aggregation MUST use SQL `SUM(column)` — never accumulate rows in application code.
- **[MEDIUM]** `BillingAuditEntry` MUST be partitioned monthly and retained >= 7 years (tenant-jurisdiction-specific minimum).

Research: `docs/research/platform-services/2026-04-08-billing-decimal-arithmetic-currency-financial.md`
