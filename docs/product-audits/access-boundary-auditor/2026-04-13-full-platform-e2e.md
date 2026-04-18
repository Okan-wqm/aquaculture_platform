# Access Boundary Auditor: Full Platform E2E

**Date:** 2026-04-13
**Scope:** `apps/**`, `web/**`, `libs/backend-common/src/guards/**`
**Prior cycle:** `docs/test-audits/access-boundary-auditor/2026-04-11-full-platform-e2e.md`
**Status:** Review-only audit; no runtime tests executed.

---

## Prior Cycle Closure Verification

The three findings from the 2026-04-11 cycle (CRITICAL-001, HIGH-002, HIGH-003) were reported as fixed in commit `79ce984f`. Verification results:

### CRITICAL-001 (MobileSettingsResolver missing role guard) -- VERIFIED RESOLVED

`MobileSettingsResolver` at `apps/auth-service/src/modules/tenant/resolvers/mobile-settings.resolver.ts` now applies `@TenantAdminOrHigher()` on all admin-facing mutations and queries (lines 14, 40, 51, 75). The new `getMyMobileSettings` query (line 30) is intentionally auth-only (no role guard) so the mobile app can fetch the current user's own settings -- this is correct because it is scoped to `currentUser.sub`.

### HIGH-002 (AquaMobil fail-open on permission fetch) -- PARTIALLY RESOLVED (see HIGH-001 below)

`useMobilePermissions.ts` now has `DEFAULT_SETTINGS` (line 39) with all features set to `false` (fail-closed). However, `FALLBACK_SETTINGS` (line 65) remains all-true and is still activated on two code paths: (a) when GraphQL returns errors and no cache exists (line 152), and (b) on network error with no cache (lines 163, 168). Additionally, `checkMobileEnabled()` in `useAuth.tsx:91` still returns `true` on fetch failure. See HIGH-001 below.

### HIGH-003 (Web shell accessType enforcement) -- VERIFIED RESOLVED

`web/shell/src/App.tsx:86` now checks `user?.accessType === 'MOBILE_ONLY'` and redirects to `/unauthorized`. This closes the prior finding.

---

## Findings

### HIGH-001 -- AquaMobil `checkMobileEnabled` still fails open; `loginWithToken` skips accessType check

**Surfaces:** AquaMobil login gate, WebAuthn biometric login flow.
**Gap taxonomy:** access-gap (fail-open authentication gate).

Two residual fail-open paths remain in the AquaMobil auth hooks:

**Path 1: `checkMobileEnabled()` returns `true` on error.**
At `web/apps/aquamobil/src/hooks/useAuth.tsx:91`, the nullish coalescing fallback `?? true` means that if the GraphQL response is malformed or the `getMyMobileSettings` field is missing, the function returns `true` (allow). At line 93, the catch block also returns `true`. This means a network interruption or backend error during login grants mobile access rather than denying it.

**Path 2: `loginWithToken` does not check `accessType`.**
At `web/apps/aquamobil/src/hooks/useAuth.tsx:238-270`, the `loginWithToken` callback (used by the WebAuthn biometric login flow) calls `checkMobileEnabled()` but never checks `user.accessType === 'PANEL_ONLY'`. The regular `login` callback at line 208 does check this. A `PANEL_ONLY` user who has registered a WebAuthn credential can bypass the access type check by authenticating with biometrics.

**Path 3: `FALLBACK_SETTINGS` all-true still activated on error + no cache.**
At `web/apps/aquamobil/src/hooks/useMobilePermissions.ts:152` and `163-168`, when the backend returns a GraphQL error or the network is down and no IndexedDB cache exists, `FALLBACK_SETTINGS` (all features enabled) is applied. While `DEFAULT_SETTINGS` is now fail-closed, these fallback paths still grant full feature access.

**Evidence:**
- `web/apps/aquamobil/src/hooks/useAuth.tsx:91` -- `?? true` fallback
- `web/apps/aquamobil/src/hooks/useAuth.tsx:93` -- catch returns `true`
- `web/apps/aquamobil/src/hooks/useAuth.tsx:238-270` -- `loginWithToken` missing `accessType` check
- `web/apps/aquamobil/src/hooks/useMobilePermissions.ts:152,163,168` -- `FALLBACK_SETTINGS` all-true

