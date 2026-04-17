# Layer-1 NestJS — Backend framework patterns

**Audience:** backend-oriented agents (data-expert, auth-security-expert, platform-kernel-expert, every domain expert writing backend code).
**Anchor:** NestJS 11.1.17 + `@nestjs/cqrs` 11.0.3 + `@nestjs/typeorm` 11.0.0 + `@nestjs/graphql` 13.2.4 + `@nestjs/jwt` ^11.0.1, as of 2026-04-16.

Depends on: `layer-1-core.md` (TS 5.3, Nx, Jest). Does not include TypeORM specifics — see `layer-1-typeorm.md`.

## Module patterns (NestJS 11)

- **Injection scope** — `@Injectable({ scope: Scope.DEFAULT })` by default. Request scope only when tenant context demands per-request state that cannot be inferred from `TenantContextService`.
- **`forRoot` / `forRootAsync`** — use `forRootAsync` whenever the module depends on `ConfigService` or other runtime-resolved state (e.g., database URL, NATS cert paths). `forRoot` only for truly static config.
- **Lifecycle hooks** — `OnModuleInit` for sync init dependent on DI graph; `OnApplicationBootstrap` for cross-module init (e.g., SchemaDriftValidator fires here per ADR-012). `OnModuleDestroy` + `OnApplicationShutdown` for cleanup; explicit `await` on shutdown drains.

## Guards + interceptors + pipes

- **Guard order** — JWT → Tenant → Role/Feature. ADR-008 defense-in-depth requires all three active on authenticated endpoints. Missing any one is a HIGH finding.
- **`ValidationPipe`** — `{ whitelist: true, forbidNonWhitelisted: true, transform: true }` is the canonical config. Missing any of the three is a lint-eligible gap.
- **Interceptors** — use for cross-cutting concerns (logging, metrics, audit trails). Use `StructuredLoggerService` (not `Logger` directly) for auto-PII-masking per CLAUDE.md.
- **OPA policy guard** — `@OpaPolicy(...)` decorator exists in backend-common but had zero adoption as of W1 audit (SEC-HIGH-004). Decision pending architectural-arbiter W4: land-and-wire-everywhere OR delete.

## CQRS (`@nestjs/cqrs` 11)

- **Controller → Service → CommandBus/QueryBus → Handler → Repository** — no layer skipping.
- **Command handlers** — one command per handler (`@CommandHandler(CreateBatchCommand)`). Handler owns the aggregate mutation; the aggregate enforces its own invariants.
- **Query handlers** — separate bus (`QueryBus`). No writes permitted.
- **Event handlers (`@EventsHandler`)** — reactive cross-aggregate orchestration. For cross-service events, consume via `@platform/event-bus` NATS subscriptions, not in-process EventBus.
- **Saga** — `@Saga()` decorator on a method returning `Observable<ICommand>`. Use for multi-step orchestration within a service (tenant provisioning, cross-aggregate compensation). For cross-service workflows, use event-driven choreography via NATS.

## Security patterns

- **JWT** — RS256 only (HS256 forbidden post-ADR-016 Phase B). `JWT_SECRET` reads banned by ESLint rule (`no-restricted-syntax` in `.eslintrc.json:97-111`). Use public-key verification via `@nestjs/jwt` `JwtModule.registerAsync`.
- **Tenant ID sourcing** — JWT claims are the trust anchor when authenticated. `x-tenant-id` header accepted ONLY on explicit pre-auth / cross-tenant admin / edge-device ingestion paths. `TenantContextMiddleware` currently has a `req.query['tenantId']` fallback (SEC-CRITICAL-001) — W5 removes it.
- **HMAC signing** — gateway→subgraph and inter-service calls must sign canonical input including method + path + body-hash + timestamp + tenantId (not just tenantId per current implementation; SEC-HIGH-002/003 hardening W5).
- **Tenant isolation at the repository layer** — `getScopedRepository<T>(ctx)` not `getRepository<T>()`. Latter bypasses tenant filter (banned by ESLint). `TenantScopedRepository` wrapper exists in backend-common but has zero adoption (MT-CRITICAL-001) — W5/W6 skill catalog promotes adoption.

## Microservices transport

- **NATS** — via `@platform/event-bus` factory, mTLS cert-CN identity per ADR-014/015. `services.yaml` is the authoritative consumer registry (ADR-015 SSoT).
- **Outbox** — `@platform/outbox` for any cross-service write. 3/12 services adopted as of W1 (DATA-HIGH-004). W5 `add-event` / `change-event-contract` skills enforce outbox-only publish path. Direct `eventBus.publish` will be banned by a new ESLint rule (W7).
- **Redis** — via `libs/backend-common/src/redis/`. Rate limiters and quotas must fail *closed* on Redis outage (not fall back to in-memory Map — MT-CRITICAL-002 regression source).

### NATS JetStream consumer config

