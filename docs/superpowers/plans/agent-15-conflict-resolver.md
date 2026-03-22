# Agent 15: Cross-Agent Conflict Resolver — Implementation Plan

> **For agentic workers:** This agent runs AFTER all Phase 1-4 agents complete.

**Goal:** Merge all agent branches, resolve conflicts, verify import consistency.

---

### Task 1: Merge Agent Branches

- [ ] **Step 1: List all agent branches**
```bash
git branch -a | grep fix/zero-defect-agent
```

- [ ] **Step 2: Merge in severity order**
```bash
# Phase 1 (CRIT) first
git merge fix/zero-defect-agent-01-tenant-isolation
git merge fix/zero-defect-agent-02-auth-security
git merge fix/zero-defect-agent-03-admin-api
git merge fix/zero-defect-agent-04-gateway-security

# Phase 2 (HIGH)
git merge fix/zero-defect-agent-05-event-consistency
git merge fix/zero-defect-agent-06-data-validation
git merge fix/zero-defect-agent-07-frontend-api

# Phase 3 (MED/LOW)
git merge fix/zero-defect-agent-08-frontend-resilience
git merge fix/zero-defect-agent-09-observability
git merge fix/zero-defect-agent-10-platform-cleanup

# Phase 4 (E2E)
git merge fix/zero-defect-agent-11-e2e-infra
git merge fix/zero-defect-agent-12-e2e-security
git merge fix/zero-defect-agent-13-e2e-workflow
git merge fix/zero-defect-agent-14-e2e-integration
```

- [ ] **Step 3: Resolve conflicts (CRIT agent version wins)**

### Task 2: Verify Import Consistency

- [ ] **Step 1: Check for broken imports**
```bash
npx tsc --noEmit 2>&1 | head -50
```

- [ ] **Step 2: Check for circular dependencies**
```bash
npx madge --circular --extensions ts apps/ libs/
```

- [ ] **Step 3: Verify barrel exports**
```bash
# Check that index.ts files export all new services
grep -rn 'TenantRedisService\|UserLifecycleService\|ProvisioningSagaService' libs/backend-common/src/index.ts
```

- [ ] **Step 4: Commit merge result**
