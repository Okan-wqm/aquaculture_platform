# Agent 3: Admin API Architect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate cross-schema writes, fix TenantStatus enum aliases, implement provisioning saga with rollback, redact invitation token from responses, remove status from public endpoint.

**Architecture:** Replace direct SQL writes to auth schema with NATS request-reply commands. Implement saga pattern with compensating transactions. Fix enum to have distinct database values.

**Tech Stack:** NestJS, TypeORM, NATS JetStream, PostgreSQL

**Owned files:** `apps/admin-api-service/src/tenant/`, new files in `libs/event-contracts/src/`

---

## File Map

| Action | Path | Purpose |
|--------|------|---------|
| Modify | `apps/admin-api-service/src/tenant/entities/tenant.entity.ts` | Fix TenantStatus enum aliases |
| Modify | `apps/admin-api-service/src/tenant/services/tenant-provisioning.service.ts` | Remove cross-schema writes, implement saga |
| Modify | `apps/admin-api-service/src/tenant/handlers/create-tenant.handler.ts` | Use saga pattern |
| Modify | `apps/admin-api-service/src/tenant/tenant.controller.ts` | Remove status from tenantBySlug, redact invitation token |
| Create | `libs/event-contracts/src/tenant-commands.ts` | New NATS command contracts |
| Create | `apps/admin-api-service/src/tenant/services/provisioning-saga.service.ts` | Saga orchestrator |
| Create | `apps/admin-api-service/src/tenant/services/provisioning-saga.service.spec.ts` | Tests |

---

### Task 1: Fix TenantStatus Enum Aliases

**Files:**
- Modify: `apps/admin-api-service/src/tenant/entities/tenant.entity.ts`

- [ ] **Step 1: Read current entity**

Read: `apps/admin-api-service/src/tenant/entities/tenant.entity.ts:1-50`

- [ ] **Step 2: Fix enum — remove aliases, add distinct values**

```typescript
// BEFORE:
export enum TenantStatus {
  ACTIVE = 'ACTIVE',
  PENDING = 'PENDING',
  SUSPENDED = 'SUSPENDED',
  CANCELLED = 'CANCELLED',
  DEACTIVATED = 'CANCELLED',  // alias!
  ARCHIVED = 'CANCELLED',     // alias!
  TRIAL = 'TRIAL',
  EXPIRED = 'EXPIRED',
}

// AFTER:
export enum TenantStatus {
  ACTIVE = 'ACTIVE',
  PENDING = 'PENDING',
  SUSPENDED = 'SUSPENDED',
  CANCELLED = 'CANCELLED',
  DEACTIVATED = 'DEACTIVATED',  // distinct value
  ARCHIVED = 'ARCHIVED',        // distinct value
  TRIAL = 'TRIAL',
  EXPIRED = 'EXPIRED',
}
```

- [ ] **Step 3: Search for any code relying on the alias behavior**

Search for `TenantStatus.DEACTIVATED` and `TenantStatus.ARCHIVED` usage across admin-api-service. Update any comparisons that assumed these equal `CANCELLED`.

- [ ] **Step 4: Commit**

```bash
git add apps/admin-api-service/src/tenant/entities/tenant.entity.ts
git commit -m "fix(admin-api): remove TenantStatus enum aliases — DEACTIVATED and ARCHIVED are now distinct values"
```

---

### Task 2: Create NATS Command Contracts

**Files:**
- Create: `libs/event-contracts/src/tenant-commands.ts`

- [ ] **Step 1: Write command contracts**

```typescript
// libs/event-contracts/src/tenant-commands.ts
import { BaseEvent } from './base-event';

/**
 * Command sent from admin-api to auth-service to create a user
 * in the auth schema. Auth-service owns its schema — admin-api
 * must not write to it directly.
 */
export interface CreateTenantAdminCommand {
  type: 'tenant.command.create-admin';
  tenantId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: string;
  sendInvitation: boolean;
}

export interface CreateTenantAdminResult {
  success: boolean;
  userId?: string;
  error?: string;
}

/**
 * Command to create role tables and seed default roles
 * in the tenant schema. Auth-service handles DDL.
 */
export interface SetupTenantRolesCommand {
  type: 'tenant.command.setup-roles';
  tenantId: string;
  schemaName: string;
}

export interface SetupTenantRolesResult {
  success: boolean;
  rolesCreated: number;
  error?: string;
}

/**
 * Command to assign modules to a tenant.
 */
export interface AssignTenantModulesCommand {
  type: 'tenant.command.assign-modules';
  tenantId: string;
  modules: Array<{ code: string; configuration?: Record<string, any> }>;
}

export interface AssignTenantModulesResult {
  success: boolean;
  modulesAssigned: number;
  error?: string;
}

/**
 * Compensating command — rollback a partially provisioned tenant.
 */
export interface RollbackTenantProvisioningCommand {
  type: 'tenant.command.rollback-provisioning';
  tenantId: string;
  completedSteps: string[];
}
```

