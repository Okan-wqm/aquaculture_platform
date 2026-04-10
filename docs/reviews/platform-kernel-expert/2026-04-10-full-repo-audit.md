# Platform Kernel Review

**Date:** 2026-04-10  
**Scope:** `platform/configs/**`, `platform/libs/cqrs/**`, `platform/libs/event-bus/**`, `libs/backend-common/src/bootstrap/**`, `libs/backend-common/src/context/**`, `libs/backend-common/src/filters/**`, `libs/backend-common/src/health/**`, `libs/backend-common/src/logging/**`, `libs/backend-common/src/metrics/**`, `libs/backend-common/src/monitoring/**`, `libs/backend-common/src/monetary/**`, `libs/backend-common/src/pagination/**`, `libs/backend-common/src/telemetry/**`, `libs/backend-common/src/types/**`, `libs/backend-common/src/utils/**`, `libs/backend-common/src/websocket/**`

**Verdict:** `PASS WITH CONDITIONS`

- No CRITICAL findings in this slice.
- The review found 6 HIGH findings in shared runtime/kernel code.
- Static review only; no tests were run.

## Findings

### HIGH-001 - `platform/configs/*` is an inert shared contract layer
All seven config files in `platform/configs/` are zero-byte placeholders: [`global.config.ts`](/var/aqua-saas/platform/configs/global.config.ts), [`kafka.config.ts`](/var/aqua-saas/platform/configs/kafka.config.ts), [`mfa.config.ts`](/var/aqua-saas/platform/configs/mfa.config.ts), [`opentelemetry.config.ts`](/var/aqua-saas/platform/configs/opentelemetry.config.ts), [`rate-limit.config.ts`](/var/aqua-saas/platform/configs/rate-limit.config.ts), [`temporal.config.ts`](/var/aqua-saas/platform/configs/temporal.config.ts), [`vault.config.ts`](/var/aqua-saas/platform/configs/vault.config.ts). There is no fail-fast validation, no secure default, and no compatibility bridge for shared config consumers.

Impact: the platform kernel does not own security-sensitive or rollout-sensitive config behavior, so services continue to duplicate local fallbacks and drift on defaults.

Remediation: implement typed config factories with schema validation and explicit migration/compatibility behavior for each shared surface, or remove the package until it can enforce a real contract.

Cross-domain dependency: `infra-expert`, `auth-security-expert`.

