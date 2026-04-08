# Research: Leave Management Accrual Atomicity

**Topic:** Transactional accrual, scheduled cron atomicity, year-end rollover, state machine PENDING→APPROVED→CANCELLED
**Date:** 2026-04-08
**Agent:** hr-expert

## Sources
- [PostgreSQL - Explicit Locking (13.3)](https://www.postgresql.org/docs/current/explicit-locking.html)
- [PostgreSQL - SELECT FOR UPDATE (Stormatics)](https://stormatics.tech/blogs/select-for-update-in-postgresql)
- [PostgreSQL - Advisory Locks](https://www.postgresql.org/docs/current/functions-admin.html)
- [Oracle HCM - Automatically Transfer Absence Accrual Balance](https://tangenz.com/automatically-transfer-absence-accrual-balance/)
- [Oracle 14 - Working with Rollovers](https://docs.oracle.com/cd/E16582_01/doc.91/e15133/wrk_wi_rollovers.htm)
- [Medium - Database Transactions: COMMIT and ROLLBACK in MySQL and PostgreSQL](https://medium.com/@alxkm/the-complete-guide-to-database-transactions-how-commit-and-rollback-really-work-in-mysql-and-36d1ce81b9eb)

## Key Findings

1. **Accrual atomicity requires either `SELECT ... FOR UPDATE` or an application-level advisory lock.** A naive `UPDATE leave_balance SET balance = balance + :accrual WHERE employee_id = :id` is safe only if it's a single atomic UPDATE with no intermediate SELECT — any read-compute-write pattern is a race.
2. **The compound-interest pattern (`SELECT balance THEN UPDATE`) is the most common accrual bug.** Two concurrent cron workers can both read the same balance, each add the accrual, and both write — losing one accrual. `SELECT ... FOR UPDATE` serializes these writes.
3. **Cron jobs must be idempotent.** A scheduled monthly accrual that runs twice because of a deployment retry must not credit twice. The canonical solution is an `accrual_run` table with a UNIQUE constraint on `(tenant_id, employee_id, period_year, period_month)` — the second attempt fails the insert and is safely skipped.
4. **Advisory locks (`pg_try_advisory_xact_lock`) are appropriate for cron-singleton guarantees** — only one worker at a time holds the monthly-accrual lock per tenant. Transaction-scoped advisory locks release automatically on commit/rollback.
5. **Year-end rollover is a distinct operation from monthly accrual** and must run as a separate command with its own audit trail. Each policy (carryover cap, expiry date on carried balance, use-it-or-lose-it) is tenant-configurable.
6. **Leave request state machine:** `PENDING → APPROVED → (CANCELLED | COMPLETED)` and `PENDING → REJECTED`. Illegal transitions (e.g., `REJECTED → APPROVED`) must be rejected at the domain layer, not fixed post-hoc.
7. **Leave balance decrement should happen on APPROVE, not on PENDING submit.** Deducting on submit creates temporary "reserved" balance that must be released on rejection; it's simpler and safer to only decrement on approval within a transaction that also writes the state transition.
8. **Overlap detection for leave requests** is the same problem as shift overlap — an employee should not have two approved leave requests covering the same day range. Use `tstzrange` + GiST exclusion constraint scoped to `(tenant_id, employee_id, status='APPROVED')`.
9. **Negative balance prevention** is a tenant policy: some employers allow advance borrowing (negative balance), most don't. The constraint `CHECK (balance >= 0)` is not the right primitive because it can't express the policy; use a guard in the command handler that reads the policy.
10. **Accrual must preserve tenant scoping.** A cross-tenant accrual run (tenant A's cron worker accruing tenant B's employees) violates search_path isolation and is a critical bug.
11. **Ledger pattern (append-only) is the gold standard for leave balances:** instead of mutating a `balance` column, append `LeaveLedgerEntry(+2.0, ACCRUAL, ...)` / `LeaveLedgerEntry(-1.0, APPROVE, ...)` rows. Balance is a `SUM()` over the ledger. This gives a built-in audit trail and eliminates read-compute-write races.

## Security Concerns

- **CRITICAL:** Double accrual from non-idempotent cron runs silently inflates leave balance — detectable only on reconciliation, looks like an internal theft vector.
- **CRITICAL:** Illegal state transitions (e.g., approving a cancelled request) corrupt the leave ledger and can create phantom approved days.
- **HIGH:** Cross-tenant cron run accrues employees of the wrong tenant — silent data corruption and tenant-isolation breach.
- **HIGH:** Approval without balance check creates negative balances in a tenant that forbids them.
- **HIGH:** Concurrent approvals of overlapping leave requests both succeed if overlap detection is application-only.
- **MEDIUM:** Year-end rollover mistakes (carrying over more than the cap) are expensive to unwind because downstream accruals reference the new balance.

## Performance Concerns

- Ledger-sum computation per request is O(history). Maintain a denormalized `leave_balance_snapshot` updated transactionally with each ledger entry (same transaction, no race) and reconcile periodically.
- Monthly accrual batch over thousands of employees should be a single `INSERT INTO leave_ledger (...) SELECT ... FROM employees WHERE ...` — not a per-employee loop with N round-trips.
- Advisory lock contention: one lock per tenant is sufficient; do not take a global lock across tenants.

## Architectural Implications for hr-expert reviews

- Leave balance must be modeled as an append-only `LeaveLedgerEntry` table: `(id, tenant_id, employee_id, delta_days NUMERIC(6,2), reason ENUM, reference_id, period_year, period_month, created_at)`.
- A `LeaveBalanceSnapshot` table holds the derived balance per employee, updated in the same transaction as each ledger entry, with a `CHECK (snapshot_balance = (SELECT SUM(delta_days) FROM leave_ledger WHERE employee_id = ...))` validated nightly.
- Monthly accrual command must:
  1. Take `pg_try_advisory_xact_lock(tenant_hash, ACCRUAL_LOCK_ID)`.
  2. Insert a row into `accrual_run(tenant_id, period_year, period_month)` with a UNIQUE constraint.
  3. Insert ledger entries in bulk (`INSERT ... SELECT`).
  4. Update snapshot balances in the same transaction.
  5. Commit, then publish `LeaveAccruedEvent` via the outbox.
- Leave request state machine must be an explicit enum transition function — illegal transitions throw a domain error.
- Balance decrement happens ONLY on approval, within the same transaction as the state change and the `LeaveLedgerEntry(-days, APPROVAL)` insert.
- Overlap detection: add `EXCLUDE USING gist (tenant_id WITH =, employee_id WITH =, leave_range WITH &&) WHERE (status = 'APPROVED')` partial exclusion constraint.
- Year-end rollover is a separate command with its own advisory lock, audit entry, and tenant-scoped policy parameters.
- Cron runner must enforce tenant scope at startup (search_path set per tenant per worker).

## Domain Rule Additions for hr-expert

- **[CRITICAL]** Leave balance must be implemented as an append-only `LeaveLedgerEntry` table. Direct `UPDATE leave_balance SET balance = ...` in command handlers is a blocking review failure.
- **[CRITICAL]** Monthly accrual cron must be idempotent via `accrual_run(tenant_id, period_year, period_month)` UNIQUE constraint + `pg_try_advisory_xact_lock` for singleton execution. Non-idempotent accrual is a blocking review failure.
- **[CRITICAL]** Leave request state transitions must use an explicit state machine function. Illegal transitions (e.g., `REJECTED → APPROVED`, `CANCELLED → APPROVED`) must throw a domain error, not be silently accepted.
- **[CRITICAL]** Balance decrement happens ONLY on `APPROVED` transition, in the same transaction as the state change and a `LeaveLedgerEntry(-days, APPROVAL)` insert. Decrementing on PENDING is a blocking review failure.
- **[CRITICAL]** Approved leave overlap must be prevented by a partial GiST exclusion constraint: `EXCLUDE USING gist (tenant_id WITH =, employee_id WITH =, leave_range WITH &&) WHERE (status = 'APPROVED')`.
- **[HIGH]** Cross-tenant accrual must be impossible: cron workers must set search_path per tenant and every accrual query must include `tenant_id` predicate. A global cron worker accruing across tenants is a blocking review failure.
- **[HIGH]** Year-end rollover must run as its own command with its own advisory lock, its own `rollover_run` idempotency table, and a tenant-scoped policy parameter covering carryover cap, expiry date on carried balance, and use-it-or-lose-it flag.
- **[HIGH]** Negative balance allowance must be a tenant policy read from config; a hard-coded `CHECK (balance >= 0)` constraint is a blocking review failure because it cannot express the policy.
- **[HIGH]** Leave balance snapshot must be updated in the same transaction as the ledger insert and validated nightly against `SUM(ledger.delta_days)`; snapshot drift is a P0 alert.
- **[MEDIUM]** Monthly accrual must run as a single set-based `INSERT ... SELECT` over the employees table, not a per-employee loop.
- **[MEDIUM]** All leave-related events (`LeaveAccruedEvent`, `LeaveApprovedEvent`, `LeaveRejectedEvent`, `LeaveRolledOverEvent`) must be published through the outbox after commit, never inside the transaction.

Research: `docs/research/hr-expert/2026-04-08-leave-management-accrual-atomicity.md`
