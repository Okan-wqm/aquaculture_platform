# 02 - AI Service Scaffold

## Overview

The `ai-service` is a NestJS microservice that runs on **port 3008** and provides the AI agent runtime for the aquaculture platform.

## Bootstrap (main.ts)

`apps/ai-service/src/main.ts` configures:

- **Helmet** - HTTP security headers (CSP, HSTS, X-Frame-Options, etc.)
- **CORS** - Configurable origins via `CORS_ORIGINS` env var; wildcard blocked in production
- **Trust proxy** - Configurable via `TRUST_PROXY` env var for reverse proxy deployments
- **ValidationPipe** - `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`; error messages disabled in production
- **Graceful shutdown** - `app.enableShutdownHooks()`

## Root Module (app.module.ts)

```
AppModule
  imports:
    ConfigModule.forRoot({ isGlobal: true })
    TypeOrmModule.forRootAsync(...)         # PostgreSQL, no static schema
    GraphQLModule.forRootAsync(...)         # Apollo Federation 2
    JwtModule.registerAsync({ global: true })
    EventBusModule.forRootAsync(...)        # NATS JetStream
    ThrottlerModule                         # Rate limiting
    ToolRegistryModule                      # Tool registry + executor
    WaterChemistryToolsModule              # 7 water chemistry tools
    HealthModule
    ConversationModule
    AgentConfigModule
    AuditModule
    CostModule
    ChatModule
  providers:
    TenantGuard    (APP_GUARD)
    RolesGuard     (APP_GUARD)
    ThrottlerGuard (APP_GUARD)
```

### TypeORM Configuration

- No static `schema` set -- schema isolation is handled dynamically by `TenantSchemaMiddleware` via `SET search_path`
- Entities: `AgentConversation`, `TenantAgentConfig`, `ToolExecutionAudit`
- `synchronize` only enabled in non-production when `DATABASE_SYNC=true`
- SSL configurable via `DB_SSL`, `DATABASE_SSL_CA`, `DATABASE_SSL_REJECT_UNAUTHORIZED`
- Connection pool: `DB_POOL_SIZE` (default 5), idle timeout 30s, connection timeout 10s

### GraphQL Configuration

- Apollo Federation 2 driver with auto-generated schema
- Depth limit: 10 (via `graphql-depth-limit`)
- Query complexity analysis with caching (SHA1 hash of query + operation name); max complexity 1000
- Playground/introspection disabled in production by default

## Middleware Chain (applied in order)

All middleware is applied to all routes except `/health` and `/health/*`:

1. **CorrelationIdMiddleware** - Extracts or generates `X-Correlation-Id` header for distributed tracing
2. **UserContextMiddleware** - Parses `x-user-payload` header from gateway, attaches user context to request
3. **TenantContextMiddleware** - Extracts `tenantId` from JWT claims or headers
4. **TenantSchemaMiddleware** - Validates tenant schema exists (with caching), executes `SET search_path TO "tenant_xxx", ai, public`

Middleware 1-3 are imported from `@platform/backend-common`. Middleware 4 is local to ai-service.

## Global Guards

| Guard            | Purpose                                              |
|------------------|------------------------------------------------------|
| `TenantGuard`    | Rejects requests without a valid tenant context       |
| `RolesGuard`     | Checks `@Roles()` decorator against user JWT roles    |
| `ThrottlerGuard` | Rate limits per-tenant and per-user                   |

## TenantSchemaMiddleware

File: `apps/ai-service/src/middleware/tenant-schema.middleware.ts`

Responsible for per-request PostgreSQL schema isolation:

1. Extracts `tenantId` from `req.tenantId` or `req.user.tenantId`
2. Validates UUID format
3. Derives schema name: `tenant_` + first 16 chars of UUID (hyphens removed, lowercased)
4. Checks schema existence against `pg_catalog.pg_namespace` (cached with 5-minute TTL, max 1000 entries, request coalescing for concurrent checks)
5. Sets `search_path TO "tenant_xxx", ai, public`
6. Registers cleanup on `res.finish`/`res.close` to `RESET search_path`

