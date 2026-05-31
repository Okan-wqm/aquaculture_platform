# Auth And Gateway SSOT

This branch makes auth-service the only token issuer and gateway-api the only creator of verified caller assertions.

## Token Issuance

- `TokenService.assertTokenIssuanceAllowed()` gates access tokens, access-only step-up tokens, refresh-token rotations, and MFA challenge tokens.
- The gate rejects inactive users, locked users, pending invitations, missing tenants, and tenants whose status is not `ACTIVE`.
- Refresh tokens persist `mfaVerified`; rotating a refresh token after MFA keeps the claim instead of silently downgrading the session.

## Admin Password Reset

- Admin API does not write auth tables or hash passwords.
- `PATCH /users/:id/reset-password` sends `AdminResetUserPasswordCommand` to auth-service over NATS.
- The controller passes the authenticated admin id as `performedBy`; auth-service records it in the refresh-token revoke reason and log line.
- Auth-service writes the `User.password` field through the entity hook and revokes every active refresh token for the target user.

## WebAuthn

- Browser ceremonies use `@simplewebauthn/browser`.
- Server verification uses SimpleWebAuthn registration/authentication helpers.
- Legacy credential rows are included in login allow-lists. If a legacy row verifies successfully through the audited library, auth-service upgrades it to version 2; otherwise the login fails closed.
- AquaMobil login calls `useWebAuthn().biometricLogin()` and sends `{ response }`; it no longer builds WebAuthn assertions manually.

## Gateway Assertions

- Gateway federation and signed REST proxy calls mint `X-Verified-User-Assertion` headers with an HMAC signature.
- The service identity v2 signature binds the assertion hash, HTTP method, path, body hash, and tenant id.
- Subgraphs must mount middleware in this order: strip inbound internal headers, tenant context, user context, verified-user assertion.
- `ServiceIdentityGuard` bypasses auth only for pure GraphQL introspection/federation SDL operations, not for mixed user queries that contain `__schema` or `_service` somewhere in the document.

## Operational Checks

- Disable a tenant, then attempt password login, MFA challenge, WebAuthn login, access-only step-up, and refresh rotation. All must fail before token issuance.
- For a gateway REST proxy request, verify both `X-Service-Assertion-Hash` and `X-Verified-User-Assertion-Signature` arrive at the subgraph.
- For admin password reset, verify refresh tokens for the user are revoked with `Admin password reset by <admin-id>`.
