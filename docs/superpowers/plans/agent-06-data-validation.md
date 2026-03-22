# Agent 6: Data Validation Architect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add class-validator DTOs to all unvalidated endpoints in admin-api-service. Note: `Object.assign` replacement, `tableData` fix, and bulk operation rate limits are in auth-service files (Agent 2's scope) — those tasks are delegated to Agent 2 or handled via coordination.

**Tech Stack:** NestJS, class-validator, class-transformer, TypeORM

**Owned files:** DTOs and controllers in `apps/admin-api-service/` ONLY. Auth-service files are owned by Agent 2.

**IMPORTANT — Scope correction (post-review):**
- `tableData` fix (HIGH-9) → lives in auth-service, delegate to Agent 2
- `bulkAssignUserRole` / `bulkUpdateMobileSettings` rate limits → auth-service resolvers, delegate to Agent 2
- `Object.assign` replacement → auth-service tenant.service.ts, already handled by Agent 2 Task 5

---

## File Map

| Action | Path | Purpose |
|--------|------|---------|
| Create | `apps/admin-api-service/src/tenant/dto/provision-tenant.dto.ts` | Validated provisioning input |
| Create | `apps/admin-api-service/src/tenant/dto/deactivate-tenant.dto.ts` | Validated deactivation reason |
| Create | `apps/admin-api-service/src/tenant/utils/tenant-field-mapper.ts` | Role-based field allowlist mapper |
| Create | `apps/admin-api-service/src/tenant/utils/tenant-field-mapper.spec.ts` | Tests |
| Modify | `apps/admin-api-service/src/tenant/tenant.controller.ts` | Wire new DTOs |
| Modify | `apps/admin-api-service/src/tenant/services/tenant-provisioning.service.ts` | Fix tableData schema enforcement |

---

### Task 1: Provision DTO

- [ ] **Step 1: Create validated DTO**
```typescript
// apps/admin-api-service/src/tenant/dto/provision-tenant.dto.ts
import { IsOptional, IsBoolean, IsEmail, IsArray, IsString, ArrayMaxSize } from 'class-validator';

export class ProvisionTenantDto {
  @IsOptional()
  @IsBoolean()
  createAdmin?: boolean;

  @IsOptional()
  @IsEmail()
  adminEmail?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20)
  modules?: string[];
}
```

- [ ] **Step 2: Wire in controller**
Replace `@Body() body: { createAdmin?... }` with `@Body() dto: ProvisionTenantDto`

- [ ] **Step 3: Commit**

### Task 2: Deactivate DTO

- [ ] **Step 1: Create validated DTO**
```typescript
// apps/admin-api-service/src/tenant/dto/deactivate-tenant.dto.ts
import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class DeactivateTenantDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}
```

- [ ] **Step 2: Wire in controller**
- [ ] **Step 3: Commit**

### Task 3: Role-Based Field Mapper

- [ ] **Step 1: Write failing test**
```typescript
// apps/admin-api-service/src/tenant/utils/tenant-field-mapper.spec.ts
import { TenantFieldMapper } from './tenant-field-mapper';

describe('TenantFieldMapper', () => {
  it('should allow all fields for SUPER_ADMIN', () => {
    const input = { name: 'New', status: 'SUSPENDED', maxUsers: 100 };
    const result = TenantFieldMapper.applyUpdate({} as any, input, 'SUPER_ADMIN');
    expect(result.name).toBe('New');
    expect(result.status).toBe('SUSPENDED');
    expect(result.maxUsers).toBe(100);
  });

  it('should restrict TENANT_ADMIN to allowlisted fields', () => {
    const input = { name: 'New', status: 'SUSPENDED', maxUsers: 100, description: 'Desc' };
    const result = TenantFieldMapper.applyUpdate({} as any, input, 'TENANT_ADMIN');
    expect(result.name).toBe('New');
    expect(result.description).toBe('Desc');
    expect(result.status).toBeUndefined();
    expect(result.maxUsers).toBeUndefined();
  });
});
```

- [ ] **Step 2: Implement field mapper**
```typescript
// apps/admin-api-service/src/tenant/utils/tenant-field-mapper.ts
const TENANT_ADMIN_ALLOWED_FIELDS = [
  'name', 'description', 'logoUrl', 'contactEmail',
  'contactPhone', 'address', 'settings',
];

export class TenantFieldMapper {
  static applyUpdate(tenant: any, input: Record<string, any>, role: string): any {
    const allowedFields = role === 'SUPER_ADMIN'
      ? Object.keys(input)
      : TENANT_ADMIN_ALLOWED_FIELDS;

    for (const key of allowedFields) {
      if (input[key] !== undefined) {
        tenant[key] = input[key];
      }
    }
    return tenant;
  }
}
```

- [ ] **Step 3: Run test, commit**

### Task 4: Fix tableData Schema Bypass

- [ ] **Step 1: Read tableData implementation**
Read the method that serves `tableData` query — find where it falls through to unfiltered SELECT when no `tenant_id` column.

- [ ] **Step 2: Enforce tenant_id requirement**
```typescript
// Replace the fallthrough unfiltered query with:
if (!hasTenantId) {
  throw new ForbiddenException(
    `Table "${tableName}" does not have a tenantId column. ` +
    `Direct row access is not permitted for non-tenant-scoped tables. ` +
    `Schema-only information is available via tableSchema query.`,
  );
}
```

- [ ] **Step 3: Commit**

### Task 5: Bulk Operation Rate Limits

- [ ] **Step 1: Find bulk endpoints and add @Throttle + @ArrayMaxSize**

Add to relevant DTOs:
```typescript
@ArrayMaxSize(100, { message: 'Maximum 100 items per bulk operation' })
userIds: string[];
```

Add to endpoints:
```typescript
@Throttle({ default: { limit: 5, ttl: 60000 } })
```

- [ ] **Step 2: Commit**

### Task 6: Discovery Pass
- [ ] **Step 1: Grep for all `@Body()` without DTO type across admin-api-service**
- [ ] **Step 2: Fix any found, log discoveries**
