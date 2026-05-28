# Farm Service Tenant Isolation

## Tenant Source

Tenant identity is accepted from verified identity context only:

1. JWT payload forwarded by a signed service request.
2. Tenant context set by middleware after internal header stripping.
3. Audited super-admin impersonation flow with durable audit evidence.

Raw controller headers, GraphQL variables, body fields, query strings, and client-selected schema names are not tenant authority.

## Database Boundary

Farm uses source schema `farm` and tenant schemas named by the platform schema sanitizer. Business writes must use `runInTenantTransaction(dataSource, "farm", tenantId, fn)` or a tenant-scoped repository port. Raw `createQueryRunner` belongs only in documented infrastructure paths.

## Read Path

Read handlers must carry tenant filters for tenant-scoped entities. Global catalog lookups must be explicitly documented in invariant allowlists.

## GraphQL DataLoaders

Request-scoped DataLoaders must derive tenant identity from authenticated request context. They must not derive schema from raw `x-tenant-id` headers.

## Tests And Gates

The following checks protect this boundary:

- `tests/invariants/farm-service-tenant-isolation.spec.ts`
- `tests/invariants/strip-internal-headers-mounted.spec.ts`
- `apps/farm-service/src/__tests__/e2e/graphql-loader-tenant-source.architecture.spec.ts`
- `tools/gates/farm-service-enterprise-guardrails.ts`
