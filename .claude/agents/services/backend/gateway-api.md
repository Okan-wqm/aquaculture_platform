---
name: gateway-api
description: Knowledge base for gateway-api - Apollo Federation GraphQL gateway, entry point for all client traffic
---

# Gateway API Knowledge Base

## Overview
The gateway-api is the single entry point for all client traffic in the aquaculture platform. It is an Apollo Federation v2 gateway that composes GraphQL schemas from all downstream subgraph services (auth, farm, sensor, alert, hr, billing, hydroponics). It handles JWT authentication, rate limiting, tenant context propagation, file uploads, WebSocket support for real-time sensor data, and OPA-based policy enforcement.

## Directory Structure
```
apps/gateway-api/src/
  app.module.ts              # Root module - Apollo Gateway, Redis, Storage, WebSocket
  main.ts                   # Bootstrap (port 3000)
  config/
    app.config.ts            # General app config
    rate-limit.config.ts     # Rate limit config (per-endpoint limits)
    opa.config.ts            # OPA policy config
    retryable-introspect.ts  # RetryableIntrospectAndCompose - retries subgraph schema loading
    index.ts
  guards/
    auth.guard.ts            # Global JWT auth guard (verifies signature, checks blacklist)
    graphql-auth.guard.ts    # GQL-aware auth guard
    rate-limit.guard.ts      # Rate limiting guard (Redis-backed)
    redis-rate-limit.store.ts
    redis-token-blacklist.store.ts  # Token blacklist (Redis or in-memory fallback)
    tenant-isolation.guard.ts
    permission.guard.ts
    ip-whitelist.guard.ts
    opa-policy.guard.ts      # OPA (Open Policy Agent) enforcement
  middleware/
    jwt.middleware.ts         # Decodes JWT, sets req.user BEFORE willSendRequest
    tenant-context.middleware.ts
    correlation-id.middleware.ts
    security-headers.middleware.ts
    device-fingerprint.middleware.ts
    compression.middleware.ts
    request-validator.middleware.ts
    timeout.middleware.ts
  interceptors/
    request-logging.interceptor.ts
    response-transform.interceptor.ts
    cache-control.interceptor.ts
    error-mapping.interceptor.ts
    tenant-context.interceptor.ts
  filters/
    global-exception.filter.ts
    http-exception.filter.ts
    validation-exception.filter.ts
  proxy/
    service-proxy.service.ts  # HTTP proxying to backend services
    circuit-breaker.service.ts
    load-balancer.service.ts
  services/
    tenant-lookup.service.ts
    http-pool.service.ts
  opa/
    opa-client.service.ts
    policy-enforcer.service.ts
    policies/
      data-residency.rego
      module-authorization.rego
      tenant-access.rego
  routes/
    v1/
      admin.routes.ts
      auth.routes.ts
      farm.routes.ts
      sensor.routes.ts
    v2/index.ts
  health/
    health.module.ts
    health.controller.ts
    health.service.ts
  upload/
    upload.module.ts
    upload.controller.ts
    dto/upload-batch-document.dto.ts
    dto/upload-chemical-document.dto.ts
  websocket/
    websocket.module.ts
    sensor-readings.gateway.ts  # WebSocket gateway for real-time sensor data
    nats-bridge.service.ts      # Bridges NATS events to WebSocket clients
  types/index.ts
```

## Modules & Features

### AppModule (root)
- Apollo Federation Gateway with `RetryableIntrospectAndCompose` (polls subgraphs every 30 seconds)
- Composed subgraphs: auth (3001), farm (3002), sensor (3003), alert (3004), hr (3005), billing (3006), hydroponics (4007)
- Note: notification-service does NOT expose GraphQL - it is event-driven only
- JWT validation via `JwtModule.registerAsync` (requires JWT_SECRET env, minimum 32 chars)
- GraphQL security: depth limit 10, complexity limit 1000 (configurable via GRAPHQL_MAX_COMPLEXITY)
- MinIO/S3 storage for file uploads via `@platform/storage`
- Redis for rate limiting and token blacklist (`keyPrefix: 'gateway:'`)
- Global guards applied in order: AuthGuard, RateLimitGuard
- Global interceptor: RequestLoggingInterceptor
- Middleware pipeline: CorrelationIdMiddleware -> JwtMiddleware -> UserContextMiddleware -> TenantContextMiddleware -> RequestLoggingMiddleware

