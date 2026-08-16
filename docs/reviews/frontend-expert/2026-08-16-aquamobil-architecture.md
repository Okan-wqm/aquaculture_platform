# AquaMobil PWA architecture audit — 2026-08-16

**Agent:** `frontend-expert` · **Mode:** CATCHER (read-only) · **Lane:** mobile
**Cycle:** `2026-08-16-farm-mobile-agent-audit` · **Verdict:** CONDITIONAL
**Findings surviving verification:** 12 (CRITICAL 0 · HIGH 1 · MEDIUM 10 · LOW 1)

> Produced by a 27-agent audit workflow, then verified by a second 25-agent pass.
> **Every** claim — CRITICAL through LOW — was handed to an independent verifier
> instructed to **refute** it by reopening each cited line, with "refuted" as the
> default when the evidence did not clearly hold. Claims that could not be defended
> were dropped into the Refuted section below; claims that proved smaller or larger
> than filed carry a corrected severity.
>
> **Finding IDs** are allocated above the `FE` high-water mark in
> `docs/reviews/_registry/findings.jsonl` (FE was at 63 at cycle time), so
> they do not collide with existing registry entries. They are **not yet registered** —
> `npm run findings:add` is a separate, human-gated append to the hash-chained ledger.

## Scope

Read the full AquaMobil PWA surface at /home/user/aquaculture_platform/web/apps/aquamobil:
CLAUDE.md, package.json, vite.config.ts, index.html,
public/{manifest.webmanifest,sw.js,firebase-messaging-sw.js,icons/placeholder.txt};
src/{main.tsx,App.tsx};
src/pwa/{messaging-sw.ts,offline-queue.ts,sw-replay.ts,operation-registry.ts} plus
**tests**/{sw-build-artifact.invariant,queued-mutation-ssot}.spec.ts;
src/hooks/{useAuth.tsx,useOfflineQueue.tsx,useSwNavigation.ts,useDarkMode.ts,useIncidentMediaUpload.ts};
src/services/authenticated-fetch.ts; src/utils/{logger.ts,tenant-query-keys.ts};
src/i18n/{I18nProvider.tsx,index.ts,locales/{en,tr}.ts}; src/types/{index.ts,messaging.ts};
src/generated/graphql.ts (header); src/components/{ErrorBoundary,InstallPrompt}.tsx;
src/layouts/MobileLayout.tsx; src/styles/main.css;
`src/**tests**/field-ergonomics.invariant.spec.ts`; and page samples (LoginPage, HomePage,
StockMovementPage, AccountPage, RecordMortalityPage, SyncStatusPage). Cross-read
/home/user/aquaculture_platform/codegen.ts,
web/shared-ui/src/{utils/index.ts,utils/tenant-query-keys.ts,components/index.ts},
infrastructure/nginx/droplet.conf,
infrastructure/docker/nginx/{aquamobil.conf,snippets/security-headers.conf}, and
apps/messaging-service media/S3 factories. Repo-wide greps for as any / @ts-ignore / `console.*` /
queryKey: / htmlFor / `toLocale*` / `caches.*`.

## Executive summary

AquaMobil is a genuinely mature offline-first PWA: hand-written injectManifest SW with a real
closed-app Background-Sync replay lane, AES-GCM tenant-partitioned IndexedDB queue with
cap/dedup/backoff/dead-letter, memory-only tokens with a re-armable auth barrier and single-flight
refresh, near-total createTenantQueryKey adoption, zero `console.*` and zero hand-written `as any`
outside generated code, and two real Tier-3 build invariants. The gaps are at the edges, and three
of them cost field data or break features in production. Logout unconditionally wipes the entire
offline queue while the confirmation dialog never mentions the pending count, so a worker who logs
out at end of shift silently loses the shift's records. The shipped CSP (connect-src 'self', img-src
'self' data: blob:) cannot reach the presigned MinIO origin, so photo/voice/incident upload and
attachment rendering are blocked at the edge. The offline-replay mutation documents live outside the
codegen document glob, so the most data-critical documents in the app have zero schema validation.
i18n exists but reaches 1 of ~40 pages while the default detected locale is Turkish. Two conflicting
web-app manifests are emitted to the same dist path.

## Findings (by severity)

### HIGH

### FE-HIGH-065

**Title:** Shipped CSP cannot reach the presigned MinIO origin \- photo/voice/incident upload and
attachment rendering are blocked in production

**Severity:** HIGH
**Layer:** 2
**State:** OPEN
**Raised as:** `FE-HIGH-002` by `frontend-expert` in cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- infrastructure/docker/nginx/snippets/security-headers.conf:22 \- Content-Security-Policy
  "default-src 'self'; script-src 'self'; ... img-src 'self' data: blob:; connect-src 'self' wss:;
  ..."
- web/apps/aquamobil/src/hooks/useIncidentMediaUpload.ts:179 \- xhr.open('PUT', presignedUrl) to the
  presigned URL returned by farm-service
- web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:114 \- await fetch(uploadUrl, { method: 'PUT',
  ... }) in replayUploadAndSendMessage
- apps/messaging-service/src/shared/messaging-s3-client.factory.ts:21 \- endpoint:
  configService.get('MINIO_ENDPOINT', '`http://localhost:9000`'); presign at
  apps/messaging-service/src/message/services/media.service.ts:112
- infrastructure/nginx/droplet.conf:113-511 \- the app.suderra.com vhost declares no
  minio/media/objects location, so the presigned origin is by construction not same-origin

**Rule violated:**

Agent CSP invariant: CSP must be enforced AND compatible with the app's real network surface;
CLAUDE.md 'report faithfully' \- a header set that silently disables a shipped feature is not
hardened, it is broken

**Proposed fix direction:**

Pick one architecture and make it enforced, not implied. Either route object storage through the
same origin (add an /objects/ location in the edge vhost, point the MinIO public endpoint at that
same-origin path, keep connect-src 'self'), or admit the cross-origin object store and add its exact
https origin to connect-src \+ img-src \+ media-src. Whichever is chosen, bind it with a test
asserting the CSP origin set is derived from the same config value the presign service uses, so the
two cannot drift again.

**Affected surface (ripple set):**

- `infrastructure/docker/nginx/snippets/security-headers.conf`
- `infrastructure/nginx/droplet.conf`
- `apps/messaging-service/src/shared/messaging-s3-client.factory.ts`
- `apps/farm-service requestIncidentMediaUpload presign path`
- `web/apps/aquamobil/src/pwa/messaging-sw.ts`

**Expected closer:**

frontend-expert WRITER mode jointly with the infrastructure owner of infrastructure/nginx/; route to
architectural-arbiter if the same-origin-vs-allowlist choice is contested

**Verifier note:**

