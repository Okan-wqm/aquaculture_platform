---
name: architecture-review
description: "Architecture review. SOLID, coupling, pattern consistency, module boundaries."
argument-hint: "[service-name | --all]"
---

## Parallel Agent Limit

**CRITICAL**: Never launch more than 3 Task agents in a single message.
Claude Code's UI crashes (React Error #185) with 4+ simultaneous agents.

Rules:
- Maximum 3 parallel Task calls per message
- Use `run_in_background: true` on all Task calls
- Wait for a batch to complete before starting the next

# Architecture Review

Run the architecture-reviewer specialist on specified service(s).

## Step 1: Parse Arguments

- If `$ARGUMENTS` is a service name from the registry below, analyze that service only
- If `$ARGUMENTS` is `--all` or empty, analyze all services

Service registry (same as analyze-service):

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
| farm-module | frontend | web/modules/farm-module |
| admin-panel | frontend | web/modules/admin-panel |
| shared-ui | frontend | web/shared-ui |

## Step 2: Setup

```bash
mkdir -p agent-workspace/l3-findings/{DOMAIN}/{SERVICE_NAME}
```

## Step 3: Run Architecture Review

For each selected service, launch a Task with `subagent_type: "general-purpose"`, `model: "sonnet"`:

```
You are an architecture reviewer. Read instructions from .claude/agents/specialists/architecture-reviewer.md
Read service knowledge from .claude/agents/services/{DOMAIN}/{SERVICE}.md
Analyze ALL code in: {PATH}/src/
Focus on: SOLID principles, coupling/cohesion, circular deps, CQRS consistency, event-driven patterns, module boundaries, code organization.
Write findings to: agent-workspace/l3-findings/{DOMAIN}/{SERVICE}/architecture.md
Use CRITICAL/HIGH/MEDIUM/LOW severity. Include file paths and line numbers.
```

Launch services in batches of maximum 3 per message, using `run_in_background: true` on each Task. Wait for each batch to complete before launching the next.

## Step 4: Present Results

If `--all`, also write a cross-service summary:
- Pattern consistency across services (CQRS adherence, event patterns)
- Module coupling hotspots
- Services that violate platform conventions
