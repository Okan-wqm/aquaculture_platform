# Unified Review Report

**Date:** 2026-04-09
**Scope:** Full architectural health check — entire Aquaculture IoT SaaS platform
**Agents Invoked:** farm-expert, sensor-expert, messaging-expert, data-expert, database-reviewer, edge-expert, hr-expert, admin-expert, frontend-expert, infra-expert, platform-services, auth-security-expert, security-reviewer, test-runner, multi-tenant-saas-expert

---

## Deployment Decision

**PASS WITH CONDITIONS**

- No deployment-blocking CRITICAL findings (previous CRITICALs resolved)
- 5 HIGH findings require attention before next release
- Multiple MEDIUM findings for ongoing improvement

---

## Summary

| Domain | CRITICAL | HIGH | MEDIUM | LOW |
|--------|----------|------|--------|-----|
| auth-security-expert | 0 | 1 | 3 | 2 |
| security-reviewer | 0 | 2 | 3 | 1 |
| multi-tenant-saas-expert | 0 | 1 | 2 | 1 |
| data-expert | 0 | 0 | 2 | 2 |
| database-reviewer | 0 | 0 | 2 | 1 |
| farm-expert | 0 | 0 | 1 | 2 |
| sensor-expert | 0 | 0 | 2 | 1 |
| platform-services | 0 | 0 | 1 | 1 |
| infra-expert | 0 | 1 | 1 | 1 |
| frontend-expert | 0 | 0 | 1 | 1 |
| edge-expert | 0 | 0 | 1 | 0 |
| test-runner | 0 | 0 | 1 | 1 |
| **Total** | **0** | **5** | **20** | **14** |

---

## High Priority Findings

### HIGH-001 [security-reviewer]: TenantContextMiddleware accepts X-Tenant-Id header from untrusted sources

**File:** `libs/backend-common/src/middleware/tenant-context.middleware.ts` (lines 95-110)

The `TenantContextMiddleware.extractTenantContext()` method accepts tenant context from four untrusted sources: `X-Tenant-Id` header, JWT, query parameter, and subdomain. The `X-Tenant-Id` header (line 97-99) and `tenantId` query parameter (line 109) are **attacker-controlled inputs**.

While the downstream `TenantGuard` correctly overrides `request.tenantId` with the JWT-verified value for regular users, there is a **timing window**: middleware runs before guards. Any code path that reads `req.tenantId` or `req.tenantContext` between middleware execution and guard execution will see the attacker-supplied value. This is especially dangerous for services that register this middleware without also registering TenantGuard.