**Root cause:** The fail-open posture was intentionally chosen for "graceful degradation" (see BUG-2/3 FIX comment) but it violates the fail-closed security principle. The `loginWithToken` path was added for WebAuthn and was not updated with the `accessType` check from commit `79ce984f`.

**Recommendation:** (1) `checkMobileEnabled()` should return `false` on error/malformed response. (2) `loginWithToken` must replicate the `PANEL_ONLY` check from `login`. (3) `FALLBACK_SETTINGS` should be replaced with `DEFAULT_SETTINGS` (all-false) or removed -- the operational argument for keeping features alive during outages must be weighed against the security posture at a product level.

---

### HIGH-002 -- AquaMobil `restoreSession` bypasses both `accessType` and `isMobileEnabled` checks

**Surfaces:** AquaMobil session restore on app relaunch.
**Gap taxonomy:** access-gap (session restore bypasses authorization gate).

When the AquaMobil app is relaunched, `restoreSession` at `web/apps/aquamobil/src/hooks/useAuth.tsx:134-173` performs a silent token refresh and sets `isAuthenticated: true` directly, without checking `accessType` or calling `checkMobileEnabled()`. A `PANEL_ONLY` user whose session was previously established (before their access type was changed) will have their session silently restored with full mobile access on the next app relaunch.

The `ProtectedRoute` component at `web/apps/aquamobil/src/App.tsx:149` does check `user?.accessType === 'PANEL_ONLY'`, but the `restoreSession` flow does not fetch `accessType` from the refresh token response (the REFRESH_MUTATION at line 51 does request `accessType` in the user object, but `restoreSession` does not check it before setting state).

**Evidence:**
- `web/apps/aquamobil/src/hooks/useAuth.tsx:134-173` -- no `accessType` or `isMobileEnabled` gate
- `web/apps/aquamobil/src/hooks/useAuth.tsx:51-65` -- REFRESH_MUTATION does return `accessType`
- `web/apps/aquamobil/src/App.tsx:149` -- `ProtectedRoute` checks `accessType` but this is frontend-only

**Root cause:** `restoreSession` was written before the `accessType` enforcement was added. It restores the session optimistically.

**Recommendation:** `restoreSession` should check `user.accessType === 'PANEL_ONLY'` and call `checkMobileEnabled(accessToken)` before setting `isAuthenticated: true`. If either check fails, clear the session and redirect to login with an appropriate message.

---

### HIGH-003 -- `TenantAdminResolver.myModules` query has no role guard

**Surfaces:** `myModules` GraphQL query in auth-service.
**Gap taxonomy:** access-gap (missing role enforcement on data query).

The `myModules` query at `apps/auth-service/src/modules/tenant/resolvers/tenant-admin.resolver.ts:34-37` has no `@Roles()` or `@TenantAdminOrHigher()` decorator. This means any authenticated user (including `MODULE_USER`) can call `myModules` to enumerate all modules within the tenant. While the query description says "TENANT_ADMIN: All tenant modules; MODULE_MANAGER/USER: Only assigned modules", the lack of a role decorator means the global `RolesGuard` treats this as "authenticated user allowed" (line 67-72 of `roles.guard.ts`).

The security impact depends on `TenantAdminService.getMyModules()` implementation -- if it returns all modules regardless of role, this is a data leak. However, even if the service correctly scopes the response, the missing decorator is an inconsistency with the rest of the resolver where all other queries and mutations carry `@TenantAdminOrHigher()`.

**Evidence:**
- `apps/auth-service/src/modules/tenant/resolvers/tenant-admin.resolver.ts:34-37` -- no role decorator on `myModules`
- `apps/auth-service/src/modules/tenant/resolvers/tenant-admin.resolver.ts:43,55,66` -- other queries have `@TenantAdminOrHigher()`

**Root cause:** `myModules` was designed to be accessible to all authenticated users (MODULE_MANAGER and MODULE_USER need their own module list), but the intentional design decision is not documented with a security marker comment. This is a design choice rather than a bug, but it should be explicitly marked.

**Recommendation:** If the intent is for all authenticated users to call `myModules`, add an explicit `// SECURITY: Intentionally auth-only -- all roles need their module list` comment. If the intent is admin-only, add `@TenantAdminOrHigher()`.

---

### MEDIUM-001 -- Announcement resolver gates all operations behind `TenantAdminOrHigher`, blocking normal users from viewing announcements

