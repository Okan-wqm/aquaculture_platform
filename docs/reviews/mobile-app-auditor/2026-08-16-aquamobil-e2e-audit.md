# AquaMobil PWA end-to-end flow audit — 2026-08-16

**Agent:** `mobile-app-auditor` · **Mode:** CATCHER (read-only) · **Lane:** mobile
**Cycle:** `2026-08-16-farm-mobile-agent-audit` · **Verdict:** BLOCK
**Findings surviving verification:** 9 (CRITICAL 1 · HIGH 2 · MEDIUM 4 · LOW 2) · 1 refuted

> Produced by a 27-agent audit workflow, then verified by a second 25-agent pass.
> **Every** claim — CRITICAL through LOW — was handed to an independent verifier
> instructed to **refute** it by reopening each cited line, with "refuted" as the
> default when the evidence did not clearly hold. Claims that could not be defended
> were dropped into the Refuted section below; claims that proved smaller or larger
> than filed carry a corrected severity.
>
> **Finding IDs** use the `PRODUCT-MOBILE-*` prefix this agent's contract in
> `.claude/shared/output-format.md` assigns it. That prefix is **rejected** by the
> `id` pattern in `docs/reviews/_registry/findings.jsonl.schema.json`, so these findings
> cannot be registered at all — see `PROC-MEDIUM-016` in the cycle report.

## Scope

Read the AquaMobil PWA
end-to-end:
`web/apps/aquamobil/CLAUDE.md`,
, the
whole offline
stack
(`src/pwa/{offline-queue.ts,operation-registry.ts,sw-replay.ts,messaging-sw.ts}`), auth/network/permission
stack
(),
`src/services/authenticated-fetch.ts`,
,
`src/types/index.ts`, and the field-worker pages (`_shared/RecordEntityPage.tsx`, water-quality,
feeding, cull, escape, lice, attendance, storage/StockMovementPage, sync/SyncStatusPage, alerts,
reports, account, HomePage). Cross-checked the backend contracts
in
`apps/farm-service/schema.graphql`,
`apps/farm-service/src/water-quality/dto/create-water-quality.input.ts`,
`apps/farm-service/src/feeding-protocol/dto/meal-execution.inputs.ts`,
,
`apps/hr-service/src/attendance/dto/clock-in-out.input.ts`,
plus .

```text
src/main.tsx`, `src/App.tsx`, `src/layouts/MobileLayout.tsx`, `src/components/{IdentityBoundary,QueuedStatusBadge,PhotoCaptureField,CriticalAlertBanner}.tsx
```

```text
src/hooks/{useAuth.tsx,useOfflineQueue.tsx,useNetworkStatus.ts,useMobilePermissions.ts,useTaskActions.ts,useTanks.ts,useAlerts.ts,useDailyOpsStats.ts,useFarmRealtimeSync.ts,useIncidentMediaUpload.ts,useSendMessage.ts}
```

```text
src/utils/{tenant-query-keys,offline-sync-invalidation,offline-optimistic,network-error,user-scoped-cache-key}.ts
```

```text
apps/farm-service/src/mobile-command/entities/farm-mobile-command-receipt.entity.ts
```

```text
codegen.ts`, `tests/invariants/dead-contract-fe-operations.spec.ts` and `e2e/tests/mobile/**
```

## Executive summary

The offline/tenant machinery is genuinely strong: the queue is AES-GCM encrypted, tenant-keyed,
version-armed, deduped by payload hash, drained under a shared Web Lock by both the foreground and a
real closed-app SW lane, and reconciled by an
exhaustive (`satisfies Record<OperationType,…>`) invalidation map. Tenant/user partitioning of
IndexedDB, React Query keys and the identity remount boundary all hold. The failures are on the
edges where nobody is watching.

One core daily flow is dead: water quality. The client sends a required `parameters: {}` field that
the server's `CreateWaterQualityInput` no longer declares, so GraphQL input coercion rejects every
submission — and offline it still shows a green "Measurement Recorded!". The structural cause is
that codegen only plucks `src/graphql/**`; the 23-mutation offline replay registry and 10
colocated `gql` documents ship with zero schema validation.

Two more truth-boundary defects: any logout — including the automatic one on a failed token refresh
— permanently destroys the unsynced queue and its decryption key with no warning, while the app's
own "Clear Queue" action demands consent for the same wipe; and a critical alarm renders
"Acknowledged" unconditionally from a local queue write.

## Findings (by severity)

### CRITICAL

### PRODUCT-MOBILE-CRITICAL-001

**Title:** Mobile water-quality recording is rejected by the server on every submission; offline it
renders a green false success

**Registry id:** `MOB-CRITICAL-018` — allocated by `npm run findings:add` when this defect was fixed.
The cycle-local `PRODUCT-MOBILE-*` prefix cannot be registered at all (`PROC-MEDIUM-016`), so the
ledger entry carries a registry-legal id and this line is the link between the two. Note that the
cycle report's synthesis block uses the same string `MOB-CRITICAL-018` for the MinIO presign
finding; the ledger is authoritative and means this one.

**Severity:** CRITICAL
**Layer:** 1
**State:** OPEN
**Raised as:** `PRODUCT-MOBILE-CRITICAL-001` by `mobile-app-auditor` in
cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/pages/water-quality/WaterQualityRecordPage.tsx:212 \- `parameters: {},` is
  placed into the mutation input on every submit
- web/apps/aquamobil/src/types/index.ts:571 \- client `CreateWaterQualityInput` still
  declares `parameters: WaterQualityParameters;` as REQUIRED
- apps/farm-service/schema.graphql:9551-9608 \- server `input CreateWaterQualityInput` has
  NO `parameters` field (dynamicParameters is the sole channel)
- apps/farm-service/src/water-quality/dto/create-water-quality.input.ts:9-13 \- "The
  legacy `WaterParametersInput` class and its fixed `parameters` field were removed"
- web/apps/aquamobil/src/pages/water-quality/WaterQualityRecordPage.tsx:258-268 \- success screen
  renders "Measurement Recorded!" with a green check for the queued (unsent) path too

**Rule violated:**

CLAUDE.md "Layer Rules" / ADR-009 frontend data-fetch
\+ `ValidationPipe({ forbidNonWhitelisted: true })`: the client type must be the schema's type, not
a drifted local copy. GraphQL input-object coercion raises on a field not defined by the input type,
so the whole mutation fails before execution.

**Proposed fix direction:**

