# 2026-10-14 — /sensor/readings client crash: root cause + SSOT guard-family restoration

**Owner agent:** zcode · **Cycle:** 2026-10-14-sensor-readings-crash

## Incident

`https://app.suderra.com/sensor/readings` rendered briefly, then the whole
module area was replaced by the shell's English error card ("Failed to Load
Sensor — An unexpected error occurred…"). Every network dependency was green
(assets 200, GraphQL 200, gateway/sensor-service logs clean), so the shell
ErrorBoundary had caught a render-phase exception — invisible in production
(DEV-only display, no telemetry).

## Root cause (proven, headless-Chromium repro on production)

A seeded TENANT_ADMIN probe with a real browser crashed deterministically
5 s after mount. The console carried the exact exception:

```
Error: useDataProvider() must be called inside a <DataProviderRoot> tree.
    at …/remotes/sensor-module/assets/ReadingsPage-7uKJ4srR.js
```

The chain: `ReadingsPage → SensorReadingsCard → MultiParameterTrendCard →
TrendChart` — and `charts/TrendChart.tsx` unconditionally called
`useRealtimeData`/`useTrendData`, whose `useDataProvider()` deliberately
throws outside the SCADA `DataProviderRoot`
(`providers/DataProviderContext.tsx:40`). TrendChart was born in the SCADA
Wave-2 commit `a5b510c93` with three modes; its ONLY consumer adopts
`mode="custom"` (`0b29f0e68`), whose data is pre-fetched — the provider-fed
realtime/history paths are dead weight with zero production consumers (SCADA
screens use their own renderers). The crash fired whenever the trend card
first mounted (data-dependent, hence the victim's 60–90 s timing).

## Fixes (this PR)

1. **Root cause — TrendChart loses the provider paths.** The dead
   realtime/history modes (hooks, buffer, toolbar, banners) are removed;
   TrendChart is the pure presentation chart its only consumer needs.
   Misuse is now impossible, not merely discouraged.
2. **Amplifier/perf — uPlot no longer rebuilt every second.**
   `options = {}` created a new identity per render feeding the memo deps,
   and the card's inline `channels.map` defeated the `lines` memo: with
   ReadingsPage's 1 s `useNow` re-render the chart was destroyed and
   recreated ~60×/min. Fixed by a module-level `DEFAULT_CHART_OPTIONS` and a
   memoized `chartChannels` projection. (Accelerator, not the cause — a
   session survived 13+ min with the same amplifier.)
3. **Guard family restored (SSOT, not a third variant).** The quarantined
   dalga3-15 family is surgically re-applied from
   `aria-karantina/kapsam-iadesi/dosyalar/web/shared-ui/src/components/guards/`
   (9 files, 40/40 spec) with three main-gate conformance deltas: theme
   tokens + dark twins, `guards.*` i18n keys, lucide icon. The
   `components/index.ts` guards block and the sensor `Module.tsx` mount were
   applied MANUALLY — `git apply` is impossible (blob mismatch:
   `37ca163fb≠9f4f969b6`).
4. **Per-route containment.** New `guards/RouteWithBoundary` COMPOSES the
   family boundary (no new class); the readings route mounts it first, the
   module-level boundary is the backstop, the host boundary stays last.
5. **Observability + recovery.** errorId (single `randomId` util) +
   last-response correlation id (single api-client capture) on the card,
   retry budget 3 + `queryClient.resetQueries`, `logError` as the single
   web logger wired to the default `onError`. Body text reuses the
   ERROR_MESSAGES SSOT; no new generic message.
6. **Shell boundary convergence.** `web/shell/src/components/ErrorBoundary`
   is now a re-export of the family class (mount points unchanged).
7. **Design-ratchet repair.** Three regex artifacts over pinned ceilings
   (farm `Module.tsx` comment/generic `>text<` shapes, shell `MainLayout`
   comment) fixed at the source; ceilings lowered where strings were really
   removed (shell 153→149, sensor-module 3172→3170) — the sanctioned
   migrate-and-lower direction. `invariants-fast` is green again on this
   branch.

## Quarantine provenance (first 16 hex of SHA-256)

`ErrorBoundary.tsx 52d5d79012891e62`, `GuardLoading.tsx e8b1ab7527f04883`,
`RequireAuth.tsx 8b11d2201040b401`, `RequireCapability f377314c4c252abf`,
`RequirePlatformAdmin 9bd1581f18e0fba1`, `RequireRole 318841d5f0448d47`,
`RequireTenantPanel e680955ff3e7519d`, `index.ts 763d713e270960bf`,
`guards.spec.tsx 08245c2478a475a2` — verbatim except the two files carrying
the declared deltas. The restore decision follows the quarantine's own
inspector verdict (`uygulama/kapanis-01-kanit-mufettisi.md`): the
scope-return was a process operation, and the work is "re-appliable through
a reviewed PR".

## Findings

- **FE-HIGH-324 — no in-module crash isolation in federated remotes.** Closed
  here (restore + RouteWithBoundary + shell convergence).
- **FE-HIGH-325 — /sensor/readings crash: TrendChart's provider-hook
  dependency.** Closed here (root-cause removal, repro-proven).
- **INFRA-MEDIUM-221 — frontend dist-provenance not verified** (artifact
  marker checked for backend only; DEPLOY.md bans manual builds yet the CI
  image chain is repo-red, forcing local builds). OPEN, owner okan,
  deadline 2026-10-28; direction: extend CI provenance verification to
  frontend images.
- **FE-MEDIUM-326 — TrendChart uPlot amplifier.** Closed here.
- **FE-MEDIUM-327 — design-ratchet drift over pinned ceilings.** Closed here.
- **FE-MEDIUM-328 — guard/boundary SSOT convergence leftovers** (tenant-admin
  local gates + rich boundary, hr SchedulingErrorBoundary dead code).
  OPEN, deadline 2026-10-28.
- **FE-MEDIUM-329 — api-client carries two private randomUUID copies**;
  converge on `utils/random-id`. OPEN, deadline 2026-10-28.

Registered IDs: FE-HIGH-324, FE-HIGH-325, INFRA-MEDIUM-221, FE-MEDIUM-326,
FE-MEDIUM-327, FE-MEDIUM-328, FE-MEDIUM-329.