**Surfaces:** `myAnnouncements`, `viewAnnouncement`, `acknowledgeAnnouncement` mutations in auth-service.
**Gap taxonomy:** access-gap (overly restrictive guard prevents intended access).

All queries and mutations in `AnnouncementResolver` at `apps/auth-service/src/modules/announcement/resolvers/announcement.resolver.ts` are gated with `@TenantAdminOrHigher()`, including read operations (`myAnnouncements` at line 34), view tracking (`viewAnnouncement` at line 148), and acknowledgment (`acknowledgeAnnouncement` at line 160). This means `MODULE_MANAGER` and `MODULE_USER` cannot view or acknowledge announcements sent to them.

If platform and tenant announcements are meant for all users (the typical use case for an announcement system), these read/ack operations should be accessible to all authenticated users, not just admins.

**Evidence:**
- `apps/auth-service/src/modules/announcement/resolvers/announcement.resolver.ts:34,49,60,148,160` -- all `@TenantAdminOrHigher()`

**Root cause:** The resolver was implemented with a uniform admin guard, likely as a cautious initial setting. The service layer (`AnnouncementService`) may further filter announcements by user, but the guard prevents lower roles from reaching the service.

**Recommendation:** Change `myAnnouncements`, `announcement`, `viewAnnouncement`, and `acknowledgeAnnouncement` to auth-only (remove `@TenantAdminOrHigher()`). Keep `createPlatformAnnouncement` at `@SuperAdminOnly()` and creation/publish/cancel/delete at `@TenantAdminOrHigher()`.

---

### MEDIUM-002 -- Support ticket resolver gates all operations behind `TenantAdminOrHigher`, blocking normal users from creating tickets

**Surfaces:** `myTickets`, `createTicket`, `addTicketComment`, `rateTicket` in auth-service.
**Gap taxonomy:** access-gap (overly restrictive guard prevents intended access).

All support ticket operations in `SupportResolver` at `apps/auth-service/src/modules/support/resolvers/support.resolver.ts` are gated with `@TenantAdminOrHigher()`. This means `MODULE_MANAGER` and `MODULE_USER` cannot create support tickets, add comments, or rate ticket satisfaction.

If the support system is meant to be used by all tenant users (the typical enterprise pattern), the read and self-service operations should be accessible to lower roles.

**Evidence:**
- `apps/auth-service/src/modules/support/resolvers/support.resolver.ts:34,50,62,88,99,139` -- all `@TenantAdminOrHigher()`

**Root cause:** Same as MEDIUM-001 -- uniform admin guard applied as cautious default.

**Recommendation:** Change `myTickets`, `ticket`, `ticketComments`, `createTicket`, `addTicketComment`, `rateTicket`, and `supportStats` to allow all authenticated users or at minimum `@ModuleManagerOrHigher()`. Keep status updates and assignment at `@SuperAdminOnly()`.

---

### MEDIUM-003 -- Support messaging resolver gates all read/write operations behind `TenantAdminOrHigher`

**Surfaces:** `mySupportThreads`, `createSupportThread`, `sendSupportMessage` in auth-service.
**Gap taxonomy:** access-gap (overly restrictive guard prevents intended access).

All operations in `MessagingResolver` at `apps/auth-service/src/modules/messaging/resolvers/messaging.resolver.ts` are gated with `@TenantAdminOrHigher()`. If module managers or regular users need to contact support, they cannot create threads or send messages.

**Evidence:**
- `apps/auth-service/src/modules/messaging/resolvers/messaging.resolver.ts:33,47,59,71,87,98,110,119` -- all `@TenantAdminOrHigher()`

**Recommendation:** Evaluate whether lower roles should access support messaging. If yes, change self-service operations to allow all authenticated users.

---

### MEDIUM-004 -- Billing resolver uses inline `requireRoles()` instead of NestJS guard decorators

**Surfaces:** All billing queries and mutations.
**Gap taxonomy:** access-gap (non-standard authorization pattern).

`BillingResolver` at `apps/billing-service/src/billing/billing.resolver.ts:142-156` implements its own `requireRoles()` function that checks `context.req.user?.roles`. This bypasses the platform's standard `@Roles()` decorator + `RolesGuard` pattern. The custom implementation:

