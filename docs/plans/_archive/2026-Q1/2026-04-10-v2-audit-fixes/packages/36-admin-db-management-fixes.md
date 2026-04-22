# Package 36: admin-db-management-fixes

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 12K
Priority: MEDIUM
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none
Sprint: 2

## Closing-Findings
Closing-Findings: [admin-expert/MEDIUM-002, admin-expert/MEDIUM-003, admin-expert/MEDIUM-004]

## Source-Reviews
- /var/aqua-saas/docs/reviews/admin-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
Three admin database-management correctness issues: (1) write operations in the database explorer use a read-only query runner even when the write feature flag is enabled; (2) restore accepts `targetSchemaName` but the restore command ignores it; (3) query history persists in localStorage across logouts, leaving sensitive SQL on shared devices.

## Findings
`MEDIUM-002` (admin-expert): Database explorer writes are effectively disabled even when the feature flag says they are enabled. File: `apps/admin-api-service/src/database-management/controllers/explorer.controller.ts`. Write operations use `createReadOnlyQueryRunner()` which sets `SET TRANSACTION READ ONLY`.

`MEDIUM-003` (admin-expert): Restore accepts `targetSchemaName` but the restore command ignores it. Files: `apps/admin-api-service/src/database-management/controllers/backup.controller.ts`, `apps/admin-api-service/src/database-management/services/backup-restore.service.ts`. `executeRestore()` uses `backup.schemaName` not `restore.targetSchemaName`.

`MEDIUM-004` (admin-expert): Query history survives logout and keeps sensitive SQL in localStorage. Files: `web/modules/admin-panel/src/components/database/QueryEditor.tsx`, `web/shared-ui/src/utils/logout-cleanup.ts`. Logout cleanup does not clear `admin_sql_query_history`.

## Affected Files
- /var/aqua-saas/apps/admin-api-service/src/database-management/controllers/explorer.controller.ts
- /var/aqua-saas/apps/admin-api-service/src/database-management/controllers/backup.controller.ts
- /var/aqua-saas/apps/admin-api-service/src/database-management/services/backup-restore.service.ts
- /var/aqua-saas/web/modules/admin-panel/src/components/database/QueryEditor.tsx
- /var/aqua-saas/web/shared-ui/src/utils/logout-cleanup.ts

## Dependencies
None.

## Atomic Commit Plan
```
fix(admin): fix DB explorer write path, restore target schema, clear query history

Three admin database-management gaps: explorer writes used a read-only
query runner, restore ignored targetSchemaName, and query history
survived logout. This creates a write-capable execution path for the
explorer when writes are enabled, makes the restore path honor
targetSchemaName, and adds admin_sql_query_history to the logout cleanup
list.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/36-admin-db-management-fixes.md
Closes: docs/reviews/admin-expert/2026-04-10-full-repo-audit.md#MEDIUM-002
Closes: docs/reviews/admin-expert/2026-04-10-full-repo-audit.md#MEDIUM-003
Closes: docs/reviews/admin-expert/2026-04-10-full-repo-audit.md#MEDIUM-004
```

## Test Plan
- Unit test: write operations use a non-read-only query runner when flag is enabled.
- Unit test: restore uses targetSchemaName when provided.
- Unit test: logout cleanup removes admin_sql_query_history.
- Negative test: write operations still fail when flag is disabled.

## Verification Command
`npx tsc --noEmit -p apps/admin-api-service/tsconfig.json`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

