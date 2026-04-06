# S2 Audit Review — HIGH Findings
**Service:** `apps/admin-api-service/`
**Reviewer:** Admin Domain Expert
**Date:** 2026-04-05
**Scope:** Database explorer SQL injection vectors, tenant schema DROP protection, super admin session timeout, impersonation audit log gaps, cross-tenant access control gaps

---

## Prior Work Status

| Fix | Status |
|-----|--------|
| WQ seeding SQL injection → parameterized | Confirmed fixed |
| Impersonation H-08: superAdminEmail optional | Confirmed fixed |
| Platform admin guard hardening (HS256, iss/aud, async verify) | Confirmed fixed |

No prior review files existed in `docs/reviews/admin-expert/`. This is the first S2 review.

---

## Findings Summary

| ID | Severity | File | Line | Category |
|----|----------|------|------|----------|
| H-S2-01 | HIGH | `database-management/controllers/explorer.controller.ts` | 143 | SQL injection — filter param declared but not used; dead DTO field invites future injection |
| H-S2-02 | HIGH | `database-management/controllers/schema.controller.ts` | 119–125 | Tenant schema DROP — no initiator audit, no confirmation gate, no UUID pipe on tenantId param |
| H-S2-03 | HIGH | `database-management/controllers/migration.controller.ts` | 115–162 | Migration executor identity — `executedBy` accepted from client body, not JWT |
| H-S2-04 | HIGH | `impersonation/services/impersonation.service.ts` | (entire service) | Impersonation — no AuditLogService integration; session start/end writes only to in-memory + own repo, never to central audit log |
| H-S2-05 | HIGH | `impersonation/controllers/impersonation.controller.ts` | 338–360 | MFA step-up absent — impersonation start has no MFA verification gate |
| H-S2-06 | HIGH | `database-management/services/schema-management.service.ts` | 183–194 | SQL injection via timestamp in raw INSERT — `new Date().toISOString()` embedded in string literal inside `createDefaultTables` |
| H-S2-07 | HIGH | `database-management/database-management.module.ts` / all DB controllers | — | No AuditLogService wired into DatabaseManagementModule — backup, restore, migration, schema DROP operations emit no central audit events |
| H-S2-08 | MEDIUM | `database-management/controllers/schema.controller.ts` | 85–139 | UUID not pipe-validated on route-level `:tenantId` params for state-mutating routes |

---

## Detailed Findings

---

### H-S2-01 — Explorer `filter` Field: Declared SQL Injection Vector

**Severity:** HIGH
**File:** `apps/admin-api-service/src/database-management/controllers/explorer.controller.ts`
**Lines:** 122–146 (DTO declaration), confirmed not consumed in query (grep: `query.filter` never referenced)

**Problem:**
`TableQueryDto` declares a `filter?: string` field at line 143. The field carries no format constraint beyond `@IsString()`. It is not consumed in `getTableData` today, but the pattern creates a trap: the next engineer who needs row filtering will likely append it into a raw `WHERE` clause using string interpolation, as the existing `orderBy` and schema/table interpolation already establish that pattern in this file. This is a latent injection vector introduced by API surface that promises more than it delivers.

Furthermore, the `orderBy` field in the same DTO is also `@IsString()` only, protected solely by the `isValidIdentifier()` call at runtime at line 361. There is no DTO-level `@Matches` constraint, so if the call to `isValidIdentifier` is ever skipped or bypassed (e.g., in a refactor that passes the DTO to another path), the raw identifier reaches the query.

**Root cause:** DTOs expose fields without defining exact valid formats at the class-validator level, relying on runtime guards instead of schema-enforced types.

**Evidence:**
```
line 141-143:
  @IsOptional()
  @IsString()
  filter?: string;

line 361:
  const orderBy = query.orderBy && this.isValidIdentifier(query.orderBy) ? query.orderBy : null;
```

**Recommendation:**
1. Remove the `filter` field from `TableQueryDto` entirely until a safe, parameterized server-side filter implementation exists.
2. Add `@Matches(/^[a-z_][a-z0-9_]*$/i)` + `@MaxLength(63)` to the `orderBy` field in the DTO so the constraint is enforced at deserialization, not at query-build time.

---

