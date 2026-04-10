# Admin Expert Review
**Date:** 2026-04-10  
**Scope:** `apps/admin-api-service/**`, `web/modules/admin-panel/**`, `web/modules/tenant-admin/**`

## Findings

### HIGH-001 - Tenant schema hard delete is still one query flag away and leaves no central audit trail
**Files:**
- [`apps/admin-api-service/src/database-management/controllers/schema.controller.ts`](/var/aqua-saas/apps/admin-api-service/src/database-management/controllers/schema.controller.ts)
- [`apps/admin-api-service/src/database-management/services/schema-management.service.ts`](/var/aqua-saas/apps/admin-api-service/src/database-management/services/schema-management.service.ts)

`DELETE /database/schemas/:tenantId?hardDelete=true` still routes directly into `DROP SCHEMA ... CASCADE` with no second confirmation step and no `AuditLogService` write. The controller simply forwards the boolean query flag, and the service performs the destructive drop immediately. That means a tenant can be permanently removed without an immutable audit record of who initiated it, when, or from where.

Recommended fix: require an explicit confirmation token or dedicated destructive-action endpoint, inject the audit service into the schema management service, and log the initiator before the drop executes.

### MEDIUM-002 - Database explorer writes are effectively disabled even when the feature flag says they are enabled
**File:**
- [`apps/admin-api-service/src/database-management/controllers/explorer.controller.ts`](/var/aqua-saas/apps/admin-api-service/src/database-management/controllers/explorer.controller.ts)

`insertRow`, `updateRow`, and `deleteRow` all check `ENABLE_DB_EXPLORER_WRITES=true`, but each one still creates a read-only query runner via `createReadOnlyQueryRunner()`. That runner explicitly executes `SET TRANSACTION READ ONLY`, so the DML statements can never succeed. The UI can expose write controls, but the backend path is functionally unreachable.

Recommended fix: split the explorer into explicit read-only and write-capable execution paths, or remove the write feature flag and UI affordances until a genuine write-safe path exists.

### MEDIUM-003 - Restore accepts `targetSchemaName` but the restore command ignores it
**Files:**
- [`apps/admin-api-service/src/database-management/controllers/backup.controller.ts`](/var/aqua-saas/apps/admin-api-service/src/database-management/controllers/backup.controller.ts)
- [`apps/admin-api-service/src/database-management/services/backup-restore.service.ts`](/var/aqua-saas/apps/admin-api-service/src/database-management/services/backup-restore.service.ts)

The restore DTO accepts `targetSchemaName`, the controller passes it through, and `restoreFromBackup()` stores it in the restore record. But `executeRestore()` still invokes `pg_restore` with `--schema=${backup.schemaName}`, not the requested target schema. The metadata later queries `restore.targetSchemaName`, so the record and the actual restore target can diverge.

Recommended fix: make the restore path honor `restore.targetSchemaName` consistently, or remove the target-schema field from the API if alternate-schema restore is not supported.

### MEDIUM-004 - Query history survives logout and keeps sensitive SQL in localStorage
**Files:**
- [`web/modules/admin-panel/src/components/database/QueryEditor.tsx`](/var/aqua-saas/web/modules/admin-panel/src/components/database/QueryEditor.tsx)
- [`web/shared-ui/src/utils/logout-cleanup.ts`](/var/aqua-saas/web/shared-ui/src/utils/logout-cleanup.ts)

The database query editor persists query previews and schema names in `admin_sql_query_history`, but the centralized logout cleanup only removes auth-related keys. Query history is therefore left behind across logouts and user switches, which is not appropriate for a super-admin tool that can contain sensitive table names, filters, and incident-specific SQL.

Recommended fix: clear `admin_sql_query_history` during logout cleanup, or move the history behind an ephemeral in-memory store that is dropped on session end.

## Cross-Domain Dependencies

None identified that require a separate agent dispatch for this audit cycle.
