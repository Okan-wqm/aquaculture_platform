# Tenant Admin Panel — Zero-Defect Architectural Audit & E2E Test Suite

**Date:** 2026-03-22
**Status:** Approved (Rev 2 — post spec review)
**Scope:** Full-stack architectural audit + enterprise-grade fixes + comprehensive E2E tests
**Target:** Zero open defects across all severity levels
**Revision:** Addresses 12 reviewer findings — agent scope refinements, dependency resolution, operational completeness

---

## 1. Problem Statement

The tenant admin panel spans 4 backend services (auth-service, admin-api-service, gateway-api, backend-common), 1 frontend module (tenant-admin), and shared infrastructure. A comprehensive audit identified **38+ findings** across CRIT/HIGH/MED/LOW severity levels. These findings represent real architectural gaps — not code style issues — that must be resolved with proper architectural solutions, not patches.

## 2. Architecture: Zero-Defect Pipeline

### 2.1 Pipeline Phases

```
Phase 1: CRITICAL FIXES (4 agents, parallel) ──→ Verify ──→ Gate
Phase 2: HIGH FIXES (3 agents, parallel) ──→ Verify ──→ Gate
Phase 3: MED/LOW FIXES (3 agents, parallel) ──→ Verify ──→ Gate
Phase 4: E2E TEST SUITE (4 agents, parallel, depends on Phase 1-3)
Phase 5: ZERO-DEFECT GATE (3 agents, sequential)
    └─→ If FAIL: rework loop (max 2 iterations, then escalate to human)
```

### 2.2 Agent Roster (18 Agents)

#### Phase 1: Critical Security Fixes (Parallel, Isolated Worktrees)

**Agent 1: tenant-isolation-architect**
- Primary: Create `TenantRedisService` wrapper with automatic `tenant:{tenantId}:` key prefixing derived from request context
- Primary: Add PostgreSQL Row-Level Security (RLS) policies on tenant-scoped tables — include performance baseline before/after
- Primary: Replace `getRepository()` escape hatch with `getScopedRepository()` that enforces tenant filtering
- Primary: Enforce tenant namespace in `@Cacheable` decorator via compile-time key pattern validation
- Primary: Harden subdomain-based tenant extraction — strict UUID validation, DNS wildcard documentation, configurable allowed domains
- Discovery scope: All `libs/backend-common/src/` files touched during implementation
- Shared file contract: Owns `libs/backend-common/src/redis/`, `libs/backend-common/src/database/`, `libs/backend-common/src/decorators/cacheable*`

**Agent 2: auth-security-architect**
- Primary: Add `@TenantAdminOrHigher()` to all MobileSettingsResolver queries/mutations
- Primary: Add `@Roles()` guard to `myModules` query in TenantAdminResolver
- Primary: Unify dual user creation paths into single `UserLifecycleService` — legacy `TenantAdminService.assignUserToModule()` must delegate to new service
- Primary: Add refresh token revocation to `deleteTenantUser` (call existing `revokeAllUserRefreshTokens`)
- Primary: Remove standalone `updateTenantSettings` mutation — route all updates through `updateTenant` with role-based field filtering
- **Dependency note:** Agent 5 must NOT add events to `updateTenantSettings` — instead add to the unified `updateTenant` path after Agent 2's refactor
- Discovery scope: All `apps/auth-service/src/modules/tenant/` files
- Shared file contract: Owns all files in `apps/auth-service/src/modules/tenant/`

**Agent 3: admin-api-architect**
- Primary: Replace cross-schema direct SQL writes with NATS request-reply pattern (`TenantProvisioningCommand` → auth-service creates users/roles in its own schema, returns result)
- Primary: Fix `TenantStatus` enum — remove aliases (`DEACTIVATED = 'CANCELLED'`, `ARCHIVED = 'CANCELLED'`), add `DEACTIVATED` and `ARCHIVED` as distinct database values with migration
- Primary: Implement provisioning saga pattern with compensating transactions (schema drop on partial failure)
- Primary: Replace runtime DDL (`ensureTenantRolesTableExists` → `CREATE TABLE IF NOT EXISTS`) with proper TypeORM migration
- Primary: Redact `invitationToken` from `ProvisioningResult` API response — token should only travel via email, never in HTTP response body
- Primary: Remove `status` field from public `tenantBySlug` response (move from Agent 9 — this endpoint is in tenant controller)
- Discovery scope: All `apps/admin-api-service/src/tenant/` files + `libs/event-contracts/` (new command contracts only)
- Shared file contract: Owns `apps/admin-api-service/src/tenant/`, may ADD to `libs/event-contracts/src/` (new files only, no modification of existing)

