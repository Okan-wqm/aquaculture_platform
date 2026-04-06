# S2 HIGH Findings — Remediation Recommendations
**Service:** `apps/admin-api-service/`
**Reviewer:** Admin Domain Expert
**Date:** 2026-04-05
**Reference:** `docs/reviews/admin-expert/2026-04-05-s2-high-findings.md`

---

## Priority Order

Fix in this order based on blast radius and deploy-blocking severity:

1. H-S2-06 — SQL interpolation fix (smallest change, highest certainty)
2. H-S2-03 — Remove client-supplied `executedBy` (contained, no new dependencies)
3. H-S2-08 — UUID pipe on schema controller (cosmetic risk)
4. H-S2-01 — Remove dead `filter` field, add DTO-level `orderBy` constraint
5. H-S2-02 — Schema DROP audit + UUID pipe + confirmation gate
6. H-S2-07 — Wire AuditLogService into DatabaseManagementModule (depends on #5 being designed)
7. H-S2-04 — Wire AuditLogService into ImpersonationModule (depends on #6 being done)
8. H-S2-05 — MFA step-up (cross-domain, auth-security-expert dependency)

---

## Remediation Designs

### REC-H-S2-06: Parameterize timestamp INSERT in createDefaultTables

**File:** `apps/admin-api-service/src/database-management/services/schema-management.service.ts`

Replace lines 183–194:
```typescript
// BEFORE (string interpolation — unsafe pattern)
await queryRunner.query(`
  INSERT INTO "${schemaName}"."_metadata" (key, value)
  VALUES
    ('schema_version', '"1.0.0"'),
    ('created_at', '"${new Date().toISOString()}"'),
    ('last_migration', 'null')
  ON CONFLICT (key) DO NOTHING
`);

// AFTER (parameterized)
await queryRunner.query(
  `INSERT INTO "${schemaName}"."_metadata" (key, value)
   VALUES ($1, $2::jsonb), ($3, $4::jsonb), ($5, $6::jsonb)
   ON CONFLICT (key) DO NOTHING`,
  [
    'schema_version', '"1.0.0"',
    'created_at',     JSON.stringify(new Date().toISOString()),
    'last_migration',  'null',
  ],
);
```

Also add schema name validation at the top of `createDefaultTables`:
```typescript
private async createDefaultTables(schemaName: string): Promise<void> {
  if (!this.isValidSchemaName(schemaName)) {
    throw new BadRequestException('Invalid schema name');
  }
  // ... rest of method
```

---

### REC-H-S2-03: Remove client-supplied executedBy from migration DTOs

**File:** `apps/admin-api-service/src/database-management/controllers/migration.controller.ts`

1. Remove `executedBy` from `RunMigrationDto`, `BatchMigrationDto`, and `RollbackMigrationDto`.
2. Add `@Req() req: Request` to each handler.
3. Derive identity from token:

```typescript
// In each handler:
@Post('tenant/:tenantId/run')
@HttpCode(HttpStatus.OK)
async runMigration(
  @Param('tenantId', ParseUUIDPipe) tenantId: string,
  @Body() dto: RunMigrationDto,
  @Req() req: Request,
) {
  const executedBy = (req as { user?: { id?: string } }).user?.id;
  if (!executedBy) throw new UnauthorizedException('User not authenticated');
  return this.migrationService.runMigration(
    tenantId, dto.version, dto.isDryRun,
    executedBy,   // JWT-derived, not client-supplied
  );
}
```

Apply the same pattern to `rollbackMigration` and `runBatchMigration`.

---

### REC-H-S2-08: Add ParseUUIDPipe to SchemaController

**File:** `apps/admin-api-service/src/database-management/controllers/schema.controller.ts`

Add `ParseUUIDPipe` import and apply to all `:tenantId` params:
```typescript
import { ..., ParseUUIDPipe } from '@nestjs/common';

@Get(':tenantId')
async getSchema(@Param('tenantId', ParseUUIDPipe) tenantId: string) { ... }

@Get(':tenantId/info')
async getSchemaInfo(@Param('tenantId', ParseUUIDPipe) tenantId: string) { ... }

@Post(':tenantId/suspend')
async suspendSchema(@Param('tenantId', ParseUUIDPipe) tenantId: string) { ... }

@Post(':tenantId/activate')
async activateSchema(@Param('tenantId', ParseUUIDPipe) tenantId: string) { ... }

@Delete(':tenantId')
async deleteSchema(@Param('tenantId', ParseUUIDPipe) tenantId: string, ...) { ... }

@Get(':tenantId/validate')
async validateSchemaIsolation(@Param('tenantId', ParseUUIDPipe) tenantId: string) { ... }

@Post(':tenantId/refresh-stats')
async refreshSchemaStats(@Param('tenantId', ParseUUIDPipe) tenantId: string) { ... }
```

---

### REC-H-S2-01: Harden TableQueryDto

**File:** `apps/admin-api-service/src/database-management/controllers/explorer.controller.ts`

```typescript
import { IsOptional, IsNumber, IsString, IsIn, IsObject, Matches, MaxLength } from 'class-validator';

class TableQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  limit?: number;

  @IsOptional()
  @IsString()
  @Matches(/^[a-z_][a-z0-9_]*$/i, { message: 'orderBy must be a valid SQL identifier' })
  @MaxLength(63)
  orderBy?: string;

  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  orderDirection?: 'ASC' | 'DESC';

  // REMOVED: filter field — no safe server-side filter implementation exists.
  // Add back only when a parameterized WHERE clause builder is implemented.
}
```

---

### REC-H-S2-02: Schema DROP Protection

**File:** `apps/admin-api-service/src/database-management/services/schema-management.service.ts`
**File:** `apps/admin-api-service/src/database-management/controllers/schema.controller.ts`

**Service changes:**
```typescript
// Inject AuditLogService
constructor(
  @InjectRepository(TenantSchema) private readonly schemaRepository: Repository<TenantSchema>,
  @InjectDataSource() private readonly dataSource: DataSource,
  @Optional() private readonly schemaManager?: SchemaManagerService,
  private readonly auditService?: AuditLogService,
) {}

async deleteSchema(
  tenantId: string,
  hardDelete = false,
  initiatedBy?: string,
  ipAddress?: string,
): Promise<void> {
  const schema = await this.getSchemaByTenantId(tenantId);

  if (hardDelete) {
    // Emit BEFORE the destructive operation so the record exists even if the process crashes
    await this.auditService?.log({
      action: 'SCHEMA_HARD_DELETED',
      entityType: 'TenantSchema',
      entityId: schema.id,
      tenantId,
      performedBy: initiatedBy ?? 'unknown',
      ipAddress,
      severity: AuditSeverity.CRITICAL,
      details: { schemaName: schema.schemaName, tableCount: schema.tableCount },
    });

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    try {
      await queryRunner.query(`DROP SCHEMA IF EXISTS "${schema.schemaName}" CASCADE`);
      await this.schemaRepository.delete({ id: schema.id });
    } finally {
      await queryRunner.release();
    }
  } else {
    schema.status = 'deleted';
    await this.schemaRepository.save(schema);
  }
}
```

**Controller changes:**
```typescript
@Delete(':tenantId')
@HttpCode(HttpStatus.NO_CONTENT)
async deleteSchema(
  @Param('tenantId', ParseUUIDPipe) tenantId: string,
  @Query('hardDelete') hardDelete?: string,
  @Req() req: Request,
) {
  const user = (req as { user?: { id?: string } }).user;
  if (!user?.id) throw new UnauthorizedException('User not authenticated');
  await this.schemaService.deleteSchema(
    tenantId,
    hardDelete === 'true',
    user.id,
    req.ip ?? req.socket?.remoteAddress,
  );
}
```

**Confirmation gate (enterprise pattern):**
Add a `POST /database/schemas/:tenantId/confirm-delete` endpoint that:
1. Receives a `confirmationToken` in the body.
2. Validates the token against a 10-minute HMAC-signed value stored when `DELETE` was first called with `hardDelete=true`.
3. Only then proceeds with the DROP.
This prevents accidental single-call destruction and creates a two-step irreversibility window.

---

### REC-H-S2-07: Wire AuditLogService into DatabaseManagementModule

**File:** `apps/admin-api-service/src/database-management/database-management.module.ts`

```typescript
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([...]),
    ScheduleModule,
    AuditModule,   // ADD THIS
  ],
  ...
})
export class DatabaseManagementModule {}
```

Then:
- Inject `AuditLogService` into `BackupRestoreService`
- Add `initiatedBy: string` to `createBackup()` and `restoreFromBackup()` signatures
- Emit `BACKUP_INITIATED`, `BACKUP_COMPLETED`, `BACKUP_FAILED`, `RESTORE_INITIATED`, `RESTORE_COMPLETED`, `RESTORE_FAILED` with CRITICAL severity
- Update `BackupController` and `RestoreController` to pass `req.user.id` to service calls

---

### REC-H-S2-04: Wire AuditLogService into ImpersonationModule

**File:** `apps/admin-api-service/src/impersonation/impersonation.module.ts`

```typescript
import { AuditModule } from '../../audit/audit.module';

@Module({
  imports: [
    ScheduleModule,
    TypeOrmModule.forFeature([ImpersonationSession, ImpersonationPermission]),
    AuditModule,   // ADD THIS
  ],
  ...
})
```

In `ImpersonationService`:
```typescript
constructor(
  @InjectRepository(ImpersonationSession) private readonly sessionRepo: Repository<ImpersonationSession>,
  @InjectRepository(ImpersonationPermission) private readonly permissionRepo: Repository<ImpersonationPermission>,
  private readonly auditService: AuditLogService,  // ADD
) { ... }

async startImpersonation(request: StartImpersonationRequest): Promise<ImpersonationSession> {
  // ... existing logic ...
  const saved = await this.sessionRepo.save(session);
  this.activeSessions.set(saved.id, saved);

  // AUDIT — emit after save so sessionId is available
  await this.auditService.log({
    action: 'IMPERSONATION_STARTED',
    entityType: 'ImpersonationSession',
    entityId: saved.id,
    tenantId: request.targetTenantId,
    performedBy: request.superAdminId,
    performedByEmail: request.superAdminEmail,
    ipAddress: request.ipAddress,
    userAgent: request.userAgent,
    severity: AuditSeverity.WARNING,
    sessionId: saved.id,
    details: {
      targetUserId: request.targetUserId,
      reason: request.reason,
      ticketReference: request.ticketReference,
      expiresAt: saved.expiresAt,
      permissions: saved.permissions,
    },
  });
  // ...
}
```

Apply equivalent calls in `endImpersonation()`, `terminateSession()`, and `expireSession()` with actions `IMPERSONATION_ENDED`, `IMPERSONATION_TERMINATED`, `IMPERSONATION_EXPIRED` respectively.

---

### REC-H-S2-05: MFA Step-Up for Impersonation Start

**Cross-domain:** Requires auth-security-expert to implement the step-up issuance side.

**Admin-api-service side (interface contract):**

Create `apps/admin-api-service/src/guards/mfa-step-up.guard.ts`:
```typescript
@Injectable()
export class MfaStepUpGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const stepUpToken = request.headers['x-step-up-token'] as string;

    if (!stepUpToken) {
      throw new ForbiddenException('MFA step-up token required for this operation');
    }

    // Verify the step-up token (HMAC-SHA256 signed by auth-service with shared secret)
    const stepUpSecret = this.configService.getOrThrow<string>('STEP_UP_SECRET');
    const [payload, sig] = stepUpToken.split('.');
    const expectedSig = crypto.createHmac('sha256', stepUpSecret).update(payload).digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expectedSig, 'hex'))) {
      throw new ForbiddenException('Invalid or expired MFA step-up token');
    }

    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());

    // Validate: not expired, scoped to impersonation, matches authenticated user
    const now = Date.now();
    if (decoded.exp < now) throw new ForbiddenException('Step-up token expired');
    if (decoded.action !== 'impersonation_start') throw new ForbiddenException('Step-up token not scoped for impersonation');
    if (decoded.sub !== request.user?.id) throw new ForbiddenException('Step-up token subject mismatch');
    if (decoded.used) throw new ForbiddenException('Step-up token already used');

    // Mark as used (requires token store — Redis preferred)
    // ... mark decoded.jti as used in token store ...

    return true;
  }
}
```

Apply to impersonation start:
```typescript
@ThrottleSensitive()
@UseGuards(MfaStepUpGuard)   // ADD BEFORE PlatformAdminGuard or as additional guard
@Post('sessions/start')
async startImpersonation(...) { ... }
```

**auth-security-expert must implement:** `POST /auth/step-up` that verifies current MFA credential and issues a single-use step-up JWT with `action: 'impersonation_start'`, `jti`, `exp: +5 minutes`, signed with `STEP_UP_SECRET`.

---

## Test Coverage Requirements

For each finding, the following test scenarios must pass before marking as remediated:

| Finding | Required Tests |
|---------|---------------|
| H-S2-01 | `filter` field rejected at DTO level; `orderBy` with SQL injection chars returns 400 |
| H-S2-02 | `DELETE /database/schemas/:id?hardDelete=true` creates SCHEMA_HARD_DELETED audit entry; non-UUID tenantId returns 400 |
| H-S2-03 | `executedBy` field in body is ignored; migration record always shows JWT sub as executor |
| H-S2-04 | `startImpersonation` produces audit log entry with IMPERSONATION_STARTED; `getSecurityLogs()` returns impersonation events |
| H-S2-05 | `POST sessions/start` without `x-step-up-token` returns 403; expired step-up token returns 403; used step-up token returns 403 |
| H-S2-06 | `createDefaultTables` with a schema name containing injection chars throws before executing SQL |
| H-S2-07 | backup creation emits BACKUP_INITIATED audit; restore emits RESTORE_INITIATED audit |
| H-S2-08 | `GET /database/schemas/not-a-uuid` returns 400 with UUID validation error |
