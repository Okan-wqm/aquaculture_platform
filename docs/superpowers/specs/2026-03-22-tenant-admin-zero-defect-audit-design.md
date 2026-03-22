# Tenant Admin Panel — Zero-Defect Architectural Audit & E2E Test Suite

**Date:** 2026-03-22
**Status:** Approved
**Scope:** Full-stack architectural audit + enterprise-grade fixes + comprehensive E2E tests
**Target:** Zero open defects across all severity levels

---

## 1. Problem Statement

The tenant admin panel spans 4 backend services (auth-service, admin-api-service, gateway-api, backend-common), 1 frontend module (tenant-admin), and shared infrastructure. A comprehensive audit identified **35+ findings** across CRIT/HIGH/MED/LOW severity levels. These findings represent real architectural gaps — not code style issues — that must be resolved with proper architectural solutions, not patches.

## 2. Architecture: Zero-Defect Pipeline

### 2.1 Pipeline Phases

```
Phase 1: CRITICAL FIXES ──→ Verify ──→ Phase 2: HIGH FIXES ──→ Verify
    ↓                                       ↓
Phase 3: MED/LOW FIXES ──→ Verify ──→ Phase 4: E2E TEST SUITE
    ↓                                       ↓
Phase 5: ZERO-DEFECT GATE (conflict resolution + code review + final build)
```

### 2.2 Agent Roster (16 Agents)

#### Phase 1: Critical Security Fixes (Parallel, Isolated Worktrees)

**Agent 1: tenant-isolation-architect**
- Primary: Create `TenantRedisService` wrapper with automatic `tenant:{tenantId}:` key prefixing
- Primary: Add PostgreSQL Row-Level Security (RLS) policies on tenant-scoped tables
- Primary: Replace `getRepository()` escape hatch with `getScopedRepository()` that enforces tenant filtering
- Primary: Enforce tenant namespace in `@Cacheable` decorator via compile-time key pattern validation
- Discovery scope: All `libs/backend-common/src/` files touched during implementation

**Agent 2: auth-security-architect**
- Primary: Add `@TenantAdminOrHigher()` to all MobileSettingsResolver queries/mutations
- Primary: Add `@Roles()` guard to `myModules` query in TenantAdminResolver
- Primary: Unify dual user creation paths into single `UserLifecycleService`
- Primary: Add refresh token revocation to `deleteTenantUser`
- Primary: Fix `updateTenantSettings` redundancy — remove separate mutation, route through `updateTenant`
- Discovery scope: All `apps/auth-service/src/modules/tenant/` files

**Agent 3: admin-api-architect**
- Primary: Replace cross-schema direct SQL writes with NATS command pattern (`TenantProvisioningCommand` → auth-service handles its own schema)
- Primary: Fix `TenantStatus` enum — remove aliases, add proper `DEACTIVATED` and `ARCHIVED` as distinct DB values
- Primary: Implement provisioning saga pattern with compensating transactions (rollback on partial failure)
- Primary: Add `ensureTenantRolesTableExists()` as proper TypeORM migration, remove runtime DDL
- Discovery scope: All `apps/admin-api-service/src/tenant/` files

**Agent 4: gateway-security-architect**
- Primary: AI proxy — header allowlist, path validation regex, circuit breaker pattern, request timeout
- Primary: CSRF protection — double-submit cookie pattern for cookie-based auth flows
- Primary: Remove notification subgraph from federation config (or add GraphQL endpoint to notification-service)
- Primary: Add hydroponics + config to health check service list
- Primary: Promote `INTERNAL_SERVICE_SECRET` to hard-fail in production
- Primary: Fix GraphQL mutation rate limiting (per-operation-type, not per-URL)
- Discovery scope: All `apps/gateway-api/src/` files

#### Phase 2: High-Priority Fixes (Parallel, Isolated Worktrees)

**Agent 5: event-consistency-architect**
- Primary: Publish `TenantSuspendedEvent` from `suspend()` method
- Primary: Publish `TenantActivatedEvent` from `activate()` method
- Primary: Publish `TenantStatusChangedEvent` as umbrella event for all status transitions
- Primary: Publish `TenantModulesAssignedEvent` from `assignModules()`
- Primary: Add `TenantUpdatedEvent` to `updateTenantSettings()`
- Primary: Ensure every event contract in `libs/event-contracts` has a matching publisher
- Discovery scope: All event-related code across auth-service and admin-api-service

**Agent 6: data-validation-architect**
- Primary: Create class-validator DTOs for `POST /tenants/:id/provision` body
- Primary: Create validated DTO for `PATCH /tenants/:id/deactivate` reason field
- Primary: Replace `Object.assign(tenant, input)` with explicit field mapper in `TenantService.update()`
- Primary: Fix `tableData` schema access — enforce `tenant_id` column requirement, reject tables without it
- Primary: Add `@Body()` validation to all unvalidated endpoint parameters across admin-api-service
- Primary: Fix bulk operation rate limiting (bulkAssignUserRole, bulkUpdateMobileSettings)
- Discovery scope: All DTOs and controllers in admin-api-service