Delete the phantom `parameters` field at its root: make the mobile client's water-quality input the
CODEGEN-EMITTED `CreateWaterQualityInput` (Tier-1 — a removed server field then becomes a compile
error at the callsite instead of a runtime coercion failure), which requires moving the
water-quality documents into the codegen pluck set (see PRODUCT-MOBILE-HIGH-003). Until the offline
path can prove the server accepted a write, the queued branch must render the
honest `QueuedStatusBadge` two-phase status like `RecordEntityPage` does, never an unconditional
"Recorded!" screen. Add the missing water-quality leg
to `e2e/tests/mobile/record-forms.spec.ts` \+ `offline-sync-roundtrip.spec.ts` so a contract break
fails CI rather than a field shift.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/pages/water-quality/WaterQualityRecordPage.tsx`
- `web/apps/aquamobil/src/types/index.ts`
- `web/apps/aquamobil/src/graphql/operations.ts`
- `codegen.ts`
- `web/apps/aquamobil/src/generated/graphql.ts`
- `e2e/tests/mobile/record-forms.spec.ts`
- `e2e/tests/mobile/offline-sync-roundtrip.spec.ts`

**Expected closer:**

form-write-auditor WRITER mode (contract fix) paired with the S1-CODEGEN owner for the pluck-set
change; data-readback-auditor to confirm the post-write invalidation still lands.

**Verifier note:**

Every cited line checks out and no missed guard exists.
web/apps/aquamobil/src/pages/water-quality/WaterQualityRecordPage.tsx:212 literally
puts `parameters: {},` into the object handed to the mutation, and both branches use that same
object: online `createMeasurement(input)` `->` graphqlRequest,
offline `addToQueue('createWaterQuality', input)`. graphqlRequest
(services/authenticated-fetch.ts:316-323)
does `JSON.stringify({ query: print(document), variables })` with no whitelist/sanitizer — I grepped
offline-queue.ts and authenticated-fetch.ts for sanitize/strip/whitelist: none.
apps/farm-service/schema.graphql input CreateWaterQualityInput (starts line 9551) has
no `parameters` field; the DTO header (create-water-quality.input.ts:1-16) states the
legacy `parameters` field was removed and `dynamicParameters` is the sole channel. GraphQL variable
coercion raises on an undefined input-object field, so the mutation fails before execution on both
the online call and the queued replay (pwa/operation-registry.ts:167-176 replays the stored payload
verbatim). The success screen at 258-268 fires for the queued path too, and this page notably does
NOT use the app's own QueuedStatusBadge two-phase pattern that
AttendancePage/LeaveRequestPage/RecordEntityPage all use. Also corroborating: the client type at
types/index.ts:571 is a hand-written copy, and the codegen output
web/apps/aquamobil/src/generated/graphql.ts contains no CreateWaterQualityInput at all, proving this
document is outside the codegen gate. Core mobile data-capture feature is 100% broken with silent
offline data loss — CRITICAL stands.

### HIGH

### PRODUCT-MOBILE-HIGH-002

**Title:** Logout — including the automatic one on a failed token refresh — permanently destroys the
unsynced offline queue with no warning

**Severity:** HIGH
**Layer:** 2
**State:** OPEN
**Raised as:** `PRODUCT-MOBILE-HIGH-002` by `mobile-app-auditor` in
cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/hooks/useAuth.tsx:194-196 \- `clearAllOperations()` is called with NO
  tenantId, i.e. every tenant's queued writes
- web/apps/aquamobil/src/pwa/offline-queue.ts:529-533 \- the unscoped clear also drops all pending
  blobs, nulls `_sessionKey` and deletes `DURABLE_QUEUE_KEY`, so the wipe is irreversible even from
  raw IndexedDB
- web/apps/aquamobil/src/services/authenticated-fetch.ts:167-172 \- a failed single-flight refresh
  calls `authStore.logout()` automatically, with no user interaction
- web/apps/aquamobil/src/pages/account/AccountPage.tsx:746-747 \- logout dialog says only "Are you
  sure you want to log out?"
- web/apps/aquamobil/src/pages/account/AccountPage.tsx:764 \- the Clear-Queue dialog for the SAME
  destructive operation
  warns

  ```text
  You have ${pendingCount} unsynced operation(s). Clearing will permanently delete them.
  ```

**Rule violated:**

CLAUDE.md Architectural Approach (Tier-1 make-it-impossible) \+ the app's own two-phase honesty
contract (`QueuedStatusBadge`: "Queued — will send when online"). A promise made to the operator
must not be silently revoked by an unrelated lifecycle event.

**Proposed fix direction:**

Separate the two concerns the wipe currently conflates: shared-device confidentiality and durability
of unsynced business records. The queue is already AES-GCM encrypted and tenant+device partitioned
and can only be drained under a matching tenant identity, so an EXPIRED-SESSION teardown must
preserve it and route to a re-authentication screen, while a USER-INITIATED logout must present the
pending count and force an explicit sync-or-discard decision (reuse the Clear-Queue dialog copy).
Make it structural: give the wipe a
required `reason: 'session-expired' | 'user-logout'` discriminant so no callsite can perform a
silent destructive wipe by omission, and add a drain-before-teardown attempt when the network is
reachable.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/hooks/useAuth.tsx`
- `web/apps/aquamobil/src/services/authenticated-fetch.ts`
- `web/apps/aquamobil/src/pwa/offline-queue.ts`
- `web/apps/aquamobil/src/pages/account/AccountPage.tsx`
- `web/apps/aquamobil/src/pages/LoginPage.tsx`
- `web/apps/aquamobil/src/hooks/**tests**/useAuth-logout-wipe.spec.tsx`

**Expected closer:**

mobile-app-auditor WRITER mode, with tenant-isolation-auditor review on the preserved-queue path
(confirm the retained ciphertext cannot be drained under a different tenant identity).

**Verifier note:**

Evidence verified line-for-line.
hooks/useAuth.tsx:427
`logout`
`->`
:471 called
with NO tenantId. pwa/offline-queue.ts:500-533: with no tenantId the prefix is the
bare `QUEUE_PREFIX` (every tenant), clearPendingBlobs(undefined) drops all blobs, and
the `if (!tenantId)` branch nulls `_sessionKey` and deletes `DURABLE_QUEUE_KEY`, so residual
ciphertext is unrecoverable. services/authenticated-fetch.ts:164-171 confirms the single-flight
refresh calls `await authStore.logout()` on a failed/rejected refresh with zero user interaction.
AccountPage.tsx:744-752 logout dialog message is exactly "Are you sure you want to log out?" while
:764 the Clear-Queue dialog for the same destructive effect names the pending count — and
AccountPage already has `pendingCount` in scope (:407), so the omission is not an
information-availability problem. No pending-op guard exists in handleLogout or logout(). The only
mitigating context is that the wipe is a deliberate shared-device security measure
(BUG-03/SEC-02/FE-CRITICAL-002) and that queues normally drain within ~1s online; that argues for
warn-and-drain rather than for the finding being wrong. Unsynced field records destroyed silently,
including by a lifecycle event the operator never triggered — HIGH holds.

```text
await clearAllUserData(currentUserId, currentTenantId)` `->` :194 `clearAllOperations()
```

