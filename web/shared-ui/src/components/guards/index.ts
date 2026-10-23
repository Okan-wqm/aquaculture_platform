/**
 * Guard family — the single route/session gate set for shell + modules.
 *
 * Mount surface (SSOT-MIMARI §3.1 row 36):
 * - `RequireAuth` — authentication defense-in-depth for every federated
 *   `Module.tsx` (the remote can be instantiated without the shell's guard).
 * - `RequireRole` — authorization: any-of roles (hierarchy-aware) OR any-of
 *   tenant-RBAC capabilities (delegation), plus the shell's parametric faces
 *   (`requiredModule`, `blockMobileOnly`).
 * - `RequirePlatformAdmin` — SUPER_ADMIN scope (admin-panel).
 * - `RequireTenantPanel` + `RequireCapability` — the tenant-admin double gate
 *   (panel entry, then per-page capability/adminOnly).
 * - `ErrorBoundary` — crash isolation at module/page altitude.
 *
 * Loading: the family's default in-flight surface is `GuardLoading`, the
 * BrandLoader (components/Loading) naming the session check — the same one
 * loading screen the shell's routes and the boot splash show (FE-MEDIUM-349).
 *
 * All gates read auth from `useAuthContext()` and capability rules from
 * `utils/tenant-capabilities` — the FE capability SSoT. Fail-closed.
 */

export { RequireAuth } from './RequireAuth';
export type { RequireAuthProps } from './RequireAuth';

export { RequireRole } from './RequireRole';
export type { RequireRoleProps } from './RequireRole';

export { RequirePlatformAdmin } from './RequirePlatformAdmin';
export type { RequirePlatformAdminProps } from './RequirePlatformAdmin';

export { RequireTenantPanel } from './RequireTenantPanel';
export type { RequireTenantPanelProps } from './RequireTenantPanel';

export { RequireCapability } from './RequireCapability';
export type { RequireCapabilityProps } from './RequireCapability';

export { ErrorBoundary } from './ErrorBoundary';
export type { ErrorBoundaryProps } from './ErrorBoundary';

export { GuardLoading } from './GuardLoading';

export { RouteWithBoundary } from './RouteWithBoundary';
export type { RouteWithBoundaryProps } from './RouteWithBoundary';