1. Uses a separate `BillingRole` enum (line 38-43) that includes roles not in the platform `Role` enum (`BILLING_ADMIN`, `FINANCE_MANAGER`).
2. Does not leverage role hierarchy -- a `SUPER_ADMIN` is checked by string match only (line 146), not through `roleHasPermission()`.
3. The `BILLING_READ_ROLES` array includes `TENANT_ADMIN` (line 85), but the `requireRoles()` function at line 150 does a flat `includes()` check without hierarchy, meaning a user with role `TENANT_ADMIN` would only match if their JWT contains exactly that string.

This is not inherently broken (the SUPER_ADMIN bypass at line 146 provides the expected escape hatch), but the divergence from the standard pattern means billing authorization is not visible to any automated guard audit tool and is harder to reason about.

**Evidence:**
- `apps/billing-service/src/billing/billing.resolver.ts:38-89` -- custom role definitions
- `apps/billing-service/src/billing/billing.resolver.ts:142-156` -- inline `requireRoles()` function

**Root cause:** Billing requires roles (`BILLING_ADMIN`, `FINANCE_MANAGER`) that do not exist in the platform `Role` enum. Rather than extending the enum, a custom inline check was implemented.

**Recommendation:** Add `BILLING_ADMIN` and `FINANCE_MANAGER` to the platform `Role` enum and migrate billing authorization to standard `@Roles()` decorators. This brings billing into the standard guard chain and makes it auditable.

---

### MEDIUM-005 -- Configuration service uses inline `checkAdminAccess()` with non-standard role names

**Surfaces:** All configuration mutations and `configurationHistory` query.
**Gap taxonomy:** access-gap (non-standard authorization pattern).

`ConfigurationResolver` at `apps/config-service/src/configuration/configuration.resolver.ts:86-89` implements `checkAdminAccess()` which checks for roles `admin`, `platform_admin`, or `SUPER_ADMIN`. The role names `admin` and `platform_admin` (lowercase) do not match the platform `Role` enum values (which are uppercase: `SUPER_ADMIN`, `TENANT_ADMIN`, etc.). If a JWT contains the standard `SUPER_ADMIN` role, this check passes, but the inclusion of non-standard lowercase role names suggests either legacy compatibility or a mismatch.

Additionally, all configuration read queries (`configuration`, `configurations`, `configurationsByService`, `configurationById`) have no role check -- only tenant context validation. This means any authenticated user within a tenant can read all configuration values (except secrets, which are masked by `resolveValue` at line 97). Depending on the nature of configurations, this may expose sensitive operational parameters.

**Evidence:**
- `apps/config-service/src/configuration/configuration.resolver.ts:86-89` -- non-standard role names
- `apps/config-service/src/configuration/configuration.resolver.ts:106-148` -- read queries with no role check

**Root cause:** The config service was built as a standalone service with its own auth pattern, not integrated with the standard guard decorators.

**Recommendation:** Migrate to standard `@Roles(Role.SUPER_ADMIN)` decorators. Evaluate whether configuration reads should be restricted to admin roles.

---

### LOW-001 -- Upload controller has no role-based guards; any authenticated tenant user can upload and delete files

**Surfaces:** `POST /upload/chemical-document`, `DELETE /upload/chemical-document/:id`, `POST /upload/batch-document`, `DELETE /upload/batch-document/:id`, `POST /upload/presigned-url`.
**Gap taxonomy:** access-gap (missing role enforcement on destructive operations).

`UploadController` at `apps/gateway-api/src/upload/upload.controller.ts` validates authentication and tenant context but does not enforce any role restrictions. Any authenticated user within a tenant can upload documents, delete documents, and generate presigned download URLs. While the gateway has a global `AuthGuard` and `TenantIsolationGuard`, there is no `@Roles()` decorator on any endpoint.

This may be intentional (all tenant users may need upload capability), but delete operations should likely be restricted to at least `MODULE_MANAGER` or higher.

**Evidence:**
- `apps/gateway-api/src/upload/upload.controller.ts:148` -- `@Controller('upload')` with no class-level guard
- Lines 158, 288, 367, 507, 614 -- no `@Roles()` on any endpoint

**Recommendation:** Add `@Roles()` decorators appropriate to each operation. Upload may be open to all authenticated tenant users; delete and presigned URL generation should be evaluated for role restrictions.

---

