# /sensor/widgets — widgets read through the nine-parameter projection (2026-10-06)

Follow-up to `2026-10-06-sensor-readings-channel-generic.md` (SENSOR-HIGH-138),
which added the channel-generic reads `channelLatestValues` and
`channelSeries`.

## SENSOR-HIGH-142 — widgets cannot show a channel outside the nine parameters

A widget stores its selection as `selectedChannels` (channel id, channel key,
sensor id). `useWidgetData` resolved those through `latestReadingsBatch` and
`aggregatedReadings`, whose payload is the fixed nine-parameter
`SensorReadings` shape, and looked the value up by channel key. A channel such
as conductivity, ORP or a vendor key therefore never produced a value, and
every value that did appear carried the constant status `normal`.

`WidgetDashboardPage` also read a layout from `localStorage` and passed it,
with a change handler, to `GridStackDashboard` — which declares both props and
uses neither. Layouts persist only through `useDashboardLayout`
(`dashboard_layouts`), so the page's storage path was dead.

Fix: the selected-channel path reads `channelLatestValues` /
`channelSeries`, matches by channel id and maps the channel's alert level to
the widget status; the dead raw-history fallback goes with it. The page and the
component drop the unused layout props. The legacy `sensorIds + metric` widget
configuration keeps its existing reads.