- [ ] **Step 2: Export from barrel**

Add to `libs/event-contracts/src/index.ts`:
```typescript
export * from './tenant-commands';
```

- [ ] **Step 3: Commit**

```bash
git add libs/event-contracts/src/tenant-commands.ts libs/event-contracts/src/index.ts
git commit -m "feat(event-contracts): add NATS tenant provisioning command contracts"
```

---

### Task 3: Provisioning Saga with Compensating Transactions

**Files:**
- Create: `apps/admin-api-service/src/tenant/services/provisioning-saga.service.ts`
- Create: `apps/admin-api-service/src/tenant/services/provisioning-saga.service.spec.ts`

- [ ] **Step 1: Write failing test for saga**

```typescript
// apps/admin-api-service/src/tenant/services/provisioning-saga.service.spec.ts
import { ProvisioningSagaService, SagaStep } from './provisioning-saga.service';

describe('ProvisioningSagaService', () => {
  let saga: ProvisioningSagaService;

  beforeEach(() => {
    saga = new ProvisioningSagaService();
  });

  it('should execute all steps in order', async () => {
    const order: string[] = [];
    saga.addStep({
      name: 'create-schema',
      execute: async () => { order.push('exec-1'); },
      compensate: async () => { order.push('comp-1'); },
    });
    saga.addStep({
      name: 'create-roles',
      execute: async () => { order.push('exec-2'); },
      compensate: async () => { order.push('comp-2'); },
    });

    const result = await saga.run();
    expect(result.success).toBe(true);
    expect(order).toEqual(['exec-1', 'exec-2']);
  });

  it('should compensate in reverse order on failure', async () => {
    const order: string[] = [];
    saga.addStep({
      name: 'create-schema',
      execute: async () => { order.push('exec-1'); },
      compensate: async () => { order.push('comp-1'); },
    });
    saga.addStep({
      name: 'create-roles',
      execute: async () => { throw new Error('roles failed'); },
      compensate: async () => { order.push('comp-2'); },
    });

    const result = await saga.run();
    expect(result.success).toBe(false);
    expect(result.failedStep).toBe('create-roles');
    // Only step 1 was completed, so only step 1 gets compensated
    expect(order).toEqual(['exec-1', 'comp-1']);
  });

  it('should report compensation failures without throwing', async () => {
    saga.addStep({
      name: 'create-schema',
      execute: async () => {},
      compensate: async () => { throw new Error('cleanup failed'); },
    });
    saga.addStep({
      name: 'create-roles',
      execute: async () => { throw new Error('failed'); },
      compensate: async () => {},
    });

    const result = await saga.run();
    expect(result.success).toBe(false);
    expect(result.compensationErrors).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest apps/admin-api-service/src/tenant/services/provisioning-saga.service.spec.ts --no-coverage`
Expected: FAIL

- [ ] **Step 3: Implement ProvisioningSagaService**

```typescript
// apps/admin-api-service/src/tenant/services/provisioning-saga.service.ts
import { Logger } from '@nestjs/common';

export interface SagaStep {
  name: string;
  execute: () => Promise<void>;
  compensate: () => Promise<void>;
}

export interface SagaResult {
  success: boolean;
  completedSteps: string[];
  failedStep?: string;
  error?: Error;
  compensationErrors: Array<{ step: string; error: Error }>;
}

export class ProvisioningSagaService {
  private readonly logger = new Logger(ProvisioningSagaService.name);
  private steps: SagaStep[] = [];

  addStep(step: SagaStep): void {
    this.steps.push(step);
  }

  async run(): Promise<SagaResult> {
    const completedSteps: string[] = [];
    const compensationErrors: Array<{ step: string; error: Error }> = [];

    for (const step of this.steps) {
      try {
        this.logger.log(`Saga executing step: ${step.name}`);
        await step.execute();
        completedSteps.push(step.name);
      } catch (error) {
        this.logger.error(`Saga step "${step.name}" failed: ${error.message}`);

        // Compensate in reverse order
        for (const completedStep of [...completedSteps].reverse()) {
          const stepDef = this.steps.find(s => s.name === completedStep);
          if (stepDef) {
            try {
              this.logger.log(`Saga compensating step: ${completedStep}`);
              await stepDef.compensate();
            } catch (compError) {
              this.logger.error(`Saga compensation failed for "${completedStep}": ${compError.message}`);
              compensationErrors.push({ step: completedStep, error: compError });
            }
          }
        }

        return {
          success: false,
          completedSteps,
          failedStep: step.name,
          error,
          compensationErrors,
        };
      }
    }

    return { success: true, completedSteps, compensationErrors: [] };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest apps/admin-api-service/src/tenant/services/provisioning-saga.service.spec.ts --no-coverage`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/admin-api-service/src/tenant/services/provisioning-saga.service.ts \
        apps/admin-api-service/src/tenant/services/provisioning-saga.service.spec.ts