**Agent 4: gateway-security-architect**
- Primary: AI proxy — header allowlist (Authorization, Content-Type, Accept only), path validation regex (reject `..`, `//`), circuit breaker pattern (3 failures → open for 30s), 30s request timeout
- Primary: CSRF protection — double-submit cookie pattern for cookie-based auth flows (refresh token endpoint)
- Primary: Remove notification subgraph from federation config (notification-service is event-driven, has no GraphQL endpoint)
- Primary: Add hydroponics + config to health check service list
- Primary: Promote `INTERNAL_SERVICE_SECRET` to hard-fail in production (throw on startup, not just log error)
- Primary: Fix GraphQL mutation rate limiting — inspect operation type from parsed query AST, not URL path
- Primary: Strip `x-user-payload` header from external requests — only allow from internal services with valid `X-Service-Identity` HMAC. This prevents payload spoofing from untrusted clients
- Discovery scope: All `apps/gateway-api/src/` files
- Shared file contract: Owns all files in `apps/gateway-api/src/`

#### Phase 2: High-Priority Fixes (Parallel, Isolated Worktrees)

**DEPENDENCY GATE:** Phase 2 starts only after Phase 1 agents complete and pass verification. Agent 5 must read Agent 2's changes to `updateTenant` before adding events.

**Agent 5: event-consistency-architect**
- Primary: Publish `TenantSuspendedEvent` from `suspend()` method
- Primary: Publish `TenantActivatedEvent` from `activate()` method
- Primary: Publish `TenantStatusChangedEvent` as umbrella event for ALL status transitions (including cancel)
- Primary: Publish `TenantModulesAssignedEvent` from `assignModules()`
- Primary: Add `TenantUpdatedEvent` to the unified `updateTenant` path (NOT `updateTenantSettings` — it will be removed by Agent 2)
- Primary: Audit every event contract in `libs/event-contracts/src/tenant-events.ts` — ensure each has at least one publisher
- Discovery scope: All event-related code across auth-service and admin-api-service
- Shared file contract: May MODIFY existing files in `libs/event-contracts/src/` (Agent 3 creates new files, Agent 5 modifies existing)

**Agent 6: data-validation-architect**
- Primary: Create class-validator DTO for `POST /tenants/:id/provision` body — `CreateProvisioningDto` with `@IsOptional()`, `@IsBoolean()`, `@IsEmail()`, `@IsArray()` decorators
- Primary: Create validated DTO for `PATCH /tenants/:id/deactivate` — `DeactivateTenantDto` with `@IsString()`, `@MaxLength(500)`, `@IsNotEmpty()` on reason
- Primary: Replace `Object.assign(tenant, input)` with explicit `TenantFieldMapper.applyUpdate(tenant, input, userRole)` that uses role-based allowlists
- Primary: Fix `tableData` schema access — enforce that EVERY queried table MUST have a `tenant_id` column. Tables without it (reference/lookup tables) return schema-only info, no row data
- Primary: Add class-validator DTOs to ALL unvalidated `@Body()` parameters across admin-api-service controllers
- Primary: Add `@Throttle()` decorator to `bulkAssignUserRole` and `bulkUpdateMobileSettings` endpoints — verify these endpoints exist first, create DTOs with `@ArrayMaxSize(100)` to limit batch size
- Discovery scope: All DTOs and controllers in admin-api-service

