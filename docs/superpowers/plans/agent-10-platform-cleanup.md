# Agent 10: Platform Cleanup Architect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix ScheduleModule quadruple forRoot across all services, normalize import path prefixes, mark stub implementations.

**Tech Stack:** NestJS, TypeScript

**Owned files:** All `apps/*/src/app.module.ts`

---

### Task 1: Fix ScheduleModule.forRoot() Duplication

- [ ] **Step 1: Audit all services for ScheduleModule usage**
```bash
grep -rn 'ScheduleModule' apps/*/src/ --include='*.ts' | grep -v node_modules
```

- [ ] **Step 2: For each service, ensure forRoot() is called ONLY ONCE in AppModule**

Pattern:
```typescript
// In app.module.ts:
import { ScheduleModule } from '@nestjs/schedule';

@Module({
  imports: [
    ScheduleModule.forRoot(), // ONLY HERE
    // ... other modules
  ],
})

// In sub-modules, use plain import (no forRoot):
@Module({
  imports: [
    // ScheduleModule, // NOT needed — it's global from forRoot()
  ],
})
```

Remove `ScheduleModule.forRoot()` from all sub-modules: SecurityModule, SystemManagementModule, ImpersonationModule, DatabaseManagementModule, and any others found.

- [ ] **Step 3: Commit per service (or batch if small changes)**
```bash
git commit -m "fix(platform): deduplicate ScheduleModule.forRoot() — single root per service"
```

### Task 2: Normalize Import Path Prefixes

- [ ] **Step 1: Audit all import path variants**
```bash
grep -rn '@platform/backend-common\|@aquaculture/backend-common' apps/ libs/ --include='*.ts' | head -30
```

- [ ] **Step 2: Standardize to `@aquaculture/backend-common`**

Check `tsconfig.base.json` to see which alias is canonical. Replace the non-canonical one everywhere.

- [ ] **Step 3: Commit**
```bash
git commit -m "fix(platform): normalize import paths — use @aquaculture/backend-common consistently"
```

### Task 3: Mark Stub Implementations

- [ ] **Step 1: Find stubs**
```bash
grep -rn 'setTimeout.*resolve.*200\|TODO.*implement\|placeholder\|stub' apps/admin-api-service/ --include='*.ts'
```

- [ ] **Step 2: Replace with NotImplementedException**
```typescript
// BEFORE:
private async backupTenantData(tenant: Tenant): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 200));
}

// AFTER:
private async backupTenantData(tenant: Tenant): Promise<void> {
  throw new NotImplementedException(
    'Tenant data backup not yet implemented. Track: BACKLOG-001',
  );
}
```

- [ ] **Step 3: Commit**

### Task 4: Discovery Pass
