# Suderra web landing — production web built from uncommitted source (2026-10-03)

Context: the 2026-10-02 production image audit found that the containers `aqua-shell`,
`aqua-tenant-admin` and `aqua-mobile` run images tagged `local-suderra-login`, built on
2026-09-21 17:06 from the working directory of the shared checkout `/var/aqua-saas` (HEAD
`43f0aa3bf`, 2026-09-03) rather than from any commit. Rolling main out to those three containers
would replace the Suderra UI, AquaMobil v4 and two field fixes that exist only there; three main
deploys (`81355797e` 09-21, `9125ae99d` and `62fb94b66` 09-27) were rolled back for that reason.

Owner: claude (implementation), okan (review). Branch `feat/land-suderra-web`.

## PROC-HIGH-047 — Production web runs images built from uncommitted source

Measured on 2026-10-02/03:

- The served HTML of the three containers is byte-identical to `/var/aqua-saas/web/*/dist`
  (built 09-21 16:57), except `50x.html` and `config.js`.
- That source is `43f0aa3bf` plus uncommitted edits. Blob-level comparison of the four web
  packages (shell, tenant-admin, aquamobil, shared-ui): 362 changed files equal PR #1569's head
  `cc65fa4bd` (322 byte-identical, 10 identical modulo main's 09-03..09-18 changes, 30 the
  earlier variant of the same edit); 14 tenant-admin files are in no commit — 10 of them the
  `sd-page` wrappers written 09-21 16:01-16:09, after #1569's last push.
- PR #1569 (`feat/suderra-session-20260917`) is open, 627 commits behind main, and its tree also
  carries sensor-, farm- and messaging-module changes that none of the three containers serve.
- Nothing ties a deployed web image to a commit: the deploy lane builds from main, the hand-built
  images from whatever the shared working directory holds, and no gate compares the two.

Rule: a production artifact is reproducible from a commit on main; a host-local build is a
recorded, time-boxed exception.

Fix path: land the production web source on main (`feat/land-suderra-web`), then roll the
three containers from main and retire the `local-suderra-login` tags. The finding closes with
that rollout, not with the code change alone.

## MOB-HIGH-023 — A record submission waits forever when no service worker activates

