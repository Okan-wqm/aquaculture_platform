# ADR-002: Single Gateway-API Edge Service

**Status:** Superseded in part by ADR-0006 (`docs/recommendations/architectural-arbiter/2026-09-05-adr-0006-two-ingress-topology-edge-hardening-bundle.md`) — the "sole internet-reachable backend service" clause no longer holds: `admin-api-service`, `sensor-service` (device provisioning) and `billing-service` (Stripe webhook) are nginx upstreams alongside `gateway-api`, and the kernel applies the edge-hardening bundle to every service declaring `serviceVisibility: 'public'`. Originally Accepted (retrodocumented 2026-04-16 during W1 audit).
**Supersedes:** none
**Context note:** this file was 0 bytes until W1 audit flagged it as a phantom canonical ADR. Content below reflects the repository's observable reality.

## Context

Fifteen backend services expose domain capabilities plus the Rust edge gateway. A browser, mobile client, or third-party integrator must not be asked to know all endpoints, rotate credentials for each, or handle different auth schemes per service.

Options considered:

1. **Direct per-service exposure** — clients hit each service directly. Simple, but leaks topology, multiplies auth surface, complicates CORS, prevents uniform rate limiting.
2. **Single gateway service** — one service terminates the public TLS + auth boundary, routes internal requests, applies cross-cutting policies.
3. **Per-domain gateway cluster** — dilutes cross-cutting policy enforcement.

## Decision

Adopt a single `gateway-api` service as the public-facing edge.

- `apps/gateway-api` is the sole internet-reachable backend service in production.
- Terminates TLS, applies rate limiting (Redis-backed token bucket), CSP headers, JWT guard, resolves tenant context (ADR-008 defense-in-depth), signs outbound requests to internal services with HMAC (`libs/backend-common/src/utils/service-identity.util.ts`).
- Federated GraphQL: gateway runs Apollo Federation 2 + `graphql-depth-limit` + `graphql-query-complexity`; internal services expose subgraph schemas; clients see one unified schema.
- REST proxy pattern: `/api/<service>/<resource>`; internal services receive requests over `http://<service-name>:<port>` behind the compose network.
- Internal services verify inbound requests via `x-service-identity` header + HMAC signature (canonical input hardening per SEC-HIGH-002/003 findings scheduled W5).
- Admin-panel + tenant-admin frontends consume `admin-api-service` through gateway-api routing.

## Consequences

**Positive:**
- One public attack surface, one TLS certificate, one rate-limit policy.
- Internal services run without public exposure — defence in depth.
- GraphQL clients see a single schema; REST clients see a single base URL.
- Cross-cutting policies applied once.

**Negative:**
- gateway-api becomes a critical-path SPoF; deploy resilience matters (ADR-016).
- Smoke tests on `/health` + `/graphql` must gate every deploy.
- Latency is double-hop; intra-VPC overhead small but realtime streaming bypasses via WebSocket route.
- HMAC canonical-input weaknesses enable replay windows (tracked SEC-HIGH-002/003, fix W5).

## References

- `apps/gateway-api/src/main.ts`
- `apps/gateway-api/src/graphql/federation.module.ts`
- `libs/backend-common/src/utils/service-identity.util.ts`
- `libs/backend-common/src/middleware/strip-internal-headers.middleware.ts`
- `/var/aqua-saas/docs/reviews/_audit/2026-04-W16-backend-security.md`