### PRODUCT-MOBILE-HIGH-004

**Title:** Critical alarm acknowledgement shows "Acknowledged" unconditionally from a local queue
write, with no queued/failed state and no offline-cache reconciliation

**Severity:** HIGH
**Layer:** 2
**State:** OPEN
**Raised as:** `PRODUCT-MOBILE-HIGH-004` by `mobile-app-auditor` in
cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/hooks/useAlerts.ts:100-123 \- `acknowledge` awaits
  only `addToQueue('acknowledgeAlert', …)` then flips the React Query cache
  to `acknowledged: true`; the returned queue op id is discarded, so no consumer can ever read the
  sync status
- web/apps/aquamobil/src/pages/alerts/AlertsPage.tsx:71-76 \- the card renders "Acknowledged · Just
  now" purely from that local flip
- web/apps/aquamobil/src/components/CriticalAlertBanner.tsx:43 \- the persistent life-safety banner
  disappears on the same local flip
- web/apps/aquamobil/src/hooks/useAlerts.ts:73,86 \- a 30s `refetchInterval` overwrites the
  optimistic flip with server truth AND rewrites the encrypted offline cache, so the alarm flaps
  back to unacknowledged mid-shift
- web/apps/aquamobil/src/pwa/offline-queue.ts:930-933,956-963 \- an ack whose error text matches a
  permanent pattern, or that exhausts `MAX_RETRY_COUNT`, is left `failed` in the queue and surfaces
  nowhere except /sync

**Rule violated:**

Domain rule: "Flag any mobile screen that renders success from local cache while the server write
failed or never completed." A life-safety acknowledgement is the one place where operator-visible
truth and server truth must not diverge.

**Proposed fix direction:**

Make the acknowledged state a function of the queue op's real status, not of an assumption: thread
the `AddToQueueResult` id into the alert row so the card renders a distinct "Ack queued" state until
the drain confirms it, and a loud "Ack FAILED — not acknowledged on the server" state when the op
fails or exhausts retries (the CriticalAlertBanner must reappear in that case). Reconcile the
encrypted offline alert cache in the same transaction as the optimistic flip so a cold offline
reopen and the 30s poll agree. Structurally, `getSyncStatus`'s result should be a required input to
any UI that claims a write landed.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/hooks/useAlerts.ts`
- `web/apps/aquamobil/src/pages/alerts/AlertsPage.tsx`
- `web/apps/aquamobil/src/components/CriticalAlertBanner.tsx`
- `web/apps/aquamobil/src/components/QueuedStatusBadge.tsx`
- `web/apps/aquamobil/src/hooks/useOfflineQueue.tsx`
- `e2e/tests/mobile/alerts-ack.spec.ts`

**Expected closer:**

button-action-auditor or alert-engine-expert WRITER mode; mobile-app-auditor CATCHER re-review on
the offline-cache reconciliation.

**Verifier note:**

Verified. hooks/useAlerts.ts:98-121: `acknowledge` awaits
only `addToQueue('acknowledgeAlert', { alertId, note })`, discards the returned op id,
then `queryClient.setQueriesData` flips `acknowledged: true` locally; the hook
returns `Promise<void>`, so no consumer can read sync status. AlertsPage.tsx:71-75 renders the green
"Acknowledged · `<time>`" solely from that flip, and grep shows AlertsPage carries no
isOnline/queued/pending indicator at all. CriticalAlertBanner.tsx:42-45 returns null
once `criticalUnacknowledged` empties, i.e. the life-safety banner clears on the local flip.
useAlerts.ts:72 `refetchInterval: ALERTS_REFETCH_INTERVAL_MS` plus the
queryFn's `cacheData(...)` / `getCachedData(...)` fallback means the server (or stale-cache) value
overwrites the optimistic flip, so a not-yet-drained ack can flap back. offline-queue.ts:952-963
confirms ops at `MAX_RETRY_COUNT` or with non-retryable errors are counted failed and skipped
forever. Decisive context that makes this a real defect rather than a style complaint: the codebase
already has the honest two-phase contract (components/QueuedStatusBadge.tsx, used by AttendancePage,
LeaveRequestPage, TaskDetailPage, RecordEntityPage, RecordTransferPage) and the alert ack — the one
life-safety write — is the surface that skips it. Impact is bounded by the 30s reconciliation when
online, but the offline/flaky-network false-safe state on a critical-alarm banner supports HIGH.

### MEDIUM

### PRODUCT-MOBILE-MEDIUM-003

**Title:** The entire offline-replay GraphQL contract sits outside the codegen/schema gate, so
reconnect-only mutations can drift undetected

**Severity:** MEDIUM (filed as HIGH, downgraded by adversarial verification)
**Layer:** 3
**State:** OPEN
**Raised as:** `PRODUCT-MOBILE-HIGH-003` by `mobile-app-auditor` in
cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- codegen.ts:47 \- `const aquamobilDocuments = ['web/apps/aquamobil/src/graphql/**/*.ts'];` — the
  pluck set excludes pages/, hooks/ and pwa/
- web/apps/aquamobil/src/pwa/operation-registry.ts:31-34 \- the 23 replay mutations are PLAIN
  template strings in a `Record<…, string>`, deliberately import-free for the SW sub-build,
  therefore invisible to codegen
- web/apps/aquamobil/src/pages/water-quality/WaterQualityRecordPage.tsx:71-75 \-
  colocated `gql` `CREATE_WQ_MUTATION` (one of 10 such files outside src/graphql)
- web/apps/aquamobil/src/hooks/useIncidentMediaUpload.ts:24-27 \-
  "the `requestIncidentMediaUpload` document is hand-written and colocated here … so graphql-codegen
  does not pluck it"
- tests/invariants/dead-contract-fe-operations.spec.ts:5-8 \- the only web-wide operation gate
  checks reachability, NOT schema/variable conformance

**Rule violated:**

CLAUDE.md Architectural Approach tiers 1-3 \+ layer-1-react "GraphQL codegen — orphan resolution"
(TypedDocumentNode is the target shape; hand-written query strings are the defect class).
aquamobil/CLAUDE.md claims "The S1 codegen gate covers its GraphQL client" — it covers one
directory.

**Proposed fix direction:**

Extend the codegen document set to every operation the mobile client can put on the
wire (`web/apps/aquamobil/src/**/*.{ts,tsx}`) and
make `operation-registry.ts` hold `TypedDocumentNode` constants printed at build time rather than
free-text strings — the SW sub-build can consume a pre-printed generated module, which removes the
React-free constraint that justified the strings. Add
the so a
schema change that breaks a replay mutation fails the PR instead of silently failing 200 queued
field records at 3am on reconnect. Type `buildOperationVariables`' return against the generated
Variables types so the shaping cannot drift from the document.

```text
npm run codegen && git diff --exit-code` CI gate for `web/apps/aquamobil/src/generated/
```

**Affected surface (ripple set):**

- `codegen.ts`
- `web/apps/aquamobil/src/pwa/operation-registry.ts`
- `web/apps/aquamobil/src/pwa/sw-replay.ts`
- `web/apps/aquamobil/src/hooks/useOfflineQueue.tsx`
- `web/apps/aquamobil/src/generated/graphql.ts`
- `web/apps/aquamobil/src/pages/water-quality/WaterQualityRecordPage.tsx`
- `web/apps/aquamobil/src/pages/storage/StockMovementPage.tsx`
- `web/apps/aquamobil/src/hooks/useTanks.ts`

**Expected closer:**

frontend-expert WRITER mode (codegen pipeline) with mobile-app-auditor CATCHER re-review; needs the
same PR as PRODUCT-MOBILE-CRITICAL-001.

**Verifier note:**

Facts are right, severity is inflated. codegen.ts:47 is
verbatim `const aquamobilDocuments = ['web/apps/aquamobil/src/graphql/**/*.ts'];` and it is the
only `documents` set for the aquamobil output (codegen.ts:79);
infrastructure/apollo-router/codegen-schema.generated.json likewise globs
only `web/apps/*/src/graphql/**/*.ts`. operation-registry.ts:31-34 is indeed
a `Record<..., string>` of plain template strings, import-free by design for the SW sub-build.
useIncidentMediaUpload.ts:23-27 says in-file that codegen does not pluck it.
tests/invariants/dead-contract-fe-operations.spec.ts checks reachability only, and the
aquamobil-local `pwa/**tests**/queued-mutation-ssot.spec.ts` only forbids duplicate documents —
neither validates documents or variables against the schema, and no repo spec builds a schema to
validate aquamobil documents (grep for buildSchema/buildClientSchema across tests/invariants and
aquamobil returns only finding-registry-integrity and messaging-sw). Two counts are slightly off:
the registry holds 27 mutation documents (not 23) and 11 files outside src/graphql carry colocated
gql (not 10). Downgraded to MEDIUM because this is a missing-gate/defect-class finding with no
independent production impact of its own — its concrete instance is CRITICAL-001, which is already
reported separately; counting the gap again at HIGH double-counts the same harm.

### PRODUCT-MOBILE-MEDIUM-005

**Title:** Logout Cache Storage wipe is hand-enumerated and has drifted: it deletes a cache that
does not exist and leaves tenant media in a 30-day image cache

**Severity:** MEDIUM
**Layer:** 2
**State:** OPEN
**Raised as:** `PRODUCT-MOBILE-MEDIUM-005` by `mobile-app-auditor` in
cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/hooks/useAuth.tsx:213 \- `caches.delete('api-cache')` — no code path
  anywhere in the app creates or writes an `api-cache`
- web/apps/aquamobil/src/pwa/messaging-sw.ts:346-353 \- the LOGOUT handler purges ONLY caches whose
  name starts with `messaging-`
- web/apps/aquamobil/src/pwa/messaging-sw.ts:134-145 \- `image-cache` (StaleWhileRevalidate, 100
  entries, 30 days) claims every `.png|.jpg|.jpeg|.gif|.webp` response and is never purged
- web/apps/aquamobil/src/pwa/messaging-sw.ts:63,100 vs :329 \- the workbox router's fetch listener
  is installed at precacheAndRoute/registerRoute time,
  BEFORE `addEventListener('fetch', handleFetchEvent)`, contradicting the ordering asserted in the
  comment at :245-250 that routes attachment images into the purgeable `messaging-media-v1`

**Rule violated:**

CLAUDE.md Security (shared-device data residue) \+ the SW's own stated invariant CRIT-2/SEC-02
("authenticated responses must never survive to the next user"). A hand-maintained list of cache
names is a Tier-4 control guarding a Tier-1 property.

**Proposed fix direction:**

Stop enumerating cache names by hand. Derive the wipe from `caches.keys()` with an explicit
ALLOW-list of caches proven to hold no tenant data (precache \+ static \+ navigation shell),
deleting everything else — so a newly added runtime cache is purged by default instead of being
forgotten. Move the media routing decision into the workbox router itself (one router, one ordering)
rather than a second `fetch` listener whose precedence assumption is wrong, and add an invariant
test that asserts every `cacheName` string in `messaging-sw.ts` is either in the allow-list or
covered by the logout purge.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/hooks/useAuth.tsx`
- `web/apps/aquamobil/src/pwa/messaging-sw.ts`
- `web/apps/aquamobil/src/pwa/**tests**/sw-build-artifact.invariant.spec.ts`
- `web/apps/aquamobil/src/hooks/**tests**/useAuth-logout-wipe.spec.tsx`

