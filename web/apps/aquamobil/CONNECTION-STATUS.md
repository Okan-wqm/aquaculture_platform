# AquaMobil — Connection & Backend Status (SSoT document)

> Living document. Every UI surface states: its data source (REAL GraphQL /
> device capability / UNWIRED-awaiting-backend), its verified read/write state,
> and where the evidence lives. Update it whenever a surface changes wiring.
>
> Last full verification: 2026-09-17 (live walkthrough on
> https://89.38.97.90:8443/mobile with a tenant-admin field account,
> plus `scripts/validate-e2e.mjs` gates against the same gateway).

## How to re-verify (the standing rule)

1. `NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/validate-e2e.mjs \
     --base https://89.38.97.90:8443 --email <e> --password <p> --with-write`
   covers auth → read → create → update → archive for the feeding protocol
   path (including the `fcrSource` enum wire format).
2. Walk the app with the same account; the table below says what each screen
   MUST show.

## Platform facts that shape "connected"

- **Auth**: login mutation → RS256 access token (short TTL) + httpOnly refresh
  cookie; silent refresh mutation on 401 and on boot (`restoreSession`).
  Login rate limit: **5 attempts / 15 min per identity** — scripted testing
  must budget for it.
- **Offline queue**: every record op is enqueued with the at-most-once command
  envelope (`clientCommandId`/`payloadHash`/`deviceId` — declared on
  `MobileCommandEnvelopeInput`, attached in `pwa/offline-queue.ts`). While
  online, the auto-sync effect drains within ~1s of enqueue; no service worker
  required. Background Sync (closed-app drain) requires a registered SW.
- **Service worker / PWA**: `https://` with a **self-signed certificate cannot
  register a service worker in Chromium/Safari** — by-IP deployments get the
  app shell and full online function, but no install prompt, no Background
  Sync, no push. A domain + trusted cert is the prerequisite for the full PWA
  feature set (tracked below as ENV-LIMITED).

## Per-surface status

| Surface | Route | Data source | Read | Write | Notes |
|---|---|---|---|---|---|
| Today hub | `/` | REAL (alerts, tasks, notifications, KPIs, stock snapshot, AI insights via ai-service) | ✅ verified | n/a | Notifications had a boot-race tenant-header bug — FIXED 2026-09-17 (token-claim SSoT in `authenticated-fetch.ts`) |
| Units | `/units` | REAL (`farmStockInventory`) + VFD drives | ✅ verified | n/a | Drive cards query the feeder/VFD schema — UNWIRED until the v4 backend (migrations 18089+) deploys; note in `useVfdDrives.ts` |
| Operations hub | `/operations` (+daily/staff/stock) | REAL (ops counts, attendance, stock events summary) | ✅ verified | attendance/leave writes via queue | |
| Record mortality | `/mortality/record` | REAL (`recordMortality` mutation + command envelope) | ✅ tank/batch list live | ✅ e2e-verified (see below) | Reason enum NAMES wire format |
| Record cull | `/cull/record` | REAL (`recordCull`) | ✅ form loads | see walkthrough | Same envelope |
| Record harvest | `/harvest/record` | REAL (`createHarvestRecord`) | ✅ form loads | see walkthrough | |
| Record transfer | `/transfer/record` | REAL (`transferBatch`) | ✅ form loads | see walkthrough | |
| Record feeding | `/feeding/record` | REAL (`recordMealFeeding` meal cutover) | see walkthrough | see walkthrough | Offline-cache + queue |
| Water quality | `/water-quality/record` | REAL (`createWaterQuality`, probe/manual per parameter) | see walkthrough | see walkthrough | |
| Lice / welfare / escape | `/lice/record`, `/welfare/record`, `/escape/record` | REAL regulatory record mutations | see walkthrough | see walkthrough | |
| Tasks | `/tasks` | REAL (`myTasks` + lifecycle mutations with envelope) | ✅ (empty list) | task actions e2e-tested in suite | |
| Reports | `/reports` | REAL (`reportDeadlines` drafts, approve live-only) | see walkthrough | online-only by design | |
| Alerts / Notifications | `/alerts`, `/notifications` | REAL | ✅ (empty) | acknowledge | Notifications fixed (boot race) |
| Messaging | `/messages` (+ai) | REAL (channels/messages + Suderra Assistant via ai-service) | see walkthrough | send via queue + binary lane | |
| Storage | `/storage*` | REAL (stock view/movement/transfer) | see walkthrough | queue writes | |
| Drives | `/drives` | REAL VFD queries — ENV: needs v4 backend | partial | start/stop gated | UNWIRED note in hook |
| Schedule/attendance/leave | `/schedule`, `/attendance`, `/leave` | REAL (HR service) | see walkthrough | queue writes | |
| Account | `/account` | REAL (profile, mobile settings incl. allowedFeatures) | ✅ | theme/lang local | |
| Scan | `/scan` | DEVICE capability (native `BarcodeDetector` + manual fallback) | n/a | n/a | Not mock — device API |
| Sync status | `/sync` | REAL (queue drain state) | ✅ | manual sync | |
| Login | `/login` | REAL | ✅ | — | Web-login miniature; NO client-side password length gate (server SSoT) |

