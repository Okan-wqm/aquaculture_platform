# Apollo Router and TypeORM dependency remediation

Date: 2026-04-30

## Problems Found

- Docker images still used `npm ci --legacy-peer-deps`, which could hide the
  Apollo/TypeORM peer graph that CI is expected to enforce.
- Apollo Router migration needed a self-hosted static-supergraph design;
  relying on GraphOS at runtime would create a registry availability SPOF.
- Router migration must prove internal-header stripping. Spoofed `x-user-id`,
  `x-user-roles`, `x-user-payload`, and `x-service-*` headers cannot be trusted
  when sent by external clients.
- TypeORM `uuid` remediation cannot be solved by `uuid@14` overrides,
  `patch-package`, or a wrapper around our repositories.

## Fix Implemented

- Removed Docker `--legacy-peer-deps` install bypasses.
- Added `scripts/ci/check-dependency-policy.mjs` and wired it into quality gates.
- Added Apollo Router PoC registry/config/scripts under
  `infrastructure/apollo-router` and `scripts/apollo-router`.
- Added ADRs for self-hosted Router static supergraph and TypeORM governed fork.

## Remaining Implementation Boundary

The Router service must not receive production traffic until GitHub Actions
passes composition, fallback, header-stripping, tenant isolation, and rollback
gates. The TypeORM fork must not replace official TypeORM until upstream tests
and Aqua DB platform tests pass against the fork package.
