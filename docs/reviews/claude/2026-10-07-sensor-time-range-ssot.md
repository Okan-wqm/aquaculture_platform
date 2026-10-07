# Sensor-reading time range — one owner (2026-10-07)

Phase 3a of the sensor-history plan. It builds on the tier policy
(SENSOR-MEDIUM-149) and the series contract (SENSOR-HIGH-150/151).

## SENSOR-MEDIUM-152 — range durations and words copied per surface

Before this change, eight browser places each kept their own table:

- the readings page: `PERIODS` in `readingsModel.ts`, Turkish labels;
- the widget dashboard: `getTimeRangeMs` in `useWidgetData.ts` and a second
  copy in `HeatmapWidgetContent.tsx`, English labels in `dashboard/types.ts`;
- the SCADA charts: `PRESET_MS` in `useTrendData.ts`, `PRESETS` in
  `ChartToolbar.tsx`, a third map in `ChartExport.tsx`;
- the SCADA trend widget: `TIME_RANGES` in `trendChartUtils.ts` and its own
  option list in `TrendChartConfig.tsx`.

Each copy invented its own answer for a value it did not know: the widget
data hook and the toolbar fell back to 1 h, the trend widget to 24 h. The
built-in RAS demo template stored `defaultRange: '4h'`, which no widget
offers, so it silently rendered 24 h. The SCADA `custom` token carried no
window, so one resolver returned null and the others substituted 1 h.

Fix:

- `libs/shared-contracts/src/sensor-readings/time-range.ts` holds every
  preset and its duration, the SCADA tokens as names for those presets, the
  relative-or-absolute range shape, its check against the tier policy's cap
  (the same number the backend enforces), and its URL form.
- The words live in the locale maps; `useTimeRangeLabels` in shared-ui gives
  the full, short and custom labels and the range errors in the user's
  language.
- Every surface takes its list from a typed subset of the presets
  (`READINGS_PRESETS`, `WIDGET_TIME_RANGE_PRESETS`, `TREND_WIDGET_PRESETS`)
  and its durations from the table; values read from storage are parsed,
  not cast.
- A fixed SCADA window is a `{ from, to }` pair. `custom` is no longer a
  range value, so every resolver always has a window.
- The demo template stores `24h`, the range it actually rendered.
- `saveDashboardLayout` rejects a widget whose `timeRange` is not a preset.

Behaviour is unchanged for every stored or offered value: golden tables in
`sensor-time-range.spec.ts` and `trend-time-range.test.ts` pin the old
durations and windows.

Proof:

- `tests/invariants/sensor-time-range-ssot.spec.ts` fails on any file in
  sensor-module or shared-ui that maps two or more range keys to a duration
  or a label of its own. It also checks that it still recognises each shape
  the removed copies took. It found two more tables besides the eight; both
  are exempted by name with a reason (see below).
- `trend-time-range.test.ts` fails when a built-in template stores a range
  its widget does not offer (checked by restoring `'4h'`).
- `dashboard-layout.dto.validation.spec.ts` covers the layout input check.

## SENSOR-HIGH-153 — invented numbers on two routed pages (open)

Found while folding the ranges. Two routed sensor pages show generated
values as if measured:

- `/sensor`: the SCADA page's trend panel reads `useScadaTrend`, which
  never queries and draws a random walk from `generateMockData`.
- `/sensor/analytics`: fixed totals, per-type counts and pond health scores,
  with a 7/30/90-day selector wired to nothing.

Not in this change. Polishing the analytics selector's labels would dress up
a page whose data is invented. Owner: claude. Deadline: 2026-10-21. Planned
closure: phase 3c moves the trend panel onto `channelSeries` and either backs
the analytics page with real aggregates or removes its route. The time-range
invariant exempts `SensorAnalyticsPage.tsx` under this ID until then.

The other exemption, `DaqConfigPanel.tsx`, is not a chart range: its keys are
the DAQ sampling and retention vocabulary.