git commit -m "feat(admin-api): add ProvisioningSagaService with compensating transactions"
```

---

### Task 4: Refactor Provisioning to Use Saga + NATS Commands

**Files:**
- Modify: `apps/admin-api-service/src/tenant/services/tenant-provisioning.service.ts`
- Modify: `apps/admin-api-service/src/tenant/handlers/create-tenant.handler.ts`

- [ ] **Step 1: Read current provisioning flow**

Read: `apps/admin-api-service/src/tenant/services/tenant-provisioning.service.ts:1-100`
Read: `apps/admin-api-service/src/tenant/services/tenant-provisioning.service.ts:280-500`
Read: `apps/admin-api-service/src/tenant/handlers/create-tenant.handler.ts`

- [ ] **Step 2: Replace direct auth-schema writes with NATS commands in provisioning service**

Replace all `INSERT INTO auth.*` raw SQL with NATS request-reply calls:

```typescript
// Replace direct writes like:
// await this.dataSource.query('INSERT INTO auth.users ...', [...])
// With:
// const result = await this.natsClient.request('tenant.command.create-admin', command);

// Wrap the full provisioning flow in a saga:
async provisionTenant(tenant: Tenant, options: ProvisioningOptions): Promise<ProvisioningResult> {
  const saga = new ProvisioningSagaService();

  saga.addStep({
    name: 'create-schema',
    execute: async () => {
      await this.schemaManager.createTenantSchema(tenant.id, options.modules);
    },
    compensate: async () => {
      await this.schemaManager.dropTenantSchema(tenant.id);
    },
  });

  saga.addStep({
    name: 'setup-roles',
    execute: async () => {
      // NATS command instead of direct DDL
      await this.natsClient.request('tenant.command.setup-roles', {
        tenantId: tenant.id,
        schemaName: this.getTenantSchemaName(tenant.id),
      });
    },
    compensate: async () => {
      // Roles are in the schema that was already dropped in step 1 compensation
    },
  });

  if (options.createAdmin && options.adminEmail) {
    saga.addStep({
      name: 'create-admin',
      execute: async () => {
        // NATS command instead of direct INSERT INTO auth.users
        const result = await this.natsClient.request('tenant.command.create-admin', {
          tenantId: tenant.id,
          email: options.adminEmail,
          role: 'TENANT_ADMIN',
          sendInvitation: true,
        });
        this.provisioningResult.adminUserId = result.userId;
      },
      compensate: async () => {
        // Deactivate the admin user via NATS
        if (this.provisioningResult.adminUserId) {
          await this.natsClient.request('tenant.command.rollback-provisioning', {
            tenantId: tenant.id,
            completedSteps: ['create-admin'],
          });
        }
      },
    });
  }

  const sagaResult = await saga.run();

  if (!sagaResult.success) {
    // Reset tenant status back to PENDING
    await this.tenantRepository.update(tenant.id, { status: TenantStatus.PENDING });
    throw new Error(`Provisioning failed at step "${sagaResult.failedStep}": ${sagaResult.error?.message}`);
  }

  return this.provisioningResult;
}
```

- [ ] **Step 3: Redact invitation token from ProvisioningResult**

Find the `ProvisioningResult` type/interface and remove `invitationToken` field:

```typescript
// BEFORE:
interface ProvisioningResult {
  adminUser?: { id: string; email: string; invitationToken: string };
}

// AFTER:
interface ProvisioningResult {
  adminUser?: { id: string; email: string; invitationSent: boolean };
  // Token travels only via email, never in API response
}
```

- [ ] **Step 4: Remove status from tenantBySlug response**

In `tenant.controller.ts`, find the `tenantBySlug` endpoint and strip `status` from response:

```typescript
@Get('slug/:slug')
@Public()
async getBySlug(@Param('slug') slug: string) {
  const tenant = await this.tenantService.findBySlug(slug);
  // Return minimal public info — no status field
  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    logoUrl: tenant.logoUrl,
  };
}
```

- [ ] **Step 5: Commit**

```bash
git add apps/admin-api-service/src/tenant/services/tenant-provisioning.service.ts \
        apps/admin-api-service/src/tenant/handlers/create-tenant.handler.ts \
        apps/admin-api-service/src/tenant/tenant.controller.ts
git commit -m "refactor(admin-api): replace cross-schema writes with NATS commands + saga pattern"
```

---

### Task 5: Discovery Pass

- [ ] **Step 1: Scan all owned files for additional issues**
- [ ] **Step 2: Check for any remaining direct auth-schema writes (grep for 'auth\.' in SQL)**
- [ ] **Step 3: Log discoveries to DISCOVERY_LOG.md**
- [ ] **Step 4: Fix CRIT/HIGH within scope**
- [ ] **Step 5: Final commit**
