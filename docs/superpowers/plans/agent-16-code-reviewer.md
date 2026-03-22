# Agent 16: Enterprise Code Reviewer — Implementation Plan

> **For agentic workers:** Use superpowers:code-reviewer agent type for this task.

**Goal:** Review all changes from agents 1-14 for SOLID compliance, security, performance, and enterprise quality.

---

### Review Checklist

For EVERY modified file, verify:

- [ ] **SRP:** Each class/function does ONE thing
- [ ] **OCP:** New behavior via extension, not modification of working code
- [ ] **LSP:** Substitutability preserved in refactored interfaces
- [ ] **ISP:** No fat interfaces — consumers only depend on methods they use
- [ ] **DIP:** High-level modules import abstractions, not implementations
- [ ] **DRY:** No copy-paste code between agents' changes
- [ ] **Security:** No new injection vectors, no credential exposure, no info disclosure
- [ ] **Performance:** No N+1 queries, no unbounded loops, no missing indexes
- [ ] **TypeScript:** No `any` casts, no `!` non-null without justification
- [ ] **Error handling:** No empty catches, proper error propagation
- [ ] **Clean Architecture:** resolver → service → repository (no shortcuts)
- [ ] **Naming:** Consistent, descriptive, follows existing conventions

### Files to Review (by agent)

Agent 1: `libs/backend-common/src/redis/tenant-redis.service.ts`, `database/rls/`, `tenant-aware.repository.ts`, `cacheable.decorator.ts`, `tenant-context.middleware.ts`

Agent 2: `apps/auth-service/src/modules/tenant/resolvers/*.ts`, `services/user-lifecycle.service.ts`

Agent 3: `apps/admin-api-service/src/tenant/entities/tenant.entity.ts`, `services/provisioning-saga.service.ts`, `services/tenant-provisioning.service.ts`, `libs/event-contracts/src/tenant-commands.ts`

Agent 4: `apps/gateway-api/src/routes/v2/ai.routes.ts`, `middleware/csrf.middleware.ts`, `guards/mutation-rate-limit.guard.ts`, `app.module.ts`, `health.service.ts`, `main.ts`

Agents 5-10: Respective files per agent plan

Agents 11-14: E2E test code quality and coverage completeness

### Output Format

For each issue found:
```
[SEVERITY] FILE:LINE — Description
  Recommendation: ...
```