- **Streams** — one NATS stream per domain (e.g., `AQUACULTURE_EVENTS`). Subject patterns live in `infrastructure/nats/services.yaml` and generate `nats.conf` subject ACLs. Adding a new subject without updating services.yaml is rejected at server-side by `verify_and_map: true`.
- **Durable vs ephemeral consumers** — use durable (`durable_name: '<service>-<event>'`) for every production consumer so restart does not replay from stream start. Ephemeral consumers are for ad-hoc debugging only; CI invariant guards against ephemeral consumers in production config.
- **`ack_policy`** — always `explicit`. `none` and `all` both produce at-most-once semantics which violate the outbox → event-store contract. The outbox worker relies on explicit ack to preserve at-least-once + idempotency via `duplicate_window`.
- **`duplicate_window`** — 2 minutes in our config. This is the deduplication window the server uses against `Nats-Msg-Id`. Outbox publisher sets `Nats-Msg-Id` = `eventId` (the branded `EventId` from `@platform/event-contracts`), so a duplicate publish within 2 min is silently dropped by the server.
- **`max_deliver` + backoff** — finite `max_deliver` (e.g., 6) plus exponential backoff `[1s, 5s, 30s, 2m, 10m, 1h]`. After max_deliver, the message routes to a DLQ stream for manual inspection; the outbox row stays in `published = true` state (the server owns retry).
- **Consumer filter** — `filter_subject` pins the consumer to exactly the subjects its service owns in services.yaml. Subscribing to `AQUACULTURE_EVENTS.>` is banned except for audit/event-store services (see ADR-015 + `tools/ripple-tracer` for the authoritative ripple set).
- **`deliver_group`** — set on consumers that should horizontally scale across multiple service replicas (competing-consumer pattern). Without it, every replica receives every message — triple-delivery in a 3-replica deployment.
- **`max_ack_pending`** — bound the in-flight window per consumer. Default 1000. Too-high = memory pressure on slow handlers; too-low = head-of-line blocking behind a single stuck message.

## GraphQL Federation v2 (Apollo Gateway composition)

- **Subgraph per service** — each service exposes `apps/<svc>/src/graphql/*.resolver.ts`; gateway composes via Apollo Federation v2 (`@link(url: "https://specs.apollo.dev/federation/v2.x")` imports on every schema).
- **`@key` directives** — every federated entity declares `@key(fields: "id")` (or composite key like `tenantId id` for per-tenant entities). Missing `@key` on a cross-service-referenced entity = composition fails at gateway start.
- **`@external` + `@requires` + `@provides`** — used to signal cross-subgraph field dependencies. `@external` marks a field that ANOTHER subgraph owns but this subgraph references; `@requires` on a resolver tells gateway which external fields to fetch first; `@provides` declares a resolver can return fields it normally wouldn't.
- **`@shareable`** — required on fields both subgraphs can resolve (shared value types). Without it, federation v2 composition rejects the schema as a conflict.
- **`@override`** — used when a field's ownership moves from one subgraph to another. Apply it as a migration-only tag; remove the old subgraph's resolver in the SAME deploy cycle (progressive override is a migration state, not a steady state).
- **Entity reference resolver** — every `@key`'d entity needs a `__resolveReference` handler. Our NestJS pattern: `@ResolveReference() resolveReference(ref: { __typename, id }): Promise<Entity>` — delegates to the CQRS QueryBus, NOT direct repository access (layer rules).
- **Depth + complexity caps** — `graphql-depth-limit: ^1.1.0` + `graphql-query-complexity: ^1.1.0` active at the gateway. Each federation subgraph also enforces depth at the subgraph-only surface so direct subgraph probes (debug port) can't bypass the gateway limit.
- **DataLoader per request** — mandatory for N+1 prevention on resolver fields that delegate to cross-service fetch; use `@Injectable({ scope: Scope.REQUEST })` for per-request loader instance. Federation v2's query planner batches cross-subgraph calls, but WITHIN a subgraph the loader still owns batching.
- **Query-plan validation** — Apollo Router exposes `/query-plan` in dev; use to verify a cross-subgraph query does not trigger fan-out. A query plan with >3 hops usually indicates a missing `@provides` hint.
- **Codegen** — pipeline wired in `codegen.ts` but output file `web/shared-ui/src/generated/graphql-types.ts` does not exist; 114 `any` + 89 `as any` + 243 hand-written query strings in `web/` are downstream consequences (FE-CRITICAL-001). W7 re-wire codegen.

## Redis patterns (`libs/backend-common/src/redis/`)

- **Single canonical client** — `RedisClientFactory.create(...)` wraps `ioredis`. Direct `new Redis(...)` in service code is banned (no matching ESLint rule yet — Phase 14 candidate).
- **Rate limiting** — `RateLimiterRedis` from `rate-limiter-flexible`. Lua-script atomic INCR+EXPIRE; fail *closed* on Redis outage. The in-memory Map fallback was removed post-MT-CRITICAL-002.
- **Cache TTL** — explicit on every `SET`; no `SET` without `EX`/`PX`/`EXAT`. Unbounded cache growth is a CRITICAL class bug (OOM in production).
- **Cache keys** — tenant-scoped: `cache:<service>:<tenant>:<resource>:<key>`. Cross-tenant keys (feature flags, platform config) explicitly prefixed `platform:*` so tenant-scope scans can't accidentally delete them.
- **Pub/Sub** — NOT used for domain events (that's NATS). Redis pub/sub is reserved for SSE fan-out + Module-Federation remote-URL invalidation. Domain events on Redis pub/sub lose at-least-once + ordering guarantees.
- **Connection pool** — single connection per process by default; `lazyConnect: true` so boot does not hard-fail if Redis is briefly unavailable. Health check (`/health`) pings the connection and surfaces the status.

## References

- Full slice audit: `/var/aqua-saas/docs/reviews/_audit/2026-04-W16-backend-security.md`
- Platform kernel ownership: `/var/aqua-saas/docs/reviews/_audit/2026-04-W16-backend-platform.md`
- ADR-006 (event flat), ADR-007 (CQRS strategy), ADR-008 (guards), ADR-013 (messaging isolation), ADR-014/015 (NATS identity), ADR-016 (RS256 Phase B)