**Agent 7: frontend-api-architect**
- Primary: Merge `tenantApi.ts` + `tenant-api.service.ts` into single `TenantApiClient` class
- Primary: Move ALL inline GraphQL queries to centralized `graphql/` directory with operation-based file organization
- Primary: Deduplicate `TENANT_USERS_QUERY` (3 variants) into single parameterized query
- Primary: Normalize import paths (`@platform/shared-ui` vs `@aquaculture/shared-ui` → single alias)
- Primary: Fix incomplete barrel exports in `pages/index.ts`
- Discovery scope: All `web/modules/tenant-admin/src/services/` and query definitions

#### Phase 3: Medium/Low Fixes (Parallel, Isolated Worktrees)

**Agent 8: frontend-resilience-architect**
- Primary: Wrap every route in `Module.tsx` with `PageErrorBoundary`
- Primary: Implement server-side pagination for `TenantUsers` (use existing backend `limit`/`offset` params)
- Primary: Refactor `useDevicePolling` to use TanStack Query `refetchInterval`
- Primary: Remove dead standalone layout code (TenantAdminLayout, TenantAdminHeader, TenantAdminSidebar — ~800 lines)
- Primary: Extract shared `formatRelativeTime` utility (duplicated in 3+ components)
- Primary: Fix Dashboard mixed data fetching — all to TanStack Query
- Primary: Replace hard-coded `'tr-TR'` locale with dynamic user preference
- Discovery scope: All `web/modules/tenant-admin/src/pages/` and `hooks/`

**Agent 9: observability-architect**
- Primary: Remove `tenantId` from all exception filter error responses (information disclosure)
- Primary: Add tenant dimension to Prometheus metrics (per-tenant request counts, latency)
- Primary: Replace placeholder `getTenantStats()` hardcoded values with real calculations
- Primary: Replace placeholder `moduleUsageStats()` zeros with real analytics
- Primary: Remove `status` field from public `tenantBySlug` response
- Primary: Fix `ScheduleModule.forRoot()` quadruple import — single root, plain import in sub-modules
- Primary: Fix import path inconsistency (`@platform/backend-common` vs `@aquaculture/backend-common`)
- Discovery scope: All filter, metrics, and stats-related code across services

#### Phase 4: E2E Test Suite (Parallel, after Phase 1-3)

**Agent 10: e2e-infra-architect**
- Playwright configuration with multi-browser support
- Test database seeding strategy (isolated test tenant per suite)
- JWT token generation helper (create tokens for any role/tenant without auth-service)
- Tenant fixture factory (create/teardown test tenants with known state)
- GraphQL test client wrapper with auth header injection
- REST test client wrapper with tenant header injection
- CI pipeline integration (GitHub Actions workflow)
- Test data cleanup and isolation guarantees