### H-S2-02 — Tenant Schema `DROP CASCADE` Has No Audit Record and No UUID Pipe

**Severity:** HIGH
**Files:**
- `apps/admin-api-service/src/database-management/controllers/schema.controller.ts` lines 119–126
- `apps/admin-api-service/src/database-management/services/schema-management.service.ts` lines 283–304

**Problem:**
The `DELETE /database/schemas/:tenantId?hardDelete=true` endpoint executes `DROP SCHEMA IF EXISTS "..." CASCADE`, which permanently destroys all tenant data. Three compounding problems exist:

1. **No UUID pipe.** The `:tenantId` route parameter at line 122 is a plain `@Param('tenantId') tenantId: string`. There is no `ParseUUIDPipe`. A malformed value that passes `isValidSchemaName` after prefix stripping could, in adversarial conditions, target an unintended schema.

2. **No audit record.** `deleteSchema()` calls `queryRunner.query('DROP SCHEMA ...')` then `schemaRepository.delete(...)`. Neither the service nor the controller emits an `AuditLogService.log()` call. After a DROP, there is no immutable record in the central audit log of who initiated the destruction, from which IP address, or at what time.

3. **No confirmation gate.** The `hardDelete=true` flag is a URL query parameter that any authenticated SUPER_ADMIN can pass without any secondary confirmation. Domain rules require destructive operations to be auditable; a silent DROP via a single HTTP call violates this.

**Root cause:** The schema controller was built without injecting or calling `AuditLogService`, and the destructive path through `deleteSchema(hardDelete=true)` was not flagged as requiring the same audit rigor as impersonation.

**Evidence:**
```typescript
// schema.controller.ts line 119-125
@Delete(':tenantId')
@HttpCode(HttpStatus.NO_CONTENT)
async deleteSchema(
  @Param('tenantId') tenantId: string,          // no ParseUUIDPipe
  @Query('hardDelete') hardDelete?: string,
) {
  await this.schemaService.deleteSchema(tenantId, hardDelete === 'true');
}

// schema-management.service.ts line 293-295
await queryRunner.query(`DROP SCHEMA IF EXISTS "${schema.schemaName}" CASCADE`);
await this.schemaRepository.delete({ id: schema.id });
// no audit log call anywhere in this path
```

**Recommendation:**
1. Add `ParseUUIDPipe` to `:tenantId` on all mutating routes in `SchemaController`.
2. Inject `AuditLogService` into `SchemaManagementService` and emit a `SCHEMA_HARD_DELETED` audit event (severity CRITICAL) before the DROP executes, recording `tenantId`, `schemaName`, `performedBy`, `ipAddress`.
3. Add a 2-step confirmation pattern: a separate `POST /database/schemas/:tenantId/schedule-delete` that sets a `pendingDelete` flag plus a confirmation token, and the actual DELETE only executes when that token is present and not expired (e.g., 10-minute window). This is the enterprise pattern for irreversible destructive operations.

---

### H-S2-03 — Migration `executedBy` Taken From Client Body, Not JWT

**Severity:** HIGH
**File:** `apps/admin-api-service/src/database-management/controllers/migration.controller.ts`
**Lines:** 38–45, 115–129, 133–146, 153–162

**Problem:**
All three migration endpoints (`POST tenant/:tenantId/run`, `POST tenant/:tenantId/rollback`, `POST batch/run`) accept `executedBy` as an optional free-text field in the request body. This field is written directly into the `SchemaMigration` record as the identity of who ran the migration. An authenticated SUPER_ADMIN can supply any string value — including another user's name or ID — allowing falsified attribution in the migration history.

None of the three endpoints inject `@Req()` or `@CurrentUser()`, so there is no mechanism to cross-check the claimed identity against the JWT sub.

**Root cause:** The `executedBy` pattern was copied from internal service calls where the caller is trusted, but exposed directly in the HTTP API without an identity override from the verified token.

**Evidence:**
```typescript
// migration.controller.ts line 38-44
class RunMigrationDto {
  ...
  @IsOptional()
  @IsString()
  @MaxLength(255)
  executedBy?: string;   // client-supplied, not JWT-derived
}

// line 115-129
async runMigration(
  @Param('tenantId') tenantId: string,
  @Body() dto: RunMigrationDto,
) {
  return this.migrationService.runMigration(
    tenantId, dto.version, dto.isDryRun,
    dto.executedBy,   // falsifiable
  );
}
```