**Expected closer:**

tenant-isolation-auditor WRITER mode (shared-device residue is its domain) with mobile-app-auditor
CATCHER.

**Verifier note:**

Verified every bullet. web/apps/aquamobil/src/hooks/useAuth.tsx:213 does
call `caches.delete('api-cache')`, and a repo-wide grep over web/apps/aquamobil (ts/tsx/js/json,
including vite.config.ts which is injectManifest with NO runtimeCaching) finds the string ONLY at
useAuth.tsx:213-214 — no code path ever creates that cache, so the delete is dead. The four caches
that DO exist are declared in web/apps/aquamobil/src/pwa/messaging-sw.ts: 'navigation-cache' (:103),
'static-cache' (:123), 'image-cache' (:137, StaleWhileRevalidate, 100 entries, 30 days) and
'messaging-media-v1' (:298). The LOGOUT purge at
messaging-sw.ts:346-353
(`clearMessagingCaches`) filters `caches.keys()` to `k.startsWith('messaging-')`, so image-cache is
never purged. The ordering claim also holds: `precacheAndRoute` (:63) and the
first `registerRoute` (:100) install workbox's own fetch listener at module-evaluation time,
BEFORE `self.addEventListener('fetch', handleFetchEvent)` at :329; the first listener to call
respondWith wins, so the image route claims any GET whose pathname ends .png/.jpg/.jpeg/.gif/.webp.
Messaging attachment storageKeys
are `messaging/{tenantId}/{channel}/{yyyy}/{mm}/{file}.jpg` (apps/messaging-service/src/message/resolvers/message-attachment.resolver.spec.ts:34,
media.service.ts), so a presigned attachment GET matches the image route and lands in the unpurged
image-cache, NOT the purgeable messaging-media-v1 the comment at :245-250 asserts. The existing test
does not catch
this:
`web/apps/aquamobil/src/hooks/**tests**/useAuth-logout-wipe.spec.tsx:117`
stubs `caches` as `{ delete: vi.fn() }`, so it asserts a call against a cache that does not exist.
GraphQL POST pass-through is unaffected (workbox routes default to method GET). MEDIUM is correctly
calibrated — this is at-rest tenant-media residue on a shared device, not an active cross-user read,
since the next user's app never requests the prior tenant's presigned URLs.

