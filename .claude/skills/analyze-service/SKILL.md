---
name: analyze-service
description: "Analyze a single service. Runs security + performance + bug + architecture + dependency + api-contract scanning."
argument-hint: "<service-name>"
---

## Parallel Agent Limit

**CRITICAL**: Never launch more than 3 Task agents in a single message.
Claude Code's UI crashes (React Error #185) with 4+ simultaneous agents.

Rules:
- Maximum 3 parallel Task calls per message
- Use `run_in_background: true` on all Task calls
- Wait for a batch to complete before starting the next

# Single Service Analysis

Analyze the service specified by `$ARGUMENTS`.

## Step 1: Resolve Service

Find the service in this registry and determine its domain and path:

| Name | Domain | Path |
|------|--------|------|
| gateway-api | backend | apps/gateway-api |
| auth-service | backend | apps/auth-service |
| farm-service | backend | apps/farm-service |
| sensor-service | backend | apps/sensor-service |
| alert-engine | backend | apps/alert-engine |
| notification-service | backend | apps/notification-service |
| hr-service | backend | apps/hr-service |
| billing-service | backend | apps/billing-service |
| admin-api-service | backend | apps/admin-api-service |
| config-service | backend | apps/config-service |
| observability-service | backend | apps/observability-service |
| event-store-service | backend | apps/event-store-service |
| hydroponics-service | backend | apps/hydroponics-service |
| shell | frontend | web/shell |
| dashboard | frontend | web/modules/dashboard |
| farm-module | frontend | web/modules/farm-module |
| admin-panel | frontend | web/modules/admin-panel |
| tenant-admin | frontend | web/modules/tenant-admin |
| hr-module | frontend | web/modules/hr-module |
| sensor-module | frontend | web/modules/sensor-module |
| hydroponics-module | frontend | web/modules/hydroponics-module |
| aquamobil | frontend | web/apps/aquamobil |
| shared-ui | frontend | web/shared-ui |
| docker | infrastructure | infrastructure/docker |
| kubernetes | infrastructure | infrastructure/kubernetes |
| terraform | infrastructure | infrastructure/terraform |
| helm | infrastructure | infrastructure/helm |
| ci-cd | infrastructure | .github |
| nginx-monitoring | infrastructure | nginx |
| sens-api-gateway | edge | sens-api-gateway |
| sens-repo | edge | sens-repo |
| backend-common | cross-cutting | libs/backend-common |
| event-contracts | cross-cutting | libs/event-contracts |
| shared-sdk-storage | cross-cutting | libs/shared |

If `$ARGUMENTS` doesn't match any service, list available services and ask the user to pick one.

Set these variables for subsequent steps:
- `SERVICE_NAME` = matched service name
- `DOMAIN` = matched domain
- `SERVICE_PATH` = matched path

## Step 2: Setup Workspace

Use the Bash tool to create the output directories:
```bash
mkdir -p agent-workspace/l3-findings/{DOMAIN}/{SERVICE_NAME}
mkdir -p agent-workspace/l2-reports/{DOMAIN}
```

## Step 3: Load Service Knowledge

Use the Read tool to read `.claude/agents/services/{DOMAIN}/{SERVICE_NAME}.md` for context about this service. Store this knowledge - you will include it in each specialist's prompt.

## Step 4: Run 6 Specialists in Parallel

Each Task uses `subagent_type: "general-purpose"`, `model: "sonnet"`, and `run_in_background: true`.

**IMPORTANT**: To avoid UI overload, run specialists in 2 batches of 3:

**Batch A** (launch 3 in ONE message, use `run_in_background: true`):
1. security-auditor
2. performance-analyst
3. bug-hunter

Wait for Batch A to complete.

**Batch B** (launch 3 in ONE message, use `run_in_background: true`):
4. architecture-reviewer
5. dependency-auditor
6. api-contract-validator

Wait for Batch B to complete.