`queueOperation` (`web/apps/aquamobil/src/pwa/offline-queue.ts`) awaited
`navigator.serviceWorker.ready` before returning whenever Background Sync was available. Per
spec `.ready` never rejects; it stays pending until a worker is active. On an origin the device
does not trust (a by-IP deployment) the worker never registers, so `queueOperation` never
returned and every record form stayed on "Recording…" (field report 2026-09-17, "kayıtlar
yapılamıyor"). The record itself was already persisted; only the optional Background Sync
registration hung, and it blocked the caller.

Fix: `waitForServiceWorker(timeoutMs)` resolves the registration or `null` within 3 s and clears
its timer; `queueOperation` skips Background Sync on `null` and the in-app sync drains the queue.
Pinned by four specs in `src/pwa/__tests__/offline-queue.spec.ts`; the queueOperation case fails
on the old code (its readiness bound is never armed), the other three pin the helper.

## MOB-MEDIUM-024 — The tenant header is read from a copy that can disagree with the token

`authenticatedFetch` (`web/apps/aquamobil/src/services/authenticated-fetch.ts`) set
`X-Tenant-Id` from `authStore.tenantId`, a copy AuthProvider pushes through `syncAuthStore`
separately from the access token. The copy is `null` whenever an auth response carries
`user.tenantId: null` while the signed token carries the claim, and on the 401 retry it is
whatever the refresh left there. Boot-time queries then reached the subgraphs without a tenant
and failed with "Tenant ID is required" (field report 2026-09-17, GetMyNotifications and peers).

Fix: one resolver, `currentTenantId()`, used for the first request and the retry: the token's
`tenantId` claim (decoded by `decodeTenantId` in `src/utils/jwt-claims.ts`, which shares one
fail-closed payload decoder with `decodeResourcePermissions`), and the stored id only for a token
without the claim. Pinned by `authenticated-fetch-tenant-header.spec.ts` (three of five cases
fail on the old code) and `jwt-claims.spec.ts`.

Not covered: the 2026-09-17 notes also record one boot-time caller that still fires before any
tenant exists; it was not identified then and is not addressed here.

## Package findings under PROC-HIGH-047

PROC-HIGH-047 closes with the rollout. The source it needs on main is tracked per package, so
each landing commit closes exactly what it lands and anything not landed stays open by name.

### FE-MEDIUM-312 — Ten tenant-admin page edits exist only in the production build

The 2026-09-21 16:01-16:09 edits add `sd-page` (the Suderra page scope) to ten tenant-admin page
roots and are in no commit. One wraps the "Appearance — coming soon" placeholder, a tab main
removed under ADMIN-LOW-027; the other nine apply. (Two farm-module edits from the same minutes
are not in the running farm-module image and are not part of this finding.)

### FE-HIGH-313 — The Suderra shell and shared-ui skin exist only in the production build

The production login (`ReefScene`, a shadow-DOM reef replacing `FishBackground`), the
`SuderraSidebar` rail with its `MainLayout`, the Suderra modal/confirm styling and the shell's
Suderra stylesheet (the `sd-*` page surface every federated page is scoped by) come from #1569's
tree and the working directory only. Main meanwhile gained the MFA setup screen (ADR-046), the
app-wide `ToastProvider` and the dark-theme and design-system ratchets, so the port is a
re-expression on main's primitives and tokens, not a file copy.

### FE-HIGH-314 — The tenant-admin Suderra restyle exists only in the production build

#1569 restyles thirteen tenant-admin files (dashboard, activity, roles, users, role and status
badges, user modals and filters). On main the same files moved to DataTable, shared-ui form
controls, Badge and dark variants, and the settings pages gained the `canEdit` gate; #1569's
restyle carries 194 static inline style blocks and 89 raw hex colours that main's design-system
ratchet holds at zero for the package.

### MOB-HIGH-025 — AquaMobil v4 exists only in the production build

The SUDERRA FIELD redesign (tablet board and phone shell split, the `components/ui` set, drives
and units surfaces, scan, reports, theme tokens and fonts) is in #1569's tree and the working
directory: 100 paths that main does not have, and 320 changed files of which 72 conflict with
main's own AquaMobil refactor (one primitive vocabulary, PageHeader bands, lucide icons, the
persisted locale, BottomSheet dialogs).

Landed as a three-way merge (base `43f0aa3bf`, production working directory against main), so
main's own AquaMobil work is kept where both changed a file: the typed GraphQL contract
(MOB-HIGH-022), the honest queued-write receipts, the BottomSheet dialogs, the generated enums and
main's specs. The v4 screens arrive on main's primitives and inside main's design-system ratchet
(no raw hex, no static inline style, no light-only surface, fewer raw buttons, fields and
hard-coded strings than main had). The drive surface is not part of this landing — see
MOB-HIGH-026.

### MOB-HIGH-026 — The v4 drive surface reads a contract main does not serve

The v4 drive screens (drive list and detail, the unit drives card, the board's drives strip,
feeder setup) query `VfdDevice.driveBinding`, `VfdDevice.drivenUnit` and `Query.feederSetup`.
None exists in `apps/sensor-service` or `apps/farm-service` on main: codegen against main's
composed supergraph fails on exactly those three fields, which is why #1569 carried a
hand-written type mirror (`src/graphql/vfd-types.ts`) that the MOB-HIGH-022 contract gate bans.
Production's sensor-service (`34db380f9`, an ancestor of main) lacks them too, so in production the
drive detail, the unit drives card and feeder setup already fail at the router; only the fleet
index renders. The server side is on `feature/aquamobil-v4-redesign` (`1401860c7` drive binding,
`05479fd83` feeder calibration). The drive screens land with that contract, regenerated from the
supergraph; the actuation never-queued guard (`src/pwa/actuation-commands.ts`) is already on
main.
