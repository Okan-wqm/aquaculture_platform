# Package 09: hr-payroll-decimal-precision

## Metadata
Status: PENDING
Estimated Tokens: 10K
Priority: CRITICAL
Security-Sensitive: no
Parallelizable: yes (Sprint 1)
Prerequisites: none
Sprint: 1
Closing-Findings: [HR-CRITICAL-004, HR-CRITICAL-005]
Source-Reviews: [user-provided finding list 2026-04-09]

## Context
Two payroll calculation defects that produce incorrect monetary amounts: (1) payroll JSONB monetary fields use no DecimalTransformer, so JavaScript float arithmetic causes rounding errors on salaries (e.g., 1/3 hourly rates, overtime multipliers); (2) hourly rate calculation hard-codes a 160-hour divisor regardless of pay period type (bi-weekly=80h, semi-monthly=86.67h, monthly=variable). Together these guarantee incorrect paychecks for any non-standard pay period.

## Findings
- **HR-CRITICAL-004**: Payroll JSONB monetary fields no DecimalTransformer -- Float rounding
  - File: `apps/hr-service/src/hr/entities/payroll.entity.ts` (~4.6K chars)
  - Monetary fields stored in JSONB without DecimalTransformer; `parseFloat()` applied on read
  - Root cause: JSONB columns bypass TypeORM column transformers

- **HR-CRITICAL-005**: Hourly rate hard-coded 160h divisor ignores pay period type
  - File: `apps/hr-service/src/hr/handlers/create-payroll.handler.ts` (~10.6K chars)
  - `hourlyRate = salary / 160` regardless of PayPeriodType
  - Root cause: initial implementation assumed monthly/40h-week only

## Affected Files
- `/var/aqua-saas/apps/hr-service/src/hr/entities/payroll.entity.ts` (~4.6K chars)
- `/var/aqua-saas/apps/hr-service/src/hr/handlers/create-payroll.handler.ts` (~10.6K chars)

## Dependencies
None.

## Atomic Commit Plan
```
fix(hr): add DecimalTransformer to payroll entity and fix hourly rate calculation

1. payroll.entity.ts: add DecimalTransformer to all monetary JSONB
   fields (baseSalary, hourlyRate, overtimeRate, deductions, netPay).
   Use decimal.js for all arithmetic, serialize as string in JSONB.
2. create-payroll.handler.ts: replace hard-coded /160 with
   PayPeriodType-aware divisor (MONTHLY=variable based on calendar,
   BIWEEKLY=80, SEMIMONTHLY=86.67, WEEKLY=40).

Closes: docs/reviews/2026-04-09-critical-fixes#HR-CRITICAL-004
Closes: docs/reviews/2026-04-09-critical-fixes#HR-CRITICAL-005
Plan: docs/plans/2026-04-09-critical-fixes/packages/09-hr-payroll-decimal-precision.md
```

## Test Plan
- Unit test: DecimalTransformer round-trip preserves precision (1/3 hourly rate)
- Unit test: hourly rate for BIWEEKLY period = salary / 80
- Unit test: hourly rate for SEMIMONTHLY period = salary / 86.67
- Unit test: hourly rate for MONTHLY period = salary / (working_days * 8)
- Unit test: overtime calculation with decimal precision matches expected penny

## Verification Command
```bash
cd /var/aqua-saas && npx jest --testPathPattern="apps/hr-service/src/hr/(entities|handlers)" --coverage=false
```

## Rollback Plan
```
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes
