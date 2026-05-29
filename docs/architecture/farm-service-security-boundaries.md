# Farm Service Security Boundaries

## Boundary

`farm-service` is an internal subgraph and service API. External clients enter through `gateway-api`; direct client traffic to farm-service is not part of the supported production topology.

## Required Request Proof

Production GraphQL and REST requests require service identity v2 headers verified by `ServiceIdentityGuard`, except health and metrics probes:

- `x-service-identity`
- `x-service-timestamp`
- `x-service-signature`
- `x-service-sig-version: v2`
- `x-service-method`
- `x-service-path`
- `x-service-body-hash`
- `x-service-user-assertion-hash`

User-scoped calls also carry `x-verified-user-assertion`. The service HMAC binds the assertion hash, method, path, body hash, and tenant ID, so a tenant or user assertion cannot be swapped after signing.

## Verified Farm Identity

Gateway creates `x-verified-user-assertion` only from an already verified JWT. Farm verifies that assertion with `VERIFIED_USER_ASSERTION_SECRET` or `GATEWAY_USER_ASSERTION_SECRET` and builds one request model: `FarmVerifiedIdentity`.

Farm code must treat these as authoritative:

- `req.farmVerifiedIdentity.effectiveTenantId`
- `req.farmVerifiedIdentity.actorTenantId`
- `req.tenantId` set by tenant middleware or guard
- `req.user` populated from the verified assertion

Farm code must not parse raw `x-user-payload`, `x-user-id`, `x-user-roles`, or `x-tenant-id` as identity authority.

## Spoofable Internal Headers

`StripInternalHeadersMiddleware` must run before user and tenant middleware. If a request lacks valid service proof, farm-service strips these headers before downstream code can read them:

- `x-user-payload`
- `x-user-id`
- `x-user-roles`
- `x-tenant-id`
- `x-act-as-tenant`
- `x-verified-user-assertion`

## Super Admin Tenant Access

`X-Act-As-Tenant` is an ingress concern at the gateway. The gateway honors it only for super-admin roles, then encodes the target as `effectiveTenantId` in the signed user assertion. Farm `TenantGuard` audits cross-tenant access using actor tenant and effective tenant from `FarmVerifiedIdentity`, requires MFA when configured, and fails closed in production if durable audit logging is unavailable.

Farm must not rely on a raw `x-act-as-tenant` header when a signed farm identity is present.

## REST Surface

GraphQL is the business API surface. REST remains for health, metrics, Sentinel Hub proxy paths, file transfer, streaming, and webhooks. New domain mutations over REST require an ADR entry and an OpenAPI entry.

## Metrics

Prometheus metric labels must not include raw tenant UUIDs or tenant-derived values. Use bounded labels such as operation, outcome, axis, surface, and error class.

## Failure Contract

Production failures must return stable client errors with correlation IDs and no SQL, password, token, key, or connection detail.
