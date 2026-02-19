---
name: cross-flow-check
description: "Run cross-flow analyses across service boundaries. 7 flows covering mobile-API, edge-sensor, billing, alert, tenant provisioning, HR, NATS events."
argument-hint: "[flow-number 1-7 | --all]"
---

## Parallel Agent Limit

**CRITICAL**: Never launch more than 3 Task agents in a single message.
Claude Code's UI crashes (React Error #185) with 4+ simultaneous agents.

Rules:
- Maximum 3 parallel Task calls per message
- Use `run_in_background: true` on all Task calls
- Wait for a batch to complete before starting the next

# Cross-Flow Check

Analyze critical data flows that cross multiple service boundaries.

## Available Flows

| # | Flow | Key Services |
|---|------|-------------|
| 1 | Mobile → API → Farm | aquamobil, gateway-api, auth-service, farm-service |
| 2 | Edge → Sensor Pipeline | sens-api-gateway, sensor-service, alert-engine |
| 3 | Billing Lifecycle | admin-api-service, billing-service, auth-service, gateway-api |
| 4 | Alert Pipeline | sensor-service, alert-engine, notification-service |
| 5 | Tenant Provisioning | admin-api-service, auth-service, farm-service, backend-common |
| 6 | HR/Attendance → Payroll | aquamobil, hr-service |
| 7 | NATS Event Bus | All services via libs/event-contracts |

## Step 1: Parse Arguments

- If `$ARGUMENTS` is a number 1-7, run only that flow
- If `$ARGUMENTS` is `--all` or empty, run all 7 flows
- Otherwise, show the table above and ask user to pick

## Step 2: Setup

Use Bash:
```bash
mkdir -p agent-workspace/cross-references
```

## Step 3: Run Selected Flows

For each selected flow, launch a Task with `subagent_type: "general-purpose"`, `model: "sonnet"`.

If running all 7 flows, use `run_in_background: true` on each Task and run in batches of 3:

**Batch 1** (launch flows 1, 2, 3 in ONE message, use `run_in_background: true`):
- Flow 1: Mobile → API → Farm
- Flow 2: Edge → Sensor Pipeline
- Flow 3: Billing Lifecycle

Wait for Batch 1 to complete.

**Batch 2** (launch flows 4, 5, 6 in ONE message, use `run_in_background: true`):
- Flow 4: Alert Pipeline
- Flow 5: Tenant Provisioning
- Flow 6: HR/Attendance → Payroll

Wait for Batch 2 to complete.

**Batch 3** (launch 1 agent, use `run_in_background: true`):
- Flow 7: NATS Event Bus

Wait for Batch 3 to complete.

### Flow 1: Mobile → API → Farm
```
name: "cross-flow-mobile-api"
subagent_type: "general-purpose"
model: "sonnet"
prompt: |
  You are analyzing the Mobile → API → Farm data flow in a multi-tenant aquaculture platform.

  Read these knowledge files first:
  - .claude/agents/services/frontend/aquamobil.md
  - .claude/agents/services/backend/gateway-api.md
  - .claude/agents/services/backend/auth-service.md
  - .claude/agents/services/backend/farm-service.md

  Then trace the data flow by reading actual code:

  1. OFFLINE QUEUE (web/apps/aquamobil/src/):
     - How does useOfflineQueue store pending mutations?
     - What happens on network reconnect? Is sync order preserved?
     - Is there conflict resolution for duplicate submissions?

  2. API GATEWAY (apps/gateway-api/src/):
     - How are mobile requests authenticated? JWT validation?
     - Rate limiting for mobile endpoints?
     - CORS configuration for mobile origin?

  3. AUTH → TENANT CONTEXT:
     - Is tenant context extracted from JWT and propagated?
     - What happens if JWT expires during offline period?

  4. FARM SERVICE (apps/farm-service/src/):
     - Do mobile mutation DTOs match backend Input types?
     - Is input validation consistent between mobile and backend?
     - Is search_path set correctly for the tenant?

  Write findings to: agent-workspace/cross-references/flow-1-mobile-api.md
  Use CRITICAL/HIGH/MEDIUM/LOW severity with file paths.
```

### Flow 2: Edge → Sensor Pipeline
```
name: "cross-flow-edge-sensor"
subagent_type: "general-purpose"
model: "sonnet"
prompt: |
  You are analyzing the Edge Device → Sensor Pipeline flow.

  Read these knowledge files first:
  - .claude/agents/services/edge/sens-api-gateway.md
  - .claude/agents/services/backend/sensor-service.md
  - .claude/agents/services/backend/alert-engine.md

  Then trace the data flow by reading actual code:

  1. EDGE AGENT (sens-api-gateway/src/):
     - MQTT payload format: what fields are sent?
     - TLS certificate handling
     - Offline queue: SQLite buffer, recovery after reconnect?
     - Device to tenant mapping

  2. SENSOR SERVICE (apps/sensor-service/src/):
     - MQTT subscriber: does payload match expected DTO?
     - Batch processor: validation pipeline?
     - TimescaleDB: hypertable config, chunk interval?
     - Continuous aggregates: refresh interval?

  3. ALERT ENGINE (apps/alert-engine/src/):
     - SensorReading to rule evaluation latency?
     - Alert rule tenant isolation?
     - Alert storm protection (throttling)?

  Write findings to: agent-workspace/cross-references/flow-2-edge-sensor.md
  Use CRITICAL/HIGH/MEDIUM/LOW severity with file paths.
```