**Recommendation:**
1. Remove `executedBy` from all three DTOs (`RunMigrationDto`, `BatchMigrationDto`, `RollbackMigrationDto`).
2. Inject `@Req() req: Request` in each handler and derive the executor identity from `req.user.id` (already set by `PlatformAdminGuard`).
3. Update `MigrationManagementService.runMigration()` signature to accept `executedById: string` (not optional) and write `req.user.id` rather than any client-supplied value.

---

### H-S2-04 — Impersonation Service Has No Central Audit Log Integration

**Severity:** HIGH
**Files:**
- `apps/admin-api-service/src/impersonation/services/impersonation.service.ts` (all start/end/expire/terminate methods)
- `apps/admin-api-service/src/impersonation/impersonation.module.ts`

**Problem:**
`ImpersonationService` manages its own `ImpersonationSession` repository and logs events to `Logger` only. It does not inject or call `AuditLogService`. This means:

- Session start, end, termination, and expiry events are never written to the `audit_logs` table.
- `AuditLogService.getSecurityLogs()` at line 235 explicitly lists `'USER_IMPERSONATED'` as a security action to track, but no code ever calls `auditService.log({ action: 'USER_IMPERSONATED', ... })`.
- The security dashboard that aggregates events from `AuditLogService` will therefore show zero impersonation events even when impersonation is actively in use.
- Cross-referencing an impersonation session with a broader audit query (e.g., "what did this admin do across all modules on that day?") is impossible because the two logs are in separate tables with no join key.

**Root cause:** `ImpersonationModule` does not import `AuditModule` and does not register `AuditLogService` as a dependency. This is a module-level omission, not an oversight in any single method.

**Evidence:**
From `impersonation.module.ts` — `AuditModule` is not in the `imports` array and `AuditLogService` is not in the `providers` array. In `impersonation.service.ts` — `AuditLogService` is not injected in the constructor.

**Recommendation:**
1. Import `AuditModule` in `ImpersonationModule`.
2. Inject `AuditLogService` into `ImpersonationService`.
3. In `startImpersonation()`, after saving the session, call:
   ```typescript
   await this.auditService.log({
     action: 'IMPERSONATION_STARTED',
     entityType: 'ImpersonationSession',
     entityId: saved.id,
     tenantId: request.targetTenantId,
     performedBy: request.superAdminId,
     ipAddress: request.ipAddress,
     userAgent: request.userAgent,
     severity: AuditSeverity.WARNING,
     details: { targetUserId: request.targetUserId, reason: request.reason, expiresAt },
   });
   ```
4. Emit corresponding `IMPERSONATION_ENDED`, `IMPERSONATION_TERMINATED`, `IMPERSONATION_EXPIRED` events in the respective methods with the same detail structure.
5. The `logAction()` method must also emit to the audit log for each action performed during an active impersonation session, with `sessionId` in `details` for correlation.

---

### H-S2-05 — No MFA Step-Up Gate Before Impersonation Start

**Severity:** HIGH
**File:** `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts`
**Lines:** 337–360

**Problem:**
`POST /impersonation/sessions/start` is protected by `PlatformAdminGuard` (JWT role check) and `@ThrottleSensitive()` (rate limiting). There is no MFA step-up verification. Domain rules explicitly state: "MFA step-up REQUIRED before initiating impersonation."

The current flow allows a SUPER_ADMIN whose JWT was obtained at normal login (without step-up) to immediately initiate impersonation of any tenant in their `allowedTenants` list. If the SUPER_ADMIN's session token is compromised (e.g., via XSS, token theft, or insider threat), the attacker gains immediate impersonation capability.

There is no `mfaVerified`, `stepUpToken`, or equivalent claim in the JWT payload structure (`JwtPayload` in `platform-admin.guard.ts`), and no custom decorator or guard exists in the codebase to enforce step-up at the route level.

**Root cause:** MFA step-up was defined as a domain requirement but was never implemented. The guard only checks role, not authentication assurance level.