**Remediation:** Remove `X-Tenant-Id` header and query parameter extraction from TenantContextMiddleware. The only trusted sources are: JWT claim (via the gateway's x-user-payload header after gateway verification) and subdomain (with UUID validation). Or, mark the middleware's sources clearly as "initial hint, not authoritative" and ensure no code path uses them without guard validation.

### HIGH-002 [security-reviewer]: event-store-service reads X-Tenant-Id directly from request headers

**File:** `apps/event-store-service/src/event-store/event-store.controller.ts` (lines 62, 94, 114, 155, 177, 192, 213, 251, 268, 298, 323)

The event-store-service controller uses `@Headers('x-tenant-id')` to extract the tenant ID on **every endpoint**. This header is attacker-controlled. If this service is accessible behind the gateway without the gateway stripping/rewriting the X-Tenant-Id header, any authenticated user can read/write events for any tenant.

**Remediation:** Replace `@Headers('x-tenant-id')` with the JWT-verified tenant context from TenantGuard. Register TenantGuard as APP_GUARD on event-store-service, or use `@CurrentUser()` decorator.

### HIGH-003 [multi-tenant-saas-expert]: ALLOWED_BASE_DOMAINS fails open in production

**File:** `libs/backend-common/src/middleware/tenant-context.middleware.ts` (lines 160-179)

The `isAllowedBaseDomain()` method defaults to **allow-all** when `ALLOWED_BASE_DOMAINS` is not configured in production. Combined with HIGH-001, this creates a path where an attacker-controlled subdomain can inject a tenant context.

**Remediation:** Invert the default in production: if `ALLOWED_BASE_DOMAINS` is not set and `NODE_ENV=production`, **reject all subdomain-based tenant extraction** (fail-closed).

### HIGH-004 [auth-security-expert]: `getRepository()` usage bypasses tenant isolation in multiple services

**Files:**
- `apps/hr-service/src/hr/handlers/update-employee.handler.ts:28`
- `apps/hr-service/src/hr/handlers/create-department.handler.ts:24`
- `apps/hr-service/src/hr/handlers/create-employee.handler.ts:27`
- `apps/hr-service/src/performance/handlers/acknowledge-review.handler.ts:49`
- `apps/hr-service/src/performance/handlers/update-goal.handler.ts:45`
- `apps/hr-service/src/performance/handlers/defer-goal.handler.ts:48`
- `apps/farm-service/src/scheduler/feeding-scheduler.service.ts` (7 occurrences)
- `apps/sensor-service/src/automation/automation.service.ts` (6 occurrences)
- `apps/sensor-service/src/edge-device/edge-device.service.ts:1832`

CLAUDE.md forbids `getRepository()` — requires `getScopedRepository()`. The hr-service handlers at `acknowledge-review.handler.ts:49`, `update-goal.handler.ts:45`, and `defer-goal.handler.ts:48` call `this.dataSource.getRepository(X).findOne(...)` **without any tenantId filter** — potential cross-tenant read vulnerabilities.

**Remediation:** Wrap all `queryRunner.manager.getRepository()` calls in a tenant-scoped helper. Add a lint rule to detect bare `getRepository()` calls outside admin/migration contexts.

### HIGH-005 [infra-expert]: WebSocket namespaces missing from nginx reverse proxy

**File:** `nginx/nginx.conf`

The four WebSocket namespaces (`/farms`, `/messaging`, `/sensor-readings`, `/st-language`) have **no dedicated location blocks** in nginx. In production, these Socket.IO connections hit the catch-all `location /` which proxies to the shell (frontend), not to `gateway-api:3000`. WebSocket connections fail silently in production behind nginx.

**Remediation:** Add four `location` blocks to nginx.conf for each Socket.IO namespace with proper WebSocket upgrade headers:
```nginx
location /farms/ { proxy_pass http://gateway-api:3000; ... }
location /messaging/ { proxy_pass http://gateway-api:3000; ... }
location /sensor-readings/ { proxy_pass http://gateway-api:3000; ... }
location /st-language/ { proxy_pass http://gateway-api:3000; ... }
```

---

## Medium Priority Findings

### MEDIUM-001 [data-expert]: TenantModulesAssignedEvent violates flat-object contract

**File:** `libs/event-contracts/src/tenant-events.ts` (lines 156-165)

The `TenantModulesAssignedEvent` contains a nested `pricing` object. CLAUDE.md requires flat-object pattern.

### MEDIUM-002 [data-expert]: TenantProvisioningFailedEvent uses JSON string workaround

**File:** `libs/event-contracts/src/tenant-events.ts` (lines 88-97)

The `stepsJson` field serializes an array as a JSON string to work around the flat-object constraint. Creates schema evolution problems.

### MEDIUM-003 [security-reviewer]: 3 `@ts-ignore` directives suppress type safety

**Files:**
- `apps/sensor-service/src/automation/compiler/worker/st-worker-pool.service.ts:34,56`
- `apps/gateway-api/src/app.module.ts:493`

CLAUDE.md forbids `@ts-ignore` and `@ts-expect-error`.

### MEDIUM-004 [security-reviewer]: 90 `as any` casts across 30 files

CLAUDE.md forbids `as any`. Production code casts weaken TypeScript's safety guarantees.

### MEDIUM-005 [security-reviewer]: 6 `console.log/warn/error` usages in production code

CLAUDE.md requires NestJS `Logger`. Bypasses structured logging and tenant/request context.

### MEDIUM-006 [sensor-expert]: sensor-service has 2 `@ts-ignore` for piscina worker pool

**File:** `apps/sensor-service/src/automation/compiler/worker/st-worker-pool.service.ts`

Life-safety adjacent system (controls PLC programming and VFD motor control).

### MEDIUM-007 [sensor-expert]: MQTT credential vault uses custom encryption with console.log

**File:** `apps/sensor-service/src/infrastructure/vault/credential.transformer.ts`

Credentials appearing in stdout logs is a PII/secret leak vector.

### MEDIUM-008 [farm-expert]: feeding-scheduler.service.ts has 7 raw getRepository() calls

**File:** `apps/farm-service/src/scheduler/feeding-scheduler.service.ts`

Without tenant-scoped wrappers. Incorrect tenant filtering could apply feeding schedules from one farm to another tenant's batches — **life-safety concern** in aquaculture.

### MEDIUM-009 [database-reviewer]: Mixed naming convention (tenantId vs tenant_id) across entities

Makes RLS policy installation fragile — the policy must match the exact physical column name.

### MEDIUM-010 [database-reviewer]: No global SnakeNamingStrategy configured

Physical database column names vary by developer annotation presence.

### MEDIUM-011 [platform-services]: alert-engine has 15 `as any` casts in integration tests

Safety-critical component (triggers emergency responses for water quality, oxygen levels).

### MEDIUM-012 [auth-security-expert]: Token service module cache uses in-memory Map

**File:** `apps/auth-service/src/modules/authentication/services/token.service.ts` (lines 122-127)

Per-process cache in multi-pod deployment — stale permissions for up to 5 minutes.

### MEDIUM-013 [auth-security-expert]: Refresh token bcrypt comparison not verified

Token validation should use `bcrypt.compare()` to prevent timing attacks.

### MEDIUM-014 [auth-security-expert]: MFA step-up for cross-tenant access is opt-in by default

**File:** `libs/backend-common/src/guards/tenant.guard.ts` (line 70)

`MFA_REQUIRED_FOR_CROSS_TENANT` defaults to `false`. Compromised SUPER_ADMIN session without MFA can access any tenant.

### MEDIUM-015 [multi-tenant-saas-expert]: TenantIsolationGuard accepts tenant from headers/body/query

**File:** `apps/gateway-api/src/guards/tenant-isolation.guard.ts` (lines 162-220)

Unnecessary attack surface — any authenticated user can request a cross-tenant check.

### MEDIUM-016 [multi-tenant-saas-expert]: 51 `as unknown as` casting hacks

CLAUDE.md forbids this pattern. Each cast is a potential tenant isolation bypass.

### MEDIUM-017 [infra-expert]: CI uses postgres:16 not timescale/timescaledb

**File:** `.github/workflows/ci-full.yml` (line 78)

Tests relying on TimescaleDB features fail silently or are skipped in CI.

### MEDIUM-018 [frontend-expert]: nginx CSP allows ws: (unencrypted WebSocket)

**File:** `nginx/nginx.conf` (line 103)

Production should be `wss:` only.

### MEDIUM-019 [edge-expert]: Rust edge agent uses eprintln! instead of tracing

**File:** `sens-api-gateway/src/main.rs` (lines 87-92, 99)

### MEDIUM-020 [test-runner]: CI workflow does not run edge-agent (Rust) tests

74 Rust source files have no automated quality gate in CI.

---

## Cross-Domain Dependencies

| From Agent | To Agent | Issue | Status |
|-----------|----------|-------|--------|
| security-reviewer | multi-tenant-saas-expert | HIGH-001/HIGH-003: TenantContextMiddleware + ALLOWED_BASE_DOMAINS fail-open creates tenant spoofing path | Open |
| security-reviewer | data-expert | HIGH-002: event-store-service X-Tenant-Id header bypass needs TenantGuard migration | Open |
| auth-security-expert | farm-expert, hr-expert, sensor-expert | HIGH-004: Raw getRepository() calls bypass tenant isolation across 3 services | Open |
| infra-expert | all frontend/WebSocket consumers | HIGH-005: Missing nginx WebSocket proxy blocks real-time features in production | Open |
| data-expert | all event consumers | MEDIUM-001: TenantModulesAssignedEvent nested pricing breaks flat-object contract | Open |
| database-reviewer | all services | MEDIUM-009/010: Mixed tenant column naming + no global naming strategy makes RLS fragile | Open |

---

## Systemic Issues

### 1. Tenant ID Trust Chain Inconsistency (HIGH-001, HIGH-002, HIGH-003, MEDIUM-015)

The platform has a strong tenant isolation layer at the guard/repository level but a **weak tenant identification layer** at the middleware level. The TenantContextMiddleware accepts tenant context from untrusted sources, and event-store-service reads X-Tenant-Id directly without guard validation. The fix is architectural: establish a single, platform-wide "the only source of tenant identity is the cryptographically verified JWT" rule and remove all other extraction paths.

### 2. Raw Repository Access Pattern (HIGH-004, MEDIUM-008)

Despite `getScopedRepository()` being well-designed, `queryRunner.manager.getRepository()` remains the path of least resistance. 16+ call sites across hr-service, farm-service, and sensor-service bypass tenant filtering. Needs a `TenantAwareQueryRunner` wrapper or static analysis rule.

### 3. Type Safety Erosion (MEDIUM-003, MEDIUM-004, MEDIUM-016)

90 `as any`, 51 `as unknown as`, and 3 `@ts-ignore` directives collectively weaken the type system — the first line of defense against tenant isolation bugs.

---

## Architectural Strengths

1. **Defense-in-depth tenant isolation**: TenantGuard + TenantAwareRepository + RLS policies + SourceSchemaWriteGuard + CrossTenantProbe + BypassRlsService
2. **Security-hardened auth flow**: JWT with type discriminator, token blacklisting, bcrypt-hashed refresh tokens, session limits, MFA step-up, algorithm pinning
3. **Production fail-fast guards**: Gateway refuses to start without critical env vars
4. **Well-structured event contracts**: BaseEvent with createBaseEvent(), flat-object pattern, versioning, upcasters, JSON Schema validation
5. **CI security posture**: GitHub Actions pinned to SHAs, minimal token permissions, Snyk/Trivy scanning
6. **Nginx hardening**: TLS 1.2/1.3, HSTS preload, CSP, rate limiting
7. **Edge agent architecture**: Rust-based with circuit breaker, graceful shutdown, alarm management per IEC 62682

---

## Recommendations Priority

1. **Immediate (before next deployment):** Fix HIGH-005 (nginx WebSocket proxy) — real-time features are broken in production
2. **This sprint:** Fix HIGH-001 + HIGH-003 (TenantContextMiddleware fail-open) and HIGH-002 (event-store X-Tenant-Id)
3. **Next sprint:** Address HIGH-004 (getRepository bypass) with a TenantAwareQueryRunner abstraction
4. **Ongoing:** Systematic reduction of `as any` / `as unknown as` casts, starting with tenant-related code paths

---

## Agent Reports

- Previous reviews: `docs/reviews/orchestrator/2026-04-06-full-platform-deep-audit.md`
- Previous reviews: `docs/reviews/orchestrator/2026-04-05-s3-medium-findings.md`
