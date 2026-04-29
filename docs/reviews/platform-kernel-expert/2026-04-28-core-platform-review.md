# platform-kernel-expert — review — 2026-04-28-core-platform-review

## Scope

Core/cross-cutting platform substrate: `platform/libs/cqrs/`, `platform/libs/event-bus/`, `platform/configs/`, and the in-scope `libs/backend-common/src/` foundational modules (bootstrap, config secrets, context, filters, health, logging, metrics, monitoring, monetary, pagination, telemetry, types, utils, websocket). Out of scope per agent contract: `auth/`, `guards/`, `security/`, `middleware/`, `audit/`, `database/`, event-contracts (owned by other agents). Branch: `main` at `a958dc66`, working tree clean. Reviewed against layer-1/2/3 SSoT and `docs/reviews/platform-kernel-expert/2026-04-10-full-repo-audit.md` for re-raised findings.

## Executive summary

Two CRITICAL findings dominate the cycle, both kernel-level "make it impossible was missed" classes that fan out across every consumer service.

1. `PLAT-CRITICAL-001` — the shared HTTP metrics middleware adds an unbounded `tenant` Prometheus label sourced from the unauthenticated `x-tenant-id` header. Every service that imports `MetricsMiddleware` (today: gateway-api, auth-service, sensor-service) inherits a Prometheus cardinality bomb that an unauthenticated caller can detonate. This is the exact "high-cardinality labels in shared metrics wrappers" pattern the agent contract calls CRITICAL.
2. `PLAT-CRITICAL-002` — `NatsEventBus.deserializeEvent` rewrites `timestamp` from the wire-string back to a `Date` instance after the kernel's own `IEvent` interface (and the upstream `BaseEvent` it imports) declares `timestamp: string`. Every NATS event handler on the platform receives a value typed `string` whose runtime is `Date` — a kernel type-lie that violates ADR-006's flat-event contract.

Three HIGH findings were carried forward from the 2026-04-10 audit; they remain unaddressed:

- `PLAT-HIGH-001` (re-raise of historical HIGH-001) — `platform/configs/*` is still 7 zero-byte placeholder files. No fail-fast validation, no shared schema. The kernel does not own platform-wide config; it advertises a contract surface it does not deliver.
- `PLAT-HIGH-002` (re-raise) — CQRS bus dispatch is keyed on `command.constructor.name` / `query.constructor.name`. Refactor + minify + class rename all silently break dispatch.
- `PLAT-HIGH-003` (re-raise) — CQRS bus drops every cross-cutting field (tenantId / correlationId / actor / trace) at the bus boundary because there is no shared execution envelope. Each handler is left to harvest context from `AsyncLocalStorage` ad hoc.

Plus three new HIGH findings: `EventHandlerRegistryModule` is a vestigial module that's never imported by any service (so `@EventHandler` / `@SubscribeTo` decorator users would silently fail to subscribe), `CqrsModule.forRoot` accepts options it never uses, and the structured logger's metrics-side cardinality discipline is undermined at the metrics middleware boundary (cross-link to `PLAT-CRITICAL-001`).

Verdict: **BLOCK** — the two CRITICAL findings cannot ship without remediation; the three re-raised HIGHs from a prior cycle compound the case for a kernel-tier consolidation pass.

## Findings (by severity)

### CRITICAL

#### PLAT-CRITICAL-001 — Unbounded `tenant` Prometheus label sourced from unauthenticated header

**Severity:** CRITICAL
**Layer:** 1 (NestJS layer rule + kernel rule)
**State:** OPEN

**Evidence**
- `libs/backend-common/src/metrics/metrics.service.ts:60` — `labelNames: ['method', 'route', 'status_code', 'tenant']` on `http_request_duration_seconds`
- `libs/backend-common/src/metrics/metrics.service.ts:68` — same on `http_requests_total` Counter
- `libs/backend-common/src/metrics/metrics.middleware.ts:41-44` — `tenantId = (req as ...).tenantId || (req.headers['x-tenant-id'] as string) || 'system'` — middleware runs **before** any authentication so the header is attacker-controlled
- `libs/backend-common/src/metrics/metrics.service.ts:111` — comment claims "Platform targets ~100 tenants max, so label cardinality is safe" but the sourcing path defeats the assumption
- Adopters of this middleware: `apps/gateway-api/src/app.module.ts:662`, `apps/auth-service/src/app.module.ts:334`, `apps/sensor-service/src/app.module.ts:412`