**Evidence:**
```typescript
// impersonation.controller.ts line 337-360
@ThrottleSensitive()
@Post('sessions/start')
async startImpersonation(
  @Body() dto: StartImpersonationDto,
  @Req() req: Request,
) {
  // Only checks: user?.id exists (line 347)
  // No MFA step-up check anywhere
  return this.impersonationService.startImpersonation(request);
}
```

**Recommendation:**
1. Design a step-up flow: the SUPER_ADMIN calls `POST /auth/step-up` (auth-service side), which issues a short-lived (5-minute), single-use `stepUpToken` after MFA re-verification.
2. The `stepUpToken` is passed in the `X-Step-Up-Token` header with the impersonation start request.
3. Create a `MfaStepUpGuard` in `admin-api-service` that validates this token (via a call to auth-service, or by verifying a HMAC-signed token with a dedicated step-up secret).
4. Apply `@UseGuards(MfaStepUpGuard)` to `POST sessions/start` exclusively.
5. The `stepUpToken` must be single-use and scoped to the impersonation action to prevent replay.
6. This is a cross-domain dependency — coordinate with auth-security-expert.

---

### H-S2-06 — Timestamp String Interpolation in Raw SQL Inside `createDefaultTables`

**Severity:** HIGH
**File:** `apps/admin-api-service/src/database-management/services/schema-management.service.ts`
**Lines:** 183–194

**Problem:**
The `createDefaultTables` method constructs a multi-row INSERT using string interpolation:

```typescript
await queryRunner.query(`
  INSERT INTO "${schemaName}"."_metadata" (key, value)
  VALUES
    ('schema_version', '"1.0.0"'),
    ('created_at', '"${new Date().toISOString()}"'),
    ('last_migration', 'null')
  ON CONFLICT (key) DO NOTHING
`);
```

`new Date().toISOString()` produces output of the form `2026-04-05T12:00:00.000Z`, which is entirely safe in isolation. However the pattern of interpolating any dynamic value — even a constant — into a raw SQL string is architecturally wrong. The risk is that a future change (e.g., reading the timestamp from an external source, or adding a metadata value that contains tenant-supplied data) would silently introduce an injection vector. The codebase has parameterized all other queries in this service (`$1` placeholders), making this inconsistency a future maintenance trap.

Additionally, `schemaName` is not validated with `isValidSchemaName` inside `createDefaultTables` (unlike `createDatabaseSchema` which calls `this.isValidSchemaName(schemaName)` at line 135). The schema name used in the double-quoted identifier is only validated in the public entry points, not in each private method that uses it.

**Root cause:** The `createDefaultTables` method was written without applying the same parameterized INSERT pattern used elsewhere, and private methods were not hardened with their own schema name validation.

**Evidence:**
```typescript
// line 184-192
await queryRunner.query(`
  INSERT INTO "${schemaName}"."_metadata" (key, value)
  VALUES
    ('schema_version', '"1.0.0"'),
    ('created_at', '"${new Date().toISOString()}"'),   // interpolated
    ('last_migration', 'null')
  ON CONFLICT (key) DO NOTHING
`);
```

**Recommendation:**
1. Replace the interpolated INSERT with a parameterized multi-row insert using `$1`, `$2`, `$3`:
   ```typescript
   await queryRunner.query(
     `INSERT INTO "${schemaName}"."_metadata" (key, value) VALUES
      ($1, $2::jsonb), ($3, $4::jsonb), ($5, $6::jsonb)
      ON CONFLICT (key) DO NOTHING`,
     ['schema_version', '"1.0.0"', 'created_at', `"${new Date().toISOString()}"`, 'last_migration', 'null'],
   );
   ```
   Note: the `schemaName` used as a quoted identifier in the table name is still validated by `isValidSchemaName` at the call site.
2. Add `isValidSchemaName` validation at the top of `createDefaultTables` (and any other private method that accepts `schemaName` and constructs SQL), as a defense-in-depth guard, independent of caller behavior.

---

### H-S2-07 — DatabaseManagementModule Does Not Wire AuditLogService

**Severity:** HIGH
**File:** `apps/admin-api-service/src/database-management/database-management.module.ts`

**Problem:**
`DatabaseManagementModule` does not import `AuditModule` and none of its five services (`SchemaManagementService`, `MigrationManagementService`, `BackupRestoreService`, `DatabaseMonitoringService`, and the explorer controller) inject `AuditLogService`.