### Flow 3: Billing Lifecycle
```
name: "cross-flow-billing"
subagent_type: "general-purpose"
model: "sonnet"
prompt: |
  You are analyzing the Billing/Subscription lifecycle flow.

  Read these knowledge files first:
  - .claude/agents/services/backend/admin-api-service.md
  - .claude/agents/services/backend/billing-service.md
  - .claude/agents/services/backend/auth-service.md
  - .claude/agents/services/cross-cutting/event-contracts.md

  Trace the billing flow by reading actual code:

  1. SUBSCRIPTION CREATION:
     - admin-api creates tenant, emits TenantSubscriptionRequestedEvent
     - billing-service consumes and creates subscription
     - What if NATS is down? Retry/dead-letter handling?

  2. MODULE ACCESS:
     - Subscription to module access mapping?
     - JWT includes modules? Gateway checks?

  3. PAYMENT:
     - Payment webhook: replay attack protection?
     - Invoice generation: tenant-isolated?

  4. EXPIRATION:
     - Subscription expires: cascade behavior?
     - Grace period? Immediate lock?

  Write findings to: agent-workspace/cross-references/flow-3-billing.md
  Use CRITICAL/HIGH/MEDIUM/LOW severity with file paths.
```

### Flow 4: Alert Pipeline
```
name: "cross-flow-alert"
subagent_type: "general-purpose"
model: "sonnet"
prompt: |
  You are analyzing the Alert Pipeline flow.

  Read these knowledge files:
  - .claude/agents/services/backend/sensor-service.md
  - .claude/agents/services/backend/alert-engine.md
  - .claude/agents/services/backend/notification-service.md
  - .claude/agents/services/cross-cutting/event-contracts.md

  Trace: sensor reading → alert evaluation → notification → dashboard

  Check:
  - SensorReadingEvent to alert-engine: latency path, tenant isolation
  - Rule evaluation: tenant-specific rules isolated?
  - Escalation: timeout handling for unacknowledged alerts
  - Notification dispatch: template tenant-customizable?
  - Alert storm: throttle for repeated triggers?
  - Dead letter: failed event handling?

  Write findings to: agent-workspace/cross-references/flow-4-alert.md
  Use CRITICAL/HIGH/MEDIUM/LOW severity with file paths.
```

### Flow 5: Tenant Provisioning
```
name: "cross-flow-tenant"
subagent_type: "general-purpose"
model: "sonnet"
prompt: |
  You are analyzing the Tenant Provisioning flow. This is CRITICAL for the platform.

  Read these knowledge files:
  - .claude/agents/services/backend/admin-api-service.md
  - .claude/agents/services/backend/auth-service.md
  - .claude/agents/services/backend/farm-service.md
  - .claude/agents/services/cross-cutting/backend-common.md

  CRITICAL CHECK - Trace provisioning by reading actual code:

  1. admin-api POST /tenants: validate → assign modules → create schema
     - Module assignment MUST happen BEFORE schema creation - verify this order!

  2. Schema creation (libs/backend-common/src/database/schema-manager.service.ts):
     - MODULE_SCHEMAS: are ALL entity tables listed?
     - Compare MODULE_SCHEMAS entries with actual entity files in each service
     - REFERENCE_DATA_TABLES: all lookup tables copied?

  3. Admin user creation → invitation email → accept → first login

  4. Onboarding: all modules accessible? Trial → billing auto-subscription?

  Write findings to: agent-workspace/cross-references/flow-5-tenant.md
  Use CRITICAL/HIGH/MEDIUM/LOW severity with file paths.
```

### Flow 6: HR/Attendance → Payroll
```
name: "cross-flow-hr"
subagent_type: "general-purpose"
model: "sonnet"
prompt: |
  You are analyzing the HR/Attendance to Payroll flow.

  Read these knowledge files:
  - .claude/agents/services/frontend/aquamobil.md
  - .claude/agents/services/backend/hr-service.md
  - .claude/agents/services/frontend/hr-module.md

  Trace: mobile clock-in → attendance → approval → payroll

  Check:
  - Mobile clock-in: GPS validation? Offshore detection?
  - Attendance record: shift validation, leave deduction?
  - Approval workflow: tenant-customizable?
  - Payroll calculation: tenant-specific tax rules?
  - Certification expiry notification chain?
  - Offshore/onshore rotation calculation?

  Write findings to: agent-workspace/cross-references/flow-6-hr.md
  Use CRITICAL/HIGH/MEDIUM/LOW severity with file paths.
```

### Flow 7: NATS Event Bus
```
name: "cross-flow-nats"
subagent_type: "general-purpose"
model: "sonnet"
prompt: |
  You are analyzing the NATS Event Bus across ALL services.

  Read: .claude/agents/services/cross-cutting/event-contracts.md

  Then systematically check EVERY backend service for event usage:

  1. For each event in libs/event-contracts/src/:
     - Grep for event name + .emit( or .publish( across all apps/
     - Grep for @EventPattern or @MessagePattern across all apps/
     - Build a map: Event → [emitters] → [consumers]

  2. tenant_id CHECK (CRITICAL):
     - Does every event interface have tenantId? (should via BaseEvent)
     - Every emit() call includes tenantId?
     - Every handler extracts and uses tenantId?

  3. Idempotency:
     - Handlers that INSERT: use ON CONFLICT?
     - Handlers with side effects (email): dedup check?

  4. Dead letter / retry:
     - What happens on handler error?
     - Retry configuration?

  5. Contract sync:
     - Events defined in lib but never emitted?
     - Events emitted but not defined in lib?

  Write findings to: agent-workspace/cross-references/flow-7-nats.md
  Use CRITICAL/HIGH/MEDIUM/LOW severity with file paths.
```

## Step 4: Present Results

After all selected flows complete, read the output files and present:
- Flow-by-flow health summary (PASS / WARNING / FAIL)
- Top critical cross-flow issues
- Which service boundaries have the most friction/risk