**Rule violated**
- `layer-1-nestjs.md` Redis/metrics section — "fail closed", and explicitly the platform-kernel-expert.md rule: *"High-cardinality labels (tenantId-in-metric-label, unbounded request-path labels) in shared metrics/logging wrappers are CRITICAL — they fan out across the entire fleet and can bankrupt Prometheus/OTEL backends."*
- Agent contract "Backend-common bootstrap ownership" — kernel must remain low-cardinality at the shared layer.

**Proposed fix direction**
- Remove the `tenant` label from the histogram + counter (Tier-1 — make the high-cardinality dimension unrepresentable). Keep `method` / `route` / `status_code`. Per-tenant attribution belongs in a separate (non-Prometheus) telemetry sink, exactly as `orchestrator-metrics.ts` already documents for the agent telemetry plane (note `tenant_id` BANNED list in that file's docblock).
- If per-tenant cost reporting is genuinely needed, add a separate sampled summary writing to a TimescaleDB hypertable, never a Prometheus label.
- Add a CI invariant assertion: any metric in `libs/backend-common/src/metrics/**` with a label named `tenant` / `tenantId` / `tenant_id` is rejected (the existing `no-high-cardinality-metric-label` ESLint rule referenced in `orchestrator-metrics.ts` should extend here).

**Affected surface (ripple set)**
- `libs/backend-common/src/metrics/metrics.service.ts`
- `libs/backend-common/src/metrics/metrics.middleware.ts`
- `apps/gateway-api/src/app.module.ts`, `apps/auth-service/src/app.module.ts`, `apps/sensor-service/src/app.module.ts` (callers do not change but their /metrics output shape changes — watchers of any tenant-segmented Grafana panels need to migrate)

**Expected closer**
platform-kernel-expert WRITER mode + auth-security-expert (verify pre-auth header surface).

#### PLAT-CRITICAL-002 — `NatsEventBus.deserializeEvent` lies about the `timestamp` type to every consumer

**Severity:** CRITICAL
**Layer:** 1 (event-bus contract) + 3 (ADR-006 flat event)
**State:** OPEN

**Evidence**
- `platform/libs/event-bus/src/interfaces/event-bus.interface.ts:14-19` — `timestamp: string` with the explicit comment *"Aligned with BaseEvent.timestamp (string, not Date) to match JSONB wire format and prevent type lie."*
- `libs/event-contracts/src/base-event.ts:38-46` — `BaseEvent.timestamp: string` with the same explicit "WHY string not Date" rationale
- `platform/libs/event-bus/src/nats/nats-event-bus.ts:825-837` — `deserializeEvent` returns `{ ...parsed, timestamp: new Date(parsed.timestamp) }` — replaces the wire string with a `Date`
- `platform/libs/event-bus/src/nats/nats-event-bus.ts:738-770` — every consumer's `handler.handle(event)` receives this mutated object

**Rule violated**
- ADR-006 (event flat) + the file-level docstring on `IEvent.timestamp` itself. Consumers are TypeScript-typed for `string`, but the runtime hands them `Date`. Any `event.timestamp.startsWith(...)` / `event.timestamp.slice(...)` etc. throws at runtime; any equality check between a freshly constructed event and a deserialized one fails silently.
- Layer-1 core "Discriminated unions / branded types — confirmed zero-escape in event-contracts domain (278 call sites)" — the kernel here introduces an escape that bypasses the branded-type discipline downstream.

**Proposed fix direction**
- Stop converting in `deserializeEvent`. Return `parsed` as-is once the upcaster has run (the upcaster preserves `timestamp` as a string already).
- Verify zero call sites depend on `event.timestamp` being a `Date` post-deserialize. If any do (very likely — consumers may have been written defensively), update them in the same change-set. Per the agent contract this is an inner-platform repair: the abstraction + every consumer atomically.
- Add a runtime assertion or unit test: `assert(typeof deserialized.timestamp === 'string')` — Tier-3 detectable backstop.

**Affected surface (ripple set)**
- `platform/libs/event-bus/src/nats/nats-event-bus.ts` (the offending function)
- All NATS event consumers across `apps/**/src/**/*.handler.ts` (many) — must verify none rely on `Date` runtime
- `apps/observability-service/src/migration-audit/consumers/schema-migration-events.consumer.ts` and similar — most likely to have date-arithmetic on timestamp

**Expected closer**
platform-kernel-expert WRITER mode (kernel fix) + data-expert WRITER (consumer ripple set).

### HIGH

#### PLAT-HIGH-001 — `platform/configs/*` is still seven empty placeholder files (RE-RAISE of 2026-04-10 HIGH-001)

**Severity:** HIGH
**Layer:** 3 (kernel config-schema rule)
**State:** OPEN — unchanged since 2026-04-10

**Evidence**
- `platform/configs/global.config.ts` — 0 bytes
- `platform/configs/kafka.config.ts` — 0 bytes
- `platform/configs/mfa.config.ts` — 0 bytes
- `platform/configs/opentelemetry.config.ts` — 0 bytes
- `platform/configs/rate-limit.config.ts` — 0 bytes
- `platform/configs/temporal.config.ts` — 0 bytes
- `platform/configs/vault.config.ts` — 0 bytes
- `git log --all -- platform/configs/` — only the initial commit `702d27a9 chore: initialize aquaculture platform monorepo workspace`; no content has ever been written
- Repo-wide grep: zero imports referencing `platform/configs` or `@platform/configs`

**Rule violated**
- platform-kernel-expert.md "Configs schema & versioning" — *"Every config surface MUST validate required inputs at boot. Silent fallbacks on security- or infra-sensitive settings (vault, mfa, rate-limit, kafka, temporal, opentelemetry) are HIGH, escalating to CRITICAL when the fallback weakens security or tenant isolation."* The kernel files for these exact surfaces are placeholders; per-service ad-hoc fallbacks fill the gap.
- Banned-phrase test: the original 2026-04-10 finding closed direction was "implement OR remove the package until it can enforce a real contract" — neither has happened in 18 days; deferral is forbidden without an explicit owner+deadline+finding ID, none of which exist in CLAUDE.md / plan files.

**Proposed fix direction**
- Either implement: typed factory per file (`zod` or `class-validator` schema, fail-fast `validate()` at boot, deep-merged service overrides via `forRootAsync`). Each must export a `*ConfigModule.forRoot()` that throws on missing required keys.
- Or remove: delete the 7 empty files + remove the directory until the kernel actually owns these surfaces. Empty placeholders advertise a contract that is not delivered — Tier-4 documentation that lies.
- The architectural arbiter must rule on which path is taken; further deferral is not acceptable.

**Affected surface (ripple set)**
- `platform/configs/*.ts` (delete OR fill)
- `tsconfig.base.json` (`@platform/configs` alias add or remove based on direction)
- Every service that currently ad-hoc reads `vault`, `mfa`, `rate-limit`, `kafka`, `temporal`, `opentelemetry` env vars (audit pass needed)

**Expected closer**
architectural-arbiter ruling, then platform-kernel-expert WRITER. Cross-domain: infra-expert + auth-security-expert.

#### PLAT-HIGH-002 — CQRS dispatch keyed on runtime class name (RE-RAISE of 2026-04-10 HIGH-002)

**Severity:** HIGH
**Layer:** 1 (NestJS CQRS pattern) + agent contract "CQRS kernel lifecycle"
**State:** OPEN — unchanged since 2026-04-10

**Evidence**
- `platform/libs/cqrs/src/command/command-bus.ts:29` — `const commandName = command.constructor.name;`
- `platform/libs/cqrs/src/command/command-bus.ts:72,90` — `commandType.name` / `commandName` stored as map key
- `platform/libs/cqrs/src/query/query-bus.ts:29,72,90` — identical pattern on QueryBus
- `platform/libs/cqrs/src/cqrs.module.ts:79-101` — registration metadata stored as `commandMetadata.commandName` / `queryMetadata.queryName` (which read `command.name` from the decorator)
- `platform/libs/cqrs/src/command/command.interface.ts:7` — `ICommand` is an empty marker interface; no stable `__commandType` token

**Rule violated**
- platform-kernel-expert.md "CQRS kernel lifecycle & handler discoverability" — *"Handler registration MUST be deterministic: no import-order dependence, no side-effect registration hidden behind module loading."* Class-name-keyed dispatch is implicitly side-effecting on minification / class rename / proxy-class wrapping.
- Layer-2 patterns "CQRS discipline" — Controller → Service → Bus → Handler is preserved, but the bus identity itself is fragile. Refactor of a `CreateBatchCommand` to `CreateAquacultureBatchCommand` silently breaks every dispatch with no compile-time signal.

**Proposed fix direction**
- Tier-1 fix: introduce branded `CommandType` / `QueryType` symbols (e.g., `static readonly TYPE: CommandType = brandCommandType('aquaculture.farm.batch.create.v1')`) and route on them. Compile-time error if a handler omits the brand.
- Tier-2 fallback: a kernel-issued unique-string registry decorator (`@CommandType('aquaculture.farm.batch.create.v1')`) checked at registration time for collisions and at compile time via a generic helper.
- Either way the change requires an inner-platform sweep — every existing command + handler must adopt the brand in the same change-set; partial adoption is a kernel regression.

**Affected surface (ripple set)**
- `platform/libs/cqrs/src/**`
- Every handler / command / query in `apps/**/src/**/handlers/*.ts` and `apps/**/src/**/query-handlers/*.ts`

**Expected closer**
implementation-planner package — kernel + every consumer atomically.

#### PLAT-HIGH-003 — CQRS bus drops the request envelope (RE-RAISE of 2026-04-10 HIGH-003)

**Severity:** HIGH
**Layer:** 1 (NestJS CQRS) + agent contract "CQRS kernel lifecycle"
**State:** OPEN — unchanged since 2026-04-10

**Evidence**
- `platform/libs/cqrs/src/command/command-bus.ts:47` — `const result = await handler.execute(command);` — no second argument, no envelope
- `platform/libs/cqrs/src/query/query-bus.ts:47` — same pattern
- `platform/libs/cqrs/src/command/command.interface.ts:23-31` — `ICommandHandler.execute(command: TCommand): Promise<TResult>` — single-arg signature; envelope fields would have to live INSIDE the command which is an anti-pattern (mixes business payload with cross-cutting metadata)
- `ITenantCommand` extends `ICommand` with `tenantId: string` (line 12-17) — but only tenantId, not correlationId / actor / trace. Each service must add fields ad hoc, defeating the kernel guarantee.

**Rule violated**
- platform-kernel-expert.md "Shared CQRS primitives MUST preserve request metadata across bus hops: tenant context, correlationId, actor identity, tracing context. Dropping any of these inside shared code is CRITICAL — services cannot recover metadata they never received." (This rule says CRITICAL; I down-grade to HIGH because services in practice harvest the same fields from `AsyncLocalStorage` via the wired `RequestContextMiddleware`. The footgun is real but mitigated; if AsyncLocalStorage propagation breaks for any non-HTTP path, the gap becomes immediate.)

**Proposed fix direction**
- Tier-1: extend `ICommandHandler<TCommand, TResult>` to `execute(command, ctx: ExecutionContext): Promise<TResult>` where `ExecutionContext` is `{ tenantId, correlationId, actorId, traceId, spanId }`. Bus reads `RequestContext` from AsyncLocalStorage and forwards explicitly. Handlers stop reading from AsyncLocalStorage by hand; the kernel hands them the envelope.
- Same atomicity rule as PLAT-HIGH-002: every handler in the repo updates in the same change-set.

**Affected surface (ripple set)**
- `platform/libs/cqrs/src/**`
- Every handler in `apps/**/src/**/handlers/*.ts` and `apps/**/src/**/query-handlers/*.ts`

**Expected closer**
implementation-planner package — paired with PLAT-HIGH-002 if both go in the same kernel sweep.

#### PLAT-HIGH-004 — `EventHandlerRegistryModule` is exported, never wired, and `@Module({})` empty — silent decorator footgun

**Severity:** HIGH
**Layer:** 1 (NestJS module pattern) + 2 (event-bus discoverability)
**State:** OPEN — new this cycle

**Evidence**
- `platform/libs/event-bus/src/nats/nats.module.ts:144-242` — `@Module({})` empty decorator on the class; the class is its own DI provider but is never listed in any other module's `imports[]` or `providers[]`
- Repo-wide grep `grep -rn "EventHandlerRegistryModule" /var/aqua-saas/apps/` returns ZERO matches — no service imports it
- `platform/libs/event-bus/src/index.ts` — `EventHandlerRegistryModule` is **not** in the barrel; only re-exported transitively via `export * from './nats/nats.module'`
- `platform/libs/event-bus/src/decorators/event-handler.decorator.ts:27-61` — `@EventHandler` and `@SubscribeTo` decorators are exported from the kernel barrel
- Repo-wide grep `grep -rn "@EventHandler\b\|@SubscribeTo\b" /var/aqua-saas/apps/` returns ZERO matches — the registry is not actually used today

**Rule violated**
- platform-kernel-expert.md "Handler registration MUST be deterministic: no import-order dependence, no side-effect registration hidden behind module loading." The current shape would let a developer write `@EventHandler('FooEvent')` and silently never subscribe — the side-effect of registration depends on a module that no service imports.
- Inner-platform contract: a decorator advertised from the kernel barrel that has no live registration path is a kernel surface lying about what it does.

**Proposed fix direction**
- Either delete the decorators + the registry module (Tier-1: make the wrong code unrepresentable). The `IEventHandler` / `IEventSubscriber` API is sufficient for current usage.
- Or wire it: `EventBusModule.forRoot({ ...providers: [EventHandlerRegistryModule, ...] })` plus actually populate `@Module({ providers: [...], imports: [DiscoveryModule] })` and ensure NestJS instantiates it. Add an adoption-invariant test like the schema-drift one.
- The "wire and adopt" path is preferred only if there is a roadmap consumer; absent that, deletion closes the footgun.

**Affected surface (ripple set)**
- `platform/libs/event-bus/src/nats/nats.module.ts`
- `platform/libs/event-bus/src/decorators/event-handler.decorator.ts`
- `platform/libs/event-bus/src/index.ts`

**Expected closer**
platform-kernel-expert WRITER mode (no consumer-side ripple).

#### PLAT-HIGH-005 — `CqrsModule.forRoot(options)` accepts options it never reads

**Severity:** HIGH
**Layer:** 1 (NestJS DI) + agent contract "Configs schema & versioning"
**State:** OPEN — new this cycle

**Evidence**
- `platform/libs/cqrs/src/cqrs.module.ts:37-46` — `forRoot(options?: CqrsModuleOptions): DynamicModule` — receives `options` and never references it inside the body
- `platform/libs/cqrs/src/cqrs.module.ts:108-120` — `CqrsModuleOptions` interface documents `enableLogging` and `enableMetrics` as a public surface
- `CommandBus` (line 32) and `QueryBus` (line 32) hard-wire `Logger.debug(...)` calls; there is no toggle path

**Rule violated**
- "Coercing surprising values into 'reasonable defaults' is HIGH — it converts a boot-time misconfiguration into a runtime mystery." Same shape, different angle: the kernel accepts caller intent that vanishes silently.

**Proposed fix direction**
- Either remove the `options` parameter and the `CqrsModuleOptions` interface (Tier-1). The current behaviour is logging-on + metrics-off; if that is the policy, name it. Callers passing `{enableLogging: false}` get the false impression the kernel honoured them.
- Or wire the options through to `CommandBus` / `QueryBus` (Tier-2 — make automatic) so the boolean actually controls the logger and metrics emission.

**Affected surface (ripple set)**
- `platform/libs/cqrs/src/cqrs.module.ts`
- `platform/libs/cqrs/src/command/command-bus.ts`
- `platform/libs/cqrs/src/query/query-bus.ts`

**Expected closer**
platform-kernel-expert WRITER mode.

#### PLAT-HIGH-006 — `metrics.service.ts` clears the global `prom-client` default registry on module init

**Severity:** HIGH
**Layer:** 1 (NestJS lifecycle)
**State:** OPEN — new this cycle

**Evidence**
- `libs/backend-common/src/metrics/metrics.service.ts:40-41` — `client.register.clear(); this.registry.clear();` inside `onModuleInit`
- This runs once per service that imports `ServiceMetricsModule`. `client.register` is the **process-global default registry** — clearing it removes any metric registered against the default registry by another module / library

**Rule violated**
- platform-kernel-expert.md "Backend-common bootstrap ownership" — kernel must not hide retry/fallback or destructive side-effects that individual services cannot opt out of. Wiping the global registry is exactly that shape.
- Cross-cutting concern: every NPM library that emits Prometheus metrics into the default registry (e.g., `pg-pool`, `bull`, third-party http clients) gets silently wiped out.

**Proposed fix direction**
- Remove `client.register.clear()`. The `this.registry.clear()` against this module's own dedicated registry is sufficient and safe.
- The comment claims it prevents "duplicate metric errors when multiple modules or tests register default metrics" — that's a test concern; tests should use isolated registries via `new client.Registry()`, not rely on global side-effects.

**Affected surface (ripple set)**
- `libs/backend-common/src/metrics/metrics.service.ts`

**Expected closer**
platform-kernel-expert WRITER mode.

#### PLAT-HIGH-007 — `HttpExceptionFilter` / `AllExceptionsFilter` / `GraphQLExceptionFilter` triple-export with explicit migration TODO at top

**Severity:** HIGH (process — kernel surface owns a known-deprecated overlay with no deadline)
**Layer:** 1 (NestJS filter pattern)
**State:** OPEN — was filed pre-2026-04-10 as ARCH-MED-005, still open

**Evidence**
- `libs/backend-common/src/filters/http-exception.filter.ts:1-35` — `TODO(ARCH-MED-005): Consolidation plan — eliminate duplicate exception filter hierarchy` listing 6 services still on the deprecated filters
- File still in active barrel export `libs/backend-common/src/filters/index.ts:7`
- The TODO has no owner / no deadline / no finding ID per CLAUDE.md "deferral is FORBIDDEN without an explicit owner + deadline + tracked finding ID"

**Rule violated**
- CLAUDE.md banned-phrase + tier-claim discipline: a Tier-4 doc (`TODO`) on a load-bearing kernel surface is a deferred fix dressed as an in-place plan.

**Proposed fix direction**
- Promote to a tracked finding with explicit owner + deadline + per-service migration commits (each `Closes:` clause references the kernel finding).
- Then either delete the three classes and the barrel export once each consumer migrates, OR re-classify the kernel filter as the canonical one and delete `libs/shared/GlobalExceptionFilter`.

**Affected surface (ripple set)**
- `libs/backend-common/src/filters/`
- 6 named services: auth-service, config-service, gateway-api, billing-service, hr-service, admin-api-service

**Expected closer**
architectural-arbiter ruling on which filter is canonical, then sub-agent WRITER per service.

### MEDIUM

#### PLAT-MEDIUM-001 — `scheduleReconnect` has no max-attempts cap; dev-only path will retry forever

**Severity:** MEDIUM (dev-mode only, but it is the kernel)
**Layer:** 1
**State:** OPEN

**Evidence**
- `platform/libs/event-bus/src/nats/nats-event-bus.ts:166-183` — recursive `setTimeout` with fixed `reconnectTimeWaitMs`; success path `return`s, failure path schedules another reconnect indefinitely
- No telemetry counter increment on failure — operators in dev will not see the busy-loop

**Rule violated**
- platform-kernel-expert.md "Silent publish failures are CRITICAL. Errors MUST surface to the caller or, when fire-and-forget is intended, to telemetry + metrics with a named counter." Reconnect is fire-and-forget at the dev path; no metric counter.

**Proposed fix direction**
- Cap retries (use `maxReconnectAttempts` already present on the instance — line 73). On exhaustion, log a fatal warning and stop scheduling.
- Emit a `nats_reconnect_attempt_total` Counter and a `nats_reconnect_state` Gauge.

**Affected surface (ripple set)**
- `platform/libs/event-bus/src/nats/nats-event-bus.ts`

**Expected closer**
platform-kernel-expert WRITER mode.

#### PLAT-MEDIUM-002 — `NatsEventBus.deserializeEvent` runs upcasters BEFORE typing — double-mutation risk

**Severity:** MEDIUM
**Layer:** 1 + ADR-006
**State:** OPEN

**Evidence**
- `platform/libs/event-bus/src/nats/nats-event-bus.ts:825-837` — `parsed = this.upcasterRegistry.upcast(parsed);` then the function applies its own `timestamp: new Date(parsed.timestamp)` — both mutations run in sequence on the same `parsed` object
- The upcaster output shape is whatever the registry returns; the kernel adds a Date conversion ON TOP — two transformations the consumer cannot disambiguate

**Rule violated**
- ADR-006 flat event pattern — the upcaster contract is "v1 → v2+ schema migration"; the kernel post-processing it after upcast is an additional transformation that bypasses the upcaster trust boundary. Companion finding to PLAT-CRITICAL-002 — fixing the timestamp bug also closes this.

**Proposed fix direction**
- Drop the post-upcast Date conversion (closes PLAT-CRITICAL-002).

**Affected surface (ripple set)**
- `platform/libs/event-bus/src/nats/nats-event-bus.ts`

**Expected closer**
Same change-set as PLAT-CRITICAL-002.

#### PLAT-MEDIUM-003 — `RequestContextMiddleware` accepts every header at face value

**Severity:** MEDIUM
**Layer:** 2 (tenant trust anchor) — note this overlaps auth-security-expert primary ownership; raised here only because it is the **kernel** middleware that establishes the platform AsyncLocalStorage shape
**State:** OPEN

**Evidence**
- `libs/backend-common/src/logging/request-context.middleware.ts:54` — `const tenantId = (req.headers['x-tenant-id'] as string) || extractTenantFromUser(req);` — header is preferred over JWT-derived value
- This contradicts CLAUDE.md "Tenant-ID sourcing: JWT claims are the trust anchor when an authenticated user is present (preferred by `TenantContextMiddleware`)"
- The `RequestContextMiddleware` is the kernel-side middleware that drives the AsyncLocalStorage; per agent contract scope, kernel-shape correctness is in this agent's lane even if the security implication is auth-security-expert's call

**Rule violated**
- CLAUDE.md tenant-id sourcing rule (header is acceptable only on explicit pre-auth / cross-tenant-admin / edge-device-ingestion paths)
- platform-kernel-expert.md "Request-scoped context (tenantId, correlationId, actor) MUST stay request-scoped. Any process-global mutable context or leaked async-local context in shared code is HIGH — cross-request contamination at the kernel level is a tenant-isolation risk." (No leak detected here, but the header preference is the wrong-priority drift it warns about.)

**Proposed fix direction**
- Reverse precedence: extract from the JWT-derived `x-user-payload` first, header only as fallback when no user payload is present.
- Cross-domain dependency: auth-security-expert validates the security envelope.

**Affected surface (ripple set)**
- `libs/backend-common/src/logging/request-context.middleware.ts`

**Expected closer**
auth-security-expert ruling, then platform-kernel-expert WRITER (kernel-shape change).

#### PLAT-MEDIUM-004 — `safe-error-logger.sanitizeForLogging` regex `key[=:]\s*['"]?[^\s'"]+/gi` over-matches innocuous strings containing `key`

**Severity:** MEDIUM
**Layer:** 1
**State:** OPEN

**Evidence**
- `libs/backend-common/src/bootstrap/safe-error-logger.ts:22` — `/key[=:]\s*['"]?[^\s'"]+/gi`
- Will match strings like `"primary-key=foo"`, `"check_key: bar"`, `"keychain=quux"` and redact them — adds false noise to bootstrap logs that are already truncated

**Rule violated**
- N/A directly. Quality-of-signal concern. Fix is low-risk.

**Proposed fix direction**
- Tighten to `/(?:^|[\s,;])(?:api[_-]?key|access[_-]?key|secret[_-]?key)[=:]\s*['"]?[^\s'"]+/gi`.

**Affected surface (ripple set)**
- `libs/backend-common/src/bootstrap/safe-error-logger.ts`

**Expected closer**
platform-kernel-expert WRITER mode.

### LOW

#### PLAT-LOW-001 — `Money.toMinorUnits` returns `number` — large currency totals risk JS number precision loss

**Severity:** LOW (uncommon edge case; budget is large but representable for most aquaculture totals)
**Layer:** 1
**State:** OPEN

**Evidence**
- `libs/backend-common/src/monetary/money.ts:274-278` — `return shifted.toDecimalPlaces(0, ...).toNumber();`
- For JPY (scale=0) at amounts > `2^53 / 1` ≈ 9 × 10^15 yen the conversion to `number` loses precision silently
- Stripe accepts amounts up to 10^9 in any currency, so the realistic blast radius is small but the kernel returns a `number` rather than a `bigint` for an integer that semantically *should* be a `bigint` if precision matters

**Rule violated**
- N/A — quality concern.

**Proposed fix direction**
- Document the precision boundary in the JSDoc OR introduce a sibling `toMinorUnitsBigInt(): bigint` for cold-path callers that need full precision.

**Affected surface (ripple set)**
- `libs/backend-common/src/monetary/money.ts`

**Expected closer**
platform-kernel-expert WRITER mode (low priority).

#### PLAT-LOW-002 — `decimal-column.decorator.ts` uses `parseFloat`-free transformer but lacks tests verifying lossless round-trip

**Severity:** LOW
**Layer:** 1
**State:** OPEN

**Evidence**
- `libs/backend-common/src/monetary/decimal-column.decorator.ts` — module exports `MoneyColumn` + `DecimalValueTransformer`
- No `__tests__/decimal-column.spec.ts` in the directory
- `find /var/aqua-saas/libs/backend-common/src/monetary -name "*.spec.ts"` returns 0 results

**Rule violated**
- Layer-1 core "Jest 30 — `@platform/testing` factories preferred" — testing discipline gap on a fix that explicitly closes a precision-loss bug; without a regression test, the next refactor can re-open it.

**Proposed fix direction**
- Add unit + integration tests covering `0.1 + 0.2`, `1e-12`, `9999999999.9999`, NULL/undefined paths, currency precision boundaries.

**Affected surface (ripple set)**
- `libs/backend-common/src/monetary/__tests__/decimal-column.spec.ts` (new)

**Expected closer**
platform-kernel-expert WRITER mode.

## Cross-domain dependencies flagged

- `PLAT-CRITICAL-001` — recommend also invoking **auth-security-expert** because the unauthenticated header sourcing is a security-class concern at the trust boundary the metrics middleware enforces.
- `PLAT-CRITICAL-002` — recommend also invoking **data-expert** because the consumer ripple set spans every event handler — data-expert owns event contracts and event-store adoption breadth.
- `PLAT-HIGH-001` — recommend **architectural-arbiter** for the implement-vs-delete ruling, plus **infra-expert** + **auth-security-expert** for the contents of vault/mfa/rate-limit configs once the direction is set.
- `PLAT-HIGH-002` + `PLAT-HIGH-003` — recommend coordination via **implementation-planner** because the consumer ripple set is platform-wide and atomic.
- `PLAT-MEDIUM-003` — recommend **auth-security-expert** as primary for the security ruling; this agent owns kernel-shape change only.

## Verdict

**BLOCK** — two CRITICAL findings, three re-raised HIGHs from a 18-day-old cycle, plus four new HIGHs make this a kernel surface that fails the "every change ships green tests with the architectural fix" discipline. Re-raising HIGH-001/002/003 from 2026-04-10 without movement is itself a process-finding that will surface in context-manager's compaction pass.

## References

- Layer-1 cites: `layer-1-core.md`, `layer-1-nestjs.md`, `layer-1-typeorm.md`
- Layer-2: `layer-2-patterns.md` (CQRS discipline, outbox, event-flat, tenant isolation)
- Layer-3: ADR-006 (event flat), ADR-007 (CQRS), ADR-008 (guard depth), ADR-014/015 (NATS identity)
- Prior cycle: `docs/reviews/platform-kernel-expert/2026-04-10-full-repo-audit.md` — HIGH-001/002/003 carried forward into PLAT-HIGH-001/002/003 here. HIGH-004/005/006 from that cycle are RESOLVED in current code (await-all subscriptions, NAK-on-handler-failure, fail-closed prod boot).
- Plan / context: `/root/.claude/plans/declarative-riding-shamir.md` BLOCKER-3, BLOCKER-15.
- CLAUDE.md "Architectural Approach" — banned-phrase list applies to any deferral attempt on PLAT-HIGH-001/002/003.

---

## Registry-anchor addenda (2026-04-29 closure cycle)

### PLAT-LOW-003 — createBaseEvent canonical contract pin

**Status:** RESOLVED — closure tracked in `docs/reviews/_registry/findings.jsonl`.

Pre-fix the canonical event factory had zero unit-test coverage. Three
runtime-critical invariants were unverified at CI time: eventId
uniqueness, ISO 8601 string timestamp (NOT Date — the W0.E
DATA-CRITICAL-003 cure depends on this), and required-field
population. Cure: 11-spec test pin at
`libs/event-contracts/src/__tests__/base-event.spec.ts` covering
each invariant. Companion to PLAT-LOW-002 (Money +
DecimalValueTransformer); locks the W0.E shift at the unit-test
layer.
