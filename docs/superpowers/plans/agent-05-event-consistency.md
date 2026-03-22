# Agent 5: Event Consistency Architect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Publish all missing NATS events for tenant lifecycle transitions. Every event contract must have a matching publisher.

**Architecture:** Add event publishing to all tenant status transition methods. Depends on Agent 2 (updateTenantSettings removed — events go through updateTenant).

**Tech Stack:** NestJS, NATS JetStream, event-contracts library

**Owned files:** May MODIFY existing files in `libs/event-contracts/src/` (Agent 3 creates new files)

---

## File Map

| Action | Path | Purpose |
|--------|------|---------|
| Modify | `libs/event-contracts/src/tenant-events.ts` | Add missing event type definitions |
| Modify | `apps/auth-service/src/modules/tenant/services/tenant.service.ts` | Add event publishing to suspend/activate/cancel |
| Modify | `apps/auth-service/src/modules/tenant/resolvers/tenant.resolver.ts` | Ensure events published on all mutations |

---

### Task 1: Add Missing Event Contracts

- [ ] **Step 1: Read current tenant-events.ts**
Read: `libs/event-contracts/src/tenant-events.ts`

- [ ] **Step 2: Add missing event types**
Add `TenantSuspendedEvent`, `TenantActivatedEvent`, `TenantStatusChangedEvent`, `TenantModulesAssignedEvent` interfaces following existing patterns in the file.

- [ ] **Step 3: Commit**
```bash
git add libs/event-contracts/src/tenant-events.ts
git commit -m "feat(event-contracts): add TenantSuspended/Activated/StatusChanged/ModulesAssigned events"
```

### Task 2: Publish Events from Status Transitions

- [ ] **Step 1: Read tenant.service.ts — find suspend(), activate(), cancel() methods**
Read: `apps/auth-service/src/modules/tenant/services/tenant.service.ts`

- [ ] **Step 2: Add event publishing to each method**

For `suspend()`:
```typescript
await this.eventBus.publish(new TenantSuspendedEvent({ tenantId: tenant.id, reason, suspendedBy: currentUserId }));
await this.eventBus.publish(new TenantStatusChangedEvent({ tenantId: tenant.id, from: tenant.status, to: TenantStatus.SUSPENDED }));
```

For `activate()`:
```typescript
await this.eventBus.publish(new TenantActivatedEvent({ tenantId: tenant.id, activatedBy: currentUserId }));
await this.eventBus.publish(new TenantStatusChangedEvent({ tenantId: tenant.id, from: tenant.status, to: TenantStatus.ACTIVE }));
```

For `cancel()` and any other status transition — same pattern.

For `assignModules()`:
```typescript
await this.eventBus.publish(new TenantModulesAssignedEvent({ tenantId, modules: moduleIds }));
```

- [ ] **Step 3: Verify updateTenant now publishes TenantUpdatedEvent (done by Agent 2)**
Read the method to confirm Agent 2's changes are present.

- [ ] **Step 4: Audit all event contracts — list each and verify publisher exists**

```bash
# Search for all event types defined in contracts
grep -n 'export.*Event' libs/event-contracts/src/tenant-events.ts
# For each, verify a matching publish call exists
grep -rn 'TenantCreatedEvent\|TenantUpdatedEvent\|TenantSuspendedEvent\|TenantActivatedEvent' apps/auth-service/ apps/admin-api-service/
```

- [ ] **Step 5: Commit**
```bash
git add apps/auth-service/src/modules/tenant/services/tenant.service.ts
git commit -m "fix(auth): publish NATS events for all tenant status transitions"
```

### Task 3: Discovery Pass
- [ ] **Step 1: Scan for any event contract without publisher**
- [ ] **Step 2: Scan for any publish call without contract**
- [ ] **Step 3: Log discoveries and fix**
