# Apollo and GraphQL EOL install surface

Date: 2026-05-02

## Problem

Strict `npm ci --ignore-scripts --no-audit --no-fund` surfaced deprecation and
EOL warnings in the GraphQL dependency surface:

- `@apollo/server-plugin-landing-page-graphql-playground@4.0.1` is migration-only
  and does not receive security or bug fixes.
- `graphql@14.7.0` is no longer supported.
- `@apollo/server@4.13.0` is end-of-life as of 2026-01-26.

## Impact

These packages sit on the gateway/subgraph request path. Treating them as normal
warnings would hide a real platform lifecycle risk: future GraphQL security,
composition, and request-handling fixes may not reach the deployed runtime.

## Existing Guardrails

- Runtime GraphQL Playground exposure is already disabled and documented.
- `scripts/ci/check-apollo-csrf-prevention.mjs` enforces explicit
  `csrfPrevention: true` on every Apollo gateway/subgraph `GraphQLModule`
  configuration under `apps/`.
- Dependency policy blocks `--legacy-peer-deps`, `--force`, `patch-package`, and
  unsafe transitive `uuid@14` overrides.
- Apollo Router static-supergraph PoC files and header-stripping gates are in
  place so gateway routing can move away from Node Apollo Server dependencies
  without making schema registry availability a runtime SPOF.

## Architectural Fix Direction

The enterprise-grade path remains one of these governed migrations:

- Move gateway routing/composition to Apollo Router with static supergraph
  fallback, tenant/auth header propagation tests, internal-header stripping
  pentest, observability checks, and traffic rollback.
- Or move the Nest Apollo stack to a strict-peer-clean Apollo Server 5 graph once
  the upstream `@nestjs/apollo` peer/dependency conflict is resolved without
  install bypasses.

## Verification

Do not suppress these warnings without controls. The dependency-policy gate,
Apollo CSRF prevention gate, and GitHub Actions audit/check jobs must remain
fail-closed while the gateway migration path is implemented through the
documented Apollo Router or peer-clean Apollo 5 track.
