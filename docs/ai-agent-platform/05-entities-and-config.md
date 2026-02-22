# 05 - Database Entities, Tenant Config & Cost Control

## Overview

This document covers the persistence layer, tenant configuration, audit trail, and cost control modules for the AI Agent Platform.

## Database Entities

### agent_conversations (tenant schema)

Stores full conversation history between users and AI agents.

| Column | Type | Description |
|--------|------|-------------|
| id | UUID (PK) | Conversation ID |
| tenantId | UUID | Tenant identifier |
| userId | UUID | User who started the conversation |
| persona | VARCHAR(50) | Agent persona used (operator-v1, manager-v1, etc.) |
| messages | JSONB | Array of message objects with role, content, toolUse, timestamp |
| title | VARCHAR(255) | Optional conversation title |
| totalTokens | INT | Total tokens consumed |
| isActive | BOOLEAN | Whether conversation is still active |
| createdAt | TIMESTAMP | Creation time |
| updatedAt | TIMESTAMP | Last update time |

**Indexes:** `(tenantId, userId, createdAt)`

**File:** `apps/ai-service/src/conversation/conversation.entity.ts`

### tenant_agent_configs (tenant schema)

Per-tenant AI configuration controlling profiles, tools, actuation, and costs.

| Column | Type | Description |
|--------|------|-------------|
| id | UUID (PK) | Config ID |
| tenantId | UUID (UNIQUE) | Tenant identifier |
| baseProfileId | VARCHAR(50) | Base persona (operator-v1, manager-v1, etc.) |
| additionalToolNames | JSONB | Extra tools added by tenant |
| blockedToolNames | JSONB | Tools blocked by tenant |
| actuationPolicy | VARCHAR(50) | blocked / confirm_required / allowed |
| customSystemPrompt | TEXT | Tenant-specific system prompt addition |
| applicableRoles | JSONB | Which roles can use AI |
| isEnabled | BOOLEAN | Master switch for AI features |
| proactiveMonitoringEnabled | BOOLEAN | Enable event-driven analysis |
| autonomousActionsEnabled | BOOLEAN | Enable autonomous actuation |
| autonomousSafetyLimits | JSONB | Safety limits for autonomous actions |
| monthlyTokenBudget | INT | Monthly token limit (default 1M) |
| hourlyRequestLimit | INT | Max requests per hour (default 60) |
| mcpEnabled | BOOLEAN | Enable MCP server access |
| mcpAllowedPersonas | JSONB | Which personas MCP can use |

**Indexes:** `(tenantId)` UNIQUE

**File:** `apps/ai-service/src/tenant-config/agent-config.entity.ts`

### tool_execution_audit (tenant schema)

Audit trail for every tool execution.

| Column | Type | Description |
|--------|------|-------------|
| id | UUID (PK) | Audit entry ID |
| tenantId | UUID | Tenant identifier |
| userId | UUID | User who triggered the execution |
| toolName | VARCHAR(100) | Tool that was executed |
| persona | VARCHAR(50) | Agent persona |
| input | JSONB | Tool input parameters |
| success | BOOLEAN | Whether execution succeeded |
| output | JSONB | Tool output (if success) |
| errorMessage | TEXT | Error message (if failed) |
| durationMs | INT | Execution time |
| correlationId | VARCHAR(100) | Request correlation ID |
| conversationId | UUID | Linked conversation |
| executed_at | TIMESTAMP | When the tool was executed |

**Indexes:** `(tenantId, executed_at)`, `(toolName, executed_at)`

**File:** `apps/ai-service/src/audit/tool-execution-audit.entity.ts`

## Services

### ConversationService

- `create(params)` - Create new conversation
- `addMessage(conversationId, message)` - Append message using JSONB concat
- `getById(id)` - Get conversation by ID
- `getRecentByUser(tenantId, userId, limit)` - List recent conversations
- `updateTokenCount(conversationId, tokens)` - Increment token counter
- `deactivate(conversationId)` - Mark conversation inactive

**File:** `apps/ai-service/src/conversation/conversation.service.ts`

### AgentConfigService

- `getConfig(tenantId)` - Get config with fallback to defaults
- `upsertConfig(tenantId, updates)` - Create or update config
- `isEnabled(tenantId)` - Quick check if AI is enabled

**File:** `apps/ai-service/src/tenant-config/agent-config.service.ts`

### AuditService

- `logToolExecution(toolName, input, result, ctx, conversationId)` - Non-blocking audit log
- `getRecentExecutions(tenantId, limit)` - Query recent executions

**File:** `apps/ai-service/src/audit/audit.service.ts`

### TokenBudgetService

- `getUsage(tenantId)` - Get current monthly usage
- `addUsage(tenantId, tokens)` - Increment usage counter
- `checkBudget(tenantId, budget)` - Check if within budget

Uses in-memory counters (to be replaced with Redis).

**File:** `apps/ai-service/src/cost/token-budget.service.ts`

### RateLimitService

- `checkRateLimit(tenantId, limit)` - Sliding window rate check

Uses in-memory counters with hourly reset (to be replaced with Redis).

**File:** `apps/ai-service/src/cost/rate-limit.service.ts`

## MODULE_SCHEMAS Entry

Added to `libs/backend-common/src/database/schema-manager.service.ts`:

```typescript
{
  moduleName: 'ai',
  sourceSchema: 'ai',
  referenceDataTables: [],
  tables: [
    'agent_conversations',
    'agent_action_logs',
    'tenant_agent_configs',
    'tool_execution_audit',
  ],
}
```

## Files Created

- `apps/ai-service/src/conversation/conversation.entity.ts`
- `apps/ai-service/src/conversation/conversation.service.ts`
- `apps/ai-service/src/conversation/conversation.module.ts`
- `apps/ai-service/src/tenant-config/agent-config.entity.ts`
- `apps/ai-service/src/tenant-config/agent-config.service.ts`
- `apps/ai-service/src/tenant-config/agent-config.module.ts`
- `apps/ai-service/src/audit/tool-execution-audit.entity.ts`
- `apps/ai-service/src/audit/audit.service.ts`
- `apps/ai-service/src/audit/audit.module.ts`
- `apps/ai-service/src/cost/token-budget.service.ts`
- `apps/ai-service/src/cost/rate-limit.service.ts`
- `apps/ai-service/src/cost/cost.module.ts`
