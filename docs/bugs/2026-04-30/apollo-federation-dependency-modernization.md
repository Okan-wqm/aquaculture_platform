# Apollo Federation Dependency Modernization

- Date: 2026-04-30
- Affected area: root dependency graph, gateway-api, GraphQL subgraphs
- Status: Partially fixed; Server 5 / Router migration remains open

## Observed Issue

The root audit reported critical Apollo Federation advisories in the Gateway/Subgraph stack and high/moderate Apollo Server advisories.

Initial direct upgrade to `@apollo/server@5.5.0` and `@nestjs/apollo@13.3.0` was rejected after verification because the dependency tree became invalid:

- `@nestjs/apollo@13.3.0` peers on Apollo Server 5.
- The same package still depends on `@apollo/server-plugin-landing-page-graphql-playground@4.0.1`.
- The Playground plugin is deprecated and peers on Apollo Server 4.

Forcing that tree with `--force` or `--legacy-peer-deps` would hide an upstream framework/runtime conflict.

## Root Cause

Apollo Federation runtime and Nest Apollo integration moved at different speeds:

- Federation critical CVEs are addressed by the 2.13.x Gateway/Subgraph family.
- Apollo Server 5 is the right non-EOL target, but this codebase currently uses Nest Apollo's `playground` option and gateway integration behavior that still pulls the deprecated Playground plugin in the 13.x line.
- The gateway has custom tenant/security behavior in `RemoteGraphQLDataSource`: JWT-derived tenant propagation, HMAC service identity headers, correlation headers, cookie forwarding, and retryable introspection. That behavior cannot be replaced by a package bump alone.

## Fix Applied

The dependency graph was moved to the highest peer-compatible Apollo Server 4 path while removing the critical Federation advisory class:

- `@apollo/gateway`: `^2.12.1` -> `^2.13.3`
- `@apollo/subgraph`: `^2.12.1` -> `^2.13.3`
- `@apollo/server`: `^4.12.2` -> `^4.13.0`
- `@nestjs/apollo`: `13.2.4` -> `13.1.0`
- `rxjs`: normalized to `^7.8.2` after npm reify left a corrupted local package without `.d.ts` files.

`@nestjs/apollo@13.1.0` is the compatible bridge for Nest 11, `@nestjs/graphql@13.x`, Apollo Server 4.13, and Apollo Federation 2.13.3 without peer-invalid overrides.

## Remaining Risk

This is not the final enterprise target because Apollo Server 4 is EOL as of 2026-01-26 and the audit still reports the Apollo Server `<5.5.0` XS-Search advisory.

The final fix is a dedicated gateway runtime migration:

1. Remove deprecated Playground behavior from service GraphQL configs and use supported Apollo landing page behavior only where allowed.
2. Upgrade Nest Apollo/runtime to a peer-clean Apollo Server 5 tree when the framework package no longer pulls the incompatible Playground plugin, or replace the integration layer explicitly.
3. Evaluate Apollo Router as a sidecar/shadow migration, not as an audit-package hot swap.
4. Prove tenant/security parity with gateway contract tests before any production routing change.

## Verification

- `npm ls @nestjs/apollo @apollo/server @apollo/gateway @apollo/subgraph @apollo/server-plugin-landing-page-graphql-playground --all`: passes with no invalid peer dependency.
- `npm audit --json`: critical count reduced from 10 to 4; total changed from 123 to 125 because Apollo critical issues moved to moderate remaining Server/uuid advisories.
- `npx tsc -p apps/gateway-api/tsconfig.app.json --noEmit`: passes.
- `npx tsc -p apps/farm-service/tsconfig.app.json --noEmit`: passes.
- `npx tsc -p apps/hydroponics-service/tsconfig.app.json --noEmit`: passes.
- `npx tsc -p apps/auth-service/tsconfig.app.json --noEmit`: passes.

## Build Policy Note

Heavy Nx builds were not completed locally. This environment is the Docker-running server with limited CPU; build verification belongs in GitHub Actions when CI can run it. Local/server verification should prefer targeted typechecks, targeted Jest/Testcontainers suites, `npm audit`, and Docker health checks.