### LOW-002 -- Event store and projections controllers trust `X-Tenant-Id` header instead of JWT claim

**Surfaces:** `POST /events/streams/*`, `GET /projections/*`, `POST /projections/*`.
**Gap taxonomy:** access-gap (tenant context from untrusted source).

`ProjectionsController` at `apps/event-store-service/src/projections/projections.controller.ts:59` extracts tenant ID from the `x-tenant-id` header (line 32-48) rather than from the verified JWT `tenantId` claim. The `EventStoreController` follows a similar pattern. While the event-store-service is an internal service (not directly accessible from clients), if any request reaches it with a spoofed `X-Tenant-Id` header, it would process the request against the wrong tenant's data.

**Evidence:**
- `apps/event-store-service/src/projections/projections.controller.ts:32-48` -- `extractTenantId` from header
- `apps/event-store-service/src/event-store/event-store.controller.ts:39` -- same pattern

**Root cause:** The event-store-service was designed as an internal-only service called by other backend services, not by end users. However, the TenantGuard pattern (JWT-only tenant ID) should be applied consistently.

**Recommendation:** If the service is behind `ServiceIdentityGuard` and only called by trusted services, this is acceptable with a security marker comment. If there is any path where client requests could reach this service, migrate to JWT-based tenant ID extraction.

---

## Guard Chain Summary

The platform uses the following global guard chains:

| Service | Guard Chain |
|---------|-------------|
| **gateway-api** | AuthGuard (JWT/API Key/Basic) -> TenantIsolationGuard -> RateLimitGuard -> MutationRateLimitGuard |
| **auth-service** | ServiceIdentityGuard -> JwtAuthGuard -> TenantGuard -> RolesGuard |
| **admin-api-service** | PlatformAdminGuard (APP_GUARD, SUPER_ADMIN only) |
| **farm-service, sensor-service, messaging-service, etc.** | ServiceIdentityGuard -> JwtAuthGuard -> TenantGuard -> RolesGuard (via shared backend-common) |

**Key design decisions verified:**
- `RolesGuard` (line 67-72 of `roles.guard.ts`) now requires an authenticated user even when no `@Roles()` decorator is present, fixing the prior CRITICAL-001 fail-open behavior.
- `TenantGuard` accepts tenant ID exclusively from JWT claims for regular users; only SUPER_ADMIN can use `X-Act-As-Tenant` header with MFA step-up enforcement and persistent audit logging.
- `PlatformAdminGuard` on admin-api-service defaults to `SUPER_ADMIN`/`PLATFORM_ADMIN` roles when no `@Roles()` decorator is present, providing a secure-by-default posture for the admin panel.

## Impersonation Flow Verification

The impersonation system at `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts` was audited:

1. **Identity source:** All session start/end/terminate/extend operations extract admin identity from `getAuthUser(req)` (JWT-verified), not from client headers. Verified at lines 300, 341, 369, 389, 400.
2. **Rate limiting:** `@ThrottleSensitive()` decorator applied to `start`, `end`, `terminate`, and `extend` endpoints (lines 335, 360, 376, 393).
3. **Session validation:** `validateSession` at line 417 passes `requestIp` for IP binding enforcement.
4. **Global guard:** The entire admin-api-service is protected by `PlatformAdminGuard` as `APP_GUARD`, so all impersonation endpoints require SUPER_ADMIN role. No per-endpoint role gaps exist.

**No findings for the impersonation flow.**

## Cross-Domain Dependencies

- **mobile-app-auditor:** HIGH-001 (fail-open paths in AquaMobil), HIGH-002 (restoreSession bypass).
- **tenant-isolation-auditor:** LOW-002 (event-store header-based tenant ID).
- **workflow-state-auditor:** MEDIUM-001, MEDIUM-002, MEDIUM-003 (overly restrictive guards may cause workflow failures for non-admin users).
- **file-transfer-auditor:** LOW-001 (upload controller missing role guards).

## Summary Statistics

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 0 | -- |
| HIGH | 3 | NEW |
| MEDIUM | 5 | NEW |
| LOW | 2 | NEW |
| Prior CRITICAL-001 | 1 | RESOLVED |
| Prior HIGH-002 | 1 | PARTIALLY RESOLVED (residual -> HIGH-001) |
| Prior HIGH-003 | 1 | RESOLVED |
