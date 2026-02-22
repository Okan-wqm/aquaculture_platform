# 06 - Agent Runtime

## Overview

The agent runtime is the core execution layer of the AI agent platform. It manages the Anthropic Messages API tool loop, persona-based profiles, tenant configuration merging, cost controls, and conversation persistence.

## Agent Runner

File: `apps/ai-service/src/agent/agent-runner.service.ts`

`AgentRunnerService` implements the agentic tool loop using the `@anthropic-ai/sdk` Messages API:

1. **Pre-flight checks** - Validates tenant AI is enabled, checks rate limits, checks token budget
2. **Profile resolution** - Merges base persona with tenant-specific configuration
3. **Conversation setup** - Creates or resumes a conversation with message history
4. **Tool loop** - Sends messages to Claude, executes tool calls, feeds results back (max iterations configurable via `AI_MAX_TOOL_LOOPS`, default 10)
5. **Post-processing** - Saves assistant response, updates token usage counters

The tool loop terminates when:
- Claude responds with `stop_reason: 'end_turn'`
- Claude responds with only text blocks (no `tool_use` blocks)
- The maximum loop iteration count is reached

### Request Flow

```
ChatRequest
  -> agentConfig.isEnabled(tenantId)
  -> agentConfig.getConfig(tenantId) -> rate limit check (hourly per tenant)
  -> tokenBudget.checkBudget(tenantId) (monthly per tenant)
  -> profileService.resolveProfile(tenantId, persona)
  -> conversationService.create() or getById()
  -> load existing messages into array
  -> save user message to conversation (JSONB append)
  -> build Claude tool definitions from profile.effectiveToolNames
  -> LOOP (max AI_MAX_TOOL_LOOPS iterations):
       -> anthropic.messages.create({ model, max_tokens, system, tools, messages })
       -> accumulate token usage
       -> if no tool_use blocks or stop_reason=end_turn -> break
       -> for each tool_use block:
            -> toolExecutor.executeTool(name, input, ctx)
            -> collect tool results
       -> append assistant message + tool results to messages
  -> save assistant response to conversation (JSONB append)
  -> update token budget + conversation token count
  -> return ChatResponse
```

### Tool Execution Within the Loop

Tool calls within a single loop iteration are currently executed **sequentially** (one at a time in a `for...of` loop). Each tool call goes through the `ToolExecutorService` pipeline (permission check, execution, audit log).

## Agent Personas

Four built-in personas with escalating capabilities:

| Persona | Model ID | Max Tokens | Actuation Policy | Use Case |
|---------|----------|-----------|------------------|----------|
| **Operator** (operator-v1) | `claude-haiku-4-5-20250515` | 4,096 | confirm_required | Frontline operators: water quality, sensors, alerts |
| **Manager** (manager-v1) | `claude-sonnet-4-5-20250514` | 8,192 | blocked | Farm managers: analytics, dosing simulation, reports |
| **Expert** (expert-v1) | `claude-sonnet-4-5-20250514` | 16,384 | confirm_required | Scientists: advanced chemistry, dosing with confirmation |
| **Supervisor** (supervisor-v1) | `claude-sonnet-4-5-20250514` | 16,384 | allowed | Autonomous monitoring: actuation within safety limits |

Files: `apps/ai-service/src/agent/personas/{operator,manager,expert,supervisor}.ts`

### Tool Access by Persona

| Tool | Operator | Manager | Expert | Supervisor |
|------|----------|---------|--------|------------|
| `calculate_ammonia_toxicity` | Yes | Yes | Yes | Yes |
| `calculate_h2s_toxicity` | Yes | Yes | Yes | Yes |
| `calculate_co2_level` | Yes | Yes | Yes | Yes |
| `calculate_carbonate_chemistry` | Yes | Yes | Yes | Yes |
| `get_reagent_list` | Yes | Yes | Yes | Yes |
| `calculate_reagent_dosing` | - | Yes | Yes | Yes |
| `simulate_dosing_effect` | - | Yes | Yes | Yes |

### Actuation Policies

- `blocked` - Cannot execute actuation tools at all
- `confirm_required` - Actuation tools require human confirmation before execution
- `allowed` - Can execute actuation tools autonomously (within platform safety limits)

## Profile Resolution

File: `apps/ai-service/src/agent/agent-profile.service.ts`

`AgentProfileService.resolveProfile()` merges configuration layers:

```
Effective Profile = Base Persona
  + tenant.additionalToolNames (only if registered in live tool registry)
  - tenant.blockedToolNames
  + tenant.customSystemPrompt (appended with "--- Tenant-Specific Instructions ---" header)
  + min(base.actuationPolicy, tenant.actuationPolicy)  // most restrictive wins
```

The actuation policy resolution uses a priority system: `blocked` (0) < `confirm_required` (1) < `allowed` (2). The minimum priority value wins, ensuring a tenant cannot escalate beyond the base persona's policy.

Tool names are filtered against the live tool registry -- only tools that are actually registered in `ToolRegistryService` are included.

## Cost Control

Two layers of cost control are enforced before every chat request:

### Token Budget (Monthly)
- `TokenBudgetService` tracks cumulative token usage per tenant per calendar month
- Default budget: 1,000,000 tokens/month (configurable per tenant via `TenantAgentConfig.monthlyTokenBudget`)
- Requests are rejected when budget is exceeded
- Currently uses in-memory `Map<string, number>` keyed by `ai:tokens:{tenantId}:{YYYY-MM}`
- Designed to be replaced with Redis

### Rate Limiting (Hourly)
- `RateLimitService` enforces hourly request count limits per tenant
- Default limit: 60 requests/hour (configurable per tenant via `TenantAgentConfig.hourlyRequestLimit`)
- Uses in-memory `Map<string, { count, resetAt }>` with automatic reset after 1 hour
- Designed to be replaced with Redis sliding window

Both services currently use in-memory counters that reset on process restart.

## Conversation Management

`ConversationService` persists conversation state in PostgreSQL:

- Each conversation tracks: tenant, user, persona, messages (JSONB array), total tokens, active status
- Messages include role, content, tool use records, and timestamps
- New messages are appended via JSONB `||` concatenation (`messages || '[...]'::jsonb`)
- Full conversation history is loaded and sent to Claude for context continuity
- Token counts are accumulated per conversation for billing attribution

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `ANTHROPIC_API_KEY` | (required) | Anthropic API key for Claude |
| `AI_MAX_TOOL_LOOPS` | 10 | Maximum tool call iterations per request |

Tenant-level configuration is managed via `TenantAgentConfig` entity (see [05-entities-and-config](05-entities-and-config.md)).

## Files

- `apps/ai-service/src/agent/agent-runner.service.ts` - AgentRunnerService (tool loop)
- `apps/ai-service/src/agent/agent-profile.service.ts` - AgentProfileService (persona resolution)
- `apps/ai-service/src/agent/agent.module.ts` - AgentModule
- `apps/ai-service/src/agent/personas/operator.ts` - Operator persona
- `apps/ai-service/src/agent/personas/manager.ts` - Manager persona
- `apps/ai-service/src/agent/personas/expert.ts` - Expert persona
- `apps/ai-service/src/agent/personas/supervisor.ts` - Supervisor persona
- `apps/ai-service/src/agent/personas/index.ts` - Re-exports
