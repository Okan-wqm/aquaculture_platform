---
name: analyze-system
description: "Full system analysis - 13 backend, 10 frontend, infra, edge. Coordinates agents across 5 domains."
argument-hint: "[--security-only | --performance-only | --quick]"
---

## Parallel Agent Limit

**CRITICAL**: Never launch more than 3 Task agents in a single message.
Claude Code's UI crashes (React Error #185) with 4+ simultaneous agents.

Rules:
- Maximum 3 parallel Task calls per message
- Use `run_in_background: true` on all Task calls
- Wait for a batch to complete before starting the next
- Check background task output with Read tool on the output_file

# Full System Analysis

Orchestrate a comprehensive analysis of the entire aquaculture platform.

## Service Registry

### Backend (13 services)
| Name | Path | Size |
|------|------|------|
| gateway-api | apps/gateway-api | large |
| auth-service | apps/auth-service | large |
| farm-service | apps/farm-service | xlarge |
| sensor-service | apps/sensor-service | large |
| alert-engine | apps/alert-engine | medium |
| notification-service | apps/notification-service | small |
| hr-service | apps/hr-service | large |
| billing-service | apps/billing-service | medium |
| admin-api-service | apps/admin-api-service | large |
| config-service | apps/config-service | small |
| observability-service | apps/observability-service | small |
| event-store-service | apps/event-store-service | small |
| hydroponics-service | apps/hydroponics-service | small |

### Frontend (10 modules)
| Name | Path |
|------|------|
| shell | web/shell |
| dashboard | web/modules/dashboard |
| farm-module | web/modules/farm-module |
| admin-panel | web/modules/admin-panel |
| tenant-admin | web/modules/tenant-admin |
| hr-module | web/modules/hr-module |
| sensor-module | web/modules/sensor-module |
| hydroponics-module | web/modules/hydroponics-module |
| aquamobil | web/apps/aquamobil |
| shared-ui | web/shared-ui |

### Infrastructure (6)
| Name | Path |
|------|------|
| docker | infrastructure/docker, docker-compose*.yml |
| kubernetes | infrastructure/kubernetes |
| terraform | infrastructure/terraform |
| helm | infrastructure/helm |
| ci-cd | .github |
| nginx-monitoring | nginx, infrastructure/monitoring |

### Edge (2)
| Name | Path |
|------|------|
| sens-api-gateway | sens-api-gateway |
| sens-repo | sens-repo |

### Cross-Cutting (3)
| Name | Path |
|------|------|
| backend-common | libs/backend-common |
| event-contracts | libs/event-contracts |
| shared-sdk-storage | libs/shared, libs/sdk, libs/storage |

## Phase 0: Parse Arguments
- `--security-only`: Only run security-auditor on each service
- `--performance-only`: Only run performance-analyst on each service
- `--quick`: Only analyze large/xlarge services, skip small ones
- No args: Full analysis (security + performance + bug-hunter on each service)

## Phase 1: Setup Workspace

Use Bash to create the full directory tree:
```bash
mkdir -p agent-workspace/blackboard
mkdir -p agent-workspace/l3-findings/backend/{gateway-api,auth-service,farm-service,sensor-service,alert-engine,notification-service,hr-service,billing-service,admin-api-service,config-service,observability-service,event-store-service,hydroponics-service}
mkdir -p agent-workspace/l3-findings/frontend/{shell,dashboard,farm-module,admin-panel,tenant-admin,hr-module,sensor-module,hydroponics-module,aquamobil,shared-ui}
mkdir -p agent-workspace/l3-findings/infrastructure/{docker,kubernetes,terraform,helm,ci-cd,nginx-monitoring}
mkdir -p agent-workspace/l3-findings/edge/{sens-api-gateway,sens-repo}
mkdir -p agent-workspace/l3-findings/cross-cutting/{backend-common,event-contracts,shared-sdk-storage}
mkdir -p agent-workspace/l2-reports/{backend,frontend,infrastructure,edge,cross-cutting}
mkdir -p agent-workspace/l1-reports
mkdir -p agent-workspace/cross-references
```

## Phase 2: Backend Analysis (13 services)

For each backend service, launch 3 Tasks IN PARALLEL (all in ONE message).
Use `subagent_type: "general-purpose"`, `model: "sonnet"`.