**Agent 11: e2e-security-tests**
Test cases:
- Cross-tenant data access attempt (User A queries User B's tenant data)
- RBAC escalation (MODULE_USER attempts TENANT_ADMIN operations)
- Token revocation verification (deleted user's token rejected)
- Header spoofing (forged `x-tenant-id`, `x-user-payload`)
- IDOR bypass attempts (access resources by ID from wrong tenant)
- Redis cache isolation (tenant A cannot read tenant B's cached data)
- JWT without `jti` rejected in production mode
- Expired/blacklisted token rejection
- Rate limit enforcement (login brute-force blocked)
- GraphQL depth/complexity limit enforcement
- GraphQL alias brute-force protection
- CSRF protection verification

**Agent 12: e2e-workflow-tests**
Test flows:
- Login → Dashboard data loads correctly
- User CRUD: create user → verify in list → edit → deactivate → verify status
- Role CRUD: create role → assign permissions → assign to user → verify access → delete role
- Module assignment: assign manager → verify module access → remove manager
- Settings: update tenant name/logo/contact → verify persistence
- Audit log: perform actions → verify audit entries with correct metadata
- Billing: view subscription → verify plan details
- Activity: verify login activity tracking
- Messages: create thread → send message → verify receipt
- Support: create ticket → add comment → rate satisfaction
- Database explorer: list tables → view schema → query data (within tenant)

**Agent 13: e2e-integration-tests**
Test chains:
- Frontend GraphQL mutation → Gateway → Auth Service → DB → verify in DB
- NATS event propagation: create tenant → verify TenantCreatedEvent consumed by all listeners
- Schema provisioning E2E: create tenant → verify schema exists → verify tables match MODULE_SCHEMAS
- Token lifecycle: login → access → refresh → logout → verify blacklisted
- Tenant suspension cascade: suspend tenant → verify all APIs reject requests
- Module assignment → frontend module visibility update
- Role permission change → next request reflects new permissions (after token refresh)

#### Phase 5: Zero-Defect Gate (Sequential)

**Agent 14: cross-agent-conflict-resolver**
- Merge all agent worktree branches
- Resolve any file conflicts (prioritize by severity: CRIT > HIGH > MED > LOW)
- Verify import chain consistency across all modified files
- Ensure no circular dependencies introduced
- Validate that shared files (backend-common, event-contracts) are coherent

**Agent 15: enterprise-code-reviewer**
- SOLID principle compliance check on every modified file
- DRY violation scan
- Clean architecture boundary verification (no layer violations)
- Security review (no new vulnerabilities introduced)
- Performance review (no N+1 queries, no unbounded loops, no memory leaks)
- TypeScript strict mode compliance
- Error handling completeness (no swallowed errors, no untyped catches)

**Agent 16: final-verification-agent**
- `npx nx run-many --target=build --all` — all services build
- `npx nx run-many --target=lint --all` — no lint errors
- `npx nx run-many --target=test --all` — all unit tests pass
- Run E2E test suite against running services
- Verify every original finding in checklist format:
  - [ ] CRIT: Redis tenant namespace enforced
  - [ ] CRIT: MobileSettings tenant guard added
  - [ ] CRIT: Cross-schema writes eliminated
  - [ ] CRIT: AI proxy secured
  - [ ] CRIT: TenantStatus enum fixed
  - [ ] HIGH: Token revocation on user delete
  - [ ] HIGH: Provisioning saga with rollback
  - [ ] HIGH: All missing NATS events published
  - [ ] HIGH: CSRF protection added
  - [ ] ... (full checklist for all 35+ findings)
- Zero tolerance: ANY unchecked item blocks completion

### 2.3 Discovery Protocol

Every agent operates as an **architectural detective**:

```
While implementing primary fixes:
  1. Read surrounding code thoroughly (not just the target lines)
  2. If new issue found:
     a. Classify severity (CRIT/HIGH/MED/LOW)
     b. If CRIT/HIGH and within my scope → fix immediately, add to my deliverables
     c. If CRIT/HIGH and outside my scope → report to orchestrator for dispatch
     d. If MED/LOW and within my scope → fix, log to DISCOVERY_LOG.md
     e. If MED/LOW and outside my scope → log to DISCOVERY_LOG.md for Phase 5
  3. All discoveries must include:
     - File path and line numbers
     - Problem description
     - Severity classification with justification
     - Architectural solution (not a patch)
     - Impact if left unfixed
```

### 2.4 Verifier Protocol (Four-Eyes Principle)

After each Phase 1-3 agent completes:

```
Verifier agent receives:
  - Original finding description
  - Agent's claimed solution
  - Modified file list

Verifier checks:
  1. Does the fix actually address the root cause? (not just symptoms)
  2. Is the solution architectural? (not a band-aid)
  3. Are there new issues introduced?
  4. Does the code follow existing patterns?
  5. Is the fix tested? (unit test exists or E2E test planned)

Verifier returns:
  - APPROVED: Fix is correct and complete
  - REJECTED with specific feedback: Agent must revise
```

### 2.5 Agent Communication Contract

Each agent produces:
```
{
  "agent_name": "string",
  "phase": 1-5,
  "primary_fixes": [
    {
      "finding_id": "CRIT-1",
      "status": "FIXED" | "PARTIAL" | "BLOCKED",
      "files_modified": ["path1", "path2"],
      "solution_summary": "string",
      "tests_added": ["test_file:test_name"]
    }
  ],
  "discoveries": [
    {
      "severity": "CRIT|HIGH|MED|LOW",
      "description": "string",
      "file": "path:line",
      "solution": "string",
      "fixed_by_me": true | false
    }
  ],
  "verification_status": "PENDING" | "APPROVED" | "REJECTED"
}
```

## 3. Success Criteria

1. **Zero open findings** — every CRIT/HIGH/MED/LOW finding verified as fixed
2. **Zero new defects** — verifier + code reviewer confirm no regressions
3. **Full E2E coverage** — every finding has at least one E2E test proving the fix
4. **Build passes** — all services compile, lint clean, unit tests pass
5. **Enterprise-grade architecture** — SOLID, clean boundaries, proper patterns throughout
6. **Discovery complete** — all newly discovered issues during fixes are also resolved or documented

## 4. Technology Decisions

- **E2E Framework:** Playwright (browser tests) + custom GraphQL/REST test client (API tests)
- **Test DB:** Isolated test tenant schema, seeded per suite, torn down after
- **Auth in tests:** Direct JWT generation (bypass auth-service for speed)
- **Assertions:** Playwright assertions + direct DB queries for data verification
- **CI:** GitHub Actions with service containers (postgres, redis, nats)

## 5. Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Agent conflicts on shared files | Isolated worktrees + Phase 5 conflict resolver |
| Fix introduces new bug | Verifier protocol + code reviewer + E2E tests |
| Discovery overwhelms scope | Orchestrator triages — only CRIT/HIGH auto-fixed, MED/LOW logged |
| Build breaks after merge | Final verification agent runs full build before completion |
| Test flakiness | Deterministic seeding, explicit waits, no shared state between tests |
