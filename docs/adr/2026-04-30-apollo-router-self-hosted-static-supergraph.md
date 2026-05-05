# ADR: Apollo Router self-hosted static supergraph migration

Date: 2026-04-30

## Decision

Adopt Apollo Router as a self-hosted Router PoC that boots from a static
`supergraph.graphql` file. Do not make production `/graphql` runtime availability
depend on Apollo Studio, GraphOS Uplink, or any external schema registry.

## Rationale

The current Node gateway uses runtime introspection and composition. That keeps
composition coupled to gateway startup and leaves Apollo Server 4 in the hot
path while the NestJS Apollo Server 5 peer graph is not clean.

Router provides a cleaner runtime boundary, but only if the supergraph artifact
is produced before deployment and mounted into Router. A registry outage must
not prevent Router from starting or serving the last approved supergraph.

## Required Controls

- Source registry: `infrastructure/apollo-router/subgraphs.json`.
- Generated Rover config: `npm run apollo-router:supergraph-config`.
- Static fallback gate: `npm run apollo-router:check-fallback`.
- Composition gate: `npm run apollo-router:compose` in GitHub Actions after the
  subgraphs are available.
- Header spoofing gate: `npm run apollo-router:pentest-headers` against a
  Router-backed environment before production traffic is shifted.

## Rejected Options

- Runtime GraphOS-only Router startup: rejected because registry availability
  would become a `/graphql` availability dependency.
- Keeping only Node gateway modernization: rejected as the primary path because
  it keeps runtime composition and Apollo Server 4/5 peer risk in the hot path.
- Deleting `gateway-api`: rejected because it still owns non-GraphQL BFF,
  upload, REST, health, and WebSocket concerns.
