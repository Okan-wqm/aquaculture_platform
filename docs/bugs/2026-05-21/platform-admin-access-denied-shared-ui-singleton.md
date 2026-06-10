# Platform Admin Access Denied: Shared UI Singleton Split

Date: 2026-05-21

## Scope

Live droplet investigation for `by-okan@live.com` accessing `/admin`.

## Finding

The user is valid platform admin/super admin:

- `auth.users.role = SUPER_ADMIN`
- `auth.users.accessType = BOTH`
- `auth.users.tenantId = NULL`, which is expected for platform admin
- auth-service logged successful login with `role: SUPER_ADMIN`

The browser failure was not a backend authorization denial. The console error was:

```text
useTenantContext must be used within a TenantProvider
```

## Root Cause

Shell and admin-panel runtime code deep-imported shared-ui source files with paths like:

```text
../../../shared-ui/src/contexts/TenantContext
../../../shared-ui/src/contexts/AuthContext
```

The shell bootstrap provides `TenantProvider` and `AuthProvider` through the federated `@aquaculture/shared-ui` package identity. Deep source imports create a second module identity, so hooks can read a different React context instance than the provider wrote.

## Fix

Runtime imports were moved to the public package entrypoint:

```text
@aquaculture/shared-ui
```

This keeps React context identity aligned with Module Federation shared singleton rules. The root TypeScript path map now resolves `@aquaculture/shared-ui` to the source entrypoint for repo-wide type-aware tooling, matching the existing app-level tsconfigs. The root ESLint Nx boundary allowlist explicitly permits this package identity because it is the platform's shared UI singleton. A CI invariant scans shell and remote module runtime code and fails on any future `shared-ui/src/...` deep import.

## Validation

- `npx tsc --noEmit -p web/shell/tsconfig.json`
- `npx tsc --noEmit -p web/modules/admin-panel/tsconfig.json`
- invariant: `web-shared-ui-singleton-imports.spec.ts`
- `npx eslint web/shell/src/layouts/MainLayout.tsx web/modules/admin-panel/src/Module.tsx web/modules/admin-panel/src/components/admin-nav-items.tsx tests/invariants/web-shared-ui-singleton-imports.spec.ts`
- `npx nx build admin-panel`
- `npx nx build shell`