**Agent 7: frontend-api-architect**
- Primary: Merge `tenantApi.ts` (REST) + `tenant-api.service.ts` (GraphQL) into single `TenantApiClient` class with two internal transport methods
- Primary: Create `src/graphql/` directory — organize by domain: `tenant-queries.ts`, `user-queries.ts`, `role-queries.ts`, `module-queries.ts`, `device-queries.ts`, `billing-queries.ts`
- Primary: Deduplicate `TENANT_USERS_QUERY` (3 variants with different fields) into single parameterized query with fragment composition
- Primary: Normalize import paths — use only `@aquaculture/shared-ui` everywhere (remove `@platform/shared-ui` alias or redirect it)
- Primary: Fix incomplete barrel exports in `pages/index.ts` — export all 14 pages
- Discovery scope: All `web/modules/tenant-admin/src/services/` and all files containing GraphQL query strings

#### Phase 3: Medium/Low Fixes (Parallel, Isolated Worktrees)

**Agent 8: frontend-resilience-architect**
- Primary: Wrap every `<Route>` in `Module.tsx` with `<PageErrorBoundary>` (the component exists at `src/components/common/ErrorBoundary.tsx`)
- Primary: Implement server-side pagination for `TenantUsers` — wire existing backend `limit`/`offset` params, enable Previous/Next buttons
- Primary: Refactor `useDevicePolling` — replace `setInterval` + `useRef` with TanStack Query `refetchInterval` option
- Primary: Remove dead standalone layout code (`TenantAdminLayout.tsx` 476 lines, `TenantAdminHeader.tsx` 153 lines, `TenantAdminSidebar.tsx` 167 lines)
- Primary: Extract shared `formatRelativeTime` into `src/utils/date-utils.ts`, replace 3+ inline duplicates
- Primary: Fix Dashboard mixed data fetching — replace all manual `useState`/`useEffect`/`fetch` with TanStack Query hooks
- Primary: Replace hard-coded `'tr-TR'` locale with `Intl.DateTimeFormat().resolvedOptions().locale` or user preference from context
- Discovery scope: All `web/modules/tenant-admin/src/pages/` and `hooks/`

**Agent 9: observability-architect** (SCOPE REDUCED — reviewer finding)
- Primary: Remove `tenantId` from all exception filter error responses in `libs/backend-common/src/filters/` (3 filters)
- Primary: Add tenant dimension to Prometheus metrics middleware (per-tenant request counts, latency percentiles)
- Primary: Replace placeholder `getTenantStats()` hardcoded values (`monthlyGrowthPercent: 15`, `activeSessions: activeUsers`) with real calculations from DB
- Primary: Replace placeholder `moduleUsageStats()` all-zeros with real analytics from `auth.user_module_assignments`
- Discovery scope: `libs/backend-common/src/filters/`, `libs/backend-common/src/metrics/`, auth-service stats resolvers

**Agent 10: platform-cleanup-architect** (NEW — split from Agent 9 per reviewer)
- Primary: Fix `ScheduleModule.forRoot()` duplication — identify ALL instances across ALL services (not just admin-api), move to single `forRoot()` in each service's `AppModule`, use plain `ScheduleModule` import in sub-modules
- Primary: Normalize import path prefix — audit `@platform/backend-common` vs `@aquaculture/backend-common` across all backend services, standardize to single alias
- Primary: Fix `backupTenantData()` and `removeTenantResources()` stub implementations (either implement or throw `NotImplementedException` with ticket reference)
- Primary: Remove `L1: No API versioning` false pattern — either add `@Version('1')` to all controllers or remove URI versioning config
- Discovery scope: All `apps/*/src/app.module.ts` files, all import statements referencing backend-common

#### Phase 4: E2E Test Suite (Parallel, after Phase 1-3 verified)

**Agent 11: e2e-infra-architect**
- Playwright configuration with Chromium (primary) + Firefox (secondary)
- Test database seeding strategy — isolated test tenant per suite with deterministic UUID
- JWT token generation helper — create tokens for any role/tenant combo using same `JWT_SECRET`, no auth-service dependency
- Tenant fixture factory — `createTestTenant()` / `teardownTestTenant()` with known state
- GraphQL test client wrapper — auto-injects `Authorization` and `X-Tenant-Id` headers
- REST test client wrapper — same header injection for admin-api-service endpoints
- CI pipeline integration — GitHub Actions workflow with service containers (postgres:15, redis:7, nats:2.10)
- Test data cleanup guarantee — `afterAll` hooks that clean up even on test failure

