# Agent 9: Observability Architect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove tenantId from error responses, add tenant dimension to metrics, replace placeholder stats with real calculations.

**Tech Stack:** NestJS, Prometheus, TypeORM, PostgreSQL

**Owned files:** `libs/backend-common/src/filters/`, `libs/backend-common/src/metrics/`, auth-service stats resolvers

---

### Task 1: Remove tenantId from Exception Filter Responses

- [ ] **Step 1: Read http-exception.filter.ts in backend-common**
Read: `libs/backend-common/src/filters/http-exception.filter.ts`

- [ ] **Step 2: Remove tenantId from all error response objects**
Find all occurrences of `tenantId` in the response body construction and remove them. The tenantId should still be logged server-side but never sent to the client.

```typescript
// BEFORE:
const responseBody = {
  statusCode,
  timestamp,
  path,
  message,
  correlationId,
  tenantId: request.headers['x-tenant-id'], // INFORMATION DISCLOSURE
};

// AFTER:
const responseBody = {
  statusCode,
  timestamp,
  path,
  message,
  correlationId,
  // tenantId removed — logged server-side only
};
```

- [ ] **Step 3: Apply same fix to gateway exception filters**
Read and fix: `apps/gateway-api/src/filters/global-exception.filter.ts`
Read and fix: `apps/gateway-api/src/filters/http-exception.filter.ts`

- [ ] **Step 4: Commit**
```bash
git commit -m "fix(filters): remove tenantId from error responses — prevent information disclosure"
```

### Task 2: Add Tenant Dimension to Prometheus Metrics

- [ ] **Step 1: Read metrics middleware**
Read: `libs/backend-common/src/metrics/metrics.middleware.ts`

- [ ] **Step 2: Add tenantId label to request metrics**
```typescript
// Add tenantId as a label (use 'system' for non-tenant requests):
const tenantLabel = req.tenantId || 'system';
this.httpRequestDuration.labels(method, route, statusCode, tenantLabel).observe(duration);
```

Note: Be careful with label cardinality — use tenant ID directly only if tenant count is bounded (<1000). Otherwise use a tenant tier/plan label.

- [ ] **Step 3: Commit**

### Task 3: Replace Placeholder Stats

- [ ] **Step 1: Read getTenantStats in auth-service**
Find the method that returns `monthlyGrowthPercent: 15` and `activeSessions: activeUsers`.

- [ ] **Step 2: Replace with real calculations**
```typescript
// monthlyGrowthPercent: calculate from actual user count changes
const currentMonth = await this.userRepo.count({ where: { tenantId, createdAt: MoreThan(startOfMonth) }});
const previousMonth = await this.userRepo.count({ where: { tenantId, createdAt: Between(startOfPrevMonth, startOfMonth) }});
const monthlyGrowthPercent = previousMonth > 0 ? ((currentMonth - previousMonth) / previousMonth) * 100 : 0;

// activeSessions: count from refresh tokens or last login
const activeSessions = await this.refreshTokenRepo.count({
  where: { tenantId, isRevoked: false, expiresAt: MoreThan(new Date()) },
});
```

- [ ] **Step 3: Fix moduleUsageStats placeholder zeros**
Replace with real query against `auth.user_module_assignments`:
```typescript
const stats = await this.moduleAssignmentRepo
  .createQueryBuilder('uma')
  .select('uma.moduleId', 'moduleId')
  .addSelect('COUNT(uma.userId)', 'userCount')
  .where('uma.tenantId = :tenantId', { tenantId })
  .andWhere('uma.isActive = true')
  .groupBy('uma.moduleId')
  .getRawMany();
```

- [ ] **Step 4: Commit**

### Task 4: Discovery Pass
