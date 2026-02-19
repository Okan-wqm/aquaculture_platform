---
name: shell
description: Knowledge base for the Shell (host) frontend application
---

# Shell Knowledge Base

## Overview

The Shell is the Module Federation host application. It owns authentication, routing, layout, and dynamically loads all remote microfrontend modules. Built with Vite + React + React Router v6. It provides the unified Sidebar, Header, and AuthContext to all child modules.

## Directory Structure

```
web/shell/src/
  App.tsx                        # Root router with all routes and ProtectedRoute
  bootstrap.tsx                  # Module Federation bootstrap
  main.tsx                       # Vite entry
  layouts/
    MainLayout.tsx               # Authenticated layout: Sidebar + Header + Outlet
    AuthLayout.tsx               # Unauthenticated wrapper for login pages
  pages/
    LoginPage.tsx                # Login, ForgotPassword, ResetPassword, AcceptInvitation
    NotFoundPage.tsx             # 404 / Unauthorized page
  components/
    RemoteModuleLoader.tsx       # Suspense fallback for remote module loading
    ErrorBoundary.tsx            # Per-module error boundary
    FishBackground.tsx           # Decorative fish animation on auth pages
  types/
    remote-modules.d.ts          # TypeScript declarations for federated modules
```

## Pages / Components

### LoginPage (`/login`)
Multi-mode form: `LoginForm`, `ForgotPasswordForm`, `ResetPasswordForm`, `AcceptInvitationForm`. Uses `useAuthContext()` for login. On success, navigates to `redirectPath` returned from the backend. Has an AquaMobil download banner.

### MainLayout
- Role-based navigation: `superAdminNavigation`, `tenantAdminBaseNavigation`, `moduleUserBaseNavigation`
- Dynamic module nav built from `modules` array in auth context using `MODULE_NAV_CONFIG`
- Theme: `admin` (indigo) for SUPER_ADMIN, `tenant` (emerald) for TENANT_ADMIN, `default` (blue) for others
- Logo text: role-specific or tenant name
- Sidebar collapse state via local `useState`

### Navigation routes loaded as remote modules

| Import alias       | Route prefix | Role restriction         |
|--------------------|--------------|--------------------------|
| `dashboard/Module` | `/dashboard` | Any authenticated         |
| `farmModule/Module`| `/sites`     | Any authenticated         |
| `hrModule/Module`  | `/hr`        | Any authenticated         |
| `sensorModule/Module` | `/sensor` | Any authenticated         |
| `hydroponicsModule/Module` | `/hydroponics` | Any authenticated |
| `adminPanel/Module`| `/admin`     | SUPER_ADMIN only          |
| `tenantAdmin/Module` | `/tenant`  | TENANT_ADMIN, SUPER_ADMIN |

## State Management

All state is in `@aquaculture/shared-ui` contexts:

### AuthContext (`web/shared-ui/src/contexts/AuthContext.tsx`)
- `useReducer` with actions: `AUTH_START`, `AUTH_SUCCESS`, `AUTH_FAILURE`, `LOGOUT`, `CLEAR_ERROR`
- `user: AuthUser` (id, email, firstName, lastName, role, tenantId, isActive)
- `modules: UserModule[]` (code, name, defaultRoute) — populated post-login via `me` query
- Helpers: `isSuperAdmin()`, `isTenantAdmin()`, `isModuleManager()`, `isModuleUser()`, `hasModuleAccess(code)`
- Module Federation fallback: decodes JWT from localStorage when context is missing (microfrontend cross-boundary)
- Token storage: `localStorage.access_token`, `localStorage.refresh_token`, `localStorage.tenant_id`

### TenantContext (`web/shared-ui/src/contexts/TenantContext.tsx`)
- `tenant` object with name, slug, etc. for display in Header/Sidebar

## GraphQL Operations

Login mutation (called directly in AuthContext):
```graphql
mutation Login($input: LoginInput!) {
  login(input: $input) {
    accessToken
    refreshToken
    redirectUrl
    user { id email firstName lastName role tenantId isActive }
  }
}

query Me {
  me {
    user { id email firstName lastName role tenantId isActive }
    modules { code name defaultRoute }
    redirectPath
  }
}

mutation Logout { logout { success } }
mutation AcceptInvitation($input: AcceptInvitationInput!) { acceptInvitation(input: $input) { accessToken } }
query ValidateInvitation($token: String!) { validateInvitation(token: $token) { valid email role firstName lastName expired } }
```

## Routing

```
/login                  -> LoginPage (public)
/forgot-password        -> LoginPage (isForgotPassword)
/reset-password/:token  -> LoginPage (isResetPassword)
/                       -> RoleBasedRedirect (SUPER_ADMIN->/admin, TENANT_ADMIN->/tenant, else->/dashboard)
/dashboard/*            -> DashboardModule (remote)
/sites/*                -> FarmModule (remote)
/hr/*                   -> HRModule (remote)
/sensor/*               -> SensorModule (remote)
/hydroponics/*          -> HydroponicsModule (remote)
/admin/*                -> AdminPanelModule (remote, SUPER_ADMIN only)
/tenant/*               -> TenantAdminModule (remote, TENANT_ADMIN+)
/unauthorized           -> NotFoundPage
```

## Key Dependencies

- `react-router-dom` v6 — routing
- `@aquaculture/shared-ui` — shared contexts, components, hooks
- Vite Module Federation plugin — remote module loading
- Tailwind CSS — styling

## Known Gotchas

- `useAuthContext()` has a Module Federation fallback that decodes the JWT from `localStorage` when the React Context is not available (microfrontend boundary). This fallback assumes `hasModuleAccess` returns `true` for all modules.
- `accessToken` is always re-read from `localStorage` in GraphQL requests for MF compatibility — module-level variable may not share across boundaries.
- Token refresh uses `POST /api/auth/refresh` (REST), not GraphQL.
- Forgot-password uses `POST /api/auth/forgot-password` (REST).
- Navigation dividers (`── Modules ──`) are dummy NavigationItem entries with empty `path`.
- `web/shell/module-federation.config.js` and `web/shell/src/bootstrap.tsx` are currently empty placeholder files.
- `web/shell/webpack.config.js` exists alongside Vite config — the project uses Vite, not webpack (webpack.config.js may be legacy).

## Related Backend Services

- **auth-service** (port 3001 dev / 3000 container) — login, logout, refresh, me, invitation flows
- **gateway-api** (port 3000) — all GraphQL goes through here at `/graphql`
