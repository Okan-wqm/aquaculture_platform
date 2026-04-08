# Research: RBAC Role Hierarchy & Privilege Escalation Prevention

**Date:** 2026-04-08
**Agent:** auth-security-expert
**Topic slug:** rbac-role-hierarchy-privilege-escalation-prevention

## Sources
- [OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)
- [OWASP Access Control Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Access_Control_Cheat_Sheet.html)
- [OWASP Top 10 Proactive Controls — C7 Access Controls](https://top10proactive.owasp.org/the-top-10/c1-accesscontrol/)
- [OWASP WSTG — Testing for Privilege Escalation](https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/05-Authorization_Testing/03-Testing_for_Privilege_Escalation)
- [OWASP Access Control Concepts](https://owasp.org/www-community/Access_Control)
- [OWASP ASVS 5.0 V8 Authorization](https://github.com/OWASP/ASVS/blob/master/5.0/en/0x17-V8-Authorization.md)
- [OWASP Top 10:2025 A01 Broken Access Control](https://owasp.org/Top10/2025/)

## Key Findings

### RBAC role hierarchy design
- OWASP: "roles may be hierarchical in nature." Higher roles inherit permissions of lower roles.
- Hierarchy for aqua-saas: `SUPER_ADMIN > TENANT_ADMIN > MODULE_MANAGER > MODULE_USER`.
- `roleHasPermission(userRole, requiredRole)` must correctly evaluate transitivity: `SUPER_ADMIN` satisfies `TENANT_ADMIN` requirement, `TENANT_ADMIN` satisfies `MODULE_USER`, etc.
- Implementation pitfall: using `===` instead of hierarchy-aware comparison.

### Privilege escalation classes (OWASP WSTG)
- **Vertical:** lower-privilege user gains access to higher-privilege functions. E.g., `MODULE_USER` calling an admin mutation.
- **Horizontal:** user accesses another user's data at the same privilege level. E.g., accessing another tenant's data as `TENANT_ADMIN`.
- Both must be blocked explicitly. Horizontal requires tenant/owner scoping in every query.

### Self-role modification prevention
- **CRITICAL invariant:** a user MUST NOT be able to modify their own role, even if they are TENANT_ADMIN.
- Attack: TENANT_ADMIN calls `updateUser(self.id, { role: SUPER_ADMIN })`.
- Enforcement: `updateUserRole()` must reject `targetUserId === currentUser.id`.
- Enforcement: `updateUserRole(targetUser, newRole)` must reject `newRole > currentUser.role`. TENANT_ADMIN cannot create SUPER_ADMIN.

### Mass-assignment protection
- OWASP: ValidationPipe `whitelist: true, forbidNonWhitelisted: true` — reject unknown fields in DTOs.
- DTOs for user updates must NOT include `role`, `tenantId`, `isSuperAdmin`, `permissions` unless in explicit privileged endpoints.
- Separate DTOs for self-service update (`UpdateProfileDto`) vs admin update (`UpdateUserByAdminDto`).

### Generic error messages (OWASP)
- "Access denied" or "Not found" — never "You need SUPER_ADMIN role" or "Tenant mismatch."
- Error enumeration leaks role structure to attackers.
- 403 vs 404 distinction can leak existence. Prefer 404 for unauthorized resource access when possible.

### SUPER_ADMIN bypass design
- SUPER_ADMIN crosses tenant boundaries — necessary for platform operations.
- MUST be audit-logged with `recordAwait()` (guaranteed persistence, blocks request until audit persisted).
- MUST require explicit `X-Act-As-Tenant` header with UUID validation. No implicit cross-tenant access.
- MFA step-up recommended (`MFA_REQUIRED_FOR_CROSS_TENANT=true`) — re-prompt for TOTP before cross-tenant write operations.

### MFA step-up authentication pattern
- High-privilege operations (role change, SUPER_ADMIN impersonation, API key creation, GDPR erasure) require fresh MFA challenge.
- Implementation: issue short-lived "step-up token" after TOTP verification, valid for 5 minutes, scoped to the target operation.
- Guard checks `req.user.mfaStepUpValidUntil > Date.now()` AND `mfaStepUpScope === 'role-change'`.

### Resource permissions vs role permissions
- Roles grant broad capabilities; resource permissions grant fine-grained access.
- `tenant_role_permissions` table: `(tenantId, roleId, resource, action)`. Evaluate AFTER hierarchy check.
- Permission check order: (1) deny-by-default; (2) hierarchy check (role >= required); (3) resource permission check; (4) IDOR/tenant scope check.

### Guard pipeline ordering (critical)
- `ServiceIdentityGuard` → `TenantGuard` → `RolesGuard` → `TenantPermissionGuard` → `IdorGuard`.
- Reordering is a security bug. IDOR must be LAST (after tenant scope established).
- Every mutation/query must traverse all applicable guards. Missing `@UseGuards(...)` = vulnerability.

### OPA / Policy engine integration
- Optional: delegate fine-grained decisions to Open Policy Agent.
- `POLICY_FAIL_OPEN` MUST be `false` in production. Policy engine unavailability = deny.

## Security Concerns
- **CRITICAL:** `roleHasPermission` using `===` instead of hierarchy check = strict role match bypasses inheritance logic.
- **CRITICAL:** User able to modify own role = trivial escalation to SUPER_ADMIN.
- **CRITICAL:** Mass-assignment on user update endpoint (role in body) = escalation via profile update.
- **CRITICAL:** Missing `@UseGuards(TenantPermissionGuard)` on a mutation = missing authorization.
- **CRITICAL:** Policy fail-open in production = any OPA outage bypasses access control.
- **HIGH:** Error enumeration (specific role messages) = role structure disclosure.
- **HIGH:** SUPER_ADMIN cross-tenant without audit = compliance violation (cannot forensically trace).
- **HIGH:** Horizontal escalation via tenant scope missing in query = cross-tenant data leak.
- **MEDIUM:** MFA step-up missing on high-privilege ops = stolen session = full admin control.

## Performance Concerns
- Hierarchy check = O(1) with integer role levels. Negligible.
- Resource permission check = Redis cache keyed by `(userId, resource, action)`; 5-minute TTL invalidated on role change.
- Full guard pipeline = ~2-5ms. Acceptable.

## Architectural Implications
- Role hierarchy encoded as ordered enum with integer levels: `{ SUPER_ADMIN: 4, TENANT_ADMIN: 3, MODULE_MANAGER: 2, MODULE_USER: 1 }`.
- `roleHasPermission(user, required) = user.roleLevel >= required.roleLevel`.
- Admin DTOs separate from self-service DTOs.
- Guards MUST execute in fixed order; any interceptor that short-circuits is a bug.

## Domain Rule Additions
- **CRITICAL:** `roleHasPermission()` MUST evaluate hierarchy (>=), not strict equality. Using `===` is CRITICAL.
- **CRITICAL:** User MUST NOT be able to modify own role or own `tenantId`. Enforce in service layer, not just guard.
- **CRITICAL:** User MUST NOT be able to assign a role higher than their own. TENANT_ADMIN cannot create SUPER_ADMIN.
- **CRITICAL:** Self-service update DTOs MUST NOT include `role`, `tenantId`, `isSuperAdmin`, `permissions`. Mass-assignment via ValidationPipe `whitelist: true, forbidNonWhitelisted: true`.
- **CRITICAL:** Every mutation MUST have explicit `@UseGuards(TenantGuard, RolesGuard, TenantPermissionGuard)`. Missing guards are CRITICAL.
- **CRITICAL:** `POLICY_FAIL_OPEN` MUST be `false` in production. Fail-open on OPA outage is CRITICAL.
- Error messages MUST be generic ("Access denied"). Role-specific messages are HIGH severity.
- SUPER_ADMIN impersonation MUST use `X-Act-As-Tenant` (UUID-validated) AND `recordAwait()` audit log. No other path allowed.
- MFA step-up REQUIRED for: role change, SUPER_ADMIN impersonation, API key creation, GDPR erasure, cross-tenant writes.
- Guard pipeline ordering MUST be: ServiceIdentity → Tenant → Roles → Permission → Idor. Any reorder is a bug.
