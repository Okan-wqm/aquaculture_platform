# Apollo Router PoC

2026-04-30

This directory is the self-hosted Apollo Router migration boundary.

Operational rule:

- Router must start with `--supergraph /etc/router/supergraph.graphql`.
- GraphOS/Apollo Studio can be evaluated later as a publishing control plane, but runtime `/graphql` traffic must not require registry availability.
- CI must compose a fresh supergraph with Rover and publish the generated SDL as an image artifact or mounted file.
- Production rollback is traffic-based: route `/graphql` back to `gateway-api` without database migrations.

Security rule:

- Client-supplied internal identity headers are untrusted input.
- The router coprocessor must strip spoofable headers before subgraph forwarding and then add verified headers from the trusted auth/tenant context.
- The pen-test gate in `scripts/apollo-router/router-header-stripping-pentest.mjs` must pass before Router receives any production traffic.
