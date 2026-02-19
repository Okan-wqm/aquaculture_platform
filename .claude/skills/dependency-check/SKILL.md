---
name: dependency-check
description: "Package security and freshness check. CVE, outdated, license analysis across all workspaces."
---

## Parallel Agent Limit

**CRITICAL**: Never launch more than 3 Task agents in a single message.
Claude Code's UI crashes (React Error #185) with 4+ simultaneous agents.

Rules:
- Maximum 3 parallel Task calls per message
- Use `run_in_background: true` on all Task calls
- Wait for a batch to complete before starting the next

# Dependency Check

Run dependency audit across all package.json files in the platform.

## Step 1: Find All Package Files

Use Glob to find all package.json files:
```
package.json (root Nx workspace)
apps/*/package.json
web/shell/package.json
web/apps/*/package.json
web/modules/*/package.json
web/shared-ui/package.json
libs/*/package.json
```

Also check for Rust: `sens-api-gateway/Cargo.toml`

## Step 2: Setup

```bash
mkdir -p agent-workspace/l3-findings/dependencies
```

## Step 3: Run Dependency Audit

Launch 3 Tasks in ONE message, each with `subagent_type: "general-purpose"`, `model: "sonnet"`, and `run_in_background: true`:

### Task 1: Backend Dependencies
```
name: "dep-audit-backend"
subagent_type: "general-purpose"
model: "sonnet"
prompt: |
  You are a dependency auditor. Read instructions from .claude/agents/specialists/dependency-auditor.md

  Analyze ALL backend package.json files:
  - Root package.json (Nx workspace - shared dependencies)
  - apps/gateway-api/package.json
  - apps/auth-service/package.json
  - apps/farm-service/package.json
  - apps/sensor-service/package.json
  - apps/alert-engine/package.json
  - apps/notification-service/package.json
  - apps/hr-service/package.json
  - apps/billing-service/package.json
  - apps/admin-api-service/package.json
  - apps/config-service/package.json
  - apps/observability-service/package.json
  - apps/event-store-service/package.json
  - apps/hydroponics-service/package.json

  Also run: npm audit (via Bash) at root level.

  Check for: known CVEs, outdated majors, deprecated packages, license issues, duplicate deps.

  Write findings to: agent-workspace/l3-findings/dependencies/backend.md
```

### Task 2: Frontend Dependencies
```
name: "dep-audit-frontend"
subagent_type: "general-purpose"
model: "sonnet"
prompt: |
  You are a dependency auditor. Read instructions from .claude/agents/specialists/dependency-auditor.md

  Analyze ALL frontend package.json files:
  - web/shell/package.json
  - web/modules/dashboard/package.json
  - web/modules/farm-module/package.json
  - web/modules/admin-panel/package.json
  - web/modules/tenant-admin/package.json
  - web/modules/hr-module/package.json
  - web/modules/sensor-module/package.json
  - web/modules/hydroponics-module/package.json
  - web/apps/aquamobil/package.json
  - web/shared-ui/package.json

  Check for: known CVEs, outdated majors, deprecated packages, bundle size impact, duplicate deps across modules.

  Write findings to: agent-workspace/l3-findings/dependencies/frontend.md
```

### Task 3: Infra & Edge Dependencies
```
name: "dep-audit-infra"
subagent_type: "general-purpose"
model: "sonnet"
prompt: |
  You are a dependency auditor. Read instructions from .claude/agents/specialists/dependency-auditor.md

  Analyze:
  - libs/backend-common/package.json
  - libs/event-contracts/package.json
  - Any other libs/*/package.json
  - sens-api-gateway/Cargo.toml (if exists - Rust dependencies)

  Check for: known CVEs, outdated versions, license issues.

  Write findings to: agent-workspace/l3-findings/dependencies/infra-edge.md
```

## Step 4: Present Results

Read all 3 finding files and present:
- CRITICAL vulnerabilities (known exploits)
- Number of outdated major versions
- License concerns
- Duplicate dependency waste across workspaces