### HIGH-002 - CQRS dispatch is tied to runtime class names
[`CommandBus.execute`](/var/aqua-saas/platform/libs/cqrs/src/command/command-bus.ts#L26) and [`QueryBus.execute`](/var/aqua-saas/platform/libs/cqrs/src/query/query-bus.ts#L26) route by `command.constructor.name` / `query.constructor.name`. Registration also stores `commandType.name` / `queryType.name` in the handler maps ([`command-bus.ts:72`](/var/aqua-saas/platform/libs/cqrs/src/command/command-bus.ts#L72), [`command-bus.ts:90`](/var/aqua-saas/platform/libs/cqrs/src/command/command-bus.ts#L90), [`query-bus.ts:72`](/var/aqua-saas/platform/libs/cqrs/src/query/query-bus.ts#L72), [`query-bus.ts:90`](/var/aqua-saas/platform/libs/cqrs/src/query/query-bus.ts#L90)). The shared interfaces are empty markers only ([`ICommand`](/var/aqua-saas/platform/libs/cqrs/src/command/command.interface.ts#L7), [`IQuery`](/var/aqua-saas/platform/libs/cqrs/src/query/query.interface.ts#L12)), so there is no stable kernel identity token.

Impact: refactors, proxies, minification, or alternate command/query construction can break dispatch without any compile-time signal. The kernel is depending on runtime naming, not an explicit shared contract.

Remediation: introduce explicit command/query IDs or metadata tokens and route on that stable identity, with strict DI resolution instead of name-based lookup.

Cross-domain dependency: `architectural-arbiter`, `data-expert`.

### HIGH-003 - CQRS lacks a first-class request envelope
`CommandBus.execute` and `QueryBus.execute` forward the raw payload object straight into the handler ([`command-bus.ts:47`](/var/aqua-saas/platform/libs/cqrs/src/command/command-bus.ts#L47), [`query-bus.ts:47`](/var/aqua-saas/platform/libs/cqrs/src/query/query-bus.ts#L47)). The shared command/query interfaces do not define a standard envelope for tenant, correlation, actor, or tracing metadata; each service currently has to embed that context ad hoc.

Impact: tenant/correlation/trace propagation remains a per-service convention instead of a kernel guarantee, which weakens auditability and cross-service consistency.

Remediation: add a shared execution context envelope to CQRS and make the buses propagate it explicitly alongside the command/query payload.

Cross-domain dependency: `auth-security-expert`, `data-expert`.

### HIGH-004 - Method-level event subscriptions are not awaited during bootstrap
`EventHandlerRegistryModule` awaits class-level `subscribe(...)`, but method-level `@SubscribeTo` handlers are fired without `await` ([`nats.module.ts:156`](/var/aqua-saas/platform/libs/event-bus/src/nats/nats.module.ts#L156)). That means module init can finish before all subscriptions are registered, and any registration failure is dropped on the floor.

Impact: startup can succeed with missing event handlers, and the first failure in a method-level registration path becomes an unobserved bootstrap defect.

Remediation: await every subscription registration, fail startup on registration errors, and surface partial registration as a boot-time failure.

Cross-domain dependency: `data-expert`.

### HIGH-005 - Handler failures are swallowed and the message is still acknowledged
Inside `processMessagesFromConsumer`, each handler is wrapped in its own `try/catch`, errors are only logged ([`nats-event-bus.ts:565`](/var/aqua-saas/platform/libs/event-bus/src/nats/nats-event-bus.ts#L565), [`nats-event-bus.ts:568`](/var/aqua-saas/platform/libs/event-bus/src/nats/nats-event-bus.ts#L568)), and the message is still acked afterward ([`nats-event-bus.ts:576`](/var/aqua-saas/platform/libs/event-bus/src/nats/nats-event-bus.ts#L576)). This loses the event for the failed handler permanently and prevents retry or dead-letter handling for that path.

Impact: a partially failing consumer can silently drop work while still reporting successful message processing.

Remediation: treat handler failure as delivery failure unless the handler is explicitly optional, and route failures into retry/DLQ semantics instead of acking unconditionally.

Cross-domain dependency: `data-expert`.

### HIGH-006 - Event bus startup is fail-open when NATS is unavailable
`NatsEventBus.onModuleInit` catches connection/setup failures, logs a warning, and explicitly continues without the event bus ([`nats-event-bus.ts:145`](/var/aqua-saas/platform/libs/event-bus/src/nats/nats-event-bus.ts#L145), [`nats-event-bus.ts:152`](/var/aqua-saas/platform/libs/event-bus/src/nats/nats-event-bus.ts#L152), [`nats-event-bus.ts:157`](/var/aqua-saas/platform/libs/event-bus/src/nats/nats-event-bus.ts#L157)). Reconnect is best-effort background retry, not a readiness gate.

Impact: services can boot and look healthy while async workflows are disabled. In an event-driven kernel, this is a platform-wide availability and correctness gap rather than a local degradation.

Remediation: make broker availability an explicit startup/readiness dependency for services that require events, or split the module into explicit required/optional modes with different health semantics.

Cross-domain dependency: `infra-expert`, affected domain experts that depend on async events.

## Cross-Domain Dependencies

| From | To | Reason | Status |
|---|---|---|---|
| platform configs | infra-expert | shared config contracts need boot-time validation and rollout-safe defaults | Open |
| platform configs | auth-security-expert | security-sensitive defaults are currently unconstrained | Open |
| CQRS kernel | architectural-arbiter | stable identity and envelope design may need a platform-level decision | Open |
| CQRS kernel | data-expert | tenant/correlation propagation affects contract integrity | Open |
| event bus kernel | data-expert | subscription registration and ack semantics affect event loss behavior | Open |
| event bus kernel | infra-expert | fail-open startup and broker readiness semantics affect deploy health | Open |

## Notes

- I did not run tests or modify any source files.
