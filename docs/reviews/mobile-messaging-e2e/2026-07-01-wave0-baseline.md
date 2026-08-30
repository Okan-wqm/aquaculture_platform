# Mobile Messaging E2E Review — Wave 0: Baseline, Delta & Closed-Claim Verification

**Cycle:** `2026-07-01-mobile-messaging-e2e`
**Scope:** AquaMobil PWA ↔ gateway-api (GraphQL federation + Socket.IO `/messaging`) ↔ messaging-service ↔ NATS/JetStream ↔ notification-service/FCM. Farm/HR mobile flows are OUT of scope for this cycle (their OPEN findings stay registered untouched).
**Method:** lead first-hand verification (grep/read, `file:line` evidence) of every closed-claim and every stale-OPEN candidate. No agent dispatch in Wave 0.
**Prior audit:** `docs/reviews/aquamobil-e2e-audit/2026-06-13-findings.md`; registry `docs/reviews/_registry/findings.jsonl`.

---

## 1. Delta since 2026-06-13

Only two commits touched the messaging surfaces after the prior audit:

| Commit           | Surface impact                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `23e94e0` (#780) | aquamobil: new `useFarmRealtimeSync` (`/farms` namespace) — additive; no messaging-path change                                                         |
| `dfe758e` (#751) | large squash (ARIA + consolidated fix content); `git log -L` shows the current `useMessages.ts` content (incl. the `user.id` key) entered history here |

Conclusion: the codebase under review is essentially the post-remediation state of the 2026-06-13 audit. The review therefore re-baselines against code, not against registry state.

## 2. Closed-claim verification (RESOLVED → verify in code)

Every finding the registry marks RESOLVED in the messaging-mobile subset, verified first-hand:

| ID                                                         | Claim                                             | Verdict                                   | Evidence                                                                                                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MSG-CRITICAL-001                                           | read cursor advanced via `useMarkRead`            | **STILL-FIXED**                           | `ChatRoomPage.tsx:34,103`; `useMarkRead.ts:60`; dead `emitMarkRead` gone (0 call sites)                                                                                         |
| MSG-CRITICAL-050                                           | live WS payload = hydrated full message           | **STILL-FIXED (code) / EFFECT REGRESSED** | bridge hydrates via `broadcastHydratedMessage` (`messaging-nats-bridge.service.ts:152-165`) — but the client writes the result to a dead cache key → **MSG-CRITICAL-055** below |
| MSG-CRITICAL-051                                           | markMessagesRead invoked from chat                | **STILL-FIXED**                           | same as 001                                                                                                                                                                     |
| MSG-CRITICAL-052                                           | attachment `downloadUrl`/`thumbnailUrl` resolvers | **STILL-FIXED**                           | `message-attachment.resolver.ts:35-73` (`@ResolveField`, presigned)                                                                                                             |
| MSG-CRITICAL-053                                           | MediaViewerPage real data                         | **STILL-FIXED**                           | `MediaViewerPage.tsx:71-100` — derives from `useMessages` pages + auto-paginates to the target attachment                                                                       |
| MSG-CRITICAL-054                                           | offline send envelope accepted                    | **STILL-FIXED**                           | `send-message.input.ts:26` `extends MobileCommandEnvelopeInput`                                                                                                                 |
| MSG-HIGH-003                                               | reconnect delta drain (M3)                        | **STILL-FIXED (code) / EFFECT DEGRADED**  | `useMessageSocket.ts:211-271,316-334` — drain exists, but upserts land on the dead key (MSG-CRITICAL-055); badge invalidations still work                                       |
| MSG-HIGH-004                                               | push fan-out subscribed                           | **STILL-FIXED**                           | `messaging-push-nats.handler.ts` durable `subscribeWildcard('MessageSent')`                                                                                                     |
| MT-CRITICAL-050                                            | logout wipes RQ cache                             | **STILL-FIXED**                           | `useAuth.tsx:461-463` (`removeQueries` + `clear`)                                                                                                                               |
| MT-CRITICAL-051                                            | user-scoped offline caches                        | **STILL-FIXED**                           | `useMySchedule.ts:121-138`; `useMessages.ts:126-131` — NOTE: this fix's key change is the root cause of MSG-CRITICAL-055                                                        |
| FE-CRITICAL-050                                            | hand-written SW deployed                          | **STILL-FIXED**                           | `vite.config.ts:17-19` (`injectManifest`, `srcDir: src/pwa`); `sw-build-artifact.invariant.spec.ts`                                                                             |
| Wave-2 closeout slices (opaque push, AI egress #422, #435) |                                                   | **STILL-FIXED**                           | `messaging-push.service.ts` notificationRef+Redis+dedup chain present; egress gate `ai-egress-gate.service.ts` present                                                          |

## 3. Stale-OPEN re-baseline (registry OPEN → fixed in code)

The following registry-OPEN findings are **verifiably fixed on the current tree**. This report is the closing evidence; the commit that adds it carries one `Closes:` trailer per finding. ⚠️ The `finding-registry close` ceremony must run **post-merge, on a full clone** (this session's clone is shallow; the CLI correctly refuses unreachable SHAs).

| ID             | Fix evidence                                                                                                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MSG-HIGH-002   | gateway has NO `markRead` socket handler (`messaging.gateway.ts` handlers: joinChannel/leaveChannel/typing/resolveNotificationRef/reAuthResponse only)                                                            |
| MSG-HIGH-050   | bridge hydrates full `WsMessage`; `readAt` (not `timestamp`) `messaging-nats-bridge.service.ts:182-192`; `isTyping` relayed with stop-always-propagates `messaging.gateway.ts:341-348`                            |
| MSG-HIGH-051   | `channelEligibleUsers` open to any messaging user (`message.resolver.ts:404`); `useTenantUsers.ts:33-41` consumes it                                                                                              |
| MSG-HIGH-053   | duplicate of MSG-HIGH-003 (M3 drain present)                                                                                                                                                                      |
| MSG-HIGH-054   | `toWireChannelType` SSoT (`utils/channel-type-wire.ts`; `useCreateChannel.ts:26`) + `channel-type-wire.spec.ts`                                                                                                   |
| MSG-HIGH-055   | `VOICE_DURATION_METADATA_KEY = 'durationSeconds'` SSoT (`media.service.ts:26,223`)                                                                                                                                |
| MSG-HIGH-056   | `finalizeAttachment` called in send path (`send-message.handler.ts:120-148`); `media-finalization.service.ts:129-137` probes dimensions + Sharp thumbnail                                                         |
| MSG-MEDIUM-050 | `MessageDeletedEnvelope` carries `channelId` (`messaging-nats-bridge.service.ts:174-176`; `messaging.gateway.ts:468`)                                                                                             |
| MSG-MEDIUM-051 | presence emits `isOnline` boolean (`messaging.gateway.ts:224-245`)                                                                                                                                                |
| MSG-MEDIUM-053 | `useEditMessage` online/offline dual path (docblock cites MSG-MEDIUM-053); `useMarkRead` offline enqueue                                                                                                          |
| MSG-MEDIUM-054 | `useChannelActions.ts:126` uppercase wire enum (S1 codegen)                                                                                                                                                       |
| MSG-MEDIUM-055 | encrypted offline blob lane: `putPendingBlob` + `replayUploadAndSendMessage` (`useOfflineQueue.tsx:257`; `ChatRoomPage.enqueueOfflineMedia`)                                                                      |
| MSG-MEDIUM-056 | EXIF strip in `media-finalization.service.ts` (send-path invoked, see MSG-HIGH-056)                                                                                                                               |
| MSG-MEDIUM-057 | client allowlist excludes `image/svg+xml` (`useMediaUpload.ts:41`), server SSoT unchanged                                                                                                                         |
| MT-HIGH-050    | logout teardown: `unregisterDeviceToken` mutation + FCM `deleteToken` via `runPushTeardown` (`useFirebaseMessaging.ts:201-228`; `push-lifecycle.ts`); `useFirebaseMessaging-deregister.spec.tsx`                  |
| FE-HIGH-051    | monotonic `queueVersion` re-arm (`useOfflineQueue.tsx:322-335`) + `useOfflineQueue-rearm.spec.tsx`                                                                                                                |
| FE-HIGH-053    | ROOT `ErrorBoundary` (`main.tsx:95-114`) + route-level boundaries (`App.tsx:204`)                                                                                                                                 |
| FE-HIGH-054    | `runSingleFlightRefresh` coalesces 401s (`authenticated-fetch.ts:151,236`) + `authenticated-fetch-single-flight.spec.ts`                                                                                          |
| FE-HIGH-055    | re-armable auth barrier `armAuthReady()` on logout (`authenticated-fetch.ts:65-101`) + `auth-ready-barrier-reset.spec.ts`                                                                                         |
| FE-HIGH-056    | zero direct `console.*` in src; `utils/logger.ts` computed-member wrapper (lint-clean by construction)                                                                                                            |
| FE-HIGH-057    | FCM SW at distinct sub-scope `/mobile/firebase-cloud-messaging-push-scope`, config via query params (`useFirebaseMessaging.ts:158-161`; `firebase-messaging-sw.js:50`) + `useFirebaseMessaging-sw-scope.spec.tsx` |
| FE-HIGH-058    | `precacheAndRoute(self.__WB_MANIFEST)` + `PrecacheFallbackPlugin({fallbackURL:'index.html'})` (`messaging-sw.ts:58,109`)                                                                                          |
| FE-MEDIUM-052  | in-band `reAuth` refresh WITHOUT socket teardown (`useMessageSocket` reAuth handshake) + `useMessageSocket-token-rotation.spec.ts`                                                                                |
| FE-MEDIUM-053  | bell unread invalidated in the same `newMessage` tick (`useMessageSocket.ts:354-357`) + `useNotifications-cadence.spec.ts`                                                                                        |

**Kept OPEN (not fully verified or genuinely partial):**

| ID                                                       | Status                       | Why                                                                                                                                                                                                                                                |
| -------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MSG-HIGH-052                                             | PARTIAL → Wave 2             | duplicate-insert effect neutralized by idempotent `upsertMessageIntoChannelCache` (:79-101), but 3 pages still each call `useMessageSocket()`; shared-manager semantics (`forceNew:false`) + unmount `disconnect()` interplay needs Wave-2 verdict |
| MSG-MEDIUM-052                                           | PARTIAL → Wave 2             | WS-half fixed client-side (`enrichSenderFromMembers`, no-PII oracle); backend `batchLoadMemberUsers` placeholder remains (`channel.resolver.ts:546`) — federation covers the GraphQL path                                                          |
| MSG-HIGH-001                                             | Wave 6                       | requires running the messaging unit suite (deps not installed in Wave 0)                                                                                                                                                                           |
| MT-MEDIUM-050, FE-LOW-050/051, MSG-LOW-051/052           | Wave 3/4/5                   | in-wave verification (specs exist: `ChatRoomPage-attachment-retry`, `AttachmentPicker`)                                                                                                                                                            |
| SEC-MEDIUM-052                                           | BLOCKED-ON-INFRA (unchanged) | CSP header is an nginx/`/mobile/` vhost control; owner = Platform/Infra, per prior audit                                                                                                                                                           |
| SEC-HIGH-050/051/052, SEC-MEDIUM-050/051, MSG-MEDIUM-001 | Wave 5                       | authorization/AI-consent surfaces re-checked there                                                                                                                                                                                                 |

## 4. NEW finding raised in Wave 0

### MSG-CRITICAL-055 — messages cache-key drift: every live/optimistic writer targets a key `useMessages` never reads

**Severity:** CRITICAL (registered OPEN in `findings.jsonl`, chain-verified)
**Owner:** realtime-sync-auditor (Wave 2 lead surface)

- **Read key** (`useMessages.ts:116`): `['tenant', tenantId, 'messaging', 'messages', user.id, channelId]` — `user.id` added by the MT-CRITICAL-051 fix (membership-scoped shared-device isolation; correct).
- **Write/invalidate keys** (all WITHOUT `user.id` → `setQueryData` exact-match miss, `invalidateQueries` prefix mismatch at segment 4):
  - `useMessageSocket.ts:74` (live `newMessage` upsert), `:376` (`messageUpdated`), `:395` (`messageDeleted`), `:420` (readReceipt cache write)
  - `useSendMessage.ts:78` (optimistic write), `:117` (post-send invalidate)
  - `ChatRoomPage.tsx:305` (delete invalidate)
- **Effect:** `ChatRoomPage` renders exclusively from `useMessages` (`ChatRoomPage.tsx:94-99`). Live incoming messages, live edits/deletes, the M3 reconnect reconciliation upserts, and the sender's own optimistic messages all land in a cache entry nothing reads. The open chat converges only via channel-list/unread prefix invalidations of OTHER query families (badges), not the message list itself.
- **Why the suite is green:** the socket/reconnect specs seed and assert the SAME `user.id`-less key — they pin the drift instead of catching it.
- **Root cause class:** no single key factory for the `messages` family; MT-CRITICAL-051 changed the read key without a compiler-enforced SSoT forcing writers to follow. Remediation (Sprint R1) must be tier-1: one exported `messagesQueryKey(tenantId, userId, channelId)` helper used by ALL readers/writers/specs, plus an invariant test banning inline construction of the `'messages'` family key.

## 5. Wave seeding (unchanged hypotheses → owning wave)

| Seed                                                                                                                                          | Wave           |
| --------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Two auth paths to `/graphql` (`executeGraphQL` raw fetch, `useOfflineQueue.tsx:452`)                                                          | W1             |
| MSG-CRITICAL-055 remediation design + socket multi-instance (MSG-HIGH-052) + sender placeholder (MSG-MEDIUM-052)                              | W2             |
| Hydration round-trip fragility (5s timeout, drop-on-failure)                                                                                  | W2             |
| Presence dual-write (gateway vs messaging-service Redis keys)                                                                                 | W2/W3          |
| Single newest-device push (`notification-command.handler.ts:183-197`); firebase-admin optional-dep silent degrade; `platform:'web'` hardcoded | W3             |
| Fail-open Redis send-idempotency (`send-message.handler.ts:361-369`)                                                                          | W1             |
| Closed-app media background replay gap (documented)                                                                                           | W4             |
| Dead AI pipeline (`AnalyzeMessageCommand`/`ExtractKnowledgeCommand` undispatched) + `useAiChat.confirmAction` TODO                            | W5             |
| No e2e for real chat path (socket delivery, push, notificationRef)                                                                            | W6 → Sprint R3 |

## 6. Registry actions in this commit

- Appended `MSG-CRITICAL-055` (OPEN) — manual append per `_registry/README.md`, full 555-entry chain re-verified.
- 24 stale-OPEN findings re-baselined as fixed: `Closes:` trailers on this commit; post-merge `finding-registry close <id> <this-commit-sha>` ceremony required (full clone).
- RESOLVED rows keep their historical (now-unreachable, squash-orphaned) closing SHAs — known PROC-HIGH-001 pattern, no new instance created here.
