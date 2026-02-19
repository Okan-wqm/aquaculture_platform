---
name: security-scan
description: "Run security audit across all services. Priority-ordered from most to least security-sensitive."
---

## Parallel Agent Limit

**CRITICAL**: Never launch more than 3 Task agents in a single message.
Claude Code's UI crashes (React Error #185) with 4+ simultaneous agents.

Rules:
- Maximum 3 parallel Task calls per message
- Use `run_in_background: true` on all Task calls
- Wait for a batch to complete before starting the next

# Security Scan

Run the security-auditor specialist across ALL services in the platform.

## Step 1: Setup

Use Bash to create all output directories:
```bash
mkdir -p agent-workspace/l3-findings/backend/{gateway-api,auth-service,farm-service,sensor-service,alert-engine,notification-service,hr-service,billing-service,admin-api-service,config-service,observability-service,event-store-service,hydroponics-service}
mkdir -p agent-workspace/l3-findings/frontend/{shell,dashboard,farm-module,admin-panel,tenant-admin,hr-module,sensor-module,hydroponics-module,aquamobil,shared-ui}
mkdir -p agent-workspace/l3-findings/infrastructure/{docker,kubernetes,terraform,helm,ci-cd,nginx-monitoring}
mkdir -p agent-workspace/l3-findings/edge/{sens-api-gateway,sens-repo}
mkdir -p agent-workspace/cross-references
```

## Step 2: Run Security Audits in Batches

Launch Task agents in parallel batches. Each Task uses `subagent_type: "general-purpose"`, `model: "sonnet"`.

Use `run_in_background: true` on every Task. Maximum 3 Tasks per message.

For each service, create a Task with this prompt template (replace {DOMAIN}, {SERVICE}, {PATH}):
```
You are a security auditor. Read instructions from .claude/agents/specialists/security-auditor.md
Read service knowledge from .claude/agents/services/{DOMAIN}/{SERVICE}.md
Analyze ALL code in: {PATH}/src/
Focus on: OWASP Top 10, auth bypass, injection, tenant isolation, secret exposure, CORS, CSRF, rate limiting.
Write findings to: agent-workspace/l3-findings/{DOMAIN}/{SERVICE}/security.md
Use CRITICAL/HIGH/MEDIUM/LOW severity. Include file paths and line numbers.
```

**Batch 1** (launch 3 in ONE message, use `run_in_background: true`):

| Service | Domain | Path |
|---------|--------|------|
| gateway-api | backend | apps/gateway-api |
| auth-service | backend | apps/auth-service |
| admin-api-service | backend | apps/admin-api-service |

**Batch 2** (launch 3 in ONE message after batch 1 completes, use `run_in_background: true`):

| Service | Domain | Path |
|---------|--------|------|
| billing-service | backend | apps/billing-service |
| farm-service | backend | apps/farm-service |
| sensor-service | backend | apps/sensor-service |

**Batch 3** (launch 3 in ONE message after batch 2 completes, use `run_in_background: true`):

| Service | Domain | Path |
|---------|--------|------|
| hr-service | backend | apps/hr-service |
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
| admin-panel | frontend | web/modules/admin-panel |

**Batch 6** (launch 3 in ONE message after batch 5 completes, use `run_in_background: true`):

| Module | Domain | Path |
|--------|--------|------|
| tenant-admin | frontend | web/modules/tenant-admin |
| aquamobil | frontend | web/apps/aquamobil |
| farm-module | frontend | web/modules/farm-module |

**Batch 7** (launch 3 in ONE message after batch 6 completes, use `run_in_background: true`):

| Module/Component | Domain | Path |
|------------------|--------|------|
| shared-ui | frontend | web/shared-ui |
| docker | infrastructure | infrastructure/docker |
| kubernetes | infrastructure | infrastructure/kubernetes |

**Batch 8** (launch 2 in ONE message after batch 7 completes, use `run_in_background: true`):

| Component | Domain | Path |
|-----------|--------|------|
| ci-cd | infrastructure | .github |
| sens-api-gateway | edge | sens-api-gateway |

## Step 3: Cross-Service Security Chain Analysis

After all batches complete, launch one final Task:
```
name: "security-chain-analysis"
subagent_type: "general-purpose"
model: "sonnet"
prompt: |
  Read ALL security finding files from agent-workspace/l3-findings/

  Use Glob to find all security.md files:
  agent-workspace/l3-findings/*/*/security.md

  Analyze these cross-service security chains:

  1. Auth Chain: login → JWT → gateway guard → service authorization
  2. Tenant Isolation Chain: middleware → search_path → query → response
  3. Data Flow Chain: user input → validation → handler → DB → response
  4. File Upload Chain: frontend → gateway → MinIO → URL generation
  5. Event Chain: publisher → NATS → subscriber (spoofing/replay?)

  Write consolidated findings to: agent-workspace/cross-references/security-chain-issues.md
```

## Step 4: Present Results

Read all security finding files and the cross-reference file.
Present to user:
- Total CRITICAL and HIGH findings count
- Top 10 most critical security issues
- Security posture grade (A-F)
- Cross-service chain vulnerabilities