### PRODUCT-MOBILE-MEDIUM-007

**Title:** The shared record scaffold's Confirm button silently no-ops when tank/batch context is
missing at submit time

**Severity:** MEDIUM
**Layer:** 1
**State:** OPEN
**Raised as:** `PRODUCT-MOBILE-MEDIUM-007` by `mobile-app-auditor` in
cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- `web/apps/aquamobil/src/pages/_shared/RecordEntityPage.tsx:218-219`
  \- `if (!validate() || !metrics?.batchId) return;` returns BEFORE `setIsSubmitting`, before any
  error state, and before any banner
- `web/apps/aquamobil/src/pages/_shared/RecordEntityPage.tsx:210-211` \- `metrics` is derived
  from `useTanks()` data, which is re-fetched on window focus and can be absent after a
  resume/eviction boundary
- web/apps/aquamobil/src/hooks/useTanks.ts:184 \- `refetchOnWindowFocus: true` — the tank set is
  re-resolved every time the app is foregrounded, including while the operator sits on the confirm
  screen
- web/apps/aquamobil/src/pages/cull/RecordCullPage.tsx:59-68 \- the
  page-supplied `validate()` checks `metrics` but not `metrics.batchId`, so the scaffold's extra
  guard is the only thing standing between a valid-looking form and a no-op

**Rule violated:**

Domain rule: mobile actions must never be dead. CLAUDE.md Architectural Approach: a silent
early-return is a Tier-4 "hope it never happens" control on an irreversible field action.

**Proposed fix direction:**

Make the precondition unrepresentable rather than re-checked: have the scaffold hold a
narrowed is only
callable with a proven context and the Confirm button is structurally disabled — not silently
ignored — when that context evaporates. If the context is lost between review and submit, surface an
explicit "tank data was refreshed — reselect the tank" banner and return the operator to the entry
step with their values intact.

```text
SelectedBatchContext` (tank \+ non-null batchId) as its state, so `buildPayload
```

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/pages/_shared/RecordEntityPage.tsx`
- `web/apps/aquamobil/src/pages/cull/RecordCullPage.tsx`
- `web/apps/aquamobil/src/pages/mortality/RecordMortalityPage.tsx`
- `web/apps/aquamobil/src/pages/harvest/RecordHarvestPage.tsx`
- `web/apps/aquamobil/src/pages/lice/LiceCountPage.tsx`
- `web/apps/aquamobil/src/pages/welfare/WelfareScorePage.tsx`
- `web/apps/aquamobil/src/pages/escape/EscapeIncidentPage.tsx`
- `web/apps/aquamobil/src/pages/_shared/**tests**/RecordEntityPage.spec.tsx`

**Expected closer:**

button-action-auditor WRITER mode.

**Verifier note:**

Confirmed
at
sits
at the top of handleSubmit, before `setIsSubmitting(true)` (:220) and before any error is set
(:221), so both branches are silent. The confirm-step render (:270-325) is worse than the claim
states: the Confirm button's only `disabled` condition is `isSubmitting` (:296), and the confirm
screen renders ONLY `errors.general` (:291) — so even the `!validate()` branch, which DOES
populate `errors.tank` ('Selected tank has no active batch', RecordCullPage.tsx:62), produces no
visible feedback on that screen. `metrics` is `selectedTank?.batchMetrics` derived from useTanks()
(:209-210) and `BatchMetrics.batchId` is genuinely
nullable (`batchId: string | null`, web/apps/aquamobil/src/types/index.ts:56). useTanks.ts:184 does
set `refetchOnWindowFocus: true`, so the tank set is re-resolved on every foreground, including
while the operator sits on the confirm screen. RecordCullPage.tsx:59-68 checks `!metrics` but
not `metrics.batchId`, exactly as claimed. One partial mitigation the claim omits: every page gates
entry with `canReview={... && !!metrics?.batchId ...}` (RecordCullPage.tsx:105,
RecordMortalityPage.tsx:113, RecordHarvestPage.tsx:125), so the dead path is only reachable when
batch context evaporates BETWEEN review and submit — a narrow but real window that a focus refetch
makes reachable. MEDIUM stands: a dead Confirm button with zero feedback on an irreversible
regulatory field action.

```text
web/apps/aquamobil/src/pages/_shared/RecordEntityPage.tsx:218` — `if (!validate() || !metrics?.batchId) return;
```

### PRODUCT-MOBILE-MEDIUM-008

**Title:** The reconnect drain has no resume/foreground re-arm, so a drain that aborts before
touching operations leaves the queue stalled with no automatic retry

**Severity:** MEDIUM
**Layer:** 2
**State:** OPEN
**Raised as:** `PRODUCT-MOBILE-MEDIUM-008` by `mobile-app-auditor` in
cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:478-493 \- the only auto-sync trigger
  is `isOnline` flipping or `queueVersion` differing from `lastArmedVersionRef`; once armed for
  version V nothing re-arms it while online
- web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:502-518 \- the 30s fallback interval fires ONLY
  when at least one op already
  carries `status === 'failed'` with `retryCount < MAX_RETRY_COUNT`; ops still `pending` after an
  aborted drain never qualify
- web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:418-421 \- a throw
  from `syncAllOperations` / `navigator.locks.request` is caught into `syncError` and leaves every
  op untouched at `pending`
- web/apps/aquamobil/src/styles/main.css:34-36 \- `overscroll-behavior-y: contain` disables the
  browser's native pull-to-refresh app-wide, so no generic gesture exists to force a retry
- web/apps/aquamobil/src/hooks/useNetworkStatus.ts:44-87 \- no `visibilitychange` listener; the
  probe loop is timer-driven only, so a resume with an unchanged `isOnline` produces no state
  transition

**Rule violated:**

Domain rule: "Flag any pull-to-refresh, resume, or foreground refresh behavior that fails to
invalidate the same queries a post-save flow depends on" — and its stronger form, a resume that
fails to re-attempt a stalled write drain.

**Proposed fix direction:**

Make the drain trigger idempotent and lifecycle-driven rather than edge-driven: subscribe the
OfflineProvider to `visibilitychange`/`pageshow` and attempt a drain on every foreground when the
queue is non-empty (the Web Lock plus `isSyncingRef` already make a redundant attempt harmless —
that is exactly the property that lets the trigger be liberal). Treat an aborted drain as a
first-class failure by recording an attempt timestamp per operation so the backoff scheduler can
retry `pending` ops too, not just `failed` ones.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/hooks/useOfflineQueue.tsx`
- `web/apps/aquamobil/src/hooks/useNetworkStatus.ts`
- `web/apps/aquamobil/src/pwa/offline-queue.ts`
- `web/apps/aquamobil/src/hooks/**tests**/useOfflineQueue-rearm.spec.tsx`

