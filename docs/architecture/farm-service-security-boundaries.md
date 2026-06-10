# Farm Service Security Boundaries

## Boundary

`farm-service` is an internal subgraph and service API. External clients enter through `gateway-api`; direct client traffic to farm-service is not part of the supported production topology.

## Required Request Proof

Production GraphQL requests require service identity v2 headers verified by `ServiceIdentityGuard`:

- `x-service-identity`
- `x-service-timestamp`
- `x-service-signature`
- `x-service-sig-version: v2`
- `x-service-method`
- `x-service-path`
- `x-service-body-hash`

`StripInternalHeadersMiddleware` must run before user and tenant middleware. If a request lacks valid service proof, farm-service strips spoofable internal headers before downstream code can read them.

## Spoofable Internal Headers

These headers are trusted only after service proof succeeds:

- `x-user-payload`
- `x-user-id`
- `x-user-roles`
- `x-tenant-id`

Code must not use raw tenant headers as tenant authority. Use verified request context: `req.user?.tenantId`, `req.tenantId`, or platform tenant context APIs.

## REST Surface

GraphQL is the business API surface. REST remains for health, metrics, Sentinel Hub proxy paths, file transfer, streaming, and webhooks. New domain mutations over REST require an ADR entry and an OpenAPI entry.

## Failure Contract

Production failures must return stable client errors with correlation IDs and no SQL, password, token, key, or connection detail.
