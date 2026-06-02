# Auth And Gateway SSOT

This branch makes auth-service the only token issuer and gateway-api the only creator of verified caller assertions.

## Token Issuance

- `TokenIssuerService.assertTokenIssuanceAllowed()` gates access tokens, access-only step-up tokens, refresh-token rotations, and MFA challenge tokens.
- The gate rejects inactive users, locked users, pending invitations, missing tenants, and tenants whose status is not `ACTIVE`.
- Refresh tokens persist `mfaVerified`; rotating a refresh token after MFA keeps the claim instead of silently downgrading the session.
- Production token verification is RS256-only through `getJwtVerifyOptions()`. Consumers verify with `JWT_PUBLIC_KEY`; only auth-service signs with the private key.

## Access Revocation

- Gateway HTTP, GraphQL fallback, and WebSocket handshakes use `GatewayTokenVerifierService`.
- The verifier enforces `type === 'access'`, required identity claims, and the composite blacklist check `isValidToken(jti, sub, iat, tenantId)`.
- Revocation keys are platform-global Redis keys under `token:blacklist:*`; gateway reads both raw keys and the legacy gateway-prefixed keys during rollout.
- Tenant suspend/cancel revokes refresh tokens, writes a tenant access-token blacklist marker, and revokes active sessions before persisting the terminal tenant status.
- `AuthenticationService.validateToken()` uses the same access-token and tenant blacklist contract as request guards.

### Redis Revocation Migration

The Redis revocation namespace is migrating from gateway-local keys to the platform-global `token:blacklist:*` namespace owned by `libs/backend-common/src/security/token-blacklist/token-blacklist.service.ts`. During the migration window:

- Writers must write only the platform-global keys.
- Gateway readers verify revocation through the shared gateway verifier and the platform-global token blacklist path.
- New revocation code must not introduce another local token-blacklist provider or Redis prefix.
- Evidence must include one disabled-tenant replay through HTTP, GraphQL, and WebSocket handshakes, plus focused gateway verifier tests.

Supported checks:

```bash
./node_modules/.bin/jest --config tests/invariants/jest.config.ts --selectProjects layer-1 --runTestsByPath tests/invariants/token-blacklist-ssot.spec.ts --runInBand
./node_modules/.bin/jest --config apps/gateway-api/jest.config.ts --runTestsByPath apps/gateway-api/src/guards/__tests__/gateway-token-verifier.service.spec.ts apps/gateway-api/src/guards/__tests__/auth.guard.gateway-verifier.spec.ts --runInBand
```

## Admin Password Reset

- Admin API does not write auth tables or hash passwords.
- `PATCH /users/:id/reset-password` sends `AdminResetUserPasswordCommand` to auth-service over NATS.
- The controller passes the authenticated admin id as `performedBy`; auth-service records it in the refresh-token revoke reason and log line.
- Auth-service writes the `User.password` field through the entity hook and revokes every active refresh token for the target user.
- Public forgot/reset password also delegates to auth-service over NATS. Password policy lives in `@aquaculture/backend-common/security/password-policy` and is enforced at DTO, NATS handler, and auth-service write boundaries.

## WebAuthn

- Browser ceremonies use `@simplewebauthn/browser`.
- Server verification uses SimpleWebAuthn registration/authentication helpers.
- Legacy credential rows are included in login allow-lists. If a legacy row verifies successfully through the audited library, auth-service upgrades it to version 2; otherwise the login fails closed.
- AquaMobil login calls `useWebAuthn().biometricLogin()` and sends `{ response }`; it no longer builds WebAuthn assertions manually.

## Gateway Assertions

- Gateway federation and signed REST proxy calls mint `X-Verified-User-Assertion` headers with an HMAC signature.
- The service identity v2 signature binds the assertion hash, HTTP method, path, body hash, and tenant id.
- Subgraphs must mount middleware in this order: strip inbound internal headers, verify user assertion, materialise user context, materialise tenant context.
- Gateway does not trust inbound `x-user-payload` as an authentication source. `AuthGuard` only trusts cached `req.user` when `JwtMiddleware` marked the request as cryptographically verified.
- `ServiceIdentityGuard` bypasses auth only for pure GraphQL introspection/federation SDL operations, not for mixed user queries that contain `__schema` or `_service` somewhere in the document.

### Identity SSoT Verification

Auth-service is the only service allowed to mint JWTs. Gateway-api verifies access tokens and converts the verified caller into an internal assertion for subgraphs; subgraphs verify that assertion before reading user or tenant context.

Supported checks:

```bash
./node_modules/.bin/jest --config tests/invariants/jest.config.ts --selectProjects layer-1 --runTestsByPath tests/invariants/auth-token-issuer-ssot.spec.ts --runInBand
./node_modules/.bin/jest --config tests/invariants/jest.config.ts --selectProjects layer-3 --runTestsByPath tests/invariants/generated-subgraph-verified-user-assertion.spec.ts --runInBand
```

Use `--runTestsByPath` for exact files. Do not use the Jest 29 singular `--testPathPattern`; Jest 30 rejects it at CLI parse time.

## Auth DB Ownership

The auth schema owns credential state. Runtime services outside `apps/auth-service` must not issue DML against `auth.users` or `auth.refresh_tokens`. Cross-service user administration must delegate to auth-service through NATS commands or typed service boundaries.

The current CI gate allows only the time-boxed bootstrap/deprovision exemptions in `scripts/ci/auth-db-ownership-baseline.json`. Each exemption must declare owner, max occurrence count, removal release, and reason. New direct DML outside auth-service fails the gate.

Supported check:

```bash
npm run gates:auth-db-ownership
```

## Operational Checks

- Disable a tenant, then attempt password login, MFA challenge, WebAuthn login, access-only step-up, and refresh rotation. All must fail before token issuance.
- Disable a tenant, then reuse an already-issued access token through gateway HTTP, GraphQL, and WebSocket handshakes. All must fail via tenant blacklist.
- For a gateway REST proxy request, verify both `X-Service-Assertion-Hash` and `X-Verified-User-Assertion-Signature` arrive at the subgraph.
- For admin password reset, verify refresh tokens for the user are revoked with `Admin password reset by <admin-id>`.
