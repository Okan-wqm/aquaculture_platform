# Review follow-ups from landing #1670 (2026-10-03)

Owner: okan. Raised while landing PR #1670 on `fix/land-farmsetup-fixes`; the code each finding cites
runs in production in the hand-built farm-service and farm-module images.

## SEC-HIGH-188

Severity: HIGH (security). Deadline: 2026-10-04.

`HarvestPlanService.completeHarvest` (#1670, 8b61d726a) issues one `CreateHarvestRecordCommand` per
stocked tank and passed `userRoles?.length ? userRoles : [Role.TENANT_ADMIN]`: a caller with no roles
moved stock with tenant-admin authority, and because MODULE_MANAGER+ bypasses
`SiteAuthorizationService.assertSiteAssignment`, the per-tank site check never ran for it. The
resolver re-derived the roles by filtering loose strings against the `Role` enum, so any role value
outside the enum produced an empty set that was then promoted. The service had no floor of its own.

Probe on ca9d9d4cb: `completeHarvest(..., roles [])` was not refused and issued
`CreateHarvestRecordCommand` with `userRoles ["TENANT_ADMIN"]`.

Fix: the resolver passes the verified `SiteScopeCaller` (roles validated as canonical `Role` values
by the JWT guard) unchanged; the service refuses, before any read, a caller whose roles do not reach
the `completeHarvestPlan` entry of the farm permission matrix through `roleHasPermission`, and
carries the caller's roles unchanged into every stock movement. A grep of `apps/farm-service/src`
finds no other fallback from no roles to a default role.

## FE-MEDIUM-310

Severity: MEDIUM. Deadline: 2026-10-09.

`SitesTab` "View Details" first navigated to `/sites/:id`, a route farm-module redirects back to the
list, and #1670 (c53d16b4a) pointed it at `handleEdit`, so viewing a site opened the edit form, a
write surface, even for users without `updateSite`. Fix: a read-only `SiteDetailsDrawer` that renders
the record the list already holds; editing stays behind the permission-gated edit button.

## FE-HIGH-311

Severity: HIGH. Deadline: 2026-10-09.

`useLocalConfirm` (#1670) exists because `useConfirm()` from shared-ui throws inside farm-module.
Measured cause: every federation vite config (shell and the 8 remotes) aliases
`@aquaculture/shared-ui` to an absolute path (`resolveSharedUiAlias` → `web/shared-ui/dist`). The
`@module-federation/vite` 1.20.8 build warns that the shared module "is aliased ... to
.../web/shared-ui/dist" and "will bypass Module Federation's sharing mechanism". Neither the
production bundles (shell, farm-module, tenant-admin) nor a fresh build contain a `loadShare` module
for shared-ui; farm-module's index chunk embeds its own shared-ui copy, including the
`ConfirmProvider bulunamadı` error text.

So every remote has its own shared-ui React contexts:

- `useConfirm()` reads the remote's `ConfirmContext`, finds no provider, and throws inside the click
  handler: the dead Delete buttons #1670 hit.
- `useToast()` falls back to per-component state, so a remote's toasts render only where the
  component mounts its own container.
- `useI18n()` falls back to English.

The production shell is also built from a tree that predates `ConfirmProvider` (aae401bc8,
2026-09-18), so the provider is missing there too.

This is not a bounded change. Sharing shared-ui for real moves every context boundary in the shell
and all 8 remotes at once, and the static `'1.0.0'` shared version lets a remote accept an older host
copy that lacks newer exports. The fix needs package resolution instead of the path alias, a shared
version that tracks the content, and a browser-level federation check in staging. Until it lands,
farm-module keeps `useLocalConfirm`, which renders shared-ui's `ConfirmModal` from the remote's own
tree.