**Agent 12: e2e-security-tests**
Test cases (each must PASS to prove the fix works):
- Cross-tenant data access: User A (tenant 1) queries `tenantUsers` with tenant 2's context → 403
- RBAC escalation: `MODULE_USER` calls `createTenantUser` mutation → 403
- RBAC escalation: `MODULE_USER` calls `getMobileUserSettings` for other user → 403 (verifies Agent 2 fix)
- Token revocation: delete user → immediately use their access token → 401
- Header spoofing: send `x-user-payload` with forged admin role from external request → rejected (verifies Agent 4 fix)
- Header spoofing: send `x-tenant-id` mismatching JWT `tenantId` → JWT wins, warning logged
- IDOR bypass: access resource by UUID belonging to other tenant → 403
- Redis cache isolation: set cache as tenant A → attempt read as tenant B → miss (verifies Agent 1 fix)
- JWT without `jti` → rejected in production mode
- Expired/blacklisted token → 401
- Rate limit: 6 login attempts in 15 min → 429 on 6th
- GraphQL depth 11 → rejected
- GraphQL complexity >1000 → rejected
- GraphQL alias: 2x `login` mutation in one request → rejected
- CSRF: POST to refresh endpoint without CSRF cookie → 403 (verifies Agent 4 fix)
- Subdomain spoofing: request with invalid subdomain UUID format → rejected (verifies Agent 1 fix)

**Agent 13: e2e-workflow-tests**
Test flows (happy path + key error paths):
- Login → Dashboard → verify stats are real numbers (not hardcoded 15%)
- User CRUD: create → list → edit name → deactivate → verify `isActive=false` in DB → attempt login with deactivated user → 401
- Role CRUD: create "CustomRole" → assign permissions → assign to user → verify user sees permitted resources → update permissions → verify change after re-login → delete role (must reassign users first)
- Module assignment: assign manager → verify `myModules` returns module → remove manager → verify removed
- Settings: update tenant name/logo/contact → re-query `myTenant` → verify persistence
- Audit log: perform 3 actions → query audit log → verify 3 entries with correct userId/action/timestamp
- Billing: query `tenantBilling` → verify plan name matches tenant's plan
- Activity: login → query `tenantActivity` → verify login event recorded
- Messages: create thread → send message → query thread → verify message
- Support: create ticket → add comment → query ticket → verify comment
- Database explorer: query `tenantDatabase` → verify tables list → query `tableSchema` for a known table → verify columns
- Edge devices: query `edgeDevices` → verify list (may be empty)

**Agent 14: e2e-integration-tests**
Cross-service chain tests:
- Full mutation chain: frontend sends `createTenantUser` → Gateway forwards → Auth Service processes → verify user in `auth.users` table → verify role assignment in tenant schema
- NATS event propagation: call `suspendTenant` → verify `TenantSuspendedEvent` was published (check via NATS monitoring or side-effect)
- Schema provisioning E2E: create test tenant via admin-api → verify PostgreSQL schema `tenant_{uuid_prefix}` exists → verify tables match `MODULE_SCHEMAS` for assigned modules
- Token lifecycle: login → get access + refresh → use access token → refresh → use new access → logout → verify old refresh token blacklisted
- Tenant suspension cascade: suspend tenant → call `myTenant` with that tenant's token → verify rejection
- Permission propagation: change user's role → user refreshes token → verify new `resourcePermissions` in JWT payload
- Provisioning rollback: trigger provisioning with invalid module → verify compensating transaction cleaned up partial state (verifies Agent 3 saga)

#### Phase 5: Zero-Defect Gate (Sequential)

**Agent 15: cross-agent-conflict-resolver**
- Merge all agent worktree branches in severity order (CRIT → HIGH → MED/LOW)
- Resolve file conflicts — CRIT agent's version wins on conflict
- Verify import chain consistency: no broken imports across ALL modified files
- Ensure no circular dependencies introduced (use `madge --circular`)
- Validate shared files coherence: `libs/backend-common/src/index.ts`, `libs/event-contracts/src/index.ts`
- Run `tsc --noEmit` on every affected project to verify type consistency

