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

## SENSOR-HIGH-160 — series buckets aligned to UTC (open, phase 3b-2b)

Series buckets of four hours, a day and a week are aligned to UTC. Gaps
assume 24-hour days.

The next change will:

- make the zone an input of the tier policy;
- aggregate local days from hourly rows, plus the minute rows of any hour
  that crosses local midnight, which is exact for +05:30 and +05:45;
- read gaps from each bucket's own end;
- report both `bucketTimeZone` and `displayTimeZone`.

Owner: claude. Deadline: 2026-10-21.

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
