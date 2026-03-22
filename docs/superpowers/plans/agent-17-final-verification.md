# Agent 17: Final Verification Agent — Implementation Plan

> **For agentic workers:** This is the LAST gate before completion. Every check must pass.

**Goal:** Build all services, run all tests, verify every finding in the master checklist.

---

### Task 1: Build Verification

- [ ] **Step 1: Build all backend services**
```bash
npx nx run-many --target=build --all --parallel=4
```
Expected: ALL services build successfully

- [ ] **Step 2: Lint all code**
```bash
npx nx run-many --target=lint --all --parallel=4
```
Expected: Zero lint errors

- [ ] **Step 3: Run all unit tests**
```bash
npx nx run-many --target=test --all --parallel=4
```
Expected: ALL tests pass

### Task 2: E2E Test Execution

- [ ] **Step 1: Start services** (if not running)
- [ ] **Step 2: Run security E2E tests**
```bash
cd e2e && npx playwright test --project=security
```
- [ ] **Step 3: Run workflow E2E tests**
```bash
cd e2e && npx playwright test --project=workflow
```
- [ ] **Step 4: Run integration E2E tests**
```bash
cd e2e && npx playwright test --project=integration
```

### Task 3: Master Checklist Verification

Manually verify each finding. For each item, provide:
- Status: PASS / FAIL
- Evidence: grep output, test name, or code reference

```
- [ ] CRIT-1: Redis tenant namespace — grep for TenantRedisService usage
- [ ] CRIT-2: MobileSettings guard — grep for @TenantAdminOrHigher in mobile-settings.resolver.ts
- [ ] CRIT-3: myModules guard — grep for @Roles in tenant-admin.resolver.ts
- [ ] CRIT-4: No cross-schema writes — grep for 'INSERT INTO auth\.' in admin-api-service
- [ ] CRIT-5: AI proxy secured — verify header allowlist in ai.routes.ts
- [ ] CRIT-6: TenantStatus distinct values — verify DEACTIVATED !== CANCELLED
- [ ] CRIT-7: getRepository removed — grep should find 0 results
- [ ] CRIT-8: RLS policies — check PostgreSQL for active policies
- [ ] CRIT-9: Subdomain hardened — verify domain whitelist in middleware
- [ ] CRIT-10: x-user-payload stripped — verify in gateway middleware chain
- [ ] HIGH-1: UserLifecycleService exists — verify single creation path
- [ ] HIGH-2: Token revocation on delete — verify revokeAllUserRefreshTokens call
- [ ] HIGH-3: updateTenantSettings removed — grep should find 0 mutation declarations
- [ ] HIGH-4: Provisioning saga — verify ProvisioningSagaService usage
- [ ] HIGH-5: All NATS events published — verify each contract has publisher
- [ ] HIGH-6: CSRF protection — verify CsrfMiddleware registered
- [ ] HIGH-7: INTERNAL_SERVICE_SECRET hard-fail — verify throw in main.ts
- [ ] HIGH-8: Invitation token redacted — verify not in ProvisioningResult
- [ ] HIGH-9: tableData enforces tenant_id — verify ForbiddenException
- [ ] HIGH-10: Notification subgraph removed — verify not in federation config
- [ ] HIGH-11: Health checks complete — verify hydroponics + config in list
- [ ] HIGH-12: Mutation rate limiting — verify AST-based guard
- [ ] MED-1 through MED-18: Verify each per master checklist
- [ ] LOW-1 through LOW-2: Verify each
```

### Task 4: Generate Report

- [ ] Create `docs/superpowers/VERIFICATION_REPORT.md` with pass/fail status for every item
- [ ] If ANY CRIT/HIGH item fails → trigger Agent 18
- [ ] If ALL items pass → declare ZERO-DEFECT ACHIEVED