**Agent 16: enterprise-code-reviewer**
- SOLID principle compliance on every modified file
- SRP: no class/function doing two unrelated things
- OCP: new behavior via extension, not modification (where applicable)
- LSP: substitutability preserved in refactored interfaces
- ISP: no fat interfaces forced on consumers
- DIP: high-level modules not importing from low-level implementation details
- DRY violation scan across all changes
- Clean architecture boundary verification — no layer violations (resolver → service → repository, never resolver → repository)
- Security review — no new injection vectors, no credential exposure, no information disclosure
- Performance review — no N+1 queries, no unbounded collections, no missing indexes on new queries
- TypeScript strict mode — no `any` casts, no `!` non-null assertions without justification
- Error handling — no swallowed errors (`catch {}` empty), no untyped catches, proper error propagation

**Agent 17: final-verification-agent**
- `npx nx run-many --target=build --all` — all services compile
- `npx nx run-many --target=lint --all` — zero lint errors
- `npx nx run-many --target=test --all` — all unit tests pass
- Run E2E security test suite → all pass
- Run E2E workflow test suite → all pass
- Run E2E integration test suite → all pass
- **Master Checklist** (every item must be checked):
  - [ ] CRIT-1: Redis tenant namespace enforced (`TenantRedisService` wrapper active)
  - [ ] CRIT-2: MobileSettings tenant guard added (`@TenantAdminOrHigher()`)
  - [ ] CRIT-3: myModules role guard added
  - [ ] CRIT-4: Cross-schema writes eliminated (admin-api no longer writes to `auth.*`)
  - [ ] CRIT-5: AI proxy secured (header allowlist, path validation, circuit breaker)
  - [ ] CRIT-6: TenantStatus enum — `DEACTIVATED` and `ARCHIVED` are distinct DB values
  - [ ] CRIT-7: `getRepository()` replaced with `getScopedRepository()`
  - [ ] CRIT-8: RLS policies active on tenant-scoped tables
  - [ ] CRIT-9: Subdomain extraction hardened
  - [ ] CRIT-10: `x-user-payload` stripped from external requests
  - [ ] HIGH-1: Dual user creation unified into `UserLifecycleService`
  - [ ] HIGH-2: Token revocation on `deleteTenantUser`
  - [ ] HIGH-3: `updateTenantSettings` removed, unified through `updateTenant`
  - [ ] HIGH-4: Provisioning saga with compensating transactions
  - [ ] HIGH-5: All missing NATS events published (Suspended, Activated, StatusChanged, ModulesAssigned, Updated)
  - [ ] HIGH-6: CSRF protection on cookie-based auth
  - [ ] HIGH-7: `INTERNAL_SERVICE_SECRET` hard-fail in production
  - [ ] HIGH-8: Invitation token redacted from API response
  - [ ] HIGH-9: `tableData` enforces `tenant_id` column requirement
  - [ ] HIGH-10: Notification subgraph removed from federation
  - [ ] HIGH-11: Health checks cover all active subgraphs
  - [ ] HIGH-12: GraphQL mutation rate limiting by AST operation type
  - [ ] MED-1: All DTOs validated (provision, deactivate, all unvalidated @Body params)
  - [ ] MED-2: `Object.assign` replaced with role-based field mapper
  - [ ] MED-3: Bulk operations rate-limited and batch-size-capped
  - [ ] MED-4: Exception filters no longer leak `tenantId`
  - [ ] MED-5: Prometheus metrics include tenant dimension
  - [ ] MED-6: Placeholder stats replaced with real calculations
  - [ ] MED-7: `tenantBySlug` no longer exposes `status`
  - [ ] MED-8: Frontend dual API layer consolidated
  - [ ] MED-9: All GraphQL queries centralized
  - [ ] MED-10: ErrorBoundary wraps all routes
  - [ ] MED-11: Server-side pagination on TenantUsers
  - [ ] MED-12: Dead standalone layout code removed
  - [ ] MED-13: `useDevicePolling` uses `refetchInterval`
  - [ ] MED-14: `formatRelativeTime` deduplicated
  - [ ] MED-15: Dashboard uses TanStack Query exclusively
  - [ ] MED-16: Hard-coded locale replaced with dynamic
  - [ ] MED-17: `ScheduleModule.forRoot()` deduplicated across platform
  - [ ] MED-18: Import path prefix normalized
  - [ ] LOW-1: Barrel exports complete
  - [ ] LOW-2: Stub implementations marked or implemented