### Task 1: Security Audit
```
name: "security-audit-{SERVICE_NAME}"
subagent_type: "general-purpose"
model: "sonnet"
prompt: |
  You are a security auditor. Read the specialist instructions from:
  .claude/agents/specialists/security-auditor.md

  Then read the service knowledge from:
  .claude/agents/services/{DOMAIN}/{SERVICE_NAME}.md

  Analyze ALL code in: {SERVICE_PATH}/src/

  Use Glob, Grep, and Read tools to thoroughly scan the codebase.
  Focus on: OWASP Top 10, auth bypass, injection, tenant isolation, secret exposure, CORS, CSRF, rate limiting.

  Write your findings to: agent-workspace/l3-findings/{DOMAIN}/{SERVICE_NAME}/security.md

  Use the standard finding format with CRITICAL/HIGH/MEDIUM/LOW severity levels.
  Include specific file paths and line numbers for every finding.
```

### Task 2: Performance Analysis
```
name: "performance-audit-{SERVICE_NAME}"
subagent_type: "general-purpose"
model: "sonnet"
prompt: |
  You are a performance analyst. Read the specialist instructions from:
  .claude/agents/specialists/performance-analyst.md

  Then read the service knowledge from:
  .claude/agents/services/{DOMAIN}/{SERVICE_NAME}.md

  Analyze ALL code in: {SERVICE_PATH}/src/

  Use Glob, Grep, and Read tools to thoroughly scan the codebase.
  Focus on: N+1 queries, missing indexes, memory leaks, async anti-patterns, caching gaps, connection pool issues.

  Write your findings to: agent-workspace/l3-findings/{DOMAIN}/{SERVICE_NAME}/performance.md

  Use the standard finding format with CRITICAL/HIGH/MEDIUM/LOW severity levels.
  Include specific file paths and line numbers for every finding.
```

### Task 3: Bug Hunt
```
name: "bug-hunt-{SERVICE_NAME}"
subagent_type: "general-purpose"
model: "sonnet"
prompt: |
  You are a bug hunter. Read the specialist instructions from:
  .claude/agents/specialists/bug-hunter.md

  Then read the service knowledge from:
  .claude/agents/services/{DOMAIN}/{SERVICE_NAME}.md

  Analyze ALL code in: {SERVICE_PATH}/src/

  Use Glob, Grep, and Read tools to thoroughly scan the codebase.
  Focus on: logic errors, race conditions, type safety, unhandled promises, null safety, DTO/entity mismatches, dead code.

  Write your findings to: agent-workspace/l3-findings/{DOMAIN}/{SERVICE_NAME}/bug-quality.md

  Use the standard finding format with CRITICAL/HIGH/MEDIUM/LOW severity levels.
  Include specific file paths and line numbers for every finding.
```

### Task 4: Architecture Review
```
name: "architecture-review-{SERVICE_NAME}"
subagent_type: "general-purpose"
model: "sonnet"
prompt: |
  You are an architecture reviewer. Read the specialist instructions from:
  .claude/agents/specialists/architecture-reviewer.md

  Then read the service knowledge from:
  .claude/agents/services/{DOMAIN}/{SERVICE_NAME}.md

  Analyze ALL code in: {SERVICE_PATH}/src/

  Use Glob, Grep, and Read tools to thoroughly scan the codebase.
  Focus on: SOLID principles, coupling/cohesion, circular deps, pattern consistency (CQRS, event-driven), module boundaries.

  Write your findings to: agent-workspace/l3-findings/{DOMAIN}/{SERVICE_NAME}/architecture.md

  Use the standard finding format with CRITICAL/HIGH/MEDIUM/LOW severity levels.
  Include specific file paths and line numbers for every finding.
```

### Task 5: Dependency Audit
```
name: "dependency-audit-{SERVICE_NAME}"
subagent_type: "general-purpose"
model: "sonnet"
prompt: |
  You are a dependency auditor. Read the specialist instructions from:
  .claude/agents/specialists/dependency-auditor.md

  Then read the service knowledge from:
  .claude/agents/services/{DOMAIN}/{SERVICE_NAME}.md

  Check package.json files in: {SERVICE_PATH}/
  Also check the root package.json for shared dependencies.

  Use Glob, Grep, Read, and Bash tools.
  Focus on: known CVEs, outdated packages, deprecated deps, license issues, duplicate deps.

  Write your findings to: agent-workspace/l3-findings/{DOMAIN}/{SERVICE_NAME}/dependency.md

  Use the standard finding format with CRITICAL/HIGH/MEDIUM/LOW severity levels.
```