## Directory Structure

```
apps/ai-service/src/
  main.ts                                         # Bootstrap
  app.module.ts                                   # Root module
  middleware/
    tenant-schema.middleware.ts                    # Per-request schema isolation
  health/
    health.module.ts
    health.controller.ts
    health.resolver.ts
  tools/
    core/
      tool.interface.ts                           # ITool, ToolMetadata, ToolResult, ToolExecutionContext
      tool.decorator.ts                           # @Tool() class decorator
      base-tool.ts                                # BaseTool abstract class
      base-tenant-tool.ts                         # TenantScopedTool (SET LOCAL search_path)
      tool-executor.service.ts                    # Permission check -> execute -> audit log
      index.ts                                    # Re-exports
    tool-registry.service.ts                      # Central tool registry (Map-based)
    tool-registry.module.ts                       # Registry + executor providers
    water-chemistry/
      calculate-ammonia-toxicity.tool.ts
      calculate-h2s-toxicity.tool.ts
      calculate-co2-level.tool.ts
      calculate-carbonate-chemistry.tool.ts
      calculate-reagent-dosing.tool.ts
      get-reagent-list.tool.ts
      simulate-dosing-effect.tool.ts
      water-chemistry-tools.module.ts
  agent/
    agent.module.ts
    agent-runner.service.ts                       # Agentic tool loop (Anthropic Messages API)
    agent-profile.service.ts                      # Persona resolution + tenant config merge
    personas/
      operator.ts                                 # operator-v1 persona definition
      manager.ts                                  # manager-v1 persona definition
      expert.ts                                   # expert-v1 persona definition
      supervisor.ts                               # supervisor-v1 persona definition
      index.ts                                    # Re-exports
  chat/
    chat.module.ts
    chat.controller.ts                            # POST /api/v2/ai/chat (SSE), POST /api/v2/ai/conversations
  conversation/
    conversation.module.ts
    conversation.entity.ts                        # AgentConversation (JSONB messages)
    conversation.service.ts                       # CRUD + JSONB append
  tenant-config/
    agent-config.module.ts
    agent-config.entity.ts                        # TenantAgentConfig
    agent-config.service.ts                       # Get/upsert config with defaults
  audit/
    audit.module.ts
    tool-execution-audit.entity.ts                # ToolExecutionAudit
    audit.service.ts                              # Log tool executions
  cost/
    cost.module.ts
    token-budget.service.ts                       # Monthly token budget (in-memory)
    rate-limit.service.ts                         # Hourly rate limiting (in-memory)
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AI_SERVICE_PORT` | 3008 | HTTP listen port |
| `DATABASE_HOST` | localhost | PostgreSQL host |
| `DATABASE_PORT` | 5432 | PostgreSQL port |
| `DATABASE_USER` | postgres | PostgreSQL user |
| `DATABASE_PASSWORD` | (required in prod) | PostgreSQL password |
| `DATABASE_NAME` | aquaculture | PostgreSQL database |
| `DATABASE_SYNC` | false | TypeORM synchronize (non-prod only) |
| `DB_SSL` | false | Enable SSL |
| `DB_POOL_SIZE` | 5 | Connection pool max |
| `JWT_SECRET` | (required) | JWT signing secret |
| `JWT_EXPIRES_IN` | 1d | JWT expiration |
| `NATS_URL` | nats://localhost:4222 | NATS server URL |
| `NATS_STREAM_NAME` | AQUACULTURE_EVENTS | JetStream stream name |
| `ANTHROPIC_API_KEY` | (required) | Anthropic API key |
| `AI_MAX_TOOL_LOOPS` | 10 | Max tool loop iterations |
| `CORS_ORIGINS` | * | Comma-separated origins (wildcard blocked in prod) |
| `TRUST_PROXY` | false | Trust proxy configuration |
| `NODE_ENV` | - | Environment (production enables security hardening) |
| `GRAPHQL_PLAYGROUND` | true | Enable GraphQL playground (non-prod) |
| `GRAPHQL_INTROSPECTION` | false | Enable GraphQL introspection (prod) |
