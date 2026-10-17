# Console live check (2026-10-17)

Defects found by checking the tenant console against production. Code changes only: no
production container, Redis or droplet runtime state was touched.

Owner: claude (implementation), okan (review).

## SEC-HIGH-202

**State:** OPEN. Resolved by the PR whose commit carries `Closes:` for this ID. Deadline
2026-10-24.

### Symptom

Tenant users were sent back to `/login` while their sessions were still valid. auth-service
logged `Rate limit exceeded for bucket 'refresh'`, and the only refresh key in Redis was
`ratelimit:refresh:ip:::ffff:172.20.0.30`. That address is the `aqua-gateway` container on
`aqua-saas_aqua-internal`, not a client.

### Root cause

`RateLimitGuard` (`libs/backend-common`) builds the IP dimension of a `@RateLimit` bucket from
`request.ip` (`libs/backend-common/src/rate-limit/rate-limit.guard.ts:301` before the fix).
auth-service is internal only and runs without `TRUST_PROXY` by design. Every pre-auth mutation
reaches it from one socket peer, the gateway, so `request.ip` is the gateway container for every
user.

A bucket with no custom identifier and no authenticated user is keyed `<name>:ip:<ip>`
(`rate-limit.guard.ts:308`). Four auth-service limits key on IP alone, so each was one bucket for
the whole platform:

| Operation             | Bucket                  | Limit         | Declared at                |
| --------------------- | ----------------------- | ------------- | -------------------------- |
| `refreshToken`        | `refresh`               | 10 per 5 min  | `auth.resolver.ts:140`     |
| `resetPassword`       | `password-reset`        | 3 per hour    | `auth.resolver.ts:229`     |
| `validateInvitation`  | `invitation-validation` | 10 per 5 min  | `auth.resolver.ts:257`     |
| `verifyWebAuthnLogin` | `webauthn-verify`       | 10 per 15 min | `webauthn.resolver.ts:187` |

Ten refreshes in five minutes across all tenants exhausted `refresh`, and every later refresh
failed until the window expired. Any anonymous caller could do the same on purpose. Three
`resetPassword` calls an hour blocked password reset for everyone.

The gateway already sends the client address. `AuthenticatedDataSource` sets `x-client-ip` from
its `TRUST_PROXY`-resolved `req.ip` on every subgraph request
(`apps/gateway-api/src/federation/authenticated-data-source.ts:271`), and the REST proxy does the
same. `resolveClientNetworkContext` (`libs/backend-common/src/http/client-network-context.util.ts`)
reads it only when the request carries a verified `gateway-api` service identity, and
`StripInternalHeadersMiddleware` deletes it from any request without a verified identity.
ORPHAN-MEDIUM-319 moved the auth audit IPs onto that reader. The rate-limit guard kept
`request.ip`.

### Other pre-auth operations checked

These key on a custom identifier and were not affected while the identifier was present. Their
IP fallback had the same defect and is fixed by the same change.

- `login`, `forgotPassword`, `webAuthnLoginChallenge`: lowercased email.
- `verifyMfaLogin`: the MFA challenge token.
- `setupMfa`, `verifyMfaSetup`: the MFA setup token, or the user when a session exists.

There is no public `register` mutation (removed by SEC-CRITICAL-001). The gateway's own edge
tiers key on the client IP it resolves under `TRUST_PROXY` and were correct. sensor-service's
provisioning limiter is reached from nginx directly with `TRUST_PROXY=1`, so its `request.ip` is
the client.

### Fix

`RateLimitGuard.identityOf` takes the IP dimension from `resolveClientNetworkContext(request).ip`,
the one platform reader of the client IP. The guard's request type extends `ClientNetworkRequest`,
which is now a structural interface that Express requests, `TenantRequest` and the guard's request
all satisfy.

The trust model is unchanged:

- A client-supplied `x-client-ip` never picks a bucket. On a request without a verified service
  identity the middleware strips the header and the bucket is the socket peer.
- A forged signature verifies as nothing, so the header is stripped.
- The header is read only from `gateway-api`. A verified call from another service is keyed on
  that service's socket address.
- A gateway hop that carries no client IP stays in the gateway's shared bucket. It is
  restrictive, never unlimited.
- The guard's fail-closed handling of an unhealthy Redis store is untouched.

Keying `refresh` on the refresh-token family was considered and rejected. Before validation the
token is attacker-chosen, so every random string would get a fresh bucket. Validating the family
first would put a database lookup in front of the limiter it is meant to protect.

### Tests

`libs/backend-common/src/rate-limit/__tests__/gateway-client-bucket.spec.ts` runs the real hop:
an Express app with `StripInternalHeadersMiddleware` and the guard, a v2 signature built by
`buildSignedInternalHeaders` against a keyring, and supertest as the single gateway socket.

- Two clients behind one gateway socket get separate `refresh` buckets.
- A planted, rotated `x-client-ip` on an unsigned request is stripped, and every call counts
  against the sender's own bucket. The victim's bucket is untouched.
- A forged signature and a verified non-gateway caller cannot pick a bucket.
- A gateway hop without a client IP shares one bucket.

Against the guard before the fix, the first two cases fail with 429 for the second client.

## SEC-MEDIUM-203

**State:** OPEN. Owner claude, deadline 2026-10-24.

Found while checking the pre-auth operations for SEC-HIGH-202. Four audit IP sites in
auth-service still bypass `resolveClientNetworkContext`:

- `mfaStepUp` and `verifyMfaLogin` (`mfa.resolver.ts:220`, `:264`) and `verifyWebAuthnLogin`
  (`webauthn.resolver.ts:196`) prefer `request.ip`, then `X-Forwarded-For`. Behind the gateway
  they record the gateway container.
- The GDPR consent audit (`user-consent.resolver.ts:291`) takes the first `X-Forwarded-For` entry
  before `request.ip`. On a direct internal call the sender chooses it.

These feed audit rows and consent records, not rate-limit buckets, so they are not part of the
SEC-HIGH-202 change. ORPHAN-MEDIUM-319 migrated `login`, `acceptInvitation`, `forgotPassword` and
`resetPassword`. These four were not part of it. Fix direction: route them through
`resolveClientNetworkContext` and add an invariant that fails subgraph code reading `request.ip`
or `x-forwarded-for` for client identity outside that reader.
