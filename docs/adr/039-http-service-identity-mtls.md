# ADR-039: HTTP Service-Identity over mTLS (retire the shared HMAC keyring)

**Status:** Proposed
**Date:** 2026-06-27
**Deciders:** platform team (auth-security-expert + infra-expert + architecture)
**Related:** ADR-014 (NATS mTLS-only auth), ADR-015 (NATS cert-is-identity SSoT), CLAUDE.md NATS Authentication, ORPHAN-HIGH-096

## Context

Inter-service HTTP calls (gateway → subgraph, service → service) authenticate
with an HMAC-signed identity header scheme: the canonical signature in
`libs/backend-common/src/utils/service-identity.util.ts` (v2: timestamp +
serviceName + method + path + bodyHash + tenantId + audience + … signed with
HMAC-SHA256), verified by `ServiceIdentityGuard`.

**The defect (ORPHAN-096):** `SERVICE_IDENTITY_KEYRING` is a SINGLE shared secret
interpolated identically into all 12 backends (`docker-compose.droplet.yml`).
Because every service holds the same secret, a single compromised service can
sign `X-Service-Identity: <any-other-service>` and the receiver cannot tell it
is forged. The only authorization is the catalog-derived `serviceIdentityCallers`
+ `matchesExpectedAudience` allow-list — a known-name sanity gate, **not** a
cryptographic per-caller boundary.

NATS already solved the analogous problem (ADR-014/015): it removed shared
credentials entirely and made the **per-service mTLS client-cert CN the sole
identity** (`verify_and_map: true`), with `infrastructure/nats/services.yaml` as
the SSoT and a cert-minting pipeline. HTTP service-identity should converge on the
same "cert-is-identity" end-state.

## Decision (to be ratified) — a phased transition

### Phase 1 (in-repo, ALREADY SCOPED as ORPHAN-096 Phase 1 / W3 T2.3): per-service keyring entries

The keyring schema already supports per-entry `secret` + `callers`, and the guard
already resolves by `kid`. Provision ONE keyring entry per service
(`{kid:'<svc>/v1', secret:<unique>, callers:['<svc>']}`) in the deploy secret
bootstrap; give each service its own `SERVICE_IDENTITY_SIGNING_KID`. A compromised
service can then only sign with ITS secret — real per-caller crypto, no new
transport. This is the stepping stone; it does NOT need this ADR.

### Phase 2 (THIS ADR): per-service mTLS, retire HMAC

Make the inter-service HTTP client cert CN the identity, mirroring ADR-015:

1. **Cert minting:** extend the existing internal-CA pipeline that mints NATS
   per-service certs (`infrastructure/.../generate-internal-certs.sh` family) to
   also mint HTTP CNs (`CN=<service_name>`), with `infrastructure/nats/services.yaml`
   (or a sibling HTTP SSoT) driving the roster — one identity source, like ADR-015.
2. **Transport:** on the single-host droplet there is **no service mesh / k8s**, so
   mTLS is terminated **in-process (Node-native)**: each inter-service HTTP client
   (the signed HTTP client factory in backend-common) presents its client cert; the
   receiver validates the cert chain + maps CN → caller identity, replacing the
   HMAC verify.
3. **Cutover:** run HMAC + mTLS in **dual mode** behind a flag, then make mTLS
   required and delete the keyring layer — the ADR-015 "remove the legacy path
   entirely" move (Make-Impossible tier).
4. **Scrape parity:** the observability-service `/metrics` `INTERNAL_API_KEY`
   header (see ADR-090 deferral) is replaced by the same per-service cert, so
   Prometheus authenticates with mTLS rather than a shared key.

## Rationale

- **Why mTLS, not "just per-service HMAC keys" (Phase 1) forever:** per-service
  HMAC keys remove cross-service forgery but still rely on a shared-secret
  distribution + rotation surface and an application-layer verify. mTLS makes the
  identity a transport-layer cryptographic fact (cert CN), rotatable per service,
  and aligns HTTP with the NATS SSoT — one identity model platform-wide.
- **Why in-process mTLS, not a sidecar mesh:** Linkerd/Istio need Kubernetes; the
  deployment is single-host Docker. Node-native TLS on the HTTP client/server is
  the proportionate transport for this topology.
- **Why phased + dual-mode:** a flag-day swap of every inter-service call is too
  risky; dual-mode + a CI invariant (no service may disable mTLS once on) is the
  safe convergence, exactly as ADR-014→015 staged the NATS move.

## Consequences

- **Infra:** the internal-CA pipeline gains HTTP CNs; each backend mounts a
  per-service cert (compose/secret change across all 12 services); rotation cadence
  defined. Requires infra access + a security review — NOT a pure code change.
- **Code:** the signed HTTP client factory + `ServiceIdentityGuard` gain an mTLS
  path; a dual-mode window; then the keyring code is deleted.
- **Risk:** a misissued/expired cert breaks an inter-service call — staging
  validation + a cert-expiry alert (reuse the NATS cert monitoring) are mandatory
  before required-mode. Until Phase 2 ships, **Phase 1 (per-service keyring) is the
  near-term hardening that removes the cross-service forgery vector** with no infra
  change.

## Implementation phases

1. **Phase 1** — per-service keyring entries (W3 T2.3; no ADR needed; staging-validated rotation).
2. **Phase 2a** — mint HTTP per-service certs from the internal CA + SSoT roster; CI invariant for roster↔cert parity (mirror `nats-invariants.spec.ts`).
3. **Phase 2b** — dual-mode mTLS in the HTTP client/guard behind a flag; staging soak.
4. **Phase 2c** — require mTLS, delete the HMAC keyring, migrate the observability scrape header to mTLS.

## References

- ORPHAN-HIGH-096 (`docs/reviews/orphan-findings.md`)
- ADR-014, ADR-015 (NATS mTLS / cert-is-identity precedent)
- `libs/backend-common/src/utils/service-identity.util.ts`, `…/guards/service-identity.guard.ts`
- `infrastructure/nats/services.yaml` (per-service identity SSoT pattern)
