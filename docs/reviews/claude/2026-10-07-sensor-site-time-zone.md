# A sensor chart's time zone, resolved once (2026-10-07)

Phase 3b-2 of the sensor-history plan. The owner decided on 2026-10-06 that
day buckets use the site's time zone. Two reviews (events/data and SQL)
replaced the first design, a sensor-side projection of site and tenant zones,
with a request to farm. A projection would have:

- copied farm's tenant-localization projection;
- needed a farm request for its backfill anyway;
- required a wire change that strict event schemas dead-letter.

## FARM-MEDIUM-361 — the site-zone resolver was feeding's private code

The order "the site's own zone, else the tenant's localization, else UTC"
lived inside the feeding clock. It also counted soft-deleted sites.
Nothing outside feeding could ask it, so a sensor chart could not use the
same day that feeding counts.

Fix:

- A `localization` module in farm owns the tenant-localization projection
  and `SiteTimeZoneService`, the one resolver.
  - Feeding's clock, its cron and its day-plan admin read that service.
  - The new `request.farm.resolveTimeZones` responder reads the same service.
- Only live sites answer.
- The reply names zones for the sites asked about, never a list of the
  tenant's sites.
- The contract and its trust-boundary guards live in
  `libs/event-contracts/src/farm-time-zone-queries.ts`.
- `services.yaml` grants the subject to sensor (publish) and farm
  (subscribe), and `nats.conf` is regenerated.
- The JetStream consumer of the moved listener keeps its name, which comes
  from the subject, not the class.

Proof:

- `site-time-zone.service.spec.ts` pins:
  - the order;
  - the live-site filter;
  - the many-tenant read.
- `resolve-time-zones.responder.spec.ts` pins:
  - the subject;
  - the live-site-only reply;
  - refusal of a malformed request before any read;
  - an unavailable authority reported instead of a guessed zone.

## SENSOR-HIGH-160 — series buckets aligned to UTC

Before this change, series buckets of four hours, a day and a week were
aligned to UTC, and gaps assumed 24-hour days. In a UTC+3 site a "day" held
21:00 to 21:00, and a 25-hour autumn day reported an hour-long false gap.

Fix:

- `SeriesTimeZoneService` reads the sensor's site, asks farm between two
  database reads (no pooled connection waits on NATS), and checks the answer
  against Postgres's `pg_timezone_names`, because Node and Postgres ship
  separate tz data.
  - All sensors on one zone get that zone; otherwise the tenant zone.
  - When farm cannot answer, or names a zone Postgres does not know, the
    series is shown in UTC and says so (`UNAVAILABLE`).
  - Farm's answers are cached for five minutes per tenant and site set.
- The zone is an input of the tier policy (`planSeriesRead` rule 5). A zoned
  series reads the hourly rollup instead of the UTC-bucketed daily one while
  that still holds the window's start.
  - In a zone whose offset is not a whole hour, the hours that straddle a
    local boundary come from the minute rollup.
  - Only where neither finer store reaches back do buckets stay UTC, and the
    plan says so. A policy test pins that this never happens inside the
    minute rollup's retention.
- Buckets are `time_bucket(width, t, zone)`. Each bucket's end is
  `date_add(bucket, width, zone)`, and gaps are read from real bucket ends.
- The response reports `bucketTimeZone` (the zone buckets were aligned in),
  `displayTimeZone` and `displayTimeZoneSource`. These are additive schema
  changes; the shared-ui generated types are regenerated.

Proof:

- `series-local-buckets.postgres.spec.ts` builds the production rollup DDL
  on real TimescaleDB and asserts one bucket per local day, with the day's
  real sample count and no false gaps, for:
  - Asia/Kolkata (+05:30): exactly 96 quarter-hour samples per day, through
    the hourly-plus-boundary-minute read;
  - Europe/Oslo's 25-hour day;
  - America/Santiago's 23-hour day, whose local midnight does not exist;
  - a UTC site;
  - a farm outage (shown in UTC, marked unavailable).
- Mutations fail it: the old `GROUP BY bucket`, dropping the boundary
  minutes, and a fixed-width bucket end.
- `series-time-zone.service.spec.ts` covers zone choice, the cache, farm
  failure and a zone Postgres does not know.
- The tier-policy spec covers rule 5.

The nine-parameter `aggregatedReadings` read keeps UTC buckets. Its widget
consumers move onto the channel series in phase 3d.

### Independent review → fixes

A sensor-domain review of the first version reported one high and five low
problems. Each was checked against TimescaleDB or the code, and fixed with a
test.

- **Sub-day buckets in a daylight-saving zone (reported high).** The report
  said a zoned `time_bucket` folds the repeated autumn hour at every width
  under a day.
  - Real TimescaleDB disagrees for 15 minutes and 1 hour: twelve hourly
    samples across Oslo's 25-hour day come back as twelve buckets.
  - It is right for 4 hours. Local 4-hour buckets turn into 5 and 3 hours,
    and the `date_add` end then leaves a false gap.
  - Widths under a day are now fixed-length buckets counted from the local
    midnight the window starts on: they never fold and never leave a gap.
    Local calendar buckets are kept for days and weeks.
  - The spec covers 15 minutes, 1 hour and 4 hours across the autumn hour,
    and the 4-hour case fails if calendar bucketing is restored.
- **Zone checks on every read.** Whether Postgres knows a zone is now kept
  for an hour per zone. Whether the zone is whole-hour or UTC-like is read
  from the offsets it uses over the window, not today's. This covers Lord
  Howe (+11 in summer, +10:30 in winter) and `Etc/GMT`.
- **The longest window.** A 365-day window lost local buckets in half-hour
  zones by milliseconds, because the client's now is earlier than the
  server's. The tier policy now has one retention rule with one bucket of
  slack (chunks drop whole), used by both rule 2 and rule 5.
- **`SITE` for an inheriting site.** Farm now names a zone only for a site
  that set its own, so an inheriting site reads as `TENANT`.
- **`sourceTier` with boundary minutes.** Its description now says that the
  minute store supplies the straddling hours.
- **A second pooled connection in the farm responder.** `siteZones` reads
  the tenant's zone through the caller's manager.

## SENSOR-MEDIUM-161 — a sensor's site is only format-checked (open)

Registration takes any uuid as `siteId`. It never asks farm whether the site
exists, is the tenant's, and is live, so a sensor can point at a deleted or
foreign site. Farm already answers `request.farm.validateSiteAssignment`.
Owner: claude. Deadline: 2026-10-21.

## FARM-LOW-362 — tenant localization projection (open)

`farm.tenant_localization` is written only when a `TenantUpdated` event
carries localization. Nothing backfills it from auth, and tenant erasure
leaves its row behind.

On prod (2026-10-07), auth holds no localization for any tenant and the
projection is empty, so no tenant has the wrong zone today. Owner: claude.
Deadline: 2026-10-28.
