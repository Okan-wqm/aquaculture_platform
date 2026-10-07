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
- The demo template stores `24h`, the range it rendered.
- Every layout input that writes widgets (`saveDashboardLayout` and the
  system-default layout) rejects a widget whose `timeRange` is not a preset;
  a spec reads the validation metadata so a new input cannot skip the check.
- Layouts stored before that check can still hold any JSON. The dashboard
  parses each widget's range where the layout enters the page
  (`useDashboardLayout`); a value that is not a preset becomes the named
  default (`DEFAULT_WIDGET_TIME_RANGE`), is shown as such in the editor, and
  is saved back as such. No chart receives an unparsed range, so
  `presetDurationMs` never meets one. Production holds 0 layout rows.
- The SCADA trend widget's editor and renderer read its range through one
  function (`trendWidgetRangeOf`), so they agree on `defaultRange` and the
  older `timeRange` key.
- The range captions, the toolbar's custom-range strings and the readings
  page's selector name come from the locale maps; the "too long" error takes
  its day count from the same cap the check enforces.

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
- `dashboard-layout.dto.validation.spec.ts` covers the layout input check
  and fails when any widget-writing input lacks it (checked by removing it
  from the system-default input).
- `useDashboardLayout.time-range.test.ts` fails when a stored range reaches
  the page unparsed (checked by removing the parse from one load path).

An independent review of the first version of this change found:

- the unchecked system-default write path and the unparsed load;
- easy evasions of the invariant: named duration constants, label records,
  `Map` entries, `<option>` lists, minute fields, and files directly under
  `src/` that its git pathspec skipped;
- the remaining English and Turkish literals.

All are fixed above. The invariant's exemptions are now pinned to the exact
keys each file holds, and the review's evasions are fixtures it must flag.
The same pathspec fault is fixed in `sensor-tier-policy-ssot.spec.ts`.

Kept apart on purpose:

- `RuntimeChart.tsx` offers the width of its live rolling buffer (1 to 240
  minutes), not a history range; only `1h` overlaps the range table.
- `PerformanceDashboardPage.tsx` in the admin panel ranges platform
  metrics, not sensor readings.

Deploy note: shared-ui is a federation singleton pinned at one version, so
the shell and sensor-module must ship together.

## SENSOR-HIGH-153 — invented numbers on two routed pages

Found while folding the ranges. Two routed sensor pages showed generated
values as if measured:

- `/sensor`: the SCADA page's trend panel read `useScadaTrend`, which never
  queried and drew a random walk from `generateMockData`. It passed process
  node ids as tag names, so no real data could ever have reached it.
- `/sensor/analytics`: fixed totals, per-type counts and pond health scores,
  with a 7/30/90-day selector wired to nothing.

Closed in phase 3c:

- The trend panel and `useScadaTrend` are removed. The SCADA page's trend
  button now opens `/sensor/readings`, where the channel series is real.
- The analytics page, its route and the dashboard link to it are removed.
  Real analytics need real aggregates, and a page of invented numbers is
  worse than no page.
- The time-range invariant drops its exemption for the analytics page.

The other exemption, `DaqConfigPanel.tsx`, is not a chart range: its keys are
the DAQ sampling and retention vocabulary.
