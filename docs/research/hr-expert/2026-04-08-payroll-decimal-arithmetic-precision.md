# Research: Payroll Decimal Arithmetic & Precision

**Topic:** Why floating point breaks money, PostgreSQL NUMERIC usage for payroll, rounding rules, tax calculation audit trail
**Date:** 2026-04-08
**Agent:** hr-expert

## Sources
- [PostgreSQL 18 - Numeric Types (8.1)](https://www.postgresql.org/docs/current/datatype-numeric.html)
- [PostgreSQL - Monetary Types (8.2)](https://www.postgresql.org/docs/current/datatype-money.html)
- [Crunchy Data - Working with Money in Postgres](https://www.crunchydata.com/developers/playground/working-with-money-in-postgres)
- [PostgreSQL Mailing List - Rounding to even for numeric data type](https://www.postgresql.org/message-id/CAEZATCWGaeLoHdsWk7Yz4jFMFOH8f=capC6SjMa0HYBK5_xu5Q@mail.gmail.com)
- [DOL - Fact Sheet #23: Overtime Pay Requirements of the FLSA](https://www.dol.gov/agencies/whd/fact-sheets/23-flsa-overtime-pay)
- [OPM - How to Compute FLSA Overtime Pay](https://www.opm.gov/policy-data-oversight/pay-leave/pay-administration/fact-sheets/how-to-compute-flsa-overtime-pay/)

## Key Findings

1. **`NUMERIC` and `DECIMAL` are equivalent in PostgreSQL** and are the only types providing exact, arbitrary-precision arithmetic. Both are SQL standard.
2. **Precision = total significant digits, Scale = digits after the decimal point.** `NUMERIC(15, 4)` stores 11 integer digits + 4 fractional digits; `NUMERIC(19, 4)` is the de facto standard for multi-currency payroll systems (matches SQL Server `MONEY` precision).
3. **PostgreSQL NUMERIC rounds ties AWAY from zero** (`2.5 → 3`, `-2.5 → -3`) — NOT banker's rounding. The `ROUND()` function uses "round half up" for numeric inputs. Banker's rounding (round half to even, ROUND_HALF_EVEN) must be implemented as a PL/pgSQL function or in the application layer if required by local tax law.
4. **Floating point (REAL, DOUBLE PRECISION) is fundamentally wrong for money:**
   - `0.1 + 0.2 ≠ 0.3` in IEEE 754 binary representation.
   - `REAL` gives ~6 decimal digits of precision; `DOUBLE PRECISION` ~15. Neither is exact.
   - Equality comparisons are unreliable; sums accumulate drift over N transactions.
   - Storing-then-reading shows slight variations (lossy round trip).
5. **PostgreSQL `money` type is NOT recommended** — locale-dependent, single fixed scale, loses precision on conversions, not portable. `NUMERIC(n, m)` is the industry standard.
6. **Performance trade-off:** NUMERIC arithmetic is significantly slower than integer or float. In hot paths, store cents as `BIGINT` and format on the edge. For payroll batch jobs, prefer correctness over speed and use NUMERIC.
7. **FLSA overtime calculation:** Overtime is hours over 40 in a workweek at 1.5 × regular rate. Regular rate = (total remuneration for the workweek, minus statutory exclusions) / (total hours worked). Non-discretionary bonuses, shift differentials, commissions, and piece-rate earnings must be included in the regular rate — not just base salary.
8. **Half-time method is an accepted payroll shortcut:** pay regular rate for ALL hours (including overtime hours), then add 0.5 × regular rate as an overtime premium for each hour over 40. Mathematically equivalent to the direct method, but requires explicit documentation in the audit trail.
9. **Regular rate must be RE-calculated weekly** based on actual hours and compensation that week. A cached hourly rate is a bug for bonus-eligible, tipped, or piece-rate employees.
10. **Tax calculations are jurisdiction-specific** — federal, state, local, and supplemental withholding each have different rounding rules (some HALF_UP, some HALF_EVEN, some HALF_DOWN). The rounding mode must be recorded as part of the calculation audit trail.

## Security Concerns

- **CRITICAL:** A `number` TypeScript / JavaScript column mapped to PostgreSQL `NUMERIC` silently casts to IEEE 754 double on read — losing precision at 2^53. All payroll numbers must be decoded as strings or BigNumber instances.
- **CRITICAL:** `parseFloat(amountString)` or `Number(amountString)` in payroll code is the most common way to destroy money. Use decimal.js / big.js / BigInt cents.
- **HIGH:** Rounding mode changes between quarters without an audit event constitute tampering with a financial calculation.
- **HIGH:** Retroactive pay adjustments applied without an audit trail of the "before" state cannot be defended in a wage-and-hour dispute.
- **MEDIUM:** Floating-point aggregation for year-to-date totals produces drift that surfaces at year-end reconciliation.

## Performance Concerns

- NUMERIC is 10-100× slower than INTEGER for arithmetic. Batch payroll runs over thousands of employees are CPU-bound on NUMERIC, not I/O-bound.
- Indexing NUMERIC columns used in range scans (e.g., salary > X) costs more storage than INTEGER.
- For aggregation (SUM of payroll_lines), prefer single-pass accumulation on the DB side (`SUM(amount)`) over reading rows and summing in application code — avoids round-trip precision loss.
- Regular rate recalculation per pay period over thousands of timeclock entries must use window functions or CTEs, not O(N^2) application loops.

## Architectural Implications for hr-expert reviews

- Every payroll-related column in hr-service entities must be `@Column({ type: 'numeric', precision: 19, scale: 4 })`. `number`, `float`, `double precision`, `money` are forbidden for money fields.
- The TypeORM transformer must decode NUMERIC as `string` or `Decimal` (decimal.js), never as JS `number`. Review every `@Column` type: 'numeric' for a transformer.
- A `PayrollCalculationAuditEntry` entity must record: input timecard IDs, regular rate at time of calculation, rounding mode, each deduction with its calculated value, tax table version, formula version, and a cryptographic hash of inputs+outputs for tamper detection.
- Rounding mode must be an explicit argument to every monetary computation function — never a global default. Default to `ROUND_HALF_EVEN` (banker's rounding) unless tenant config specifies otherwise for local tax law compliance.
- Retroactive adjustment commands must carry: original pay period ID, original calculated amount, new calculated amount, delta, reason code, approver ID. The original PayrollRun must remain immutable; the adjustment is a new row.
- FLSA regular rate calculation logic must live in a single pure function, unit-tested against DOL fact-sheet examples, and invoked from every command that computes overtime.
- `@AuditLog()` interceptor on every command handler mutating payroll state (covered in cqrs-audit-log-interceptor-payroll research).

## Domain Rule Additions for hr-expert

- **[CRITICAL]** All payroll/money/tax columns must use `@Column({ type: 'numeric', precision: 19, scale: 4 })` with an explicit string or Decimal transformer. Any `number`, `float`, `real`, `double precision`, or PostgreSQL `money` type on a monetary field is a blocking review failure.
- **[CRITICAL]** TypeScript payroll code MUST use decimal.js, big.js, or BigInt cents — never `parseFloat()`, `Number()`, `+string`, or native JS arithmetic on money. Review any arithmetic operator applied to a money variable.
- **[CRITICAL]** Every payroll mutation must record a `PayrollCalculationAuditEntry` row containing: input timecards, regular rate, rounding mode, tax table version, formula version, computed deductions, and a SHA-256 hash of the canonicalized input+output payload.
- **[HIGH]** Rounding mode must be explicit on every monetary operation. Default is `ROUND_HALF_EVEN` (banker's rounding) unless tenant config overrides it; the chosen mode is persisted in the audit entry.
- **[HIGH]** FLSA regular rate must be calculated per workweek from actual hours + non-discretionary bonuses + shift differentials + commissions + piece-rate earnings. A cached hourly rate used for overtime calculation on bonus-eligible employees is a blocking review failure.
- **[HIGH]** Overtime premium uses the half-time method (0.5 × regular rate for each hour over 40) OR the direct method (1.5 × regular rate × OT hours); both must produce identical totals when run through unit tests against the DOL fact-sheet examples.
- **[HIGH]** Retroactive pay adjustments must NEVER mutate a prior PayrollRun. Instead, create a new `PayrollAdjustment` row referencing the original, carrying delta, reason, approver, and before/after snapshots.
- **[MEDIUM]** Year-to-date and quarter-to-date aggregates must run as SQL `SUM()` on numeric columns within a single query — never accumulate by reading rows into JS and summing.
- **[MEDIUM]** Any change to a tax bracket table or withholding formula must bump a `TaxTableVersion` row; each payroll calculation references its version, and a migration may never mutate historical rows.

Research: `docs/research/hr-expert/2026-04-08-payroll-decimal-arithmetic-precision.md`
