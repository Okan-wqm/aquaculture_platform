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
