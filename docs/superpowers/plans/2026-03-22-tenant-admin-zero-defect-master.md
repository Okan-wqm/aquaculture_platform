# Tenant Admin Zero-Defect Pipeline — Master Orchestration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:dispatching-parallel-agents to execute this plan. Each agent task references a sub-plan file with detailed steps.

**Goal:** Fix all 38+ architectural findings and write comprehensive E2E tests for the tenant admin panel with zero remaining defects.

**Architecture:** 18 specialized agents across 5 phases. Each phase-1-3 agent runs in an isolated git worktree. Phase gates enforce dependency ordering. Discovery protocol enables agents to find and fix additional issues.

**Tech Stack:** NestJS, TypeORM, PostgreSQL (RLS), Redis, NATS JetStream, Apollo Federation v2, React 18, TanStack Query, Playwright, Vitest

**Spec:** `docs/superpowers/specs/2026-03-22-tenant-admin-zero-defect-audit-design.md`

---

## Phase 1: Critical Security Fixes (Parallel)

All 4 agents run simultaneously in isolated worktrees.

| Agent | Sub-Plan | Findings |
|-------|----------|----------|
| Agent 1: tenant-isolation-architect | `plans/agent-01-tenant-isolation.md` | CRIT-1,7,8,9 |
| Agent 2: auth-security-architect | `plans/agent-02-auth-security.md` | CRIT-2,3, HIGH-1,2,3 |
| Agent 3: admin-api-architect | `plans/agent-03-admin-api.md` | CRIT-4,5,6, HIGH-4,8 |
| Agent 4: gateway-security-architect | `plans/agent-04-gateway-security.md` | CRIT-5,10, HIGH-6,7,10,11,12 |

**Gate:** All 4 agents verified before Phase 2 starts.

## Phase 2: High-Priority Fixes (Parallel)

3 agents run simultaneously. Agent 5 reads Agent 2's changes first.

| Agent | Sub-Plan | Findings |
|-------|----------|----------|
| Agent 5: event-consistency-architect | `plans/agent-05-event-consistency.md` | HIGH-5 |
| Agent 6: data-validation-architect | `plans/agent-06-data-validation.md` | MED-1,2,3, HIGH-9 |
| Agent 7: frontend-api-architect | `plans/agent-07-frontend-api.md` | MED-8,9, LOW-1 |

**Gate:** All 3 agents verified before Phase 3 starts.

## Phase 3: Medium/Low Fixes (Parallel)

3 agents run simultaneously.

| Agent | Sub-Plan | Findings |
|-------|----------|----------|
| Agent 8: frontend-resilience-architect | `plans/agent-08-frontend-resilience.md` | MED-10,11,12,13,14,15,16 |
| Agent 9: observability-architect | `plans/agent-09-observability.md` | MED-4,5,6,7 |
| Agent 10: platform-cleanup-architect | `plans/agent-10-platform-cleanup.md` | MED-17,18, LOW-2 |

**Gate:** All 3 agents verified before Phase 4 starts.

## Phase 4: E2E Test Suite (Parallel)

4 agents run simultaneously. Agent 12-14 depend on Agent 11's infra.

| Agent | Sub-Plan | Coverage |
|-------|----------|----------|
| Agent 11: e2e-infra-architect | `plans/agent-11-e2e-infra.md` | Test framework + fixtures |
| Agent 12: e2e-security-tests | `plans/agent-12-e2e-security.md` | 16 security test cases |
| Agent 13: e2e-workflow-tests | `plans/agent-13-e2e-workflow.md` | 11 workflow test flows |
| Agent 14: e2e-integration-tests | `plans/agent-14-e2e-integration.md` | 7 cross-service chains |

## Phase 5: Zero-Defect Gate (Sequential)

| Agent | Sub-Plan | Role |
|-------|----------|------|
| Agent 15: cross-agent-conflict-resolver | `plans/agent-15-conflict-resolver.md` | Merge + consistency |
| Agent 16: enterprise-code-reviewer | `plans/agent-16-code-reviewer.md` | SOLID + security review |
| Agent 17: final-verification-agent | `plans/agent-17-final-verification.md` | Build + test + 38-item checklist |
| Agent 18: regression-sweep-agent | `plans/agent-18-regression-sweep.md` | Rework loop (if needed) |

---

## Orchestration Rules

1. **Worktree naming:** `worktree-agent-{N}-{name}` (e.g., `worktree-agent-01-tenant-isolation`)
2. **Branch naming:** `fix/zero-defect-agent-{N}-{name}`
3. **Commit convention:** `fix({scope}): {description}` where scope matches the agent's domain
4. **Discovery log:** Each agent appends to `docs/superpowers/DISCOVERY_LOG.md`
5. **Phase gate:** Orchestrator reviews all agent outputs before advancing phase
6. **Shared file ownership:** See spec Section 2.5 — conflicts are prevented by ownership table
