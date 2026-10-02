# Web shell, microfrontends and AquaMobil — production readiness review (2026-10-02)

| Field | Value |
| ----- | ----- |
| Date | 2026-10-02 |
| Reviewer | `frontend-expert` (read-only specialist, dispatched by the orchestrator) |
| Question | What blocks this repository from going to production? |
| Scope | web/shell, shared-ui, the 8 federated remotes, web/apps/aquamobil (offline PWA) |
| Verdict | **NOT READY** |
| Method | Independent read-only review; claims cite file:line as the reviewer reported them. Items the orchestrator re-checked are marked in the verification section. |

Two blockers. Sensor pages show fabricated readings as if they were real, and AquaMobil silently
deletes unsynced field records.

## Blockers

- **B1. Fake sensor data in production navigation.**
  - `/sensor/readings` shows random values, with warning/critical status computed from those
    values, for real registered sensors
    (`sensor-module/src/pages/ReadingsPage.tsx:177-217,505-533`).
  - The `/sensor` index trend panel shows random points marked `quality:'good'`
    (`hooks/useScadaTrend.ts:171-174`, used at `SensorScadaPage.tsx:60`).
  - `/sensor/water-chemistry` runs on mock fixtures (`WaterChemistryMonitoringPage.tsx:14`, nav at
    `MainLayout.tsx:348`).
- **B2. AquaMobil loses queued data.**
  - Logout wipes every unsynced op without warning (`hooks/useAuth.tsx:194-195`; the
    `AccountPage.tsx:704-707` confirm text does not mention pending ops; `HomePage.tsx:175-176` is
    a one-tap icon logout).
  - Any refresh failure, including a transient network error, triggers logout and the wipe
    (`authenticated-fetch.ts:165-170`, `useAuth.tsx:637-638`). Refresh tokens last 7 days, so a
    worker offline longer than that loses the whole queue on reconnect.
  - Starting the app while offline cannot restore the session (`useAuth.tsx:300-301`).

## Major

- **M3. The offline queue is keyed by tenant, not user** (`offline-queue.ts:349`). On a shared
  device, user B's login replays user A's queued records under B's identity.
- **M4. The shipped CSP breaks features.**
  - AquaMobil's `camera=()` kills barcode scanning (`BarcodeScanButton.tsx:53`).
  - `script-src 'self'` plus `connect-src 'self' wss:` break FCM push
    (`public/firebase-messaging-sw.js:40`) and block the inline theme script (`index.html:8`).
    Header: `security-headers.conf:21-22`.
  - Shell CSP has no `unsafe-eval`, so the SCADA script worker's `new Function` fails
    (`workerScript.ts:282`). Shell CSP: `droplet.conf:197`.
- **M5. The remote-integrity (SRI) check does nothing.** Remotes are `type:'module'`
  (`shell/vite.config.ts:31`), which the federation runtime loads with `import()`, not a script
  tag, so the guard never sees them. The prod deploy never generates the hash file
  (`deploy-digitalocean.yml:765`), and the hash tooling leaves out messaging-module
  (`generate-sri-hashes.sh:51-59`, `ci-full.yml:362,375-383`).
- **M6. Token exposure.** The raw access token sits as a mutable property,
  `window.__AQUACULTURE_AUTH_STATE_V2__.accessToken` (`api-client.ts:226-253`). The shell
  `script-src` allowlists `cdn.jsdelivr.net`, which no app code uses: a known CSP bypass.
- **M7.** Module-user sidebar items `/analytics` and `/reports` have no route and land on the 404
  page outside the layout (`MainLayout.tsx:463-474` vs `App.tsx`).

## Minor

- Edge `no-store` applies to every remote chunk, so nothing caches (`droplet.conf:494-556`).
  Lighthouse only audits the login page, has no assertions, and uploads reports to public storage
  (`performance-benchmark.yml:113-118`). The farm bundle limit only warns.
- A failing remote degrades per route, not to a white screen. But "Retry" cannot recover because
  `React.lazy` keeps the failed import, and nothing reports errors (`ErrorBoundary.tsx:56`). There
  is no `errorLoadRemote` hook.
- Accessibility: AquaMobil disables pinch-zoom (`index.html:19`, WCAG 1.4.4), the logout icon
  button has no label, farm "Coming Soon" tooltips are hover-only (`SetupPage.tsx:153-176`), and
  CI has no axe checks.