- Zero tolerance: ANY unchecked item blocks completion

**Agent 18: regression-sweep-agent** (NEW — handles rework loop)
- Triggered ONLY if Agent 17 reports failures
- Analyzes which finding(s) failed verification
- Traces failure to responsible agent
- Applies targeted fix (not re-running entire agent)
- Re-runs only the failed verification checks
- Maximum 2 rework iterations — if still failing after 2 rounds, escalates to human with:
  - Which findings remain open
  - What was attempted
  - Why it failed
  - Recommended manual action

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
  4. Orchestrator reviews DISCOVERY_LOG.md between phases:
     - CRIT discoveries → spawn new agent or assign to next-phase agent
     - HIGH discoveries → assign to appropriate Phase 2/3 agent
     - MED/LOW discoveries → Phase 5 conflict resolver handles
```

### 2.4 Verifier Protocol (Four-Eyes Principle)

After each Phase 1-3 agent completes:

```
Verifier agent receives:
  - Original finding description
  - Agent's claimed solution
  - Modified file list
  - Discovery log entries

Verifier checks:
  1. Does the fix actually address the root cause? (not just symptoms)
  2. Is the solution architectural? (not a band-aid)
  3. Are there new issues introduced?
  4. Does the code follow existing patterns in the codebase?
  5. Is the fix tested? (unit test exists or E2E test planned)
  6. Performance impact assessed? (especially for RLS, Redis wrapper)

Verifier returns:
  - APPROVED: Fix is correct and complete
  - APPROVED_WITH_NOTES: Fix is correct, minor suggestions for Phase 5
  - REJECTED with specific feedback: Agent must revise (max 1 revision cycle)
