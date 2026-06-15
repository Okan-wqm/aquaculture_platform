# R1 — self-built Apollo Router coprocessor (Rust)

**Agent:** architect-review
**Date:** 2026-06-14
**Track:** D (Apollo Router cutover), R1
**Predecessor:** R0 (#417, CONTRACT-HIGH-001) — build-time supergraph composition + `router.yaml`.

## CONTRACT-HIGH-002 — Apollo Router needs a coprocessor to sign subgraph requests with service-identity HMAC-v2

### Decision (PATH 2, operator-confirmed)

Apollo Router's static-fallback guard requires a coprocessor (not a GraphOS Enterprise
license) to inject auth. The HMAC-v2 contract binds a per-subgraph, post-query-planning
body hash, so signing MUST happen at the Router's SubgraphRequest stage — Rhai cannot do
HMAC-SHA256, so a coprocessor is architecturally mandatory. Language: **Rust** — hot-path
(every subgraph request) + HMAC-SHA256 crypto + single-droplet memory budget (~15MB vs
~96MB Node heap, GC-free predictable latency). New crate `crates/router-coprocessor`.

### Load-bearing invariant (firsthand-verified)

The coprocessor's SubgraphRequest signing MUST be **byte-for-byte identical** to the TS
`generateServiceIdentityHeadersV2` (`libs/backend-common/src/utils/service-identity.util.ts`)
— every subgraph guard re-verifies the HMAC, so a one-byte divergence rejects all
gateway→subgraph traffic. Contract: a 14-field canonical string newline-joined
(`v2`, timestamp, serviceName, method-upper, path, bodyHash, tenantId, keyId, audience,
queryHash, contentType, effectiveTenantId, assertionHash, nonce), signed
`HMAC-SHA256(canonical, secret)` lowercase hex.

### This commit — golden-fixtures-FIRST foundation

The highest-risk integration point is tested first. `crates/router-coprocessor`:
`sha256_hex` + `build_canonical_v2` + `sign_v2` reproduce the TS contract, with a parity
test pinned to a **golden vector computed with the same crypto the TS generator uses**
(Node `createHash`/`createHmac`, fixed timestamp+nonce):
`sig=1f6e6d1423dcf8efa92e61bc96ad37e004134c0794c4bee5207440d80a783147`. If the TS canonical
layout or HMAC drifts, the test fails loudly. Rust compiles + runs on Rust CI.

### Remaining phases (tracked under CONTRACT-HIGH-002)

2. axum HTTP server + the Apollo Router coprocessor protocol (RouterRequest / SubgraphRequest stages).
3. RouterRequest auth parity with gateway-api: spoofable-header strip, RS256 JWT verify,
   Redis token blacklist, CSRF double-submit, Redis rate-limit.
4. `router.yaml` hardening (csrf, limits depth/alias/token, introspection off, error masking).
5. Staging compose overlay + `e2e/tests/integration/router-parity.e2e.spec.ts` +
   existing `apollo-router:pentest-headers` against the staging Router.
