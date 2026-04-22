# Access Boundary Auditor: Full Platform E2E

Scope: `web/**`, `web/apps/aquamobil/**`, `apps/**`, and shared auth/guard code in `libs/**` and `platform/**`, with emphasis on admin-panel, tenant-admin, shared auth context, AquaMobil permission boundaries, and backend enforcement.

## Findings

### CRITICAL-001 - Mobile settings resolver is auth-only, so any authenticated tenant user can inspect and mutate per-user mobile permissions
`MobileSettingsResolver` exposes `getMobileUserSettings`, `getMobileUsersSettings`, `updateMobileUserSettings`, and `bulkUpdateMobileSettings` without any `@Roles()` or `@TenantAdminOrHigher()` metadata. Because the global `RolesGuard` allows any authenticated request when no role metadata is present, these endpoints are effectively open to every logged-in tenant member, not just tenant admins. That turns mobile entitlement management into a normal user surface.

Evidence:
- [`apps/auth-service/src/modules/tenant/resolvers/mobile-settings.resolver.ts:14`](/var/aqua-saas/apps/auth-service/src/modules/tenant/resolvers/mobile-settings.resolver.ts#L14)
- [`apps/auth-service/src/modules/tenant/resolvers/mobile-settings.resolver.ts:29`](/var/aqua-saas/apps/auth-service/src/modules/tenant/resolvers/mobile-settings.resolver.ts#L29)
- [`apps/auth-service/src/modules/tenant/resolvers/mobile-settings.resolver.ts:49`](/var/aqua-saas/apps/auth-service/src/modules/tenant/resolvers/mobile-settings.resolver.ts#L49)
- [`apps/auth-service/src/modules/tenant/resolvers/mobile-settings.resolver.ts:72`](/var/aqua-saas/apps/auth-service/src/modules/tenant/resolvers/mobile-settings.resolver.ts#L72)
- [`libs/backend-common/src/guards/roles.guard.ts:67`](/var/aqua-saas/libs/backend-common/src/guards/roles.guard.ts#L67)

Root cause:
- The resolver omits explicit admin role metadata on all mobile settings queries and mutations.
- The shared `RolesGuard` treats missing role metadata as “authenticated user allowed,” so the intended admin boundary is not enforced at the backend layer.

Cross-domain dependency:
- Route the mobile permission-state consumer review to `mobile-app-auditor`.
- Route the tenant-scope validation of user-setting mutations to `tenant-isolation-auditor`.

### HIGH-002 - AquaMobil permission checks fail open at both login and runtime
The mobile app has two separate fail-open paths. During login, `checkMobileEnabled()` returns `true` on any fetch failure or malformed GraphQL response, which allows the session to continue instead of blocking access. After login, `useMobilePermissions()` falls back to `FALLBACK_SETTINGS` with every feature enabled when the permissions endpoint errors and no fresh cache is available. That means backend permission unavailability turns into broad mobile access rather than denied access.

Evidence:
- [`web/apps/aquamobil/src/hooks/useAuth.tsx:78`](/var/aqua-saas/web/apps/aquamobil/src/hooks/useAuth.tsx#L78)
- [`web/apps/aquamobil/src/hooks/useAuth.tsx:91`](/var/aqua-saas/web/apps/aquamobil/src/hooks/useAuth.tsx#L91)
- [`web/apps/aquamobil/src/hooks/useAuth.tsx:206`](/var/aqua-saas/web/apps/aquamobil/src/hooks/useAuth.tsx#L206)
- [`web/apps/aquamobil/src/hooks/useAuth.tsx:214`](/var/aqua-saas/web/apps/aquamobil/src/hooks/useAuth.tsx#L214)
- [`web/apps/aquamobil/src/hooks/useMobilePermissions.ts:57`](/var/aqua-saas/web/apps/aquamobil/src/hooks/useMobilePermissions.ts#L57)
- [`web/apps/aquamobil/src/hooks/useMobilePermissions.ts:65`](/var/aqua-saas/web/apps/aquamobil/src/hooks/useMobilePermissions.ts#L65)
- [`web/apps/aquamobil/src/hooks/useMobilePermissions.ts:145`](/var/aqua-saas/web/apps/aquamobil/src/hooks/useMobilePermissions.ts#L145)
- [`web/apps/aquamobil/src/hooks/useMobilePermissions.ts:156`](/var/aqua-saas/web/apps/aquamobil/src/hooks/useMobilePermissions.ts#L156)

Root cause:
- Both the login gate and the runtime permission provider use optimistic defaults instead of a fail-closed boundary when the backend permission service is unavailable.
- The runtime fallback does not preserve the restrictive default model; it replaces it with an allow-all feature set.

Cross-domain dependency:
- Route the mobile offline/reconnect boundary review to `mobile-app-auditor`.
- Route any downstream action/state truthfulness issues to `workflow-state-auditor`.

### HIGH-003 - Web shell never applies accessType, so MOBILE_ONLY accounts can still enter the web panel
`AuthContext` fetches `accessType` specifically so the frontend can enforce platform access restrictions, and the mobile app does use that field to block `PANEL_ONLY` users. The web shell, however, never consumes `accessType` in `ProtectedRoute`, so access control there is still only role-, module-, and tenant-based. A user marked `MOBILE_ONLY` can therefore authenticate into the shell and reach web routes if their role/tenant checks pass, despite the stated platform boundary.

Evidence:
- [`web/shared-ui/src/contexts/AuthContext.tsx:221`](/var/aqua-saas/web/shared-ui/src/contexts/AuthContext.tsx#L221)
- [`web/shared-ui/src/contexts/AuthContext.tsx:322`](/var/aqua-saas/web/shared-ui/src/contexts/AuthContext.tsx#L322)
- [`web/shared-ui/src/contexts/AuthContext.tsx:427`](/var/aqua-saas/web/shared-ui/src/contexts/AuthContext.tsx#L427)
- [`web/shell/src/App.tsx:72`](/var/aqua-saas/web/shell/src/App.tsx#L72)
- [`web/shell/src/App.tsx:85`](/var/aqua-saas/web/shell/src/App.tsx#L85)
- [`web/shell/src/App.tsx:93`](/var/aqua-saas/web/shell/src/App.tsx#L93)
- [`web/shell/src/App.tsx:100`](/var/aqua-saas/web/shell/src/App.tsx#L100)
- [`web/apps/aquamobil/src/App.tsx:146`](/var/aqua-saas/web/apps/aquamobil/src/App.tsx#L146)

Root cause:
- `accessType` is captured in shared auth state but not used as an authorization input in the web shell.
- The platform access model is enforced on the mobile side only, leaving the web side as a role-only gate.

Cross-domain dependency:
- Route the shared auth-context consistency check to `mobile-app-auditor`.
- Route the tenant user access-type lifecycle to `tenant-admin`.

## Review Notes

- Review-only audit; no runtime tests were executed for this report.
