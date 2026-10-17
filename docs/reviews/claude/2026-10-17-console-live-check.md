# Console live check (2026-10-17)

Defects found by checking the tenant console against production. Code changes only: no
production container, Redis or droplet runtime state was touched.

Owner: claude (implementation), okan (review).

## FE-HIGH-343

**State:** OPEN. Resolved by the PR whose commit carries `Closes:` for this ID. Deadline
2026-10-24.

### Symptom

On production `/dashboard` rendered the shell's "Failed to Load Dashboard" boundary with
`Error: useTenantContext must be used within a TenantProvider`, thrown from
`remotes/dashboard/assets/DashboardPage-*.js`. The shell mounts `TenantProvider`
(`web/shell/src/bootstrap.tsx`), and its own tenant pages read it without error.

### Root cause

Every federation vite config (the shell and all eight remotes) aliased `@aquaculture/shared-ui`
to `web/shared-ui/dist` in every mode except `test`
(`web/shared-ui/src/federation/sharedUiAlias.ts:30-32`, applied at
`web/modules/dashboard/vite.config.ts:40` and `web/shell/vite.config.ts:78`).

Vite's alias plugin runs before every user plugin. `@module-federation/vite` therefore received
`/…/web/shared-ui/dist` instead of the shared specifier and never routed the import through its
`loadShare` proxy. The `shared:` entry for `@aquaculture/shared-ui` (singleton, strictVersion)
was inert. The shell and each remote imported a private copy of shared-ui, so each bundle created
its own `TenantContext`. `DashboardPage` (`web/modules/dashboard/src/pages/DashboardPage.tsx:102`)
read the dashboard's copy, which no provider had mounted, and `useTenantContext` threw
(`web/shared-ui/src/contexts/TenantContext.tsx:133-137`).

The dashboard is the only remote that calls `useTenantContext`, which throws without a provider.
The other shared-ui hooks remotes call hid the same split behind fallbacks: `useAuthContext`
reads a window bridge (FE-MEDIUM-059 named the alias warning as its cause) and `useToast` keeps
local state.

### Evidence

- Vite's plugin pipeline for the dashboard config in production mode resolves `react` to
  `virtual:mf:…__loadShare__react__loadShare__.js` and `@aquaculture/shared-ui` to the raw path
  `web/shared-ui/dist`. The plugin prints its own warning on every build: "Shared module
  `@aquaculture/shared-ui` is aliased … will bypass Module Federation's sharing mechanism".
- A dashboard build from before the fix has `loadShare` modules for react, react-dom, the router,
  TanStack Query, recharts and zustand, but none for shared-ui. `DashboardPage-*.js` imports
  `useTenantContext` from a local `index-*.js` chunk. The shell build shows the same pattern.

### Fix

`sharedUiAlias(root, mode)` replaces `resolveSharedUiAlias`. It returns alias entries to spread
into `resolve.alias`: `{ '@aquaculture/shared-ui': <root>/src }` under `test` and nothing in any
other mode. All nine federation configs spread it. Unaliased, the specifier resolves through the
workspace package's `exports` to `web/shared-ui/dist/index.mjs`, the barrel the alias used to
name, and `@module-federation/vite` proxies it like every other singleton.

After the fix, the dashboard and shell builds each emit
`…__loadShare___mf_0_aquaculture_mf_1_shared_mf_2_ui__loadShare__.js`. `DashboardPage-*.js` and
the shell's `bootstrap-*.js` import shared-ui from it.

All shared-ui providers in one runtime now come from one module instance, so every remote reads
the shell's `TenantProvider`, `AuthProvider`, `ToastProvider`, `ConfirmProvider` and
`I18nProvider`. The shared-ui pin is a constant `1.0.0`, so the federation images must ship from
one commit. `docker-compose.droplet.yml` already guarantees this: all nine images use one `TAG`.

### Detection

- `tests/invariants/web-shared-ui-singleton-imports.spec.ts` fails when a federation vite config
  spells an alias whose `find` shadows any `SHARED_VERSIONS` key, and when `sharedUiAlias`
  returns a shadowing entry outside test mode. Before the fix, it failed on all nine configs. The
  deep-import scan now matches whole statements, so a multi-line `import { … } from
'…/shared-ui/src/…'` is caught too.
- `tests/invariants/shared-ui-test-alias.spec.ts` requires every federation config to spread the
  resolver and none to spell the key or the built barrel.
- `web/modules/dashboard/src/__tests__/federation-shared-ui.spec.ts` runs the dashboard and shell
  configs' real plugin pipelines in production mode. It asserts that `react` (the control) and
  `@aquaculture/shared-ui` both resolve to their `loadShare` proxies. Before the fix, the
  shared-ui cases failed on both sides with the `dist` path.
- `web/modules/dashboard/src/__tests__/DashboardModule.shell-providers.spec.tsx` mounts
  `./Module` on the shell's `/dashboard/*` route inside the shell's provider tree, with the
  session and GraphQL hooks stubbed. It renders, and it reads the tenant from the host's
  `TenantProvider`. Without that provider it throws the production error.

## FE-MEDIUM-344

**State:** OPEN. Deadline 2026-10-31.

`useAuthContext` still falls back to the `__AQUACULTURE_AUTH_CONTEXT_STATE_V1__` window bridge
(`web/shared-ui/src/contexts/AuthContext.tsx:97-116`, `:230-279`, `:814-850`). FE-MEDIUM-059
added it because remotes read a different `AuthContext` than the shell's `AuthProvider`, the
split FE-HIGH-343 removes. With one shared-ui instance, no federated render path reaches the
bridge. It remains a second auth source that does not need a provider.

The bridge is kept out of the FE-HIGH-343 change on purpose. The auth fallback should be retired
against a deployed single-instance build, not in the same change that creates it.

Closes when `useAuthContext` has only two outcomes, the provider value or the fail-closed value
when no provider exists, the window global is gone, and `AuthContext.spec` covers a remote under
the shell's `AuthProvider`.