As a result, the following operations produce no entry in the central audit log:
- `DROP SCHEMA CASCADE` (schema hard-delete)
- `pg_dump` backup execution (who initiated, which tenant, backup size)
- `pg_restore` restore execution (who initiated, from which backup, target schema)
- Batch migration runs affecting all active tenants
- Schema status changes (suspend, activate)

The `BackupRestoreService` uses `Logger.log()` for backup completion, but the `Logger` output goes to console/stdout only — it is not queryable, not retention-controlled, and not surfaced in the security dashboard.

For backup and restore, `createBackup` accepts no `initiatedBy` parameter at all, meaning there is no mechanism to record who triggered the backup even if audit logging were added later.

**Root cause:** Systematic omission. The module was built with an internal logger as the sole observability mechanism, without connecting to the platform audit infrastructure.

**Recommendation:**
1. Add `AuditModule` to the `imports` array of `DatabaseManagementModule`.
2. Inject `AuditLogService` into `BackupRestoreService` and `SchemaManagementService`.
3. For `BackupRestoreService.createBackup()`, add an `initiatedBy: string` parameter (derived from the controller's `req.user.id`) and emit a `BACKUP_INITIATED` event and a `BACKUP_COMPLETED` / `BACKUP_FAILED` event.
4. For `restoreFromBackup()`, add `initiatedBy: string` and emit `RESTORE_INITIATED` and `RESTORE_COMPLETED` / `RESTORE_FAILED`.
5. All database operations controllers (`BackupController`, `MigrationController`, `SchemaController`) must inject `@Req()` and pass `req.user.id` downstream.

---

### H-S2-08 — Schema Controller Missing ParseUUIDPipe on Mutating Routes

**Severity:** MEDIUM
**File:** `apps/admin-api-service/src/database-management/controllers/schema.controller.ts`
**Lines:** 85, 90, 109, 114, 119, 132, 137

**Problem:**
All routes with `:tenantId` path parameters use plain `@Param('tenantId') tenantId: string` with no `ParseUUIDPipe`. While the DTO for `POST /` (body) uses `@IsUUID()`, route-level parameters on GET/DELETE/POST sub-routes pass the raw string directly to service methods which do a database lookup by `tenantId`. A non-UUID value will generate a TypeORM query that fails at the DB driver level rather than being rejected at the controller boundary, leaking internal error messages in the response.

By contrast, `TenantController` correctly uses `@Param('id', ParseUUIDPipe)` on all its routes, demonstrating the platform standard.

**Root cause:** Inconsistent application of the UUID pipe pattern across the codebase.

**Recommendation:**
Add `ParseUUIDPipe` to all `:tenantId` route parameters in `SchemaController`:
```typescript
@Get(':tenantId')
async getSchema(@Param('tenantId', ParseUUIDPipe) tenantId: string) { ... }
```

---

## Summary Table

| ID | Severity | Root Cause Category | Blocking Deploy? |
|----|----------|---------------------|------------------|
| H-S2-01 | HIGH | Latent injection surface, unsafe DTO design | Yes |
| H-S2-02 | HIGH | Missing audit, missing UUID validation, no confirmation gate | Yes |
| H-S2-03 | HIGH | Client-controlled audit identity falsification | Yes |
| H-S2-04 | HIGH | Missing module-level audit integration | Yes |
| H-S2-05 | HIGH | Missing MFA step-up enforcement | Yes |
| H-S2-06 | HIGH | String interpolation in raw SQL | Yes |
| H-S2-07 | HIGH | No audit wiring for destructive DB operations | Yes |
| H-S2-08 | MEDIUM | Inconsistent UUID validation | No |

All HIGH findings are deploy blockers per domain rules.

---

## Cross-Domain Dependencies

| Finding | Dependency |
|---------|-----------|
| H-S2-05 (MFA step-up) | auth-security-expert must implement `POST /auth/step-up` endpoint and step-up token validation |
| H-S2-04, H-S2-07 (audit integration) | security-reviewer quality gate on audit completeness |
| H-S2-02 (schema DROP cascade) | data-expert migration review for any schema-level destructive operation |
