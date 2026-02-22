# AI Agent Platform - Overview

## Project Goal

Build a layered AI agent system for the aquaculture platform that provides intelligent water quality analysis, proactive recommendations, and guided dosing operations through conversational interfaces. The system operates within the existing multi-tenant architecture, respecting tenant isolation, role-based permissions, and module licensing.

## Architecture

```
                          +--------------------+
                          |   Web Frontend     |
                          |  (Chat Panel SSE)  |
                          +--------+-----------+
                                   |
                          REST SSE / GraphQL
                                   |
                     +-------------v--------------+
                     |        ai-service           |
                     |       (port 3008)           |
                     |                             |
                     |  +----------+ +-----------+ |
                     |  | Agent    | | Tool      | |
                     |  | Runtime  | | Registry  | |
                     |  +----+-----+ +-----+-----+ |
                     |       |             |        |
                     |  +----v-------------v-----+  |
                     |  | Anthropic Messages API  |  |
                     |  | @anthropic-ai/sdk       |  |
                     |  +------------------------+  |
                     +---+--------+--------+--------+
                         |        |        |
                    NATS |   HTTP |   PG   |
                         |        |        |
          +--------------v--+ +---v---+ +--v-----------+
          | Event Bus       | | Other | | PostgreSQL   |
          | (NATS JetStream)| | Svcs  | | (per-tenant) |
          +-----------------+ +-------+ +--------------+
```

## Layer Breakdown

| Layer             | Purpose                                              |
|-------------------|------------------------------------------------------|
| **Tools**         | Atomic, auditable operations (calculate, query, act)  |
| **Agent Profiles**| Persona + system prompt + allowed tools per role      |
| **Tenant Config** | Per-tenant feature flags, model selection, limits     |
| **Execution Modes** | Chat (interactive), Proactive (scheduled), Event-driven |

## Service Map

The `ai-service` runs on **port 3008** and connects to the existing platform:

- **NATS JetStream** - Subscribes to sensor events (`telemetry.>`, `alert.>`), publishes agent events (`ai.{tenantId}.>`)
- **Internal HTTP** - Calls other services (farm-service, sensor-service, alert-service) for data retrieval tools
- **PostgreSQL** - Per-tenant schema for conversation history, agent config, audit logs
- **In-memory counters** - Token budget and rate limiting (placeholder for Redis)

## Technology Stack

| Component               | Technology                                  |
|-------------------------|---------------------------------------------|
| Runtime                 | Node.js 20 + NestJS 10                      |
| AI SDK                  | `@anthropic-ai/sdk` (Messages API)          |
| ORM                     | TypeORM (dynamic schema per tenant)         |
| Message Bus             | NATS JetStream (`@platform/event-bus`)      |
| Rate Limiting           | `@platform/backend-common` ThrottlerModule + in-memory counters |
| API                     | GraphQL (Apollo Federation 2) + REST SSE    |
| Database                | PostgreSQL (multi-tenant, schema-per-tenant)|
| Auth                    | JWT (shared `@platform/backend-common`)     |
| Shared Engines          | `@platform/aquaculture-engines`             |

## Security Model Summary

1. **JWT-only authentication** - All requests carry a JWT validated by the shared `JwtModule`
2. **Tenant isolation** - `TenantGuard` extracts `tenantId` from JWT; `TenantSchemaMiddleware` sets `SET search_path` before every DB call
3. **Role-based tool access** - Each tool declares `requiredPermissions`; `ToolExecutorService` checks user roles before execution
4. **Audit trail** - Every tool invocation is logged with tenantId, userId, tool name, inputs (sanitized), and outcome
5. **Rate limiting** - `ThrottlerGuard` enforces per-tenant and per-user request limits; `RateLimitService` enforces hourly request caps per tenant
6. **Confirmation gates** - Tools marked `requiresConfirmation: true` pause execution and require human approval before proceeding
7. **GraphQL depth limiting** - `graphql-depth-limit(10)` prevents deeply nested query abuse
8. **Query complexity analysis** - Per-request complexity scoring with a max threshold of 1000

## Files

- `apps/ai-service/src/main.ts` - Bootstrap, Helmet, CORS, ValidationPipe, shutdown hooks
- `apps/ai-service/src/app.module.ts` - Root module wiring all imports, guards, and middleware