Each Task prompt follows this template:
```
You are a {SPECIALIST}. Read instructions from .claude/agents/specialists/{SPECIALIST}.md
Read service knowledge from .claude/agents/services/backend/{SERVICE}.md
Analyze ALL code in: apps/{SERVICE}/src/
Write findings to: agent-workspace/l3-findings/backend/{SERVICE}/{SPECIALIST_OUTPUT}.md
Use CRITICAL/HIGH/MEDIUM/LOW severity. Include file paths and line numbers.
```

Specialists per service (unless --security-only or --performance-only):
| Specialist | Output file | Focus |
|-----------|-------------|-------|
| security-auditor | security.md | OWASP, auth, injection, tenant isolation |
| performance-analyst | performance.md | N+1, caching, memory, async |
| bug-hunter | bug-quality.md | Logic errors, race conditions, type safety |

**Process services 1 at a time using 3 specialists per wave** (each wave = 1 service × 3 specialists = 3 parallel tasks).
Use `run_in_background: true` on all Task calls. Launch exactly 3 Tasks per message, then wait.

Wave 1: gateway-api (3 specialists in parallel)
Wave 2: auth-service (3 specialists in parallel)
Wave 3: farm-service (3 specialists in parallel)
Wave 4: sensor-service (3 specialists in parallel)
Wave 5: alert-engine (3 specialists in parallel)
Wave 6: hr-service (3 specialists in parallel)
Wave 7: billing-service (3 specialists in parallel)
Wave 8: admin-api-service (3 specialists in parallel)
Wave 9: notification-service (3 specialists in parallel)
Wave 10: config-service (3 specialists in parallel)
Wave 11: observability-service (3 specialists in parallel)
Wave 12: event-store-service (3 specialists in parallel)
Wave 13: hydroponics-service (3 specialists in parallel)

For farm-service (xlarge), in the prompt tell the specialist to analyze in 4 groups:
- Group 1 (core): farm/, tank/, batch/, site/, department/
- Group 2 (ops): feed/, feeding/, production/, maintenance/
- Group 3 (assets): equipment/, species/, chemical/, supplier/
- Group 4 (system): cache/, modules/, filters/, database/

After each wave completes, launch the service-report-writer Task for that service:
```
Read .claude/agents/synthesizers/service-report-writer.md
Read all L3 files from agent-workspace/l3-findings/backend/{SERVICE}/
Write synthesized report to agent-workspace/l2-reports/backend/{SERVICE}.md
```

## Phase 3: Frontend Analysis (10 modules)

Same pattern as backend but adjust specialist prompts for frontend focus (XSS, bundle size, re-renders, state management).
Process 1 module at a time with 3 specialists per wave (3 parallel Tasks per message).

## Phase 4: Infrastructure + Edge + Cross-Cutting

Run in batches of 3 Tasks per message using `run_in_background: true`:
- Batch 1: 3 infra components × 1 specialist each (security or architecture)
- Batch 2: next 3 infra/edge/cross-cutting components
- Continue until all components are covered

## Phase 5: Domain Reports (L1)

After all L2 reports are written, launch domain-report-writer Tasks in batches of 3 (use `run_in_background: true`):
```
For each domain in [backend, frontend, infrastructure, edge, cross-cutting]:
  Read .claude/agents/synthesizers/domain-report-writer.md
  Read all L2 reports from agent-workspace/l2-reports/{DOMAIN}/
  Write domain report to agent-workspace/l1-reports/{DOMAIN}.md
```

## Phase 6: Cross-Flow Analysis

Launch 3 cross-flow Tasks in parallel:
```
Task 1: Read .claude/agents/cross-flow/cross-service-validator.md
  Analyze API contracts across all services.
  Write to agent-workspace/cross-references/api-contract-issues.md

Task 2: Read .claude/agents/cross-flow/event-flow-analyzer.md
  Analyze NATS event flows across all services.
  Write to agent-workspace/cross-references/event-flow-issues.md

Task 3: Read .claude/agents/cross-flow/tenant-isolation-checker.md
  Check tenant isolation across all services.
  Write to agent-workspace/cross-references/tenant-schema-issues.md
```

## Phase 7: Final Report

Launch system-report-writer:
```
Read .claude/agents/synthesizers/system-report-writer.md
Read ALL L1 reports from agent-workspace/l1-reports/
Read ALL cross-reference files from agent-workspace/cross-references/
Write final report to agent-workspace/final-report.md
```

## Phase 8: Present to User

Read agent-workspace/final-report.md and present:
- System health score
- Top 10 critical findings across the entire platform
- Cross-flow vulnerabilities
- Phased remediation roadmap
- Paths to detailed reports for drill-down
