# Package 13: admin-audit-immutability

## Metadata
Status: PENDING
Estimated Tokens: 10K
Priority: CRITICAL
Security-Sensitive: yes
Parallelizable: yes (Sprint 1)
Prerequisites: none
Sprint: 1
Closing-Findings: [ADMIN-CRITICAL-006, ADMIN-CRITICAL-007]
Source-Reviews: [user-provided finding list 2026-04-09]

## Context
Two audit log integrity defects: (1) the audit purge operation deletes records without checking for legal holds or creating an archive copy -- this violates retention requirements and can destroy evidence needed for legal proceedings; (2) the audit log entity has no database-level immutability enforcement (no UPDATE/DELETE triggers or policies), meaning any code path with write access can silently modify historical audit entries. Together these make the audit log unreliable as an evidence trail.

## Findings
- **ADMIN-CRITICAL-006**: Audit purge deletes without legal hold check or archive
  - File: `apps/admin-api-service/src/audit/audit.service.ts` (~11.9K chars)
  - Purge operation uses DELETE without checking `legal_hold` flag or archiving
  - Root cause: retention policy not implemented at the service layer

- **ADMIN-CRITICAL-007**: Audit log entity no DB-level immutability triggers
  - File: `apps/admin-api-service/src/audit/audit.entity.ts` (~3K chars)
  - No database triggers to PREVENT UPDATE or DELETE on audit rows
  - Root cause: immutability enforced only at application layer (easily bypassed)

## Affected Files
- `/var/aqua-saas/apps/admin-api-service/src/audit/audit.service.ts` (~11.9K chars)
- `/var/aqua-saas/apps/admin-api-service/src/audit/audit.entity.ts` (~3K chars)

## Dependencies
None.

## Atomic Commit Plan
```
security(admin): enforce audit log immutability and legal hold on purge

1. audit.service.ts: add legal hold check before purge -- skip any
   records with active legal holds. Archive purged records to
   audit_archive table before deletion.
2. audit.entity.ts: add migration creating DB-level triggers:
   - BEFORE UPDATE trigger: RAISE EXCEPTION 'audit log immutable'
   - BEFORE DELETE trigger: check legal_hold flag, RAISE EXCEPTION
     if held; otherwise allow only from audit_purge_role
3. Create audit_purge_role with DELETE-only on audit table, used
   exclusively by the purge service after legal hold verification.

Closes: docs/reviews/2026-04-09-critical-fixes#ADMIN-CRITICAL-006
Closes: docs/reviews/2026-04-09-critical-fixes#ADMIN-CRITICAL-007
Plan: docs/plans/2026-04-09-critical-fixes/packages/13-admin-audit-immutability.md
```

## Test Plan
- Unit test: purge skips records with active legal hold
- Unit test: purge archives records before deletion
- Integration test: UPDATE on audit table triggers exception
- Integration test: DELETE on legally-held record triggers exception
- Integration test: purge via audit_purge_role on non-held record succeeds

## Verification Command
```bash
cd /var/aqua-saas && npx tsc --noEmit -p apps/admin-api-service/tsconfig.json && npx jest --testPathPattern="apps/admin-api-service/src/audit" --coverage=false
```
Dispatch: security-reviewer

## Rollback Plan
```
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes
