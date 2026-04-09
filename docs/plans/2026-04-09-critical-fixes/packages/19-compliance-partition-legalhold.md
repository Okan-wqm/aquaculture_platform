# Package 19: compliance-partition-legalhold

## Metadata
Status: IMPLEMENTED
Implemented: 2026-04-09
Estimated Tokens: 8K
Priority: CRITICAL
Security-Sensitive: yes
Parallelizable: yes (Sprint 1)
Prerequisites: none
Sprint: 1
Closing-Findings: [MSG-CRITICAL-009, MSG-CRITICAL-018]
Source-Reviews: [user-provided finding list 2026-04-09]

## Context
Two compliance infrastructure defects: (1) the compliance_audit_log table is not partitioned, causing query performance degradation as the table grows (audit queries scan the entire table); for regulatory compliance (GDPR Article 30), fast audit retrieval is mandatory; (2) the LegalHold entity is missing the `legalMatterId` field, violating GDPR proportionality requirements -- a hold must reference a specific legal proceeding, not be an open-ended blanket freeze on all data.

## Findings
- **MSG-CRITICAL-009**: compliance_audit_log not partitioned
  - File: `apps/messaging-service/src/compliance/entities/compliance-audit-log.entity.ts` (~2.3K chars)
  - No table partitioning configured; unbounded growth causes slow audit queries

- **MSG-CRITICAL-018**: LegalHold missing legalMatterId -- GDPR proportionality
  - File: `apps/messaging-service/src/compliance/entities/legal-hold.entity.ts` (~1.5K chars)
  - No field linking the hold to a specific legal matter or regulatory request

## Affected Files
- `/var/aqua-saas/apps/messaging-service/src/compliance/entities/compliance-audit-log.entity.ts` (~2.3K chars)
- `/var/aqua-saas/apps/messaging-service/src/compliance/entities/legal-hold.entity.ts` (~1.5K chars)
- `/var/aqua-saas/apps/messaging-service/src/compliance/services/legal-hold.service.ts` (~5.1K chars)

## Dependencies
Soft dependency on Package 23 (DB-CRITICAL-003 fixes the same entity's PK). If Package 23 is executed first, this package's migration must account for the updated PK. However, both can be developed independently.

## Atomic Commit Plan
```
fix(messaging): partition compliance_audit_log and add legalMatterId to LegalHold

1. compliance-audit-log.entity.ts: add migration to partition table
   by RANGE on created_at (monthly partitions). Create partitions for
   trailing 12 months + current month. Add cron to create future partitions.
2. legal-hold.entity.ts: add legalMatterId column (VARCHAR, NOT NULL).
   Add legalMatterDescription, requestedBy, expiresAt columns.
3. legal-hold.service.ts: require legalMatterId on hold creation;
   add expiration check on hold validation.

Closes: docs/reviews/2026-04-09-critical-fixes#MSG-CRITICAL-009
Closes: docs/reviews/2026-04-09-critical-fixes#MSG-CRITICAL-018
Plan: docs/plans/2026-04-09-critical-fixes/packages/19-compliance-partition-legalhold.md
```

## Test Plan
- Integration test: compliance_audit_log queries partition-pruned by date range
- Unit test: LegalHold creation requires legalMatterId
- Unit test: LegalHold creation without legalMatterId -- throws validation error
- Unit test: expired legal hold not enforced on data access

## Verification Command
```bash
cd /var/aqua-saas && npx tsc --noEmit -p apps/messaging-service/tsconfig.json && npx jest --testPathPattern="apps/messaging-service/src/compliance" --coverage=false
```

## Rollback Plan
```
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes
