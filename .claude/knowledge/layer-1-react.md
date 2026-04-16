# Layer-1 React — Frontend patterns

**Audience:** frontend-expert, domain experts reviewing `web/modules/<domain>/**`.
**Anchor:** React 18.3.1 (shell) / ^18.2.0 (remotes) + Vite ^5.0.0 + `@originjs/vite-plugin-federation` + `eslint-plugin-react-hooks` ^4.6.0 (shared-ui) / ^5.0.0 (elsewhere) + GraphQL 16 codegen, as of 2026-04-16.

**Note on anchor drift:** root `package.json` declares some deps at higher versions (Vite 7.3.1, React 18.2) — these are overridden by per-project `project.json` pins in shell + remotes. W1 frontend audit corrected these; this SSoT reflects what ships, not what root declares.

Depends on: `layer-1-core.md` (TypeScript 5.3). React 19 Server Actions are NOT in scope.

## React 18 runtime patterns

- **Suspense boundaries** — mandatory at every Module Federation remote-load site. Missing Suspense on `React.lazy(() => import('remote/Module'))` causes visible flash-of-loading failure.
- **Error Boundaries** — one per microfrontend, wrapping the remote component. Without it, an uncaught error in a remote crashes the entire shell. Component: `web/shared-ui/src/error-boundary/*`.
- **`useTransition` / `useDeferredValue`** — use for non-urgent updates (table filtering, search-as-you-type). Blocking pattern (setState in handler) still dominates the codebase; W6 frontend skill catalog promotes adoption.
- **Automatic batching** — 18's default. Do not add explicit `unstable_batchedUpdates` wrappers — those are 17-era code smell.
- **Concurrent rendering** — React 18 is concurrent by default. Avoid tearing state between render passes: derive from props/server state rather than caching in `useRef`.

## Module Federation (`@originjs/vite-plugin-federation`)

- **Shell + 7 remotes** — `web/shell` (host) + `web/modules/{dashboard, farm-module, sensor-module, hr-module, admin-panel, tenant-admin, hydroponics-module}`. Each remote exposes entry components via `exposes:` config.
- **Shared singletons** — react, react-dom, @tanstack/react-query MUST be shared singletons. Remote-local instances break query-cache sharing and Suspense behaviour.
- **Versioned remote loading** — remote URLs are environment-specific (dev vs staging vs prod); loaded via runtime config, not build-time imports.
- **SRI enforcement** — FE-CRITICAL-002: current SRI is post-load JS patching via `remoteIntegrity.ts` (racey, spec-non-compliant). Correct: attach via `createScript` runtime hook. W6 fix.
- **CSP** — currently whitelists `cdn.jsdelivr.net` without hash/nonce/`strict-dynamic` (FE-CRITICAL-002 paired with EDGE-HIGH-002 SCADA). W6 joint fix.

## Vite 5 + build

- **`vite-plugin-svgr` ^4.5.0** — SVG-as-component pattern. Use over inline `<img>` for tree-shakable icons.
- **HMR boundaries** — React 18 Fast Refresh works out of the box; keep `export default` singleton per module so HMR can replace in-place.
- **`import.meta.env`** — typed via `vite-env.d.ts` per project; prefer over `process.env` for runtime config.
- **Build target** — `esnext` for modern browsers; polyfills handled by `@vitejs/plugin-legacy` in shell only.

## Server state + tenant scoping

- **React Query (`@tanstack/react-query`)** — canonical server-state manager. Per ADR-009 frontend data-fetch pattern.
- **`createTenantQueryKey(queryKey, tenantId)`** — SSoT tenant-scoped key factory in `web/shared-ui`. Adopted in 4 of ~30+ modules as of W1 (FE-CRITICAL-001). Farm-module alone has 265 non-conforming `queryKey` arrays. Tenant switch cannot purge previous-tenant cache — cross-tenant leak vector.
- **W6 ESLint rule** `no-bare-tenant-query-key` (BLOCKER-20 family) detects bare arrays and demands `createTenantQueryKey`.
- **`staleTime` default** — 5 minutes for cross-service joins; 30s for high-churn streams. Customise per query; don't set globally.

## GraphQL codegen

- **`codegen.ts`** defines the pipeline wired to 8 service schemas. Output path `web/shared-ui/src/generated/graphql-types.ts` **does not exist on disk** — codegen is orphaned. Every `any` / `as any` in `web/` GraphQL sites (114 + 89 respectively per W1 anti-pattern scan) is a consequence.
- **`client-preset` + `typed-document-node`** — target migration state. One PR re-wires codegen + migrates all sites. W7 deliverable.
- **Fragment masking** — enable via client-preset `presetConfig.fragmentMasking: true` so consumer components only see fields they explicitly fragment.

## Styling (ADR-010)

- Canonical choice — verify via `web/shell/tailwind.config.js` + shared-ui CSS setup. ADR-010 is Tier-4 in the ADR drift matrix (doc-only) — W7 promote to Tier-3 via ESLint rule banning arbitrary `style={{...}}` props where a design token exists.

## Testing

- **Vitest (`@nx/vite`)** — unit test runner aligned with Vite. Use `@testing-library/react` for component tests.
- **Playwright** — E2E surface at `e2e/tests/**` (shared with backend). Frontend-specific flows use `@playwright/test` with per-tenant fixtures.
- **Module-federation E2E** — remote loading must be covered by an E2E that starts shell + a remote, asserts Suspense fallback, assert final render. Gap as of W1 — W6 test-runner agent catalog.

## References

- Slice audit: `/var/aqua-saas/docs/reviews/_audit/2026-04-W16-frontend-react.md`
- `/var/aqua-saas/web/shared-ui/` — design system + federation singletons
- `/var/aqua-saas/codegen.ts` — orphan codegen pipeline (W7 rewire)
- ADR-009 (data-fetch), ADR-010 (styling)
