# 2026-05-06 - Admin Panel Vitest DOM Environment

## Affected Area
- `web/modules/admin-panel/vite.config.ts`
- `web/modules/admin-panel/src/hooks/__tests__/useAsyncData.spec.ts`
- GitHub Actions `CI - Affected / test`

## Observed Issue
The latest affected test run failed admin-panel React hook tests with:

- `ReferenceError: document is not defined`
- failure source: `@testing-library/react` `renderHook`
- failing spec: `src/hooks/__tests__/useAsyncData.spec.ts`

The same admin-panel test target also failed page specs with:

- `Cannot find module '@aquaculture/shared-ui'`
- failing imports from `CreateTenantPage.tsx` and `TenantManagementPage.tsx`

## Root Cause
`admin-panel` is a React microfrontend, but its Vitest runtime was using the default Node environment. React Testing Library requires a DOM-compatible environment for hooks/components that render through React.

This is a project test harness contract problem, not a production hook behavior problem.

Separately, `admin-panel` resolves `@aquaculture/shared-ui` to `../../shared-ui/dist`, but its test target did not declare `shared-ui:build` as a dependency. CI test jobs do not run the build graph implicitly for run-command targets, so the package-boundary artifact was absent.

## Architectural Fix
Declare the Vitest runtime at the project boundary:

- `environment: 'jsdom'`
- `globals: true`

This matches the existing pattern used by other React microfrontends in the repo and avoids per-spec `@vitest-environment` pragmas.

Declare `shared-ui:build` as a dependency of `admin-panel:test`. This preserves the existing package boundary instead of changing test-only import aliases to source files.

## Verification
- `npx nx run admin-panel:test`
- GitHub Actions `CI - Affected / test`

## Status
Fixed on 2026-05-06; pending CI confirmation.