### Task 6: API Contract Validation
```
name: "api-contract-{SERVICE_NAME}"
subagent_type: "general-purpose"
model: "sonnet"
prompt: |
  You are an API contract validator. Read the specialist instructions from:
  .claude/agents/specialists/api-contract-validator.md

  Then read the service knowledge from:
  .claude/agents/services/{DOMAIN}/{SERVICE_NAME}.md

  Analyze ALL code in: {SERVICE_PATH}/src/

  Use Glob, Grep, and Read tools to thoroughly scan the codebase.
  Focus on: DTO↔entity field sync, GraphQL schema↔resolver consistency, event contract↔implementation sync, column name: mappings (snake_case DB vs camelCase TS).

  Write your findings to: agent-workspace/l3-findings/{DOMAIN}/{SERVICE_NAME}/api-contract.md

  Use the standard finding format with CRITICAL/HIGH/MEDIUM/LOW severity levels.
  Include specific file paths and line numbers for every finding.
```

## Step 5: Wait and Verify

After all 6 tasks complete, verify all output files exist:
- `agent-workspace/l3-findings/{DOMAIN}/{SERVICE_NAME}/security.md`
- `agent-workspace/l3-findings/{DOMAIN}/{SERVICE_NAME}/performance.md`
- `agent-workspace/l3-findings/{DOMAIN}/{SERVICE_NAME}/bug-quality.md`
- `agent-workspace/l3-findings/{DOMAIN}/{SERVICE_NAME}/architecture.md`
- `agent-workspace/l3-findings/{DOMAIN}/{SERVICE_NAME}/dependency.md`
- `agent-workspace/l3-findings/{DOMAIN}/{SERVICE_NAME}/api-contract.md`

## Step 6: Synthesize (L2 Report)

Launch one more Task:
```
name: "synthesize-{SERVICE_NAME}"
subagent_type: "general-purpose"
model: "sonnet"
prompt: |
  You are a service report writer. Read your instructions from:
  .claude/agents/synthesizers/service-report-writer.md

  Read ALL 6 L3 finding files from:
  agent-workspace/l3-findings/{DOMAIN}/{SERVICE_NAME}/

  Files to read:
  - security.md
  - performance.md
  - bug-quality.md
  - architecture.md
  - dependency.md
  - api-contract.md

  Synthesize these into a consolidated L2 service report.
  Deduplicate findings, group by root cause, sort by severity.

  Write the report to: agent-workspace/l2-reports/{DOMAIN}/{SERVICE_NAME}.md
```

## Step 7: Present Results

After synthesis completes, read the L2 report and present to the user:
- Overall finding count by severity (CRITICAL / HIGH / MEDIUM / LOW)
- Top 5 most critical findings with brief descriptions
- Path to the full L2 report file

## farm-service Special Handling

If the service is `farm-service`, it's too large for a single scan. Split each specialist into 4 sub-scans:
- Group 1 (core): `apps/farm-service/src/farm/`, `apps/farm-service/src/tank/`, `apps/farm-service/src/batch/`, `apps/farm-service/src/site/`, `apps/farm-service/src/department/`
- Group 2 (ops): `apps/farm-service/src/feed/`, `apps/farm-service/src/feeding/`, `apps/farm-service/src/production/`, `apps/farm-service/src/maintenance/`
- Group 3 (assets): `apps/farm-service/src/equipment/`, `apps/farm-service/src/species/`, `apps/farm-service/src/chemical/`, `apps/farm-service/src/supplier/`
- Group 4 (system): `apps/farm-service/src/cache/`, `apps/farm-service/src/modules/`, `apps/farm-service/src/filters/`, `apps/farm-service/src/database/`

Run each specialist once per group (24 total tasks), then merge findings per specialist before synthesis.
