# What a channel is, now, by its key (2026-10-07)

PR-2b of the water-chemistry channel-binding plan, on top of #1847.

## SENSOR-MEDIUM-171 — nothing answers "what is this bound channel now"

Farm binds water-chemistry inputs to sensor channels by their stable natural
key (sensorId, channelKey), because channel ids change when a device is
rediscovered. To validate a binding (PR-3) and to read its value (PR-4), farm
needs to know whether the channel still exists and is enabled, where its
sensor stands, what quantity it reports in which unit, and its last value.

No query gave that by key. The readings page asked per sensor and dropped
disabled channels. Without one answer, farm would either copy channel fields
into its own rows, where they go stale, or ask several sensor queries that
could disagree.

### Fix

- **One answer.** `ChannelDescriptionService.describe(tenantId, keys)` returns
  one description per asked key, in request order. Each description has:
  - `presence`: `FOUND`, `NO_SENSOR` or `NO_CHANNEL`;
  - the sensor's active flag and its site, system and tank;
  - the channel id and whether it is enabled;
  - the effective quantity and quantity family, from the registry;
  - the unit and the calibration due date;
  - the last value, time and quality code inside the readings page's
    freshness window.

  Disabled channels and inactive sensors are described, not dropped. A
  binding to a switched-off probe says so instead of vanishing.
  - It runs as one SQL statement in the tenant's RLS boundary:
    `unnest … WITH ORDINALITY`, left joins, and a per-channel `LIMIT 1`.
  - A non-uuid sensor id is answered as `NO_SENSOR` without a read.
  - The cap is 100 keys per request.

- **Two doors to it, both thin.**
  - NATS `request.sensor.describeChannels`, contract in
    `@platform/event-contracts` `sensor-channel-queries`:
    - the request is validated exactly;
    - the reply validator requires every documented field and tolerates
      unknown ones, so sensor can add a field without breaking farm.
  - GraphQL `channelsByKey(keys)`, the same service, for the picker.
  - farm-service gains publish permission on the subject (services.yaml,
    nats.conf regenerated). sensor-service already subscribes to
    `request.sensor.>`.
- **Responder** like farm's time-zone responder. A malformed request is
  refused before any read, and a failed read is reported as an unavailable
  authority, never as an empty answer.

How fresh is fresh enough for a calculation is the caller's decision (PR-4).
Values come in the channel's unit; `toCanonicalUnit` converts them.

Proof:

- `channel-description.rls.postgres.spec.ts`, real Postgres, FORCE RLS,
  non-owner role:
  - request order;
  - all three presences;
  - another tenant's sensor reads as `NO_SENSOR`;
  - a non-uuid id;
  - a declared family member (`ammonia` declared as TAN);
  - sensor location and the calibration due date;
  - a disabled channel described, whose sample is older than the window, so it
    has no latest value;
  - the 100-key cap.
  - Mutation check: shifting the ordinal mapping by one fails it.
- `sensor-channel-queries.spec.ts`: exact requests and tolerant replies.
- `describe-channels.responder.spec.ts`: queue, tenant pass-through, refusal
  before read, unavailable authority.
- `channel-description.dto.spec.ts`: the GraphQL date mapping.

### Independent review → fixes

A sensor review found three medium and six low problems.

- **No gate pinned the subject's broker grants.** The generic NATS RPC scan
  reads `.respond(` as a send, so neither this contract nor the farm time-zone
  contract was in it. `tests/invariants/request-reply-contract-acl.spec.ts`
  now derives each contract's grants from its constants:
  - the owner holds a subscribe grant, exact or wildcard, matched the way the
    broker matches;
  - each caller holds a publish grant;
  - the owner registers exactly one responder.
  - Mutation check: dropping farm's publish grant fails it.
- **A raw quality code.** Farm would have had to copy `>= 192`, becoming a
  second owner of the quality scale. The reply now carries `latestQuality`
  (GOOD, UNCERTAIN or BAD), classified by the sensor service's own
  `qualityCategoryOf`. "Latest" is the newest sample of any quality, with its
  band.
- **A sample paired with a newer unit.** Samples carry no unit. Re-labelling an
  H2S channel from mg/L to µg/L would have paired the last sample with the new
  unit: a thousandfold error.
  - `sensor_data_channels.measurement_configured_at` (migration
    `1821000000000`) is stamped whenever the unit or the declared quantity
    changes.
  - The description returns it as `configuredAt` and never reports a sample
    older than it.
  - Mutation check: dropping the filter fails the spec.
- **Low:**
  - The cross-tenant case was hidden by `search_path`, not RLS. The spec now
    puts another tenant's rows inside this tenant's schema.
  - Cases added: duplicates, an inactive sensor, a missing unit, a refused
    stored declaration, a BAD newest sample.
  - The 101-key cap moved to a unit spec.
  - GraphQL key validators did not run on a bare array. The input is now a
    validated, capped `ChannelsByKeyInput`.
  - The reply validator is now exhaustive by type (`satisfies Record<keyof …>`)
    and checks ISO instants. `describesRequest` checks that a reply matches its
    request.
  - The contract now states:
    - the window (`AS_OF_LOOKBACK`, 7 days);
    - that location is the device owning the channel;
    - that a null unit means unconvertible;
    - that a null calibration date means no schedule;
    - that a new `presence` or quality value is a contract change, which an
      older caller refuses.
- Left as recorded (CONTRACT-LOW-012): removing farm's self-publish grant on
  `request.farm.validateSiteAssignment`, and teaching the e2e RPC scan to read
  `.respond(`. Both belong to the owners of those files.
