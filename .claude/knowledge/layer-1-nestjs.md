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

## GraphQL (Apollo Federation 2)

- **Subgraph per service** — each service exposes `apps/<svc>/src/graphql/*.resolver.ts`; gateway composes via Apollo Federation.
- **`graphql-depth-limit: ^1.1.0`** + **`graphql-query-complexity: ^1.1.0`** — depth + complexity caps active in gateway-api.
- **DataLoader** — mandatory for N+1 prevention on resolver fields that delegate to cross-service fetch; use `@Injectable({ scope: Scope.REQUEST })` for per-request loader instance.
- **Codegen** — pipeline wired in `codegen.ts` but output file `web/shared-ui/src/generated/graphql-types.ts` does not exist; 114 `any` + 89 `as any` + 243 hand-written query strings in `web/` are downstream consequences (FE finding). W7 re-wire codegen.

## References

- Full slice audit: `/var/aqua-saas/docs/reviews/_audit/2026-04-W16-backend-security.md`
- Platform kernel ownership: `/var/aqua-saas/docs/reviews/_audit/2026-04-W16-backend-platform.md`
- ADR-006 (event flat), ADR-007 (CQRS strategy), ADR-008 (guards), ADR-013 (messaging isolation), ADR-014/015 (NATS identity), ADR-016 (RS256 Phase B)
