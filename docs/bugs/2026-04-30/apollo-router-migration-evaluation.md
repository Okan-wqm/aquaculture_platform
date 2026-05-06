# Apollo Router Migration Evaluation

- Date: 2026-04-30
- Affected area: gateway-api / supergraph routing
- Status: Evaluated; migration recommended as a separate architecture project

## Decision

Do not replace the current Nest Apollo Gateway with Apollo Router as part of the dependency audit change.

Apollo Router is a valid enterprise target because it is the current Rust-based supergraph router direction from Apollo and can improve routing performance and operational isolation. However, this codebase's gateway is not a thin pass-through router. It owns tenant and security behavior that must be migrated deliberately.

## Current Gateway Responsibilities

The current `gateway-api` implementation includes behavior that must be preserved before Router can serve production traffic:

- JWT-derived tenant resolution before accepting any tenant header.
- `x-tenant-id`, `x-user-id`, `x-user-roles`, and `x-user-payload` propagation to subgraphs.
- HMAC service identity headers bound to the signed tenant.
- Cookie forwarding from subgraphs back to the browser.
- Correlation and trace header propagation.
- Retryable subgraph introspection/composition.
- Gateway-level guards, request validation, CSRF/rate-limit/security headers, metrics, and websocket/NATS bridges.

Replacing this in one dependency-audit step would be a behavioral migration, not a package modernization.

## Enterprise Migration Plan

1. Create an ADR for Router adoption with explicit non-goals: no tenant/security behavior may be weakened to gain performance.
2. Compose the current subgraph schema into a Router-compatible supergraph artifact in CI.
3. Run Apollo Router as a sidecar/shadow route in non-production, forwarding mirrored traffic where safe.
4. Rebuild tenant/security behavior using supported Router configuration/plugins/coprocessor mechanisms or keep a dedicated auth edge in front of Router.
5. Add gateway parity tests covering tenant isolation, HMAC headers, cookie forwarding, CSRF/rate-limit, error shape, and websocket/subscription behavior.
6. Canary one internal tenant only after parity tests pass and rollback is proven.

## Verification Required Before Adoption

- Tenant A cannot read Tenant B data through Router.
- Subgraphs reject requests without valid service identity headers.
- Browser auth/cookie flows behave identically to the current gateway.
- Existing mobile/frontend read-after-write paths still invalidate/refetch correctly.
- Router metrics/tracing are connected to the existing observability model.

## Notes

Apollo Router may still be the correct long-term platform choice. The key point is sequencing: first stabilize the current dependency and tenant isolation work; then migrate routing architecture with a dedicated parity plan.
