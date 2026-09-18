# Authorization — current state (SEC-HIGH-125, 2026-08-23 scan)

**There is no OPA (or any external policy engine) in this platform.** This
file previously existed empty while `CLAUDE.md` and code comments cited an
"OPA" layer at the gateway — a documented control that did not exist, which
is exactly what an auditor must never find (SEC-HIGH-125, 2026-08-23 scan
№70).

The authorization SSoT today is the NestJS guard chain, in order:

1. Edge: nginx allowlist routing + rate limits.
2. Gateway: global `AuthGuard` (RS256 JWT, issuer/audience, jti/user-epoch
   revocation) → `TenantIsolationGuard` → `RateLimitGuard`; internal-header
   stripping + HMAC v2 service identity for subgraph calls.
3. Services: role guards (`@Roles`), capability guards
   (`@RequireTenantPermission` — currently auth/sensor/hr only, coverage
   tracked as SEC-MEDIUM-126), tenant-scoped repositories + Postgres RLS.

If an external policy engine is introduced, this file becomes its policy
inventory and the guard chain above shrinks accordingly — until then, any
reference to OPA in this repository is a bug.