### AuthenticatedDataSource
Custom `RemoteGraphQLDataSource` that forwards these headers to all subgraphs:
- `authorization` - raw JWT
- `x-tenant-id` - from JWT tenantId or header
- `x-correlation-id` - for distributed tracing
- `traceparent` - W3C Trace Context
- `x-user-id`, `x-user-roles`, `x-user-payload` - decoded user info

### HealthModule
- REST endpoint `/health`
- Checks gateway connectivity and subgraph availability

### UploadModule
- REST endpoint for file uploads (batch documents, chemical documents)
- Stores files in MinIO

### WebSocketModule
- `SensorReadingsGateway`: WebSocket server for real-time sensor readings
- `NatsBridgeService`: Subscribes to NATS events, pushes to WS clients

## Key Entities
No TypeORM entities - this is a pure proxy/gateway service.

## API / GraphQL
The gateway composes the supergraph from all subgraph schemas. All GraphQL operations from clients go through this single endpoint (`http://localhost:3000/graphql`). The gateway proxies operations to appropriate subgraphs based on schema composition.

### Rate Limiting Config
- Global: 100 req/min
- Login: 5 req/15 min
- Register: 3 req/15 min
- Password reset: 3 req/hour
- GraphQL mutations: 30/min
- File uploads: 10/min
- Redis-backed when `RATE_LIMIT_USE_REDIS=true`, otherwise in-memory

## Patterns Used
- Apollo Federation v2 gateway (composes supergraph from subgraphs)
- JWT-first authentication with Redis token blacklist
- OPA (Open Policy Agent) for declarative policy enforcement
- Circuit breaker pattern for downstream service calls
- Middleware chain with explicit ordering (correlation -> JWT -> tenant -> logging)

## Inter-Service Communication
- All communication to subgraphs is via HTTP GraphQL (Apollo Federation)
- Reads NATS events for WebSocket bridging (via nats-bridge.service.ts)
- Calls auth-service for tenant lookup (`tenant-lookup.service.ts`)

## Key Dependencies
- `@apollo/gateway` - Federation gateway
- `@nestjs/apollo` with `ApolloGatewayDriver`
- `graphql-depth-limit` - Query depth protection
- `graphql-query-complexity` - Query complexity protection
- `@platform/backend-common` - Shared middleware and Redis
- `@platform/storage` - MinIO integration
- `@nestjs/jwt` - JWT verification
- `ioredis` - Redis client

## Known Gotchas
- **JWT_SECRET must be set in production** - fails fast with clear error; in dev use `ALLOW_DEV_JWT_SECRET=true` + `DEV_JWT_SECRET` (min 32 chars)
- **JwtMiddleware runs BEFORE AuthGuard** - this is intentional; `req.user` must be set by the middleware so `willSendRequest` can forward user headers to subgraphs. The guard still does blacklist checking.
- **Introspection disabled in production** - playground and schema discovery are off when `NODE_ENV=production`
- **RetryableIntrospectAndCompose** - custom class that retries subgraph schema loading on startup (subgraphs may not be ready immediately)
- **notification-service excluded** - it has no GraphQL schema, so it is deliberately omitted from the gateway subgraph list
- **Schema polling** - gateway re-fetches subgraph schemas every 30 seconds (`pollIntervalInMs: 30000`)
- **Token blacklist fallback** - uses Redis if `TOKEN_BLACKLIST_USE_REDIS=true`, else in-memory (breaks on multi-instance deployments)

## Related Services
- auth-service: JWT token issuance and validation source of truth
- All subgraph services: auth, farm, sensor, alert, hr, billing, hydroponics
- Redis: rate limit state and token blacklist storage
- MinIO: file upload storage