Verified and if anything understated. security-headers.conf:23 is exactly `connect-src 'self' wss:`
and `img-src 'self' data: blob:`, and Dockerfile.aquamobil:73 copies it into the aquamobil image
where aquamobil.conf includes it at server level plus every overriding location; droplet.conf
/mobile/ (line ~487) proxies without proxy_hide_header, so the CSP reaches the PWA document. Uploads
do go cross-origin: useIncidentMediaUpload.ts:179 xhr.open('PUT', presignedUrl) and
useOfflineQueue.tsx PUT to the presigned uploadUrl. The presign endpoint is worse than the claim
states — docker-compose.droplet.yml sets MINIO_ENDPOINT: minio / MINIO_PORT: 9000 for gateway,
messaging and farm services (farm app.module.ts:410, messaging-s3-client.factory.ts:21), so
presigned URLs carry the Docker-internal host `minio:9000`, which is not merely CSP-blocked but
unresolvable from any browser. droplet.conf declares no minio/objects location, confirming no
same-origin proxy. Photo/voice/incident upload and presigned-GET attachment rendering are broken in
production. HIGH stands.

### MEDIUM

### FE-MEDIUM-064

**Title:** Logout unconditionally destroys the entire offline queue; the confirmation dialog never
mentions unsynced records

**Severity:** MEDIUM (filed as HIGH, downgraded by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:** `FE-HIGH-001` by `frontend-expert` in cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/hooks/useAuth.tsx:194-196 \-
  `await Promise.all([clearAllOperations(), clearCache(), ...])` inside clearAllUserData, called
  unconditionally from logout()
- web/apps/aquamobil/src/pwa/offline-queue.ts:500-534 \- clearAllOperations() with no tenantId
  deletes every `pending_*` key, every blob, AND
  `_sessionKey = null; await del(DURABLE_QUEUE_KEY, keyStore)` (cryptographic erase \- residue
  unrecoverable)
- web/apps/aquamobil/src/pages/account/AccountPage.tsx:744-757 \- logout ConfirmDialog message is
  exactly 'Are you sure you want to log out?'; pendingCount is in scope (line 407) but never
  referenced
- web/apps/aquamobil/src/pages/account/AccountPage.tsx:659-670 \- the Clear-queue row in the SAME
  component does surface `${pendingCount} unsynced operation(s)` and gates on it, proving the
  pattern exists and was simply not applied to logout

**Rule violated:**

CLAUDE.md Architectural Approach \- 'Make it impossible' (Tier 1); agent invariant: offline mutation
queue must never silently drop queued work (silent drop = HIGH, data loss)

**Proposed fix direction:**

Make the destructive path structurally unreachable while work is pending: have the logout entry
point require a QueueDrainedToken (or equivalent) producible only by a successful drain or an
explicit typed discardUnsyncedRecords decision, so a caller cannot invoke the wipe without having
handled the queue. Short of the full Tier-1 refactor, logout must attempt a drain when online,
render the pending count and operation types in the confirm dialog, and require a second explicit
discard confirmation \- mirroring the clear-queue row already in the same file. Add an invariant
spec asserting the logout dialog reads pendingCount.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/hooks/useAuth.tsx`
- `web/apps/aquamobil/src/pages/account/AccountPage.tsx`
- `web/apps/aquamobil/src/pwa/offline-queue.ts`
- `web/apps/aquamobil/src/hooks/useOfflineQueue.tsx`
- `web/apps/aquamobil/src/**tests**/`

**Expected closer:**

frontend-expert WRITER mode; coordinate with multi-tenant-saas-expert because the same wipe carries
the shared-device tenant-residue guarantee (MT-CRITICAL-050) that must not be weakened

**Verifier note:**

Facts verified. useAuth.tsx:194-196 calls clearAllOperations() with no tenantId inside
clearAllUserData(), invoked unconditionally at useAuth.tsx:471 in logout(); offline-queue.ts:500-534
confirms the no-tenantId branch deletes every `pending_*` key, every version token, all pending
blobs, then nulls _sessionKey and dels DURABLE_QUEUE_KEY (unrecoverable). AccountPage.tsx:746
message is literally 'Are you sure you want to log out?', pendingCount is in scope (line 407) and
used only for the Clear-Queue row (659-670) and dialog (764). No sync-before-logout exists in
logout(). BUT severity is inflated to HIGH: the full wipe is a deliberate, documented shared-device
security control (SEC-02 / FE-CRITICAL-002 / MT-CRITICAL-050), the loss is user-initiated behind a
confirm dialog, and the pending count is not invisible — MobileLayout.tsx:119 badges the Account tab
with pendingCount and the Account page shows it. The real defect is a missing warning string / no
sync-first prompt, not a silent drop of queued work. MEDIUM.

### FE-MEDIUM-066

**Title:** Offline-replay mutation documents sit outside the codegen document glob \- the most
data-critical GraphQL in the app has zero schema validation

**Severity:** MEDIUM (filed as HIGH, downgraded by adversarial verification)
**Layer:** 3
**State:** OPEN
**Raised as:** `FE-HIGH-003` by `frontend-expert` in cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- codegen.ts:47 \- `const aquamobilDocuments = ['web/apps/aquamobil/src/graphql/**/*.ts'];` is the
  entire aquamobil document set
- web/apps/aquamobil/src/pwa/operation-registry.ts:31-35 \-
  `export const OPERATION_MUTATIONS: Record<..., string>` holds 27 hand-written mutation strings
  (recordMortality, recordCull, createHarvestRecord, recordMealFeeding, clockIn/Out,
  createLeaveRequest) under src/pwa/, not src/graphql/
- `web/apps/aquamobil/src/pwa/**tests**/queued-mutation-ssot.spec.ts:63-78` \- the only gate over
  these documents checks for DUPLICATION against src/graphql, never schema validity
- web/apps/aquamobil/CLAUDE.md:13 \- 'The S1 codegen gate covers its GraphQL client' \- true only
  for src/graphql/**, an over-claim for the replay lane
- web/apps/aquamobil/src/hooks/useAuth.tsx:48-89 \- LOGIN/REFRESH/MOBILE_SETTINGS are likewise
  inline strings outside the glob

**Rule violated:**

ADR-009 (frontend data-fetch) \+ layer-1-react.md TypedDocumentNode target shape;
aquaculture/no-bare-graphql-query-string

**Proposed fix direction:**

Promote the replay registry into the codegen document set so a schema change becomes a build error
rather than a drain-time failure after the data was already collected offline. Move the documents
into src/graphql/ (or widen aquamobilDocuments to `src/**/*.ts`) and re-key OPERATION_MUTATIONS on
generated TypedDocumentNode constants \- the SW sub-build already imports the registry and print()
is already the wire path in authenticated-fetch. Then activate no-bare-graphql-query-string for this
app and correct the CLAUDE.md coverage claim.

**Affected surface (ripple set):**

- `codegen.ts`
- `web/apps/aquamobil/src/pwa/operation-registry.ts`
- `web/apps/aquamobil/src/pwa/sw-replay.ts`
- `web/apps/aquamobil/src/hooks/useOfflineQueue.tsx`
- `web/apps/aquamobil/src/hooks/useAuth.tsx`
- `web/apps/aquamobil/CLAUDE.md`

**Expected closer:**

frontend-expert WRITER mode; farm-expert must sign off on the mortality/cull/harvest/feeding input
shapes

**Verifier note:**

Factually correct: codegen.ts:47 sets aquamobilDocuments =
['`web/apps/aquamobil/src/graphql/**/*.ts']` and is the only aquamobil document set;
operation-registry.ts:31-35 holds the replay mutations as plain (non-gql-tagged) template strings
under src/pwa/, so they are outside the codegen glob. The two gates over them do not validate
schema: queued-mutation-ssot.spec.ts only checks non-duplication against src/graphql,
operation-registry.spec.ts only checks OperationType coverage and variable shaping. The
aquaculture/no-bare-graphql-query-string rule cannot fire either — it matches
TaggedTemplateExpression with a `gql` tag
(tools/eslint-rules/rules/no-bare-graphql-query-string.ts), and these are untagged strings; it is
also only 'warn' (eslint.config.mjs:545). However the claim demonstrates no actual drift:
spot-checking recordMealFeeding against apps/farm-service meal-execution.resolver.ts:194 and
MealFeedingResultView (meal-execution.results.ts:29-43) shows
id/status/actualKg/varianceKg/variancePercent all exist, and the other root fields resolve. This is
a missing build-time gate (risk of future drift), not a live production defect. MEDIUM.

### FE-MEDIUM-067

**Title:** Logout Cache-Storage wipe targets a cache name no worker creates; image-cache survives on
shared field devices

**Severity:** MEDIUM (filed as HIGH, downgraded by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:** `FE-HIGH-004` by `frontend-expert` in cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/hooks/useAuth.tsx:213-215 \- `caches.delete('api-cache')` \- no service
  worker in this repo ever opens a cache named api-cache
- web/apps/aquamobil/src/pwa/messaging-sw.ts:346-353 \- clearMessagingCaches() deletes only keys
  matching k.startsWith('messaging-')
- web/apps/aquamobil/src/pwa/messaging-sw.ts:134-145 \- new StaleWhileRevalidate({ cacheName:
  'image-cache', maxAgeSeconds: `60*60*24*30` }) matching every .png|.jpg|.jpeg|.gif|.webp pathname
  \- outside the messaging- prefix and therefore never purged
- web/apps/aquamobil/src/components/messaging/MemberRow.tsx:63 and ChannelAvatar.tsx:160 \- tenant
  user avatars rendered via `<img` `src>`, i.e. real per-tenant imagery flowing through that route
- web/apps/aquamobil/src/pwa/messaging-sw.ts:120-131 \- navigation-cache / static-cache likewise
  survive logout

**Rule violated:**

Agent invariant: logout must purge Workbox named caches; every tenant-scoped browser-storage
namespace must be cleared on logout (shared-device residue)

**Proposed fix direction:**

Remove the phantom name and make the purge set derivable rather than hand-listed: export the SW
cache-name constants from one module both the SW and the logout handler import, and have the LOGOUT
message handler iterate caches.keys() deleting everything in that declared tenant-data set
(image-cache included) rather than guessing a messaging- prefix. Add an invariant spec asserting
every cacheName literal in messaging-sw.ts appears in the purge set.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/hooks/useAuth.tsx`
- `web/apps/aquamobil/src/pwa/messaging-sw.ts`
- `web/apps/aquamobil/src/pwa/**tests**/sw-build-artifact.invariant.spec.ts`
- `web/apps/aquamobil/src/hooks/**tests**/useAuth-logout-wipe.spec.tsx`

**Expected closer:**

frontend-expert WRITER mode; multi-tenant-saas-expert reviews the shared-device residue contract

**Verifier note:**

The dead-cache-name part is confirmed: useAuth.tsx:213 calls caches.delete('api-cache') and no
worker in the repo ever opens that name — messaging-sw.ts opens only 'navigation-cache' (103),
'static-cache' (123), 'image-cache' (137), 'messaging-media-v1' (298); clearMessagingCaches()
(346-353) deletes only keys starting with 'messaging-'. So image-cache/navigation-cache/static-cache
survive logout, and avatars do flow through image-cache (MemberRow.tsx:62-63,
ChannelAvatar.tsx:158-160 render `<img` `src>`). Severity is inflated though: the authenticated
GraphQL and media caches (`messaging-*`) ARE purged via the LOGOUT postMessage at useAuth.tsx:482,
static-cache holds only content-hashed js/css/woff, and navigation-cache holds the SPA shell
(maxEntries 1) — no user data. Residue is limited to avatar imagery whose URLs are already
presigned/expiring, so shared-device exposure is thin. The api-cache line is a genuine no-op that
should be replaced with a caches.keys() sweep, but this is MEDIUM, not HIGH.

### FE-MEDIUM-068

**Title:** i18n infrastructure reaches 1 of ~40 pages while the default detected locale is Turkish
and `<html` `lang>` is hardcoded 'en'

**Severity:** MEDIUM (filed as HIGH, downgraded by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:** `FE-HIGH-005` by `frontend-expert` in cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/i18n/I18nProvider.tsx:34-39 \- detectLocale() returns 'tr' for every
  non-English browser language; 'tr' is the platform default
- web/apps/aquamobil/src/i18n/locales/en.ts:4-5 \- 'Scope: the surfaces rewritten by the meal
  cutover (feeding) \+ shared bits. Remaining legacy hardcoded strings are tracked' \- 47 keys total
- web/apps/aquamobil/src/pages/feeding/RecordFeedingPage.tsx \- the ONLY page importing useI18n
  (repo-wide grep: 3 hits, two of which are the i18n module itself)
- web/apps/aquamobil/src/pages/LoginPage.tsx:157-158 \- 'Welcome back' / 'Sign in to continue'
  hardcoded; src/pages/HomePage.tsx:370-371 \- 'No tanks found' / 'You are offline \- showing cached
  data'
- web/apps/aquamobil/index.html:2 \- `<html` `lang="en">` never updated from the active locale (WCAG
  3\.1.1)

**Rule violated:**

Agent i18n invariant: user-visible strings must route through the typed i18n layer (hardcoded =
HIGH); WCAG 3.1.1 Language of Page

**Proposed fix direction:**

The typed t(key: MessageKey) already makes a NEW hardcoded string impossible on a migrated surface
\- the gap is coverage, not design. Land a ratcheting invariant spec (the repo idiom, cf.
field-ergonomics.invariant.spec.ts) that freezes the count of literal user-visible JSX text nodes
per page directory and only lets it shrink, then migrate page-by-page. Separately drive
document.documentElement.lang from the I18nProvider locale so page language is never a build-time
constant.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/i18n/locales/en.ts`
- `web/apps/aquamobil/src/i18n/locales/tr.ts`
- `web/apps/aquamobil/src/pages/`
- `web/apps/aquamobil/src/components/`
- `web/apps/aquamobil/index.html`

**Expected closer:**

frontend-expert WRITER mode (multi-phase); shared-ui i18n owner reviews key-namespace parity

**Verifier note:**

Every cited fact checks out: I18nProvider.tsx:33-38 detectLocale() returns 'tr' unless
navigator.language starts with 'en' and falls back to MESSAGES.tr; en.ts:4-5 states the scope is the
meal-cutover surfaces with remaining legacy strings tracked; RecordFeedingPage.tsx:32,190 is the
only non-i18n-module consumer of useI18n (main.tsx:106 mounts the provider); LoginPage.tsx:157-158
and HomePage.tsx:370-371 are hardcoded English; index.html:2 is `<html` `lang="en">` with no runtime
update. Page count is 40 `*Page.tsx` files, so '1 of ~40' is accurate. Severity is inflated to HIGH:
this is an explicitly documented, phased rollout (P-28 Faz 6 scope note, retrofit tracked), with no
functional break, no data loss and no security impact — the concrete defect is an untranslated UI
for the default locale plus a WCAG 3.1.1 lang mismatch. MEDIUM.

### FE-MEDIUM-069

**Title:** Two conflicting web-app manifests emitted to the same dist path; the public one's icon
URLs are unroutable

**Severity:** MEDIUM
**Layer:** 2
**State:** OPEN
**Raised as:**

```text
FE-MEDIUM-006` by `frontend-expert` in cycle `2026-08-16-farm-mobile-agent-audit
```

**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/vite.config.ts:26-54 \- VitePWA manifest: theme_color '#0073e6', PNG icons at
  /mobile/icons/icon-192x192.png, no shortcuts
- web/apps/aquamobil/public/manifest.webmanifest:9,15,21 \- theme_color '#0ea5e9', SVG icons at
  /icons/icon-192x192.svg (root-absolute, NO /mobile/ prefix)
- web/apps/aquamobil/public/manifest.webmanifest:28-43 \- the 'Record Mortality' / 'Record Harvest'
  app shortcuts exist ONLY in this copy and vanish entirely if the generated manifest wins
- infrastructure/nginx/droplet.conf:487-490 \- location /mobile/ { rewrite `^/mobile/(.*`) /$1
  break; } \- a bare /icons/... request falls through to location / (the shell), so the public
  manifest's icons 404
- web/apps/aquamobil/public/icons/placeholder.txt:1-17 \- the icon set is still documented as
  placeholder, listing 8 required sizes of which 2 exist

**Rule violated:**

CLAUDE.md \- single source of truth per artifact; agent invariant: PWA install metadata must be
deterministic

**Proposed fix direction:**

Delete one source. Keep the VitePWA-generated manifest (it is base-aware), move the shortcuts array
into vite.config.ts, then remove public/manifest.webmanifest and the hardcoded `<link`
`rel="manifest">` from index.html so exactly one link and one file are emitted. Generate the missing
icon sizes and drop placeholder.txt. Extend the existing sw-build-artifact invariant to assert
dist/manifest.webmanifest carries the /mobile/-prefixed icon URLs and the shortcut entries.

**Affected surface (ripple set):**

- `web/apps/aquamobil/vite.config.ts`
- `web/apps/aquamobil/public/manifest.webmanifest`
- `web/apps/aquamobil/index.html`
- `web/apps/aquamobil/public/icons/`
- `web/apps/aquamobil/src/pwa/**tests**/sw-build-artifact.invariant.spec.ts`

**Expected closer:**

frontend-expert WRITER mode

**Verifier note:**

Confirmed, and I resolved the ambiguity the claim left open. vite.config.ts:26-53 declares
theme_color '#0073e6' with PNG icons at /mobile/icons/icon-{192x192,512x512}.png and no shortcuts;
public/manifest.webmanifest:9,15,21 declares theme_color '#0ea5e9' with SVG icons at
/icons/icon-192x192.svg (root-absolute, no /mobile/ prefix) and is the only place the 'Record
Mortality' / 'Record Harvest' shortcuts (lines 28-43) exist.
infrastructure/nginx/droplet.conf:486-490 is
and
the catch-all `location /` (501+) proxies to the shell with `error_page 404 = /index.html`, so a
bare /icons/... request returns the shell's HTML, not an icon. public/icons/placeholder.txt still
documents 8 required sizes; only icon-192x192.png and icon-512x512.png exist. On the collision I
went further than the claim: vite 7.3.5 copies publicDir in prepareOutDir
(node_modules/vite/dist/node/chunks/config.js:33410-33412, a renderStart-phase hook) BEFORE the
bundle is written, and vite-plugin-pwa emits manifest.webmanifest unconditionally in generateBundle
(node_modules/vite-plugin-pwa/dist/index.js:240-251). So the outcome is deterministic, not a race:
the generated manifest always overwrites the public one, the two app shortcuts silently never ship,
and public/manifest.webmanifest stays a maintained file with zero effect on the artifact. That is
squarely 'a developer would eventually hit this' \- MEDIUM stands. The 'unroutable icon URLs' half
is latent rather than live (that copy is overwritten before any browser sees it), which is why this
is not higher.

```text
location /mobile/ { rewrite ^/mobile/(.*) /$1 break; proxy_pass http://$backend_mobile:80; }
```

### FE-MEDIUM-070

**Title:** Self-contradictory service-worker update strategy: unconditional top-level skipWaiting
makes the confirm() update prompt unreachable

**Severity:** MEDIUM
**Layer:** 1
**State:** OPEN
**Raised as:**

```text
FE-MEDIUM-007` by `frontend-expert` in cycle `2026-08-16-farm-mobile-agent-audit
```

**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/vite.config.ts:20-22 \- '// PERF-10: autoUpdate ensures field workers always
  run the latest version without needing to manually dismiss an update prompt' \+ registerType:
  'autoUpdate'
- web/apps/aquamobil/src/main.tsx:57-66 \- registerSW({ onNeedRefresh() { if (confirm('New version
  available. Reload to update?')) { void updateSW(true); } } }) \- a prompt-mode handler under an
  autoUpdate registration
- web/apps/aquamobil/src/pwa/messaging-sw.ts:53-54 \- `void self.skipWaiting(); clientsClaim();` at
  module top level, so the new worker never enters the waiting state any prompt would key off
- web/apps/aquamobil/src/pwa/messaging-sw.ts:67 \- cleanupOutdatedCaches() runs on the newly
  activated worker while the previous page is still live

**Rule violated:**

CLAUDE.md Architectural Approach \- one mechanism per behaviour, no dead compat paths; agent
invariant: SW update/skipWaiting strategy must be a single controlled handshake

**Proposed fix direction:**

Choose one contract and delete the other. Either keep silent autoUpdate (drop onNeedRefresh/confirm
from main.tsx entirely and rely on the register module's controlled reload), or adopt a real prompt
handshake (remove the top-level self.skipWaiting(), switch registerType to 'prompt', have the SW
call skipWaiting only on an explicit SKIP_WAITING client message and reload on controllerchange).
Extend sw-build-artifact.invariant.spec.ts to assert the chosen contract is present in the emitted
artifact.

**Affected surface (ripple set):**

- `web/apps/aquamobil/vite.config.ts`
- `web/apps/aquamobil/src/main.tsx`
- `web/apps/aquamobil/src/pwa/messaging-sw.ts`
- `web/apps/aquamobil/src/pwa/**tests**/sw-build-artifact.invariant.spec.ts`

**Expected closer:**

frontend-expert WRITER mode

**Verifier note:**

Confirmed, and the mechanism is more absolute than the claim argues. Cited lines are exact:
vite.config.ts:20-22 carries the PERF-10 comment and registerType: 'autoUpdate'; main.tsx:57-66
passes onNeedRefresh() { if (confirm('New version available. Reload to update?')) { void
updateSW(true); } }; messaging-sw.ts:53-54 is `void self.skipWaiting(); clientsClaim();` at module
top level; messaging-sw.ts:67 is cleanupOutdatedCaches(). The decisive evidence is the register
client the claim did not open \- node_modules/vite-plugin-pwa/dist/client/build/register.js: when
`auto === true` (registerType 'autoUpdate') registerSW wires only the 'activated' and 'installed'
Workbox listeners; onNeedRefresh is referenced ONLY in the `else` (prompt) branch and is therefore
never registered at all. The confirm() prompt is dead regardless of skipWaiting. The escape hatch is
dead too: updateServiceWorker() is `await registerPromise; if (!auto) sendSkipWaitingMessage()`, so
`void updateSW(true)` is a no-op under autoUpdate. Impact the claim understates: because
onNeedReload is also not supplied, the auto branch calls window.location.reload() on any update
activation, so a deploy silently reloads the page out from under a field worker mid-form. Real
behavioural defect, not merely dead code, but it fires only on deploy activation and the app has an
offline queue \- MEDIUM, not HIGH.

### FE-MEDIUM-071

**Title:** WCAG 2.1 AA: primary data-entry fields have no programmatic label and no visible focus
indicator

**Severity:** MEDIUM
**Layer:** 2
**State:** OPEN
**Raised as:**

```text
FE-MEDIUM-008` by `frontend-expert` in cycle `2026-08-16-farm-mobile-agent-audit
```

**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/pages/storage/StockMovementPage.tsx:582-590 \- the step-3 quantity `<input`
  `type="number">` has only placeholder="0"; no `<label>`, no aria-label, no aria-labelledby (1.3.1
  / 3.3.2 / 4.1.2)
- web/apps/aquamobil/src/pages/storage/StockMovementPage.tsx:661-671 and 676-684 \- `<label>Lot` /
  Batch `Number</label>` followed by a SIBLING `<input>` with no htmlFor/id pairing
- web/apps/aquamobil/src/styles/main.css:168-172 \- global
  \- the replacement halo is 10% alpha (~1.1:1), far under the 3:1 required by 1.4.11

  ```text
  input:focus, textarea:focus, select:focus { outline: none; border-color:#0073e6 !important; box-shadow: 0 0 0 3px rgba(0,115,230,0.1) !important; }
  ```

- web/apps/aquamobil/src/pages/feeding/RecordFeedingPage.tsx:496 \-
  `border-none focus:outline-none focus:ring-0` \- with no border there is nothing for the global
  border-color rule to tint, so the meal-amount input has zero focus indicator (2.4.7)
- repo-wide grep: 39 native `<input>/<select>/<textarea>` occurrences vs 4 htmlFor bindings across 3
  files

**Rule violated:**

WCAG 2.1 AA \- 1.3.1, 2.4.7, 1.4.11, 3.3.2, 4.1.2 (agent accessibility invariant set)

**Proposed fix direction:**

Make the unlabeled control unrepresentable: introduce a single LabeledField primitive that owns the
generated id, the `<label` `htmlFor>`, the aria-describedby error wiring and the focus-ring class,
and route every native control through it (_shared/RecordEntityPage and NotesInput are the existing
precedent). Replace the global outline:none in main.css with a :focus-visible token carrying `>=3:1`
contrast in both themes. Add eslint-plugin-jsx-a11y label-has-associated-control /
control-has-associated-label to the aquamobil lint config once the primitive lands.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/styles/main.css`
- `web/apps/aquamobil/src/pages/storage/`
- `web/apps/aquamobil/src/pages/feeding/RecordFeedingPage.tsx`
- `web/apps/aquamobil/src/pages/messaging/AiChatPage.tsx`
- `web/apps/aquamobil/src/components/`
- `web/apps/aquamobil/tailwind.config.js`

**Expected closer:**

frontend-expert WRITER mode

**Verifier note:**

Confirmed at the cited lines. StockMovementPage.tsx:582-590 \- the step-3 quantity `<input`
`type="number">` carries only ref/type/inputMode/placeholder="0"/value/onChange/className: no id, no
aria-label, no aria-labelledby, and the 'Enter quantity' `<h2>` at line 577 is not programmatically
associated, so the accessible name falls back to the placeholder '0'. StockMovementPage.tsx:661 and
:676 are `<label` className="block `...">` with no htmlFor, followed by sibling `<input>` at 664-670
and 679-683 with no id. main.css:168-172 is the global
exactly as quoted. RecordFeedingPage.tsx:496 is `border-none focus:outline-none focus:ring-0` on the
meal-amount input (485-496), which also has no id/aria-label; the !important box-shadow overrides
Tailwind's focus:ring-0, leaving only the ~10%-alpha halo since border-none means the border-color
rule paints nothing. Grep counts hold: 39 `<input>/<select>/<textarea>` tags vs 4 htmlFor across 3
files (LoginPage:190,210; NewChatPage:374; RecordFeedingPage:520) \- though 12 of the 39 are in spec
files. Two corrections that do not overturn the finding: (1) the main.css bullet is half-stated \-
the same rule's `border-color:#0073e6 !important` yields ~4.6:1 against white and ~3.9:1 against
dark-mode gray-900, which does satisfy 1.4.11 for bordered inputs, so the focus-indicator failure is
scoped to border-none/transparent-border controls like RecordFeedingPage:496, as the claim's own
last bullet concedes. (2) The proposed fix's lint suggestion is partly already in place \-
jsx-a11y/label-has-associated-control is live at ERROR for this tree (verified with
`eslint --print-config`; aquamobil is not in PROJECT_LINT_OVERRIDES so the '**/*.tsx' recommended
block applies). It misses StockMovementPage:661/676 because those labels contain a dynamic
`{needsLot && <span>*</span>}` expression, which makes the rule's mayContainChildComponent check
bail out; a probe file with static label text errors immediately. The gate exists and is being
evaded, which strengthens the finding. Missing programmatic labels on the primary stock-movement and
feeding data-entry path is a genuine WCAG 2.1 level-A failure \- MEDIUM.

```text
input:focus, textarea:focus, select:focus { outline: none; border-color:#0073e6 !important; box-shadow: 0 0 0 3px rgba(0,115,230,0.1) !important; }
```

### FE-MEDIUM-072

**Title:** No route-change focus management or route announcement; Suspense fallback is silent \-
shared-ui already ships the primitives aquamobil cannot import

**Severity:** MEDIUM
**Layer:** 2
**State:** OPEN
**Raised as:**

```text
FE-MEDIUM-009` by `frontend-expert` in cycle `2026-08-16-farm-mobile-agent-audit
```

**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/App.tsx:149-155 \- PageLoader is a bare spinner div: no role="status", no
  aria-live="polite", no text (WCAG 4.1.3)
- web/apps/aquamobil/src/App.tsx:203-235 \- App() calls useSwNavigation() and renders `<Routes>`,
  but nothing moves focus or announces the new route on navigation (WCAG 2.4.3)
- web/apps/aquamobil/src/layouts/MobileLayout.tsx:39-61 \- the single shell for every authenticated
  page declares no `<main>` landmark and no focus target; repo-wide only 4 files use `<main` (the
  operations hubs)
- web/shared-ui/src/components/index.ts:151-153 \- export { VisuallyHidden, FocusTrap,
  RouteAnnouncer } from './a11y' \- the exact primitives exist but aquamobil deliberately cannot
  import shared-ui

**Rule violated:**

WCAG 2.1 AA \- 2.4.3, 4.1.3; agent invariant: React Router v6 does not manage focus, the app must

**Proposed fix direction:**

Add a `<main` id="main" `tabIndex={-1}>` landmark inside MobileLayout plus a route-announcer live
region driven by useLocation, moving focus to the landmark on pathname change; give PageLoader
role="status" aria-live="polite" with a translated loading string (common.loading already exists in
both locales). Since aquamobil is standalone by design, mirror shared-ui's a11y primitives as a
local module and add a spec asserting the two API surfaces match \- the same mirror-with-a-gate
discipline the tenant-query-keys copy should have had.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/layouts/MobileLayout.tsx`
- `web/apps/aquamobil/src/App.tsx`
- `web/apps/aquamobil/src/i18n/locales/en.ts`
- `web/shared-ui/src/components/a11y/`

**Expected closer:**

frontend-expert WRITER mode

**Verifier note:**

Every cited line checks out. web/apps/aquamobil/src/App.tsx:149-155 PageLoader is exactly
— no role="status", no aria-live, no text. App() at App.tsx:203+ calls useSwNavigation() then
renders `<Routes>` with no location-driven focus or announcement (a repo-wide grep for
RouteAnnouncer/tabIndex={-1}/skip-link in web/apps/aquamobil returns nothing).
web/apps/aquamobil/src/layouts/MobileLayout.tsx:159 renders
`<div className="flex-1 overflow-auto">{children}</div>` — no `<main>` and no focus target; the only
`<main>` tags in the app are the 4 operations hub pages (DailyOpsHubPage:197, OperationsHubPage:182,
StaffHubPage:139, StockEventsHubPage:232), so most routes have no landmark at all.
web/shared-ui/src/components/index.ts:151-153 does export { VisuallyHidden, FocusTrap,
RouteAnnouncer } from './a11y' and the directory exists. The one nuance: tsconfig.json:21 declares a
@aquaculture/shared-ui path mapping, so 'cannot import' is not literally true at type level — but
vite.config.ts:83-94 aliases only farm-shared and shared-contracts, so a runtime import would not
resolve in the standalone Docker build, and no src file imports it. That nuance does not change the
defect. Real WCAG 2.4.3/4.1.3 gap on the single shell for every authenticated page; MEDIUM as filed.

```text
<div className="flex items-center justify-center min-h-[50vh]"><div className="animate-spin …"/></div>
```

### FE-MEDIUM-073

**Title:** Dates, times and numbers formatted with hardcoded en-US / en-GB locales and no explicit
timeZone

**Severity:** MEDIUM
**Layer:** 2
**State:** OPEN
**Raised as:**

```text
FE-MEDIUM-010` by `frontend-expert` in cycle `2026-08-16-farm-mobile-agent-audit
```

**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx:289,379 \- toLocaleDateString('en-US', ...)
  / toLocaleString('en-US') on task due dates and note timestamps
- web/apps/aquamobil/src/pages/schedule/MySchedulePage.tsx:53,95 \- toLocaleDateString('en-GB', ...)
  on shift dates
- web/apps/aquamobil/src/pages/attendance/AttendancePage.tsx:26,298 \- toLocaleTimeString([]) /
  toLocaleDateString([]) on clock-in records with no timeZone argument, so an ISO date renders in
  the device's zone
- web/apps/aquamobil/src/utils/messaging-helpers.ts:53,68,94 and
  src/components/DataFreshness.tsx:36,59 \- 'en-US' hardcoded in the shared helpers themselves
- web/shared-ui/src/utils/index.ts:81-112 \-
  formatNumber/formatCurrency/formatDate/formatRelativeTime already exist as an Intl-based SSoT and
  are unreachable from this app

**Rule violated:**

Agent i18n/l10n invariant: dates/times via Intl.DateTimeFormat with explicit timeZone;
numbers/currencies via Intl.NumberFormat with explicit locale

**Proposed fix direction:**

Introduce one local format.ts that reads the active locale from the I18nProvider and the tenant/site
timezone from context, exposing formatDate/formatTime/formatNumber built on cached Intl formatters
\- then ban raw `toLocale*` in aquamobil via an ESLint no-restricted-syntax rule so a new call site
cannot regress. Attendance/schedule/harvest surfaces must pass an explicit timeZone so an operator
west of UTC never reads a shifted record date.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/utils/messaging-helpers.ts`
- `web/apps/aquamobil/src/components/DataFreshness.tsx`
- `web/apps/aquamobil/src/pages/tasks/`
- `web/apps/aquamobil/src/pages/schedule/`
- `web/apps/aquamobil/src/pages/attendance/`
- `web/apps/aquamobil/src/i18n/`
- `eslint.config.mjs`

**Expected closer:**

frontend-expert WRITER mode; hr-expert reviews the attendance/schedule date semantics

**Verifier note:**

All cited call sites verified verbatim: TaskDetailPage.tsx:289 toLocaleDateString('en-US',
{day,month,year}) and :379 toLocaleString('en-US'); MySchedulePage.tsx:53 and :95
toLocaleDateString('en-GB', …); AttendancePage.tsx:26 toLocaleTimeString([], {hour,minute}) and :298
toLocaleDateString([], {weekday,month,day}) with no timeZone; messaging-helpers.ts:53/68/94 hardcode
'en-US' inside the shared helpers; DataFreshness.tsx:36 and :59 hardcode 'en-US'.
web/shared-ui/src/utils/index.ts exports the Intl-based `formatNumber/formatCurrency/format*` SSoT,
which aquamobil cannot reach (no vite alias). The impact is stronger than a style nit:
src/i18n/I18nProvider.tsx:35-52 defaults the app locale to 'tr' (detectLocale returns 'tr' as
fallback and MESSAGES fallback is tr), so Turkish-default users read English month names next to
Turkish UI strings, and the timeZone-less date rendering on attendance/schedule records can shift a
record's day for an operator west of UTC. MEDIUM is correct — real, user-visible, and it regresses
on every new call site absent a lint gate.

### FE-MEDIUM-074

**Title:** AquaMobil CSP omits base-uri/form-action/report-to, and the app's own index.html violates
its script-src with an inline script the config claims does not exist

**Severity:** MEDIUM
**Layer:** 2
**State:** OPEN
**Raised as:**

```text
FE-MEDIUM-011` by `frontend-expert` in cycle `2026-08-16-farm-mobile-agent-audit
```

**Verification:** NOT VERIFIED — no verifier returned a verdict for this id

**Evidence:**

- infrastructure/docker/nginx/snippets/security-headers.conf:11 \- 'D14-SC-02: unsafe-inline removed
  from script-src; Vite production builds emit no inline scripts' \- false for this app
- web/apps/aquamobil/index.html:8-15 \- a hand-authored inline `<script>` (dark-mode flash
  prevention) that Vite copies verbatim into dist/index.html and script-src 'self' blocks
- infrastructure/docker/nginx/snippets/security-headers.conf:22 \- the policy has no base-uri, no
  form-action, no report-uri/report-to (none of which fall back to default-src)
- infrastructure/nginx/droplet.conf:389 \- location = /api/csp-report exists at the edge, so a
  collector is available but nothing in the AquaMobil policy points at it
- web/apps/aquamobil/src/hooks/useDarkMode.ts:152 \- applyTheme(_snapshot.isDark) at module scope is
  the backstop that keeps the blocked script from being a functional break, limiting impact to a
  theme flash

**Rule violated:**

Agent CSP invariant: base-uri/object-src/frame-ancestors mandatory, violations must stream to an
active aggregator; CLAUDE.md 'report faithfully' \- a config comment asserting an untrue premise

**Proposed fix direction:**

Delete the inline script from index.html (useDarkMode already applies the theme at module init) and
correct the snippet comment to state what is actually true. Add base-uri 'none'; form-action 'self';
frame-ancestors 'none'; report-to csp-endpoint to the AquaMobil policy and wire report-to at the
already-existing /api/csp-report collector so the next violation is observable rather than
invisible.

**Affected surface (ripple set):**

- `infrastructure/docker/nginx/snippets/security-headers.conf`
- `web/apps/aquamobil/index.html`
- `web/apps/aquamobil/src/hooks/useDarkMode.ts`
- `infrastructure/nginx/droplet.conf`

**Expected closer:**

frontend-expert WRITER mode with security-reviewer sign-off on the final policy string

### LOW

### FE-LOW-075

**Title:** Dead exports, an unproduced message type, and three stale doc claims across the PWA
surface

**Severity:** LOW
**Layer:** 1
**State:** OPEN
**Raised as:** `FE-LOW-012` by `frontend-expert` in cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** NOT VERIFIED — no verifier returned a verdict for this id

**Evidence:**

- web/apps/aquamobil/src/pwa/offline-queue.ts:43-44 \- `export const QUEUE_WARNING_THRESHOLD = 180;`
  documented as 'the threshold at which the UI should warn the user' \- repo-wide grep finds zero
  consumers, so no near-full warning exists and the user meets a hard throw at 200 (line 287)
- web/apps/aquamobil/src/hooks/useSwNavigation.ts:19-23,66,78-87 \- handles NAVIGATE_TO_CHANNEL and
  its JSDoc says messaging-sw.ts posts it, but messaging-sw.ts:219-222 posts
  NAVIGATE_TO_NOTIFICATION_REF; no worker in the repo ever posts NAVIGATE_TO_CHANNEL
- web/apps/aquamobil/src/utils/tenant-query-keys.ts:5,7 \- 'Mirrors
  web/shared-ui/src/utils/tenant-query-keys.ts verbatim' and 'aquamobil is a standalone React Native
  bundle' \- both false; web/shared-ui/src/utils/tenant-query-keys.ts:106,132-137 appends
  sessionEpochSegment() and exports createTenantInvalidationKey, neither of which the mirror has
- web/apps/aquamobil/index.html:17 \- `<link` rel="icon" type="image/svg+xml"
  href="/icons/icon-192x192.png" `/>` declares an SVG MIME for a PNG

**Rule violated:**

CLAUDE.md Code Quality Standards \+ Working Style ('report faithfully'); dead exports and false doc
claims are exactly the drift the nested CLAUDE.md already warns about

**Proposed fix direction:**

Either consume QUEUE_WARNING_THRESHOLD in the offline banner / record-submit path or delete it \- an
exported constant documenting UI that does not exist is worse than no constant. Delete the
NAVIGATE_TO_CHANNEL branch and its JSDoc or make the SW actually post it. Correct the
tenant-query-keys header to state the real delta and, if the epoch segment is wanted here, port
sessionEpochSegment \+ createTenantInvalidationKey; otherwise add a diff-based spec asserting the
intended delta so the copies cannot drift further unnoticed. Fix the favicon MIME.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/pwa/offline-queue.ts`
- `web/apps/aquamobil/src/hooks/useSwNavigation.ts`
- `web/apps/aquamobil/src/utils/tenant-query-keys.ts`
- `web/apps/aquamobil/index.html`
- `web/apps/aquamobil/CLAUDE.md`

**Expected closer:**

frontend-expert WRITER mode

## Inventory — what exists / what is missing

| Status          | Area                                                       | Note                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MISSING**     | Offline queue near-full warning UI                         | QUEUE_WARNING_THRESHOLD (180) is exported and documented as driving a warning, but has zero consumers; the user's first signal is a hard throw at 200. See FE-LOW-012.                                                                                                                                                                                                                                                                |
| **MISSING**     | Proactive / visibility-driven token refresh                | Refresh is purely reactive on a 401. No 80%-TTL timer and no visibilitychange/focus re-check, so a backgrounded tab resuming after throttling takes a 401 round-trip on its first request. shared-ui ships installVisibilityTokenRefresh; aquamobil cannot import it.                                                                                                                                                                 |
| **MISSING**     | Session-epoch cache generation (shared-ui parity)          | shared-ui appends sessionEpochSegment() and exports createTenantInvalidationKey; the aquamobil mirror has neither while its header claims verbatim parity. Low practical risk (no tenant switcher here), but the false claim is the drift hazard.                                                                                                                                                                                     |
| **MISSING**     | l10n formatting (Intl)                                     | No locale/timezone-aware formatting layer; ~20 call sites hardcode 'en-US'/'en-GB' or pass no locale at all, and none pass an explicit timeZone. See FE-MEDIUM-010.                                                                                                                                                                                                                                                                   |
| **MISSING**     | shared-ui reuse                                            | By design aquamobil imports nothing from @aquaculture/shared-ui (standalone lockfile \+ Docker context). Consequence: tenant-query-keys, I18nProvider, the API client / token lifecycle, logout-cleanup, url-allowlist, sanitize-html, the Intl format helpers and the a11y primitives (VisuallyHidden/FocusTrap/RouteAnnouncer) are each either re-implemented locally or absent, and only one copy (i18n) carries any parity guard. |
| **PARTIAL**     | Generated vs hand-written type drift                       | Enum vocabularies (Role, MessageContentType, ReceiptStatus, ChannelMemberRole, NotificationPreference) are re-exported from generated rather than hand-maintained, and the one deliberate divergence (lowercase internal ChannelType with a documented wire codec) is explained. Entity view types (Channel, Message, MessageAttachment) remain hand-written and are not derived from operation result types.                         |
| **PARTIAL**     | GraphQL codegen / TypedDocumentNode                        | A real committed generated client exists with TypedDocumentNode constants and a two-overload graphqlRequest that makes the inference path fully typed. But the codegen document glob covers only src/graphql/**, leaving the 27 offline-replay mutations plus auth/webauthn/tenant-user documents unvalidated. See FE-HIGH-003.                                                                                                       |
| **PARTIAL**     | Logout teardown                                            | Strong on the ordered parts \- push teardown first, cancelQueries before the awaited persistent wipe, biometric \+ unscoped-localStorage clearing, AES key erase, barrier re-arm, and a failed wipe rejecting rather than presenting as a clean logout. Two gaps: the Cache-Storage purge names a cache that does not exist (FE-HIGH-004) and the queue is destroyed without warning (FE-HIGH-001).                                   |
| **PARTIAL**     | Offline binary/media lane (upload-and-send)                | Blobs are persisted AES-GCM-encrypted under tenant-partitioned keys with a 25MB cap and the 3-call presign-PUT-send replay works in the foreground. The SW closed-app lane explicitly skips blob ops (SW_REPLAY_SKIP_TYPES), so media queued while the app is closed waits for the next foreground.                                                                                                                                   |
| **PARTIAL**     | SW update / skipWaiting strategy                           | skipWaiting \+ clientsClaim \+ cleanupOutdatedCaches are present, but registerType 'autoUpdate' and a confirm()-based onNeedRefresh prompt coexist and the top-level skipWaiting makes any waiting-state prompt unreachable. See FE-MEDIUM-007.                                                                                                                                                                                       |
| **PARTIAL**     | Web app manifest \+ icon set                               | Two manifests with divergent theme_color, icon formats and shortcut sets are emitted to the same dist path; the public copy's icon URLs omit the /mobile/ base and are unroutable at the edge, and placeholder.txt still lists 6 of 8 required icon sizes as outstanding. See FE-MEDIUM-006.                                                                                                                                          |
| **PARTIAL**     | i18n (typed message keys, en/tr)                           | The mechanism is Tier-1 correct \- t() accepts only MessageKey and `Record<MessageKey`, `string>` forces tr/en key parity at compile time, so both locales are fully filled for the 47 keys that exist. Coverage is the problem: one page consumes it. See FE-HIGH-005.                                                                                                                                                               |
| **IMPLEMENTED** | Background Sync \- closed-app queue replay                 | A real drain lane, not a notify-only stub: zero-clients gate, shared 'aquamobil-queue-drain' Web Lock, httpOnly-cookie token mint, then /graphql re-POST through the shared operation registry. Asserted in the build artifact.                                                                                                                                                                                                       |
| **IMPLEMENTED** | Code hygiene (CLAUDE.md bans)                              | Zero raw `console.*` in source \- a single computed-member logger facade is the only console touch-point, DEV-gated for debug/info. No @ts-ignore or @ts-expect-error anywhere. Only two hand-written `as unknown as` casts remain (offline-queue.ts:127 envelope spread, useMessageSocket.ts:194 dynamic-import narrowing); the rest is codegen output.                                                                              |
| **IMPLEMENTED** | Dead-letter surfacing (permanently failed ops)             | SyncStatusPage renders per-op status, retryCount/MAX_RETRY_COUNT, the truncated lastError, a 'Permanently failed \- please remove' state and manual removal.                                                                                                                                                                                                                                                                          |
| **IMPLEMENTED** | Error boundaries                                           | Three composed tiers: root boundary inside QueryClientProvider but outside Router/Auth, a route-level boundary wrapping the lazy Suspense subtree, and per-hub boundaries. Fallback carries role=alert aria-live=assertive and logs through the structured logger.                                                                                                                                                                    |
| **IMPLEMENTED** | Field-ergonomics \+ build-artifact invariant gates         | Two genuine Tier-3 gates exist and are the right idiom: a ratcheting field-ergonomics spec (44px touch token, banned sub-12px text with a freeze-and-shrink baseline) and a spec that runs a real production build and asserts the emitted SW retains every handler. These are the model the i18n and a11y gaps should copy.                                                                                                          |
| **IMPLEMENTED** | Install prompt (A2HS)                                      | beforeinstallprompt capture for Android/Chrome plus iOS manual share-sheet instructions, 24h dismissal memory, standalone-mode suppression. The dismiss X button has no accessible name.                                                                                                                                                                                                                                              |
| **IMPLEMENTED** | Offline mutation queue (crypto \+ isolation \+ resilience) | AES-GCM with a fresh 12-byte IV per encrypt, non-extractable CryptoKey, tenant-partitioned IDB keys (pending_${tenantId}_${id}), 200-item cap, SHA-256 content-fingerprint dedup in a 5s window, exponential backoff with jitter, retryable-vs-permanent error classification, monotonic per-tenant re-arm version.                                                                                                                   |
| **IMPLEMENTED** | Precache \+ cold-offline app-shell fallback                | globPatterns include html, index.html is precached, and a PrecacheFallbackPlugin on the NetworkFirst navigation route (networkTimeoutSeconds: 5) serves the shell when both network and runtime cache miss. Asserted by the build invariant.                                                                                                                                                                                          |
| **IMPLEMENTED** | Push notifications (FCM)                                   | Dedicated firebase-messaging-sw.js at a disjoint sub-scope, pinned SDK version, IndexedDB-durable active-user gate that drops pushes for a non-active user on shared devices, notification-URL origin allowlist, UUID-validated opaque notificationRef deep links, Badge API, severity-escalated alert presentation.                                                                                                                  |
| **IMPLEMENTED** | Route-level code splitting / bundle discipline             | ~40 React.lazy route components, manualChunks splitting react/react-dom/react-router and @tanstack/react-query, sourcemaps off in production, and the two heaviest deps (firebase, socket.io-client) behind dynamic import().                                                                                                                                                                                                         |
| **IMPLEMENTED** | Service worker (deployed artifact)                         | vite-plugin-pwa injectManifest makes the hand-written src/pwa/messaging-sw.ts the real dist/messaging-sw.js, carrying precache, runtime routes, sync, notificationclick and the LOGOUT purge. A build-artifact invariant runs a real vite build and asserts each handler survives minification.                                                                                                                                       |
| **IMPLEMENTED** | Tenant-scoped query keys                                   | Effectively full adoption \- every queryKey/invalidate/remove site in hooks and pages routes through createTenantQueryKey, including the logout wipe. No bare tenant-scoped arrays found outside test fixtures.                                                                                                                                                                                                                       |
| **IMPLEMENTED** | Token lifecycle (memory-only \+ single-flight refresh)     | Access token lives only in React state plus a module-level store (never localStorage/sessionStorage); refresh rides an httpOnly cookie; a re-armable auth-ready barrier prevents a session-2 request firing on session-1 state; concurrent 401s coalesce onto one refresh promise cleared in .finally, with a single fail-closed logout.                                                                                              |

## Verdict

CONDITIONAL

## References

- Cycle report: `docs/reviews/orchestrator/2026-08-16-farm-mobile-audit-cycle.md`
- Finding format: `.claude/shared/output-format.md`
- Agent definition: `.claude/agents/**/frontend-expert.md`
- Rule SSoT: `CLAUDE.md`
