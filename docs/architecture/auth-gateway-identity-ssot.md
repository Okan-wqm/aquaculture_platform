# Auth Gateway Identity SSoT

Auth-service is the only JWT issuer and the only writer for `auth.*` domain state. Gateway verifies access tokens through `GatewayTokenVerifierService`; subgraphs do not accept caller-supplied identity headers.

## Token Validity

Every gateway token path must perform the same checks: JWT signature, issuer/audience, `type=access`, required claims, production JTI, user blacklist, and tenant blacklist. HTTP middleware, guards, and WebSocket handshakes must use the shared verifier.

Auth-service uses `TokenIssuerService` for issuance and composite blacklist checks for token validation. Production deployments require Redis-backed token blacklist and session revocation; in-memory stores are allowed only for dev/test.

## Trust Chain

Gateway strips inbound internal headers before context materialization. It emits gateway-signed verified-user assertions for subgraphs and binds the assertion hash into service-identity v2. Subgraphs materialize `req.user` only after `VerifiedUserAssertionMiddleware` succeeds.

Canonical subgraph order:

1. `StripInternalHeadersMiddleware`
2. `VerifiedUserAssertionMiddleware`
3. `UserContextMiddleware`
4. `TenantContextMiddleware`
5. `RequestContextMiddleware`
