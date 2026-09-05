# ADR-0006 — Two Ratified Internet-Reachable Ingresses + Kernel Edge-Hardening Bundle

**Status:** accepted
**Date:** 2026-09-05
**Supersedes in part:** `docs/adr/002-gateway-api-pattern.md` (the "sole internet-reachable backend service" clause, lines 21 and 26)
**Resolves:** ARCH-CRITICAL-000 (Phase 5a arbitration), auth-security-expert#AUTH-009, #AUTH-010, #AUTH-017, observability-expert#OBS-005, access-boundary-auditor#ACCESS-022
**Finding reference:** docs/reviews/admin-expert/2026-09-05-superadmin-audit.md#SEC-CRITICAL-056

## Context

ADR-002 states that `apps/gateway-api` is the sole internet-reachable backend service and that admin frontends reach `admin-api-service` through gateway routing. Production contradicts both: `infrastructure/nginx/droplet.conf:423-433` proxies `/api/` straight to `admin-api-service:3000`, and `apps/admin-api-service/src/guards/platform-admin.guard.ts:101-103` documents the same in code.

Every kernel edge control is therefore mounted on a service that is not the admin surface's edge. `tests/invariants/access-log-middleware-mounted.spec.ts:20-21` asserts gateway-api is "the single external ingress"; `strip-internal-headers-mounted.spec.ts:75-79` excludes admin-api behind a `// Future:` comment; `TRUST_PROXY` (`create-service-app.ts:279`) defaults to `'false'` and admin-api never sets it, so `request.ip` is the nginx bridge address and every `byIp` rate-limit bucket is one global bucket (AUTH-010). `csrf.middleware.ts:18` sets cookie `csrf-token` while all readers look for `XSRF-TOKEN` (AUTH-017) — the middleware is dead.

Options framed by the reports: (a) route `/api/` through gateway-api and repair ADR-002; (b) hand-add `configure()` blocks to admin-api and extend the two allowlists; (c) make the hardening a kernel default for public services with the public set derived from nginx.

## Decision

We ratify two internet-reachable ingresses, `gateway-api` and `admin-api-service`, and we make edge hardening a property of the bootstrap factory rather than of any one service.

- `bootstrapService` applies an edge-hardening bundle — `StripInternalHeadersMiddleware`, `AccessLogMiddleware`, `RequestContextMiddleware`, and mandatory `TRUST_PROXY` resolution — to every service declaring `serviceVisibility: 'public'`. A public service without `TRUST_PROXY` refuses to boot.
- The set of public services is derived from `infrastructure/nginx/droplet.conf` `proxy_pass` upstreams. No hand-maintained list of internet-facing services may exist.
- `tests/invariants/strip-internal-headers-mounted.spec.ts` and `access-log-middleware-mounted.spec.ts` are merged into `tests/invariants/public-service-edge-hardening.spec.ts`, which parses nginx and asserts each upstream (i) declares public visibility, (ii) sets `TRUST_PROXY` in the droplet compose, (iii) has the bundle mounted by the factory.
- Dead CSRF middleware and its client-side attach logic are deleted platform-wide; admin-api is bearer-only.
- `docs/adr/002-gateway-api-pattern.md` Status becomes `Superseded in part by ADR-0006` when this decision lands.

Option (a) is rejected: it would move the admin surface behind a second hop for the sake of a documented claim, without removing the class defect (a hand-listed ingress set). Option (b) reproduces the defect: a second hand-maintained list is exactly what produced ARCH-CRITICAL-000.

## Consequences

- `shared.access_logs` begins receiving one row per admin request, traffic it has never carried. ADR-0012 (single retention authority, entity-typed policies) is a hard prerequisite, or this decision grows an unbounded table.
- All 13 Nest services boot through the changed factory; public ones gain a required variable in `docker-compose.droplet.yml`. A missing `TRUST_PROXY` now fails deploy loudly instead of silently mis-attributing IPs.
- The losing side: ADR-002's clean "one ingress" story is gone. Operators and reviewers must treat admin-api as an edge with the same scrutiny as gateway-api.
- Dependency: R1 (ADR-0007), R5 (ADR-0011) and R10 (ADR-0016) all mount on this decision.

## Implementation note (landed 2026-09-05)

- The bundle the factory applies is `TRUST_PROXY` (mandatory in production for a public service, resolved by `resolveTrustProxy`) and `AccessLogMiddleware` (`mountEdgeHardening`), both in `libs/backend-common/src/bootstrap/edge-hardening.ts`. `RequestContextMiddleware` needed no second mount: `LoggingModule` already installs it for every importer.
- `StripInternalHeadersMiddleware` stays in each service's module chain rather than the factory. gateway-api must run `CaptureRequestedTenantMiddleware` before the strip deletes `x-act-as-tenant`; a factory-level mount would run ahead of it. The merged invariant enforces the strip on every bootstrapped Nest service with no exclusion list, which is stronger than the decision text: the four services the old spec deferred (admin-api, config, event-store, observability) now mount it.
- `serviceVisibility` is a required boot option. The compiler refuses a service that does not declare it; the invariant refuses a declaration that disagrees with nginx, a public service whose compose entry lacks a literal `TRUST_PROXY`, and an internal service whose compose entry carries edge configuration. nginx proxies four Nest services: gateway-api, admin-api-service, sensor-service, billing-service. The last two had never set `TRUST_PROXY`.
