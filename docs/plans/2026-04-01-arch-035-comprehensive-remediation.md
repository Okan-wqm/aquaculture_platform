# ARCH-035: Comprehensive Security & Architecture Remediation Plan

**Date:** 2026-04-01  
**Scope:** All findings from sec-review, code-quality, and remaining-issues scans  
**Approach:** Enterprise production-grade architectural solutions only — no patches  
**Build:** GitHub Actions CI/CD only — no local builds  

---

## Wave 1: Parallel Code Agents (6 agents, no file conflicts)

### Agent 1: compose-security-agent
**Scope:** NEW-01, NEW-02, NEW-06, NEW-07, NEW-08  
**Files:** docker-compose*.yml, ai-service/app.module.ts, hydroponics-service/app.module.ts  
**Pattern:** Mandatory env vars (`:?` operator), remove predictable defaults  

### Agent 2: auth-refactor-agent
**Scope:** KRITIK-01/02/03, ONEMLI-01/06, BULGU-5  
**Files:** auth.guard.ts (split via Strategy Pattern), types/index.ts, jwt.middleware.ts, 7+ GqlContext files  
**Pattern:** Strategy Pattern for auth methods, Single Source of Truth for types  

### Agent 3: sensor-gateway-agent
**Scope:** KRITIK-01 (part 2), BULGU-1/8, ONEMLI-02/03/04, ONERI-02/03/04  
**Files:** sensor-readings.gateway.ts (split), device-ownership.service.ts (new), NATS constants  
**Pattern:** Service extraction, LRU cache, type-safe validation  

### Agent 4: admin-security-agent
**Scope:** NEW-03, NEW-04, NEW-05  
**Files:** debug-tools.controller.ts, password-reset.controller.ts, migration-management.service.ts  
**Pattern:** Feature flags, HMAC token hashing, SQL statement whitelist  

### Agent 5: tenant-guard-agent
**Scope:** BULGU-2/3/4, ONEMLI-05  
**Files:** tenant.guard.ts, audit-log.service.ts, tenant.guard.spec.ts  
**Pattern:** Async canActivate, iat_minimum global revocation, audit failure metrics  

### Agent 6: bootstrap-agent
**Scope:** BULGU-6, BULGU-7  
**Files:** sensor-service/main.ts, gateway-api trust proxy config  
**Pattern:** Stack trace sanitization, consistent trust proxy configuration  

## Wave 2: Review Agents (2 agents)

### Agent 7: security-review-agent
Reviews all Wave 1 changes for security regressions  

### Agent 8: architecture-review-agent
Reviews all Wave 1 changes for SOLID, DRY, file size compliance  

## Wave 3: Integration

### Step 1: Commit all changes
### Step 2: Push to main
### Step 3: GitHub Actions build verification

---

## Acceptance Criteria
- [ ] All files under 500 lines
- [ ] Zero duplicate interface definitions
- [ ] Zero hardcoded credentials in compose files
- [ ] All auth strategies independently testable
- [ ] LRU cache with size limit on device ownership
- [ ] All JSDoc comments in English
- [ ] No `any` type anywhere
- [ ] No `process.env` direct access (use ConfigService)
- [ ] GitHub Actions CI passes
