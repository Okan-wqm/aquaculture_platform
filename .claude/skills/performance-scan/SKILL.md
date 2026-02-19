---
name: performance-scan
description: "Run performance analysis across all services. N+1 queries, memory leaks, caching, bundle size."
---

## Parallel Agent Limit

**CRITICAL**: Never launch more than 3 Task agents in a single message.
Claude Code's UI crashes (React Error #185) with 4+ simultaneous agents.

Rules:
- Maximum 3 parallel Task calls per message
- Use `run_in_background: true` on all Task calls
- Wait for a batch to complete before starting the next

# Performance Scan

Run the performance-analyst specialist across ALL services.

## Step 1: Setup

```bash
mkdir -p agent-workspace/l3-findings/backend/{gateway-api,auth-service,farm-service,sensor-service,alert-engine,notification-service,hr-service,billing-service,admin-api-service,config-service,observability-service,event-store-service,hydroponics-service}
mkdir -p agent-workspace/l3-findings/frontend/{shell,dashboard,farm-module,admin-panel,tenant-admin,hr-module,sensor-module,hydroponics-module,aquamobil,shared-ui}
mkdir -p agent-workspace/l3-findings/infrastructure/{docker,kubernetes,terraform,helm,ci-cd,nginx-monitoring}
mkdir -p agent-workspace/l3-findings/edge/{sens-api-gateway,sens-repo}
mkdir -p agent-workspace/cross-references
```

## Step 2: Run Performance Analysis in Batches

Each Task uses `subagent_type: "general-purpose"`, `model: "sonnet"`.

Prompt template for each service (replace {DOMAIN}, {SERVICE}, {PATH}):
```
You are a performance analyst. Read instructions from .claude/agents/specialists/performance-analyst.md
Read service knowledge from .claude/agents/services/{DOMAIN}/{SERVICE}.md
Analyze ALL code in: {PATH}/src/
Focus on: N+1 queries, missing indexes, SELECT *, memory leaks, connection pool, async anti-patterns, caching gaps.
Write findings to: agent-workspace/l3-findings/{DOMAIN}/{SERVICE}/performance.md
Use CRITICAL/HIGH/MEDIUM/LOW severity. Include file paths and line numbers.
```

Use `run_in_background: true` on every Task. Maximum 3 Tasks per message.

**Batch 1 - High Throughput** (launch 3 in ONE message, use `run_in_background: true`):

| Service | Domain | Path |
|---------|--------|------|
| sensor-service | backend | apps/sensor-service |
| farm-service | backend | apps/farm-service |
| gateway-api | backend | apps/gateway-api |

**Batch 2** (launch 3 in ONE message after batch 1 completes, use `run_in_background: true`):

| Service | Domain | Path |
|---------|--------|------|
| auth-service | backend | apps/auth-service |
| hr-service | backend | apps/hr-service |
| billing-service | backend | apps/billing-service |

**Batch 3** (launch 3 in ONE message after batch 2 completes, use `run_in_background: true`):

| Service | Domain | Path |
|---------|--------|------|
| admin-api-service | backend | apps/admin-api-service |
| alert-engine | backend | apps/alert-engine |
| notification-service | backend | apps/notification-service |

**Batch 4** (launch 3 in ONE message after batch 3 completes, use `run_in_background: true`):

| Service | Domain | Path |
|---------|--------|------|
| config-service | backend | apps/config-service |
| observability-service | backend | apps/observability-service |
| event-store-service | backend | apps/event-store-service |

**Batch 5** (launch 3 in ONE message after batch 4 completes, use `run_in_background: true`):

| Service | Domain | Path |
|---------|--------|------|
| hydroponics-service | backend | apps/hydroponics-service |
| shell | frontend | web/shell |
| farm-module | frontend | web/modules/farm-module |

**Batch 6 - Remaining Frontend** (launch 3 in ONE message after batch 5 completes, use `run_in_background: true`):

For frontend, adjust the prompt to focus on: React re-renders, bundle size, code splitting, state management, GraphQL over-fetching, missing pagination.

| Module | Domain | Path |
|--------|--------|------|
| admin-panel | frontend | web/modules/admin-panel |
| aquamobil | frontend | web/apps/aquamobil |
| shared-ui | frontend | web/shared-ui |

## Step 3: Cross-Service Performance Analysis

After all batches, launch one Task:
```
name: "performance-cross-analysis"
subagent_type: "general-purpose"
model: "sonnet"
prompt: |
  Read ALL performance finding files: agent-workspace/l3-findings/*/*/performance.md

  Analyze cross-service performance patterns:
  1. N+1 query chains across service boundaries
  2. Gateway bottleneck: all traffic funnels through gateway-api
  3. Cache strategy consistency across services (Redis vs in-memory vs none)
  4. Database connection pool total pressure (sum all pool sizes)
  5. Frontend bundle size: total size across all micro-frontends
  6. TimescaleDB: continuous aggregate refresh intervals vs query patterns

  Write to: agent-workspace/cross-references/performance-cross-analysis.md
```

## Step 4: Present Results

Show user:
- Top performance bottlenecks
- Quick wins (easy fix, big impact)
- Architecture-level concerns
