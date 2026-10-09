# /sensor/readings — fabricated values and no channel-generic read model (2026-10-06)

Operator report: `/sensor/readings` shows only a water-temperature value for
`Codex Su Sıcaklığı Simülatörü` (WT-CODEX-01), whose five data channels
(temperature, pH, dissolved oxygen, salinity, ammonia) all had stored rows.

## SENSOR-HIGH-138 — the readings page invents values; reads cannot address a channel

`ReadingsPage.tsx` rendered `generateMockReading()`: a `Math.random()` value
per sensor TYPE, regenerated every 30 s, with a random trend arrow. The page
listed sensors, not channels, so a single-row sensor of type `temperature`
with five `sensor_data_channels` showed one invented temperature. Its period
selector and "Dışa Aktar" button were wired to nothing.

The backend could not have fed a channel view either: `SensorReading` and
`AggregatedReadingType` carry a fixed nine-parameter vocabulary, so a channel
outside it (conductivity, ORP, CO2, a vendor key) is unreadable. In the
mock-generator's render loop the page also never settles under test.

`SensorDataChannel.getAlertLevel` compared stored `null` bounds with
`!== undefined`; `value < null` coerces null to 0, so any negative reading on
a channel without a low bound (ammonia) was classified critical.

Fix: `channelLatestValues(sensorIds)` and `channelSeries(sensorId, range)` read
by channel through `runInTenantRead`; the page renders one tile per enabled
channel with its stored value, alert level and age, a trend over the selected
period, and a CSV export of the shown values. Threshold bounds are typed
`number | null` and compared with `!= null`.

## SENSOR-MEDIUM-139 — three copies of the metric tier selection, two of them dead

`SensorQueryService` (live), `MetricQueryService` (no module registers it) and
`TimeBucketService` (registered, never injected) each choose between
`sensor_metrics`, `metrics_1min`, `metrics_1hour` and `metrics_1day`, with
different thresholds (1 h / 24 h / 30 d versus 2 h / 7 d / 90 d). Both dead
copies select a `quality_pct` column the rollups do not have, and
`MetricQueryService.getCurrentReadings` reads `alert_thresholds->>'criticalLow'`,
a key the stored `{warning,critical}.{low,high}` shape never contains.

Fix: the tier rules move to `sensor/services/metric-source.ts`, used by the
nine-parameter projection and the channel reads alike; the two dead services
and their specs are deleted.
