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

## INFRA-HIGH-230

**State:** OPEN. Resolved by the PR whose commit carries `Closes:` for this ID. Deadline
2026-10-24.

### Symptom

CI - Affected run 38990686731 (`ffd6aa2f4`, `deploy-development / deploy`) ended with
`status=rollback_failed`. Afterwards `ghcr.io/okan-wqm/aquaculture_platform/<svc>:ffd6aa2f4...`
named the pre-release image for every app service (`shell` → `ebc6d366dea1`, the same image as
`rollback-ffd6aa2f4-*` and `:latest`). The release image pulled from GHCR by digest
(`shell@sha256:e2dcd102...`) was left untagged. Compose resolves app images as `<svc>:${TAG}`,
so any later `TAG=ffd6aa2f4... docker compose up` started old code against a schema two
migrations ahead of it.

### Root cause

The job logs of attempts 3 and 4 (release ids `ffd6aa2f4...-20261017T<time>`) show two defects
in the same rollback path, plus a compose recreate that cannot survive its own failure.

| Attempt        | db-migrate | Compose failure                       | Rollback              |
| -------------- | ---------- | ------------------------------------- | --------------------- |
| 3 (`T083603Z`) | 2 applied  | `/aqua-mobile` held by `740006e18d09` | refused, no tag moved |
| 4 (`T085545Z`) | 0 applied  | rename onto `/aqua-dashboard`         | retagged, then failed |

1. **The release tag was the rollback mechanism.** `rollback_deployed_services`
   (`scripts/deploy/droplet-up.sh:573-574` before the fix) ran
   `docker tag <pre-release id> <svc>:latest` and `docker tag <pre-release id> <svc>:<DEPLOY_SHA>`
   so that compose, which resolves `<svc>:${TAG}`, would pick the old image. The retag ran
   before `docker compose up` (`:583`). When compose failed, the tags stayed on old code. The
   release pin in `pull_deploy_image_required` also swallowed a failed `docker tag` with
   `|| true` (`:446`). This is the ORPHAN-HIGH-381 mechanism: that fix added guards but kept
   the release-tag rewrite.
2. **The migration guard counted one attempt.** `MIGRATIONS_APPLIED_THIS_RELEASE` comes from
   this attempt's `aqua-db-migrate` log (`:331-333`). Attempt 3 applied the release's two
   migrations and was refused correctly. Attempt 4 of the same release applied none, passed the
   guard (`:529-538`) and restored images captured from containers that had booted days before
   those migrations (`capture_rollback_manifest`, `:487-498`, checks health only). Its own
   compose run failed, so nothing crash-looped. Had it succeeded, every restored service would
   have cold-started against the forward schema: the 2026-07-12 farm-service outage class.
3. **Compose recreate could not recover.** `docker compose up --force-recreate` creates the new
   container as `<old-id12>_<name>`, removes the old one and renames the new one. In attempt 3
   a container compose did not own already held `aqua-mobile`. Compose aborted mid-run and left
   `<id12>_aqua-*` temp containers next to the originals. In attempt 4 compose took each temp
   container as the one to replace and could not rename onto the name the original still held.
   The rollback's own `compose up` hit the same wall (`f33602842a24_aqua-auth`). The selective
   path (`:1612`) ran compose with no check for either state.

### Fix

- **Release tags have one writer.** `pull_deploy_image_required` pins `<svc>:<DEPLOY_SHA>` and
  `<svc>:latest` from the release digest and fails the deploy if either pin fails. The rollback
  writes no tag. Capture tags the running images as `<svc>:rollback-<DEPLOY_RELEASE_ID>`, and
  restore runs compose with `TAG=rollback-<DEPLOY_RELEASE_ID>`. Compose picks the rollback
  generation by name, and `TAG=<release-sha>` keeps naming the release whatever the rollback
  does. Restore recreates only services whose rollback tag still resolves to the captured image.
- **The schema boundary spans attempts.** Every release-ledger write now carries
  `deploy_metadata.migrationsApplied` and `deploy_metadata.schemaAdvancedAt`. The latter is the
  epoch at which db-migrate stopped whenever it did not prove zero migrations, including
  failures and timeouts. `schema_advanced_at` reads the latest advance from the ledger. Rows
  written before this change count at `created_at`. A db-migrate container that is still
  running or exited non-zero also counts. Capture keeps only healthy containers that started
  after that moment. An unreadable ledger leaves no rollback point. Restore still refuses unless
  this attempt's count is a proven `0`. Attempt 4 now captures nothing and refuses.
- **One recreate path.** `compose_recreate_services` (`scripts/deploy/lib/compose-recreate.sh`)
  serves the selective rollout and the restore. It first runs
  `scripts/deploy/compose-container-preflight.ts`, which reads the target container names from
  `docker compose config` and the host from `docker ps -a`. A target name held by a container
  that is not this project's service fails the deploy before anything is stopped, naming the
  container, its id and its compose owner. Temp containers `<12 hex>_<name>` labelled as this
  project's service are removed. Anonymous volumes are kept.
- The rollback and image-reference code moved from `droplet-up.sh` into
  `scripts/deploy/lib/release-rollback.sh`, so the specs can source it.

### Tests

- `tests/invariants/deploy-rollback-release-tag.spec.ts` runs capture and restore against a
  fake Docker daemon (`tests/invariants/helpers/fake-deploy-docker.ts`). Attempt 4 is refused
  with no release-tag write and no compose run. Attempt 3 is refused untouched. Unknown counts
  are refused. A permitted rollback removes the leftover temp container and runs
  `TAG=rollback-<id> compose up` while both release tags stay on the release image. A
  re-pointed rollback tag is not restored. An unreadable ledger and an unclean db-migrate run
  are treated as advances. A static check pins the three `docker tag` writers. Against the
  `origin/main` logic, the attempt-4, permitted-rollback and writer checks fail.
- `tests/invariants/compose-recreate-preflight.spec.ts` covers removal of the temp container
  before `compose up` with the caller's `TAG`. A foreign, unlabeled or other-service holder of
  the name fails with no `rm`, `stop` or `up`. Temp names of other projects are left alone and
  undefined services are refused.

### Not changed

- The full-stack path runs `compose down` and force-removes every `aqua-*` container before
  `compose up`, so no leftover can block it. Its rollback goes through the same
  `compose_recreate_services`.
- No container, image tag or ledger row on the droplet was changed. Attempt 5 re-pinned the
  `ffd6aa2f4` tags from the digests and was promoted at 09:27:36Z. A read-only check on the host
  shows `shell:ffd6aa2f4...`, `shell:latest` and the running `aqua-shell` on `e2dcd102bd52`.
