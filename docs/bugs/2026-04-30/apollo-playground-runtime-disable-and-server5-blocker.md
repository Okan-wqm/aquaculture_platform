# Apollo Playground runtime disable and Apollo Server 5 blocker

Date: 2026-04-30

## Problem

The platform still had GraphQL `playground` runtime configuration in gateway
and subgraph modules. That kept deprecated developer UI behavior alive and made
the Apollo/Nest dependency modernization harder to reason about.

## Root Cause

The Nest Apollo integration still carries
`@apollo/server-plugin-landing-page-graphql-playground`. Attempting to move to
`@nestjs/apollo@13.4.0` with `@apollo/server@5.5.0` under
`strict-peer-deps=true` fails because the Playground plugin has a peer dependency
on Apollo Server 4 while the package itself declares Apollo Server 5 support.

This is an upstream package-graph conflict. Bypassing it with `--force`,
`--legacy-peer-deps`, or `--no-strict-peer-deps` would violate the repository
dependency policy.

## Fix Applied

- Removed runtime `playground` options from gateway and subgraph GraphQL module
  configuration.
- Removed the stale gateway feature flag exposure for Playground.
- Changed the platform setting default for `feature.graphql_playground` to
  disabled and updated its description so admin settings do not advertise an
  unsupported developer UI.
- Updated the common bootstrap log message to advertise the GraphQL endpoint,
  not GraphQL Playground.

## Verification

Server/local build and test execution was not run. Those gates must run in
GitHub Actions.

Lightweight checks performed:

- `npm install @nestjs/apollo@13.4.0 @apollo/server@5.5.0 --package-lock-only
  --ignore-scripts --no-audit --no-fund` failed under `strict-peer-deps=true`,
  proving the upstream peer conflict.
- Repository search found no remaining runtime `playground:` config,
  `GRAPHQL_PLAYGROUND` usage, or “GraphQL playground” bootstrap log.

## Remaining Work

Apollo Server 5 must wait until one of these is true:

- `@nestjs/apollo` publishes a release without the Apollo Server 4 Playground
  plugin peer conflict.
- The platform replaces `@nestjs/apollo` with a maintained custom integration
  that supports Apollo Server 5 and gateway/federation without deprecated
  Playground packages.

Do not bypass the conflict with npm force or legacy peer resolution.
