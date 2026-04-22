# Package 12: admin-db-explorer-readonly

## Metadata
Status: PENDING
Estimated Tokens: 14K
Priority: CRITICAL
Security-Sensitive: yes
Parallelizable: yes (Sprint 1)
Prerequisites: none
Sprint: 1
Closing-Findings: [ADMIN-CRITICAL-004, ADMIN-CRITICAL-005]
Source-Reviews: [user-provided finding list 2026-04-09]

## Context
The admin DB Explorer panel executes queries using the application's main database role (full read-write permissions) instead of a dedicated read-only PostgreSQL role. Combined with the raw SQL endpoint missing `SET TRANSACTION READ ONLY`, an attacker (or a careless admin) can execute DDL/DML statements that modify or destroy production data. The DB Explorer should be a diagnostic tool, not a write-capable SQL console.

## Findings
- **ADMIN-CRITICAL-004**: DB Explorer uses application service role (no read-only PG role)
  - File: `apps/admin-api-service/src/database-management/controllers/explorer.controller.ts` (~35K chars)
  - Queries execute via the main DataSource with full write permissions
  - Root cause: no separate read-only connection pool configured

- **ADMIN-CRITICAL-005**: Raw SQL endpoint missing SET TRANSACTION READ ONLY
  - File: `apps/admin-api-service/src/database-management/controllers/explorer.controller.ts`
  - The raw query endpoint does not set the transaction to read-only mode
  - Even without a dedicated role, SET TRANSACTION READ ONLY would prevent accidental writes

## Affected Files
- `/var/aqua-saas/apps/admin-api-service/src/database-management/controllers/explorer.controller.ts` (~35K chars)

## Dependencies
None.

## Atomic Commit Plan
```
security(admin): enforce read-only access for DB Explorer

1. Create a dedicated read-only DataSource connection using a PG role
   with SELECT-only grants. Configure via READ_ONLY_DATABASE_URL env var.
2. Explorer controller: use the read-only DataSource for all queries.
3. As defense-in-depth: wrap all explorer queries in SET TRANSACTION
   READ ONLY even on the read-only connection.
4. Add statement type validation: reject any query starting with
   INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, TRUNCATE, GRANT, REVOKE.

Closes: docs/reviews/2026-04-09-critical-fixes#ADMIN-CRITICAL-004
Closes: docs/reviews/2026-04-09-critical-fixes#ADMIN-CRITICAL-005
Plan: docs/plans/2026-04-09-critical-fixes/packages/12-admin-db-explorer-readonly.md
```

## Test Plan
- Unit test: SELECT query executes successfully on read-only connection
- Unit test: INSERT/UPDATE/DELETE rejected at statement validation layer
- Unit test: DDL statements (DROP, ALTER) rejected
- Integration test: query executes within READ ONLY transaction
- Verify: read-only DataSource configured with separate connection pool

## Verification Command
```bash
cd /var/aqua-saas && npx tsc --noEmit -p apps/admin-api-service/tsconfig.json && npx jest --testPathPattern="apps/admin-api-service/src/database-management" --coverage=false
```
Dispatch: security-reviewer

## Rollback Plan
```
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes
