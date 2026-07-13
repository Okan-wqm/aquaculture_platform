# AquaMobil E2E Audit — broken flows + industrial-frontend gaps (2026-07-12)

Cycle: `2026-07-12-aquamobil-e2e-audit`
Scope: `web/apps/aquamobil/**` end-to-end (routes, offline queue, service
workers, push, messaging/AI surfaces), plus the backend surfaces mobile binds
to (`apps/{gateway-api,alert-engine,ai-service,messaging-service,sensor-service,notification-service}`)
and the repo Playwright suite (`e2e/`).

Three parallel exploration passes (structure map, broken-flow hunt,
industrial-field-app gap audit) reviewed the PWA end-to-end and verified
backend feasibility for every wiring decision against resolver source. The app
is mature (~60 pages, 49 unit spec files; offline queue, auth single-flight
refresh, tenant scoping all verified solid). The defects and gaps below are the
audit's SSoT finding IDs. Remediation is phased on branch
`claude/mobile-e2e-testing-plan-6nzom7` (plan: Faz 0 repairs + E2E scaffold →
Faz 1 alarms/live-data → Faz 2 AI action flow → Faz 3 field ergonomics →
Faz 4 performance/full E2E).

## Broken / lying surfaces

### MOB-HIGH-001 — AI action confirm flow is dead end-to-end (build decision: wire it up)
`useAiChat.ts` `confirmAction()` ends in a TODO; `addAction` has zero callers,
so proposal cards are never created; `AiChatPage` empty-state copy promises
"request actions". Backend: `messaging-service.confirmAiAction` fires NATS
`request.ai.executeAction`, but **no ai-service responder exists** for that
subject (only `request.ai.chat` / `request.ai.isEnabled`), and nothing emits
`metadata.status='proposed'` messages. All remote branches checked 2026-07-12 —
no duplicate implementation in flight. Owner decision: BUILD end-to-end
(proposal persistence + emission in ai-service, `executeAction` responder with
confirmation override, mobile wiring). Deadline: Faz 2 of this cycle's branch.

### MOB-MEDIUM-002 — closed-app Background Sync is a no-op and the code claims otherwise
`src/pwa/messaging-sw.ts` `handleSyncEvent` only posts `SYNC_COMPLETE` to open
window clients; the SW never replays the queue itself, while
`offline-queue.ts` (~line 700) asserts the SW "can re-POST /graphql". A field
worker who records offline and closes the app gets no sync until next launch.
Fix: SW-side replay (refresh-cookie auth, shared Web Lock with the foreground
drain, blob lane excluded per MSG-MEDIUM-055) + truthful comments.

### MOB-MEDIUM-003 — hardcoded "Weekly Sentiment" shown to TENANT_ADMIN as real analytics
`ChannelSettingsPage.tsx` renders `SentimentBadge` from a hardcoded
`'neutral'`. The real `sentimentTrends` query exists (messaging subgraph,
TENANT_ADMIN-gated, weekly aggregates over `message_analyses`). Fix: wire it;
render nothing when no analysis rows exist.

### MOB-LOW-004 — orphan pages: HrHubPage, RecordHubPage, MorePage
Zero import sites; App.tsx redirects `/hr`, `/record`, `/more` away. Dead code
duplicating live UI (AccountPage biometric panel). Fix: delete.

### MOB-LOW-005 — catch-all `*` silently redirects to home
`App.tsx` `<Route path="*" element={<Navigate to="/" replace />} />` masked
broken deep links (BUG-16's /culling/* compat redirects were discovered only
because of this silence). Fix: mobile 404 page (precached, works offline).

### FE-LOW-051 — NotificationBell renders a failed count fetch as "0" (pre-tracked)
`useNotifications` already exposes `isCountError` for exactly this (see the
hook's FE-LOW-051 comment); the bell ignored it. Fix: error affordance +
aria-label; error state wins over stale numeric counts.

## Industrial field-app gaps (exists on desktop / backend, missing on mobile)

### MOB-HIGH-006 — no alarm surface on mobile
No alerts page, no acknowledge flow, no severity model, no critical-alert
banner. alert-engine already exposes `alertHistory` / `acknowledgeAlert` /
`resolveAlert` (MODULE_USER) via the federated graph; desktop sensor-module
has the full reference UI. Fix: Faz 1.1 (offline-capable ack via the queue).

### MOB-MEDIUM-007 — push notifications are not alarm-grade
`firebase-messaging-sw.js` sets only body/icon/data: no `requireInteraction`,
`vibrate`, `actions`, `tag`/`renotify`; `navigator.vibrate` never used
anywhere. Severity is already on the wire (`push.service.ts` sends
`data.severity`). Fix: Faz 1.2 severity-driven notification options.

### MOB-MEDIUM-008 — no live sensor readings and no data-age stamps
Tank screens show only batch metrics; no temp/DO/pH anywhere; no "as of X ago"
on any metric; `MobileLayout` discards `isConnected` from
`useFarmRealtimeSync`. sensor-service `sensorRawList` + `latestReadingsBatch`
exist. Fix: Faz 1.3 (DataFreshness SSoT component + connection indicator).

### MOB-MEDIUM-009 — touch targets below 44px and weak outdoor readability
Icon buttons at `p-2`/`p-2.5` (~36-40px); `.touch-feedback` has no size floor;
translucent low-contrast text (`text-white/70`) and `text-[9-11px]` labels.
Fix: Faz 3.1 (Tailwind touch token + static invariant spec).

### MOB-MEDIUM-010 — no photo capture on incident flows, no barcode/QR on stock flows
Camera/`BarcodeDetector` exist only in messaging attachments; Escape/Welfare/
Mortality/Lice records take no evidence photos; stock pages are manual
selects. Resolution split (2026-07-12): the BARCODE half shipped in Faz 3.2
(BarcodeScanButton — progressive enhancement over BarcodeDetector, wired into
StockMovement/StockTransfer scan-to-find). The PHOTO half turned out to require
a farm-service media pipeline that does not exist (the messaging presign is
channel-scoped and unusable for farm records) — tracked as MOB-HIGH-014 below.

### MOB-HIGH-014 — farm-service has no media/attachment pipeline (blocks incident photo capture)
Verified 2026-07-12: farm-service exposes NO presigned-upload mutation and the
incident record inputs (RecordEscapeIncidentInput, RecordWelfareAssessmentInput,
RecordMortalityInput, RecordLiceCountInput) carry no attachment/media-key
fields. The messaging media pipeline (requestMediaUpload) is channel-scoped and
cannot serve farm records. Evidence photos on regulatory incident records
(escape/welfare/mortality/lice) therefore need: a farm-scoped presign mutation
backed by @platform/storage, `attachments`/`mediaKeys` columns + DTO fields on
the four record entities (blue-green migration), offline blob-lane replay for
the farm lane, and the mobile PhotoCaptureField. OWNER: farm-service
maintainers (farm-expert lane). DEADLINE: next farm-service feature cycle —
2026-08-15. STATUS: OPEN. The mobile capture UI lands together with the backend
pipeline; shipping a camera button with nowhere to upload would be a fake.

### MOB-LOW-011 — offline UX polish: no global last-synced clock, no optimistic farm writes
`aquamobil_last_sync_at` is written but never surfaced; farm records are
queue-then-invalidate only. Fix: Faz 3.3.

### MOB-MEDIUM-012 — zero list virtualization
No react-window/react-virtual anywhere; chat history, notifications, tank and
stock lists render fully — jank/memory risk on low-end field devices.
Resolution split (2026-07-12): the shared VirtualList (@tanstack/react-virtual,
dynamic measurement) now backs the lists that grow without user action —
notifications and the stock SKU pickers (StockMovement/StockTransfer). The
home tank cards deliberately stay plain (bounded by physical farm size;
nesting a scroll region inside the dashboard hurts one-handed use more than a
few dozen cards hurt memory — rationale on VirtualList). Chat-history
virtualization is carved out as MOB-MEDIUM-015 below.

### MOB-MEDIUM-015 — ChatRoomPage message-list virtualization needs browser-verified delivery
The chat DOM is bounded only by user-driven pagination (each "load older" adds
a page; a determined scroll mounts thousands of nodes). Virtualizing it means
rewriting reverse-scroll anchoring (scrollHeight-delta restoration on prepend),
at-bottom detection feeding the read-cursor advance (Wave-6 M2), and optimistic
send pinning — semantics that CANNOT be verified blind: they need the
messaging-smoke Playwright lane (this branch) running against a live stack.
OWNER: messaging-expert lane / aquamobil maintainers. DEADLINE: 2026-08-15.
STATUS: OPEN. Guard when delivered: extend e2e/tests/mobile/messaging-smoke.spec.ts
with a long-history scroll case.

### MOB-HIGH-013 — zero browser E2E coverage for the mobile app
The repo Playwright suite has no aquamobil/`/mobile/` reference; mobile is
validated only by unit/component specs. Fix: Faz 0.5 scaffold (login +
offline-sync roundtrip first — the guard for MOB-MEDIUM-002) + Faz 4.2 full
coverage.

### MOB-MEDIUM-016 — mobile E2E lane: CI wiring + feeding/WQ form coverage (blocked on full-stack CI env)
Plan-review finding (2026-07-13). The mobile Playwright lane exists and runs
locally/against any deployed stack (`npm run test:e2e:mobile`, 8 tests), but
CI wiring cannot mirror the water-chemistry lane as planned: that job serves
STATIC frontend builds only (`e2e/scripts/serve-water-chemistry-shell.mjs` —
the water-chemistry page is a client-side calculation engine), while the
mobile lane needs the FULL platform (Postgres, NATS, Redis, MinIO, gateway +
auth/farm/alert/messaging/ai services) which no CI job currently provides for
browser tests. Also outstanding: feeding and water-quality record-form specs
(the shipped mortality/cull specs pin the shared RecordEntityPage scaffold,
but RecordFeedingPage and the DynamicMeasurementForm WQ flow are separate
scaffolds needing feed-inventory/equipment seed helpers verified against a
live stack). OWNER: infra-expert lane (CI stack) + aquamobil maintainers
(specs). DEADLINE: 2026-08-31. STATUS: OPEN.

### MOB-LOW-017 — real-time alert push independent of FCM (gateway socket bridge)
The CriticalAlertBanner is fed by the 30s alertHistory poll + FCM foreground
pushes. Neither `/farms` nor `/sensors` socket namespaces bridge tenant-level
`AlertTriggered` events, so a device without FCM (no Firebase config, denied
notification permission) sees a new critical alarm only on the next poll tick
(≤30s). Enhancement: a NATS→socket.io bridge in the gateway following the
`farm-nats-bridge.service.ts` pattern. OWNER: alert-engine/gateway
maintainers. DEADLINE: 2026-09-15. STATUS: OPEN (explicitly optional for the
MVP — the poll + push lanes ship in this cycle).

## Verified clean (for the record)
No `as any`/ts-suppressions in production source; auth/tenant handling solid
(single-flight 401 refresh, tenant-partitioned encrypted queue); AI insight
queries all resolve against farm-service; record-form error surfacing
disciplined; offline replay idempotent and tenant-scoped.
