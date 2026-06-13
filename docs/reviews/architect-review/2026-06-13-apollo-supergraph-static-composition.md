# Apollo Router static supergraph composition (R0)

**Date:** 2026-06-13
**Agent:** architect-review (lead-verified)
**Wave:** R0 (S2). Track D — Apollo Router gradual cutover.

---

## CONTRACT-HIGH-001 — The GraphQL supergraph is composed at RUNTIME (IntrospectAndCompose), and there was no build-time composition gate; a subgraph schema break is discovered as a production gateway restart-loop

**Problem.** `apps/gateway-api/src/app.module.ts` boots an Apollo Gateway whose
`supergraphSdl` is a `RetryableIntrospectAndCompose` (apps/gateway-api/src/config/
retryable-introspect.ts): at startup the gateway fetches every subgraph's schema
over HTTP and composes the supergraph LIVE, retrying ~24× over ~72–94s before the
container's Docker `start_period` trips and restarts it. Composition is
all-or-nothing — a single unreachable or schema-broken subgraph restart-loops the
ENTIRE gateway. The failure surfaces at deploy time (or worse, mid-incident) as a
crash-looping gateway, with no signal at PR time that subgraph schemas stopped
federating.

The static-composition path was scaffolded but **could not run**: `infrastructure/
apollo-router/router.yaml` + the registry generator + `compose-supergraph.sh`
existed, but `compose-supergraph.sh` shelled out to `rover supergraph compose`
reading `dist/graphql/subgraphs/<name>.graphql` files that **no script generated**
(the 10 subgraphs emit their SDL only as a runtime side-effect of a full service
boot — `autoSchemaFile`, which needs Postgres/NATS/Redis). So there was no way to
compose the supergraph at build time and no CI gate on composition.

**Firsthand-validated approach.** Code-first GraphQL SDL is pure metadata
reflection: importing a resolver file registers its `@ObjectType`/`@Field`/
`@Resolver` decorators into NestJS's global `TypeMetadataStorage`, and
`GraphQLSchemaFactory` + `@apollo/subgraph` build the federated schema from that
metadata WITHOUT instantiating the resolvers or their service/repository deps —
so NO runtime infra and NOT the `@nestjs/apollo` driver are needed. Verified by
emitting all 10 subgraphs (auth 31KB/0 @key, farm 218KB/6 @key, sensor 90KB/2,
hr, hydroponics, messaging 13KB/1, alert, billing, notification, config — 10 OK /
0 FAIL) and composing them with `@apollo/composition` → a 522 KB supergraph, zero
composition errors. `@apollo/composition` is the same Federation-2 engine `rover
supergraph compose` wraps, so the gate runs in pure Node with no rover binary.

---

## R0 (this PR) — build-time SDL emission + static composition + CI gate

- `tools/scripts/emit-subgraph-sdl.ts` — emits one subgraph's Federation v2 SDL
  from its code-first resolvers (no runtime, no `@nestjs/apollo`). Reproduces the
  runtime `GraphQLFederationFactory.generateSchemaFromCodeFirst` pipeline
  standalone: glob resolvers → populate the global metadata storage → build via
  `GraphQLSchemaFactory.create` → `@link` federation directive → `buildSubgraph
  Schema` → `printSubgraphSchema`.
- `scripts/apollo-router/build-supergraph.mjs` — the canonical build: emits each
  subgraph in its OWN process (the global `TypeMetadataStorage` is per-process;
  two subgraphs in one process would cross-contaminate) and composes them with
  `@apollo/composition`, writing `dist/graphql/supergraph.graphql` or **failing
  loud with the composition errors**.
- `scripts/apollo-router/compose-supergraph.sh` — rewritten as a thin wrapper over
  build-supergraph.mjs (the rover-binary + missing-SDL dependencies removed; one
  canonical compose path, no blind spot).
- `.github/workflows/apollo-supergraph-validate.yml` — runs the build on every
  subgraph-schema change; a schema break that cannot federate (unresolvable @key,
  type conflict, invalid @requires) is a **RED PR**, and the composed supergraph
  is uploaded as a CI artifact for the router image build.

### Validation
- `node scripts/apollo-router/build-supergraph.mjs` — **10 subgraphs composed →
  dist/graphql/supergraph.graphql (522 KB)**, exit 0, valid `@link(join/v0.3)`.
- All emitter/orchestrator runs infra-free (no DB/NATS/Redis) and `@nestjs/apollo`-free.
- The runtime IntrospectAndCompose root cause is now killable: composition is a
  build artifact, not a boot-time recompose.

## NOT done here (Track D continuation, separate waves)
- **R1**: the Rust router-coprocessor that reproduces `generateServiceIdentity
  HeadersV2`'s 14-field canonical signature byte-for-byte (the gateway currently
  signs subgraph requests with `secret: undefined` — authenticated-data-source.ts;
  the coprocessor injects the keyring). Golden-vector parity vs the TS signer.
- **R2**: production cutover — nginx `$backend_gw_gql` → `apollo-router:4000`,
  `Dockerfile.apollo-router` bundling the composed supergraph, dual-run + fallback.
- **R3**: delete the gateway-api IntrospectAndCompose path once stable.
The runtime gateway IntrospectAndCompose stays LIVE until R2/R3 — zero data migration.