**Expected closer:**

mobile-app-auditor WRITER mode.

**Verifier note:**

All five bullets check out. web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:477-493: the auto-sync
effect arms on `lastArmedVersionRef.current !== queueVersion` and only resets the sentinel to -1
when `isOnline` goes false, so once armed for version V nothing re-arms while continuously online.
:502-518: the 30s interval early-returns unless some op
has `status === 'failed' && retryCount < MAX_RETRY_COUNT`; ops left `pending` never qualify.
:418-421: a throw
from `navigator.locks.request(QUEUE_DRAIN_LOCK, runDrain)` / `syncAllOperations` (which itself
throws on a missing tenantId at offline-queue.ts:916-918, and can throw
from `getPendingOperations` decryption/IDB failure at :922 before any op is touched) is caught
into `setSyncError` and returns, leaving every op at `pending`. main.css:33-36
confirms `html { overscroll-behavior-y: contain }`, and useNetworkStatus.ts:38-88 has
only `online`/`offline` listeners plus a timer probe — the only `visibilitychange` listener in the
whole app is ChatRoomPage.tsx:174, unrelated to the queue. I also found evidence the claim
UNDERSTATES: `syncError` is exposed on the context (useOfflineQueue.tsx:527) but is not rendered
anywhere — SyncStatusPage.tsx:42 and AccountPage.tsx:407 both destructure the queue without it — so
an aborted drain is invisible as well as un-retried. Holding at MEDIUM rather than raising, because
three recovery paths exist that the fix direction should preserve: any new enqueue bumps
queueVersion and re-arms, a real offline→online probe flip resets the sentinel, and
manual `syncNow()` buttons exist on SyncStatusPage.tsx:108, AccountPage.tsx:447 and
QueuedStatusBadge.tsx:34.

### LOW

### PRODUCT-MOBILE-LOW-009

**Title:** Queue status UI is non-exhaustive: the 'unknown' SyncStatus renders a blank screen and 7
of 24 operation types show raw identifiers to field workers

**Severity:** LOW
**Layer:** 1
**State:** OPEN
**Raised as:** `PRODUCT-MOBILE-LOW-009` by `mobile-app-auditor` in
cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:45-53 \- the comment claims "Adding the member
  forces exhaustive handling at every consumer — a missed branch is a compile error"
- web/apps/aquamobil/src/components/QueuedStatusBadge.tsx:40-91 \- the badge
  uses `status === 'x' && …` expressions, not an exhaustive switch, so `'unknown'` renders no icon,
  no title and no subtitle
- web/apps/aquamobil/src/pages/sync/SyncStatusPage.tsx:16-39
  \- `OPERATION_LABELS: Record<string, …>` is declared "the SINGLE source of truth" but omits
  recordMealFeeding, setChecklistItem, recordLiceCount, recordWelfareAssessment,
  recordEscapeIncident, acknowledgeAlert and uploadAndSendMessage
- web/apps/aquamobil/src/types/index.ts:349 \- `OperationType` enumerates all 24 members the labels
  map must cover

**Rule violated:**

CLAUDE.md Code Quality Standards / Architectural Approach tier 3 (make it detectable). A comment
asserting compile-time exhaustiveness that the code does not deliver is worse than no claim.

**Proposed fix direction:**

Earn the exhaustiveness the comments claim: key both maps
as
pattern
already used correctly in `offline-sync-invalidation.ts` is the in-repo precedent), so adding a
status or an operation type without its UI representation is a compile error. Delete the untrue
exhaustiveness comment in the same change.