## Verified end-to-end (evidence log)

- 2026-09-17 `validate-e2e.mjs --with-write` vs live gateway:
  login ✓, feedingDayPlans read ✓, protocol create (fcrSource=MATRIX +
  fcrMatrix) ✓, update ✓, archive cleanup ✓.
- 2026-09-17 UI walkthrough (same account): Today/units/operations/record
  forms load real tenant data; mortality/cull/harvest/transfer tank+batch
  selects populated from `farmStockInventory`.
- 2026-09-17 UI walkthrough (same account, deployed app): all record forms
  (mortality/cull/harvest/transfer/lice/welfare/escape/water-quality/feeding)
  load REAL tank/batch/equipment lists; tasks/reports/alerts/messages
  (5 live conversations)/storage-view/schedule/attendance/leave/account/drives
  all render real data or honest empty states.
- 2026-09-17 MORTALITY WRITE, full loop on the deployed app: UI submit →
  queue → auto-sync ("Last synced: Just now / All Synced") → mobile
  Stock Events shows the record → **web path (`equipmentList`) reads
  pieces 1660→1657, totalMortality 86→89, lastMortalityAt=2026-09-17**.
  Cross-device update CONFIRMED.
- ROOT CAUSE fixed on the way: `queueOperation` awaited
  `navigator.serviceWorker.ready`, which NEVER settles on origins with an
  untrusted certificate — every record submission hung on "Recording..."
  forever (this was the "kayıtlar yapılamıyor" bug). Now raced with a 3s
  timeout; Background Sync is skipped when no SW is ready and the in-app
  auto-sync drains the queue.

## Known gaps (honest inventory)

1. **VFD/feeder surfaces** — real queries, backend not yet deployed on this
   droplet (v4 migrations). Graceful empty/error states by design.
2. **Full PWA (SW, install, push, Background Sync)** — ENV-LIMITED: needs a
   trusted certificate (domain). In-app online sync works without the SW
   (and recording no longer hangs without one — see the fix above).
3. **Storage hub** (`/storage`) — renders an error card while
   `/storage/view` works; underlying query failure not yet root-caused
   (open item, 2026-09-17).
4. **Residual "Tenant ID is required"** — one GraphQL caller still fires
   pre-tenant at boot despite the token-claim header SSoT fix and the
   `enabled` gates in `useNotifications` (both verified). Believed to be a
   different consumer; harmless to data but noisy. Open item.
5. **HR surfaces** show "Employee record not found for current user" for
   accounts without an HR employee row — honest empty, by design.
3. **Tablet board** (`/board*`) — three-column control board wired through
   the single `AppShell` viewport seam; post-login capture pending (login
   rate-limit budget), architecture verified in code + tests.
