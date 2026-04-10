# Platform Kernel Ownership and Guardrails

## Topic

Why `platform/configs`, `platform/libs/{cqrs,event-bus}`, and backend-common runtime foundations need a dedicated reviewing agent instead of being split loosely across service experts.

## Sources

- Code inspection on 2026-04-10:
  - `platform/configs/global.config.ts`
  - `platform/configs/kafka.config.ts`
  - `platform/configs/mfa.config.ts`
  - `platform/configs/opentelemetry.config.ts`
  - `platform/configs/rate-limit.config.ts`
  - `platform/configs/temporal.config.ts`
  - `platform/configs/vault.config.ts`
  - `platform/libs/cqrs/src/command/command-bus.ts`
  - `platform/libs/cqrs/src/query/query-bus.ts`
  - `platform/libs/cqrs/src/cqrs.module.ts`
  - `platform/libs/event-bus/src/interfaces/event-bus.interface.ts`
  - `platform/libs/event-bus/src/nats/nats-event-bus.ts`
  - `libs/backend-common/src/bootstrap/create-service-app.ts`
  - `libs/backend-common/src/context/with-tenant-context.ts`
  - `libs/backend-common/src/health/standard-health.controller.ts`
  - `libs/backend-common/src/logging/request-context.ts`
  - `libs/backend-common/src/logging/structured-logger.service.ts`
  - `libs/backend-common/src/metrics/metrics.service.ts`
  - `libs/backend-common/src/telemetry/tracing.ts`
- Review context:
  - `docs/reviews/orchestrator/2026-04-10-agent-review.md`

## Key Findings

- `platform/configs/*` is a shared runtime contract layer, not ordinary service code. Changes here affect security posture, infra rollout behavior, and service boot semantics at once.
- `platform/libs/cqrs/*` and `platform/libs/event-bus/*` are small in file count but high in blast radius. A local change in these folders is a cross-service kernel change.
- `libs/backend-common/src/bootstrap`, `context`, `health`, `logging`, `metrics`, and `telemetry` provide platform defaults reused by many services. They were not cleanly owned by the previous agent set.
- The prior agent roster had strong domain experts, but no primary owner focused on shared runtime and shared-contract breakage. That made routing fuzzy for platform-level defects.

## Security Concerns

- Weak or silent config defaults can disable expected security controls across multiple services at once.
- Shared event-bus or CQRS abstractions that lose tenant/correlation/trace context create cross-service audit and isolation blind spots.
- Shared logging and metrics code can leak sensitive context or create unsafe cardinality across the whole fleet.

## Performance Concerns

- Shared metrics label choices and health-probe behavior fan out to every service using the shared modules.
- Hidden blocking/retry behavior in CQRS or event-bus abstractions becomes a platform-wide latency and failure-amplification issue.
- Bootstrap and tracing defaults determine startup cost and telemetry overhead across many services, so bad choices here are systemic rather than local.

## Architectural Implications

- A dedicated `platform-kernel-expert` is justified because the failure modes are distinct from domain logic, infra manifests, or auth internals.
- Orchestrator routing should send `platform/configs/**`, `platform/libs/cqrs/**`, `platform/libs/event-bus/**`, and backend-common runtime foundations to a single primary owner.
- Service experts should consume these shared contracts, not own them.

## Domain Rule Additions

- Treat shared-layer defects as shared-layer fixes; do not recommend repeated service-local compensations.
- Require fail-fast validation and secure defaults for `platform/configs/*`.
- Treat tenant/correlation/trace propagation loss in shared CQRS/event-bus code as a blocking architectural defect.
- Keep liveness checks cheap and keep shared logging/metrics cardinality bounded because the blast radius is fleet-wide.