```text
Record<SyncStatus, …>` and `Record<OperationType, …>` (the `satisfies Record<OperationType, …>
```

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/components/QueuedStatusBadge.tsx`
- `web/apps/aquamobil/src/pages/sync/SyncStatusPage.tsx`
- `web/apps/aquamobil/src/hooks/useOfflineQueue.tsx`

**Expected closer:**

frontend-expert WRITER mode.

**Verifier note:**

Holds on every cited line. web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:45-53 does carry the
comment "Adding the member forces exhaustive handling at every consumer — a missed branch is a
compile error" above `export type SyncStatus = 'pending'|'syncing'|'synced'|'failed'|'unknown'`, and
that claim is untrue: web/apps/aquamobil/src/components/QueuedStatusBadge.tsx:38-91 renders icon,
title and subtitle purely via `status === 'synced' && …` / 'pending' / 'syncing' / 'failed'
short-circuit expressions with no switch and no exhaustiveness check,
so . The
'unknown' branch is reachable in practice, not dead: getSyncStatus (useOfflineQueue.tsx:428-445)
returns 'unknown' whenever an id is in neither the in-memory `syncResults` map
nor `pendingOperations`, and the SW closed-app replay lane can drain an op without ever populating
the foreground `syncResults` state (setSyncResults is only written inside the foreground syncNow,
lines 353 and 381), so a badge mounted over an SW-drained op falls to 'unknown'. Second half also
holds: SyncStatusPage.tsx:16 declares `const OPERATION_LABELS: Record<string, {label;icon}>` under a
comment calling it "the SINGLE source of truth", and it contains exactly 17 keys; types/index.ts:349
enumerates 24 OperationType members; the 7 missing are exactly recordMealFeeding, setChecklistItem,
recordLiceCount, recordWelfareAssessment, recordEscapeIncident, acknowledgeAlert,
uploadAndSendMessage. SyncStatusPage.tsx:124 falls back
to `OPERATION_LABELS[op.type] || { label: op.type, icon: '📝' }`, so those 7 render the raw camelCase
identifier. No lint rule or spec guards either map (grep for `OPERATION_LABELS` across web/ and
tests/ returns only its declaration and its one use), and the
in-repo `satisfies Record<OperationType, …>` precedent the finding cites is real
(offline-sync-invalidation.ts:52). Impact is display-only — no data loss, no wrong write — so LOW is
the correct severity, not higher.

```text
status === 'unknown'` renders an empty icon slot, an empty `<h2>` and an empty `<p>
```

### PRODUCT-MOBILE-LOW-010

**Title:** Optimistic KPI bumps applied at enqueue are never reverted when the queued operation
permanently fails

**Severity:** LOW
**Layer:** 2
**State:** OPEN
**Raised as:** `PRODUCT-MOBILE-LOW-010` by `mobile-app-auditor` in
cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/utils/offline-optimistic.ts:64-88
  \- `applyOptimisticKpiBump` increments `dailyOpsCounts` / `stockEventsSummary` at enqueue time
- web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:244-246 \- the bump fires on
  every `status === 'queued'` enqueue
- web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:399-402 \- only operations that
  DRAINED (`!remainingIds.has(op.id)`) feed `invalidateSyncedOperationQueries`, so a
  permanently-failed op never triggers the reconciliation its own comment promises
- web/apps/aquamobil/src/hooks/useDailyOpsStats.ts:81 \- `dailyOpsCounts` carries a 5-minute
  staleTime, so the inflated counter is operator-visible for a full stale window

**Rule violated:**

Domain rule: local optimistic state must be reconciled against backend truth on reconnect. The
bump's own comment states "server truth reconciles on the next successful sync's invalidation" —
which never runs for a failed op.

**Proposed fix direction:**

Close the loop symmetrically: have the drain invalidate the read models for every operation it
OBSERVED (drained or terminally failed), not only the successful ones, so the KPI card is re-derived
from the server in both outcomes. The invalidation set is already an exhaustive per-type map, so
widening the trigger costs nothing structurally.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/hooks/useOfflineQueue.tsx`
- `web/apps/aquamobil/src/utils/offline-optimistic.ts`
- `web/apps/aquamobil/src/utils/offline-sync-invalidation.ts`
- `web/apps/aquamobil/src/hooks/**tests**/useOfflineQueue-invalidation.spec.ts`

**Expected closer:**

data-readback-auditor WRITER mode.

**Verifier note:**

Holds on every cited line. offline-optimistic.ts:64-88 is `applyOptimisticKpiBump`, which
unconditionally increments the cached `dailyOpsCounts` counter
and `stockEventsSummary.thisWeekEventsCount` via queryClient.setQueriesData; no revert/decrement
function exists anywhere in that file. useOfflineQueue.tsx:244-246 fires it
on `if (result.status === 'queued')` at enqueue. useOfflineQueue.tsx:399-402
builds
and
passes only that to invalidateSyncedOperationQueries, so an op that stayed in the queue as 'failed'
never triggers the reconciliation the bump's own comment ("the post-sync invalidation reconciles
with server truth") promises. The terminal state is genuinely terminal: offline-queue.ts:839-842 and
:956-963 keep an op at retryCount `>=` `MAX_RETRY_COUNT` (5) in the queue as 'failed' indefinitely,
skipped on every subsequent drain, and removeFromQueue does not revert the bump either.
useDailyOpsStats.ts:81 does carry `staleTime: 1000 * 60 * 5` (gcTime 30m). Two facts bound the blast
radius and keep this at LOW rather than higher: the QueryClient in main.tsx:32-50 does not disable
refetchOnWindowFocus/refetchOnReconnect and there is no cache persister, so the inflated counter
self-corrects on the next stale refetch (app focus, remount, or reconnect once past the 5-minute
window) and never survives a reload. So it is a real, transient, operator-visible over-count on a
KPI card, exactly as filed — LOW.

```text
syncedOperationTypes = preSyncOps.filter((op) => !remainingIds.has(op.id)).map(op => op.type)
```

## Refuted by adversarial verification

These did **not** survive independent re-checking. They are recorded so the same
claim is not re-raised next cycle.

### ~~PRODUCT-MOBILE-MEDIUM-006~~

**Title:** Regulatory incident records filed offline permanently lose their evidence photos —
capture is hard-disabled without connectivity

**Raised as:** MEDIUM · **Result:** REFUTED

The cited lines are accurate but the harm they are claimed to prove does not exist.
web/apps/aquamobil/src/components/PhotoCaptureField.tsx:98 does
set `captureDisabled = !isOnline || isUploading || atCapacity`, but :202-206 of the same file
renders an explicit amber banner whenever offline: 'Connect to add photos — the record still submits
without them.', and the button icon swaps to `<ImageOff/>`. Nothing is 'silently' dropped and no
captured evidence is lost — offline capture never starts, so there is no staged blob to lose. The
field is titled 'Photos (Optional)' (PhotoCaptureField.tsx:139) and the backend agrees:
apps/farm-service/src/fish-health/dto/field-capture.inputs.ts:90,255,320 all
declare `mediaKeys?: string[]` as optional, so the cited domain rule ('loses REQUIRED fields, files,
or derived values in the mobile UI path') does not apply. The claim's own evidence bullet quotes the
code documenting the boundary deliberately (useIncidentMediaUpload.ts:19-22: 'Scope: only the
upload-at-capture path… is NOT built here — it is the remaining enhancement'), which makes this a
restatement of a documented, user-disclosed scope decision, i.e. a feature request, not a defect.
The proposed interim fix is also incoherent against the code: it asks the app to 'refuse to finalise
an offline incident submission that had photos staged', but PhotoCaptureField.tsx:98 makes staging
offline impossible, so there is never such a state.
EscapeIncidentPage.tsx:136 (`mediaKeys: mediaKeys.length > 0 ? mediaKeys : undefined`) is simply the
correct encoding of an optional field.

## Inventory — what exists / what is missing

| Status          | Area                                                                     | Note                                                                                                                                                                                                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MISSING**     | Water quality recording                                                  | Navigable and fully built, but dead: the client sends a `parameters` field the server schema removed, so every submission is rejected at GraphQL input coercion. Online it shows an error banner; offline it shows a green "Measurement Recorded!" over an op that will exhaust its retries. See PRODUCT-MOBILE-CRITICAL-001.                |
| **PARTIAL**     | Alerts list \+ acknowledge                                               | Read path is good (30s poll, encrypted offline fallback that avoids a false "all clear", persistent critical banner). The acknowledge write reports success unconditionally from a local queue write with no failure surface. See PRODUCT-MOBILE-HIGH-004.                                                                                   |
| **PARTIAL**     | Build-time GraphQL contract gate \+ mobile E2E coverage                  | Codegen covers only `src/graphql/**`; the offline replay registry and 10 colocated `gql` documents are unvalidated (HIGH-003). E2E exists for login, cull-online, mortality-offline-roundtrip, alerts-ack, messaging and ai-confirm — but not for water quality or feeding, which is why CRITICAL-001 shipped.                               |
| **PARTIAL**     | Incident photo capture / media pipeline                                  | Upload-at-capture (presign `->` PUT `->` storageKey) works online with compression, MIME allow-list and a size cap. There is no capture-offline-upload-on-sync lane, so the control is disabled offline and evidence is not collected.                                                                                                       |
| **PARTIAL**     | Logout device wipe (IndexedDB, React Query, biometric PII, localStorage) | The in-memory and IndexedDB wipe is thorough and correctly awaited (a failed wipe rejects rather than presenting as a clean logout). Two gaps: Cache Storage names are hand-enumerated and drifted (MEDIUM-005), and the wipe destroys unsynced field records without consent (HIGH-002).                                                    |
| **PARTIAL**     | Regulatory field capture: lice / welfare / escape                        | Record path is solid — site and species resolved from the tank snapshot (never asked of the operator), lice upsert is naturally idempotent, escape incidents are drained FIRST on reconnect, and the legally-loaded "varsling is immediate" banner is present. Photos are lost on the offline path (MEDIUM-006).                             |
| **PARTIAL**     | Sync status page (the only failure-visibility surface)                   | Shows per-op status, retry counts, truncated errors and manual remove/sync. But it is the ONLY place a permanently-failed write is visible (the Account tab badge merges it with unread notifications), and its label map covers 17 of 24 operation types.                                                                                   |
| **PARTIAL**     | Task notes                                                               | Online-only by construction — `addNote` throws "Adding notes requires network connectivity" with no queue path and no OperationType, so a field observation typed offline is simply refused.                                                                                                                                                 |
| **IMPLEMENTED** | At-most-once command envelope (client `->` server dedup)                 | Envelope stamped at enqueue (clientCommandId, payloadHash, deviceId, operationType, schemaVersion); online attempts thread the SAME clientCommandId into the offline fallback; backend inputs extend `MobileCommandEnvelopeInput` and a receipt ledger enforces uniqueness on (tenantId, clientCommandId).                                   |
| **IMPLEMENTED** | Attendance clock in / clock out                                          | Queue-first with GPS capture, honest `QueuedStatusBadge` success surface, refetch on return; `GeoLocation` matches the server `GeoLocationInput` field-for-field; clockIn/clockOut both carry read-model invalidation entries.                                                                                                               |
| **IMPLEMENTED** | Batch transfer between tanks                                             | Queued `recordTransfer` `->` `transferBatch(TransferBatchInput!)`; the client interface carries an explicit contract comment pinning it to the server SSoT (`avgWeightG`, no `biomassKg`) and matches the schema.                                                                                                                            |
| **IMPLEMENTED** | Closed-app Background Sync replay (service worker lane)                  | Real drain lane: zero-clients gate, shared `aquamobil-queue-drain` Web Lock also held by the foreground, cookie-refresh to mint identity, tenant scoped to the refreshed identity, blob ops skipped intact. Defers to the next foreground where Web Locks are unavailable.                                                                   |
| **IMPLEMENTED** | Feeding (meal-level cutover, recordMealFeeding)                          | Typed `feedingDayPlans` source with an encrypted tenant-scoped 12h offline cache and an honest "served from cache" banner; partial pours supported via `finalize`; payload matches `RecordMealFeedingInput` exactly. Success screen correctly states "queued for sync".                                                                      |
| **IMPLEMENTED** | Leave request \+ my leaves                                               | Queued `createLeaveRequest` chains an immediate `submitLeaveRequest` inside the same drain pass via a shared registry helper, so the mobile promise of "requested" (not "drafted") holds on both drain lanes; a missing created id throws so the op surfaces as failed.                                                                      |
| **IMPLEMENTED** | Login, silent session restore, `PANEL_ONLY` / mobile-entitlement gate    | httpOnly-cookie silent refresh on mount with an 8s abort, fail-closed `checkMobileEnabled`, hard `PANEL_ONLY` block at login, restore and route level. Role normalized through `normalizeRole` at the trust boundary.                                                                                                                        |
| **IMPLEMENTED** | Messaging: channels, messages, send / edit / delete / mark-read, media   | All four write types are first-class queue operations sharing one drain; the binary lane persists blobs encrypted and replays presign `->` PUT `->` send with a stable idempotencyKey, deleting the blob only after a confirmed send. Channel and message caches are user-scoped.                                                            |
| **IMPLEMENTED** | Mortality / Cull / Harvest recording                                     | Shared `RecordEntityPage` scaffold, two-step `review->confirm`, honest `QueuedStatusBadge` two-phase status, distinct "Already recorded" screen for a deduped double-tap. Payload shapes match the farm schema.                                                                                                                              |
| **IMPLEMENTED** | Offline write queue (encrypt, dedup, retry, backoff, version token)      | AES-GCM with a non-extractable persisted key, tenant-prefixed keys, SHA-256 payload-hash dedup within a 5s window, exponential backoff with jitter, permanent-vs-transient error classification, monotonic per-tenant version driving reconnect re-arm, 200-op cap.                                                                          |
| **IMPLEMENTED** | Post-sync query invalidation (read-back convergence)                     | `SYNC_INVALIDATION_SEGMENTS` is `satisfies Record<OperationType, …>`, so a new queueable operation without a read-model mapping is a compile error. Online and offline mutation paths converge on the same awaited invalidation helper.                                                                                                      |
| **IMPLEMENTED** | Real-time farm sync \+ reconnect reconciliation                          | Socket.IO `/farms` subscription auto-joined to the tenant room, per-event read-model invalidation, and a full farm-namespace invalidation on RECONNECT (not first connect) to catch missed events. A dropped live channel is surfaced as a "data may lag" strip rather than silently.                                                        |
| **IMPLEMENTED** | Regulatory reports due / report review                                   | Deliberately online-only (`enabled: … && isOnline`) with an honest offline notice — a regulator submission is correctly kept out of the device queue. FeatureRoute enforces the `MODULE_MANAGER` floor mirroring the backend @Roles matrix.                                                                                                  |
| **IMPLEMENTED** | Role / feature gating on mobile actions                                  | Fail-closed by default and on every error branch (401, GraphQL error with expired cache, IndexedDB failure); permissions cached under a tenant+user key with an 8h TTL and a degraded-source indicator; `FeatureRoute` folds the entitlement flag with the feature role floor so a `MODULE_USER` never reaches a form the backend would 403. |
| **IMPLEMENTED** | Tasks: start / complete / checklist toggle                               | Online-first with offline fallback under one shared clientCommandId; the checklist op carries an ABSOLUTE target `isCompleted` so a replay converges instead of reverting; `TaskActionResult.wasQueued` keeps the UI honest.                                                                                                                 |
| **IMPLEMENTED** | Tenant \+ user partitioning of persisted client state                    | IndexedDB queue/cache/blob keys all embed tenantId; `my*` reads use a branded `UserScopedCacheKey` that cannot be constructed without a userId; all React Query keys go through the local `createTenantQueryKey`; an `IdentityBoundary` remounts the whole authenticated subtree on identity change. No cross-tenant path found.             |
| **IMPLEMENTED** | Warehouse: stock movement / transfer / stock view                        | Wizard flows with barcode scan, idempotencyKey, online-first plus recoverable-network fallback to the queue, and an honest `isOnline ? 'Movement Recorded!' : 'Queued for Sync'` success label. Minor: the fallback path after an online transport failure still shows the online wording.                                                   |

## Verdict

BLOCK

## References

- Cycle report: `docs/reviews/orchestrator/2026-08-16-farm-mobile-audit-cycle.md`
- Finding format: `.claude/shared/output-format.md`
- Agent definition: `.claude/agents/**/mobile-app-auditor.md`
- Rule SSoT: `CLAUDE.md`
