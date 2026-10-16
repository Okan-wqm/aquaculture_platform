# /sensor/readings Charts — Operator Report (app.suderra.com, 2026-10-16)

Operator symptoms, verbatim: _"burada oluşan grafikler aşağı doğru uzuyor;
parametreler mqtt ile gelen kanallar aynı grafikte üst üste biniyor"_ — and in the
follow-up: readings should appear the moment data arrives (not on a refresh), each
parameter on its own chart, time on the x-axis. All three verified in the deployed
frontend (build `6f2a49573`, = `origin/main` at review time).

## FE-HIGH-330 — TrendChart grew without end (ResizeObserver feedback loop)

**Where:** `web/modules/sensor-module/src/components/charts/TrendChart.tsx` (render).

**Root cause chain (each link verified):**

1. TrendChart's root carried `h-full` alongside the caller's `h-64`. In compiled
   Tailwind v4 CSS, `.h-full { height: 100% }` is emitted AFTER `.h-64 { … }`
   (verified in the module's built `dist/assets/index-*.css`), so `h-full` wins and
   the caller's height is silently dead.
2. `height: 100%` against the card's auto-height parent computes to auto → the box
   is content-sized.
3. The uPlot mount div was flow-positioned (`flex-1 min-h-0`) inside that
   content-sized box. uPlot's root = the sized wrap + the legend rendered below it,
   so the mount div's height = chart height + legend height.
4. The ResizeObserver read the mount div's `contentRect.height` (chart + legend)
   and fed it back as the CHART height (`setSize`). Next notification: chart =
   previous chart + legend → grows by ~one legend row per cycle, forever.

**Symptom:** every chart on the page stretched downward continuously.

**Fix (Tier 1 — structurally impossible):** the root no longer carries `h-full`
(the caller's className is the only height source), and the mount div is
box-positioned (`absolute inset-0`) — its contentRect is the assigned box and can
never depend on the uPlot root it hosts, so the feedback path no longer exists.
Pinned by `src/components/charts/__tests__/trend-chart-layout.test.tsx`.

## FE-HIGH-331 — MQTT channels drawn on one chart, overlapping

**Where:** `web/modules/sensor-module/src/components/charts/MultiParameterTrendCard.tsx`.

Every channel of a sensor was drawn as a series on ONE uPlot chart with only two
y-scales (`unitScaleGroup`: °C → axis 1, everything else → axis 2). A multi-parameter
MQTT sonde (pH ~7, DO ~8 mg/L, salinity, turbidity, conductivity in thousands of
µS/cm, …) put every non-temperature channel on axis 2, whose auto-range the
largest-magnitude channel dominated — the small-value parameters collapsed into one
indistinguishable bundle at the bottom ("üst üste biniyor"). Compounding it, the
hand-rolled `PALETTE` repeated `primary[700]` at index 4 (and `primary[600]` at 5), so
from the fifth channel on, lines shared literal colors.

**Fix:** one chart per parameter — a responsive grid of small multiples, each with
its own y-axis auto-scaled to its own data, shared time axis (uPlot cursor sync
ties them together), threshold zones kept per chart. Colors fall back to the
design-system `chartPalette` (10 distinct tokens) instead of the duplicate array.
API unchanged, so the water-chemistry point panel (single-channel use) is untouched.

## FE-MEDIUM-332 — values appear only at the 30 s poll, not on arrival

**Where:** `web/modules/sensor-module/src/pages/ReadingsPage.tsx` +
`web/modules/sensor-module/src/hooks/useChannelReadings.ts`.

The page learned about new readings only via `refetchInterval: 30_000`, although the
platform already pushes every persisted reading (MQTT ingest → `SensorReading` on
NATS → gateway-api `sensor-readings.gateway` → Socket.IO `/sensors`).

**Fix:** `useChannelReadingsRealtime` subscribes the page's sensors and, on each
push, invalidates the tenant-scoped `channel-latest-values` / `channel-series` /
`channel-data-bounds` queries (throttled to 2 s so a sonde's multi-channel burst is
one refetch round). The push is a signal, not a value source — the server stays
the SSoT for calibrated values, quality codes and alert levels. The poll
intervals remain as the socket-outage fallback.

## Verification

- `vitest run` (sensor-module): 90 files / 1439+ tests green, including the new
  `trend-chart-layout`, `use-channel-readings-realtime` and the reworked
  `MultiParameterTrendCard` suites.
- `tsc --noEmit -p web/modules/sensor-module/tsconfig.json`: clean.
- `eslint src` (sensor-module): clean.