- Admin API types: `openapi.json` responses are untyped objects. Of 5 spot-checked calls,
  `getDashboardSummary` matches the backend; `getKpiComparisons`, `getTenantChurn`,
  `getFinancialMetrics` and `getSystemAnalytics` do not, but no page uses them.
- **messaging-module** is no longer a scaffold. It is in the nav (`MainLayout.tsx:204,458`) but
  text-only: media renders as placeholder labels and you can only create AI channels.
- **Stubs reachable from navigation: about 11.**
  - The 3 mock-data pages above and the 2 dead nav links.
  - 18 HR placeholder routes, some linked (`DepartmentsPage.tsx:324`).
  - 2 dashboard "view all" buttons that do nothing.
  - 5 "coming soon" items across farm, hydroponics and sensor.
  - A search that does nothing.

## Registry

- **FE-HIGH-150: CONFIRMED, past its 2026-09-25 deadline.**
  - `AiChatPage.tsx:94-95` still trusts `metadata.isAi`, and `useAiChat.ts:157-171` builds
    proposal cards without checking the sender.
  - `ai-identity.spec.ts` is gone.
  - The backend passes client metadata through unchanged (`send-message.handler.ts:316`), even
    though `message.entity.ts:127` says it is stripped.
- **FE-HIGH-079: STALE.** Sensor, HR and tenant-admin now use `<Button>` about 790 times; design
  debt only.
- **FE-HIGH-089: CONFIRMED, partly stale.** `<html lang>` is now set at runtime
  (`localePreference.ts:58`), but mixed-language literals remain (e.g. `OverviewWidgets.tsx:306`).
- **FE-MEDIUM-093: CONFIRMED** (`PrintScheduleButton.tsx:52-54`), not a blocker.
- **FE-CRITICAL-001 (resolved): still holds.** No bare query keys found.

## Not verified

- Read-only review: no builds, tests or browser were run, and `node_modules` is not installed. The
  `import()` loading of remotes is from knowledge of the federation runtime, not checked in local
  source. Blob-worker CSP inheritance and Lighthouse scores are untested, and it is unknown
  whether the performance workflow is a required check.

## Registry entries

This review appended 8 finding(s) to `docs/reviews/_registry/findings.jsonl` (state OPEN, owner
okan). Findings the review only confirmed, such as ALERT-CRITICAL-009 or the INFRA-CRITICAL
deploy-pipeline cluster, already exist and were not re-filed.

| ID | Severity | Title |
| --- | --- | --- |
| FE-CRITICAL-159 | CRITICAL | Fake sensor data is shown as real in production navigation: /sensor/readings renders random values with warning/critical status computed from them for real sensors, the /sensor trend panel plots random points marked quality good, and /sensor/water-chemistry runs on mock fixtures |
| FE-CRITICAL-160 | CRITICAL | AquaMobil silently deletes unsynced field records: logout wipes every queued op without warning, any token refresh failure including a transient network error triggers logout and the wipe, refresh tokens last 7 days so a long-offline worker loses the whole queue on reconnect, and starting offline cannot restore the session |
| FE-HIGH-161 | HIGH | The AquaMobil offline queue is keyed by tenant, not user, so on a shared device user B's login replays user A's queued records under B's identity |
| FE-HIGH-162 | HIGH | The shipped CSP breaks features: AquaMobil camera=() kills barcode scanning, script-src self plus connect-src self wss: break FCM push and block the inline theme script, and the shell CSP has no unsafe-eval so the SCADA script worker's new Function fails |
| FE-HIGH-163 | HIGH | The remote-integrity (SRI) check does nothing: remotes are type module so the federation runtime loads them with import() and the guard never sees them, the production deploy never generates the hash file, and the hash tooling leaves out messaging-module |
| FE-MEDIUM-164 | MEDIUM | The raw access token is a mutable window property and the shell script-src allowlists cdn.jsdelivr.net, which no app code uses and which is a known CSP bypass |
| FE-MEDIUM-165 | MEDIUM | Module-user sidebar items /analytics and /reports have no route and land on the 404 page outside the layout, and about 11 stubs are reachable from navigation (18 HR placeholder routes, two dead dashboard "view all" buttons, five "coming soon" items, a search that does nothing) |
| FE-LOW-166 | LOW | Frontend hygiene: edge no-store applies to every remote chunk so nothing caches, Lighthouse audits only the login page with no assertions, a failed remote cannot recover via Retry because React.lazy keeps the failed import, AquaMobil disables pinch-zoom, and CI has no axe checks |