```

### 2.5 Shared File Ownership Protocol

To prevent merge conflicts between parallel agents:

| Shared File/Directory | Owner Agent | Others May |
|---|---|---|
| `libs/backend-common/src/redis/` | Agent 1 | Read only |
| `libs/backend-common/src/database/` | Agent 1 | Read only |
| `libs/backend-common/src/filters/` | Agent 9 | Read only |
| `libs/backend-common/src/metrics/` | Agent 9 | Read only |
| `libs/event-contracts/src/` (new files) | Agent 3 | Read only |
| `libs/event-contracts/src/` (existing files) | Agent 5 | Read only |
| `apps/auth-service/src/modules/tenant/` | Agent 2 | Read only |
| `apps/admin-api-service/src/tenant/` | Agent 3 | Read only |
| `apps/gateway-api/src/` | Agent 4 | Read only |
| `web/modules/tenant-admin/src/services/` | Agent 7 | Read only |
| `web/modules/tenant-admin/src/pages/` | Agent 8 | Read only |
| All `apps/*/src/app.module.ts` | Agent 10 | Read only |

### 2.6 Agent Communication Contract

Each agent produces:
```json
{
  "agent_name": "string",
  "phase": "1-5",
  "primary_fixes": [
    {
      "finding_id": "CRIT-1",
      "status": "FIXED | PARTIAL | BLOCKED",
      "files_modified": ["path1", "path2"],
      "solution_summary": "string",
      "architectural_pattern": "string (e.g., 'Saga Pattern', 'Decorator Guard', 'Proxy with Allowlist')",
      "tests_added": ["test_file:test_name"],
      "performance_notes": "string | null"
    }
  ],
  "discoveries": [
    {
      "severity": "CRIT | HIGH | MED | LOW",
      "description": "string",
      "file": "path:line",
      "solution": "architectural solution description",
      "fixed_by_me": true,
      "delegated_to": "agent_name | null"
    }
  ],
  "verification_status": "PENDING | APPROVED | APPROVED_WITH_NOTES | REJECTED"
}
```

### 2.7 Rollback Strategy

If Phase 5 zero-defect gate fails after 2 rework iterations:

1. **Triage:** Categorize remaining failures as "shippable" (MED/LOW, no security impact) vs "blocking" (CRIT/HIGH, security impact)
2. **Partial ship:** If only MED/LOW remain open, ship with documented known issues and follow-up tickets
3. **Selective revert:** If a specific agent's changes cause cascading failures, revert that agent's worktree branch while keeping others
4. **Human escalation:** Present to human with full context:
   - What works (verified checklist items)
   - What doesn't (failed items with root cause analysis)
   - Recommended path forward (specific code changes needed)
5. **Never ship CRIT/HIGH open** — these are hard blockers regardless of iteration count

### 2.8 Performance Baseline Protocol

Before applying performance-impacting changes:

1. **RLS Policies (Agent 1):** Benchmark top-5 most-queried tenant tables with `EXPLAIN ANALYZE` before and after RLS. If >20% regression, use partial indexes or policy simplification.
2. **Redis Tenant Namespace (Agent 1):** Measure key-prefixing overhead with 1000-key benchmark. Must be <1ms per operation.
3. **GraphQL AST Parsing (Agent 4):** Benchmark per-request AST parsing overhead. Must be <5ms per query.

## 3. Success Criteria

1. **Zero open findings** — every CRIT/HIGH/MED/LOW finding verified as fixed
2. **Zero new defects** — verifier + code reviewer confirm no regressions
3. **Full E2E coverage** — every finding has at least one E2E test proving the fix
4. **Build passes** — all services compile, lint clean, unit tests pass
5. **Enterprise-grade architecture** — SOLID, clean boundaries, proper patterns throughout
6. **Discovery complete** — all newly discovered issues resolved or documented with severity and follow-up plan
7. **Performance maintained** — no measurable regression on critical paths

## 4. Technology Decisions

- **E2E Framework:** Playwright (browser tests) + custom GraphQL/REST test client (API tests)
- **Test DB:** Isolated test tenant schema, seeded per suite, torn down after
- **Auth in tests:** Direct JWT generation using shared `JWT_SECRET` (bypass auth-service for speed)
- **Assertions:** Playwright assertions + direct DB queries for data verification
- **CI:** GitHub Actions with service containers (postgres:15, redis:7, nats:2.10)

## 5. Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Agent conflicts on shared files | Shared file ownership table (Section 2.5) + isolated worktrees + Phase 5 conflict resolver |
| Fix introduces new bug | Verifier protocol + code reviewer + E2E tests |
| Discovery overwhelms scope | Orchestrator triages between phases — CRIT/HIGH dispatched, MED/LOW logged |
| Build breaks after merge | Final verification agent runs full build before completion |
| Test flakiness | Deterministic seeding, explicit waits, no shared state between tests |
| Performance regression | Baseline protocol (Section 2.8) — measure before/after on impacting changes |
| Rework loop diverges | Max 2 iterations + human escalation with full context |
| Phase dependency missed | Explicit dependency gates between phases + shared file ownership table |
| Agent scope overlap | Each agent's owned files documented — conflicts flagged at merge time |

## 6. Dependency Graph

```
Phase 1 (parallel):
  Agent 1 ←→ (no deps)
  Agent 2 ←→ (no deps)
  Agent 3 ←→ (no deps, creates new event-contracts files)
  Agent 4 ←→ (no deps)

Phase 2 (parallel, after Phase 1 verified):
  Agent 5 → depends on Agent 2 (updateTenantSettings removal)
  Agent 5 → reads Agent 3's new event-contracts files
  Agent 6 ←→ (no deps on Phase 1, but benefits from Agent 3's provisioning changes)
  Agent 7 ←→ (no deps)

Phase 3 (parallel, after Phase 2 verified):
  Agent 8 → depends on Agent 7 (centralized queries to import)
  Agent 9 ←→ (no deps)
  Agent 10 ←→ (no deps)

Phase 4 (parallel, after Phase 3 verified):
  Agent 11 ←→ (infra, no deps on fixes)
  Agent 12 → depends on Agent 11 (test infra)
  Agent 13 → depends on Agent 11 (test infra)
  Agent 14 → depends on Agent 11 (test infra)

Phase 5 (sequential):
  Agent 15 → all Phase 1-4 agents
  Agent 16 → Agent 15 (merged codebase)
  Agent 17 → Agent 16 (reviewed codebase)
  Agent 18 → Agent 17 (only if failures)
```
